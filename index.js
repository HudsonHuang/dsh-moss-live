/**
 * Host half of the Speech Agent bundle.
 *
 * Thin wrapper around the MOSS-Live browser demo (vendored from
 * `@mossai/mosslive@0.1.0`'s official `examples/browser-demo`, MIT):
 *
 *   1. serves the demo UI + relays the browser to MOSS with the API key
 *      (the demo's own `startLocalClient`);
 *   2. hands the demo's delegation tasks to the DSH session that opened the call,
 *      and returns the agent's final answer as the spoken result.
 *
 * Nothing else of MOSS is reimplemented: duplex audio, VAD, barge-in and the
 * delegation protocol all stay in the official demo/SDK.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Load the vendored relay lazily. A missing npm dependency then becomes a
 * diagnosable startup error with a fix, instead of throwing while the plugin
 * module is imported (where the user only sees "plugin failed to load").
 */
let startLocalClientPromise = null
function loadRuntime() {
  startLocalClientPromise ??= import('./vendor/runtime/server.mjs').then(module => module.startLocalClient)
  return startLocalClientPromise
}

const RUNTIME_DEPENDENCIES = ['ws', '@mossai/mosslive']

/** Name of the first dependency the relay needs that cannot be resolved, or ''. */
export function missingRuntimeDependency() {
  if (typeof import.meta.resolve !== 'function') return ''
  for (const dependency of RUNTIME_DEPENDENCIES) {
    try { import.meta.resolve(dependency) } catch { return dependency }
  }
  return ''
}

/**
 * Translate the relay's startup failures into something a user can act on.
 * Used by the /speech/call/open handler so the panel never shows a bare
 * `PUBLIC_WSS_URL_REQUIRED` / `EADDRINUSE`.
 */
export function describeStartError(error, settings = DEFAULTS) {
  const message = String(error && error.message ? error.message : error)
  const dependency = error && error.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (package|module)/.test(message)
  if (dependency) {
    return `插件依赖未安装（${message.split('\n')[0]}）：在插件目录 ${HERE} 执行 npm ci，然后重载插件；运行 npm run doctor 可检查。`
  }
  if (message === 'API_KEY_REQUIRED') {
    return 'MOSS API key 为空或含换行：填插件配置 apiKey、环境变量 MOSS_API_KEY，或插件目录下的一行 .moss-api-key。'
  }
  if (message === 'PUBLIC_WSS_URL_REQUIRED') {
    return `mossUrl 不合法：必须是 wss:// 地址（本机开发可用 ws://127.0.0.1），且不能带用户名、密码、query 或 hash。当前：${settings.mossUrl}`
  }
  if (message === 'INVALID_LOCAL_CONFIGURATION') {
    return `listen/delegation 不合法：listen 必须是 127.0.0.1:端口；当前：${settings.listen}`
  }
  if (error && error.code === 'EADDRINUSE' || /EADDRINUSE/.test(message)) {
    const port = (() => { try { return new URL('http://' + settings.listen).port || '17861' } catch { return '17861' } })()
    const owner = process.platform === 'win32'
      ? `netstat -ano | findstr :${port}`
      : `lsof -nP -iTCP:${port} -sTCP:LISTEN`
    return `本地中继端口 ${settings.listen} 被占用：把插件配置 listen 改成 127.0.0.1:${Number(port) + 1}，或先停掉占用进程（${owner} 查到 PID 后结束它）。`
  }
  return `本地中继启动失败：${message}。运行 npm run doctor 检查依赖、端口和 key。`
}

export const name = 'dsh-moss-live'
export const inject = ['webServer', 'sessionController', 'sessions', 'workspaceController', 'agents', 'subagents']

const DEFAULTS = {
  mossUrl: 'wss://api.mosi.cn/v1/realtime',
  model: 'moss-live-1.0',
  listen: '127.0.0.1:17861',
  apiKey: '',
  keyFile: '.moss-api-key',
  user: 'dsh-voice-user',
  sessionTimeoutMs: 180000,
}

/** Session policy pushed to MOSS right after attach: the real executor is DSH. */
const SESSION_POLICY = {
  instructions: [
    '你是 DSH 的语音前端：负责听、把需求问清楚、交给后台执行、然后把结果说给用户。',
    '一、先澄清，再转交。',
    '1. 用户的请求如果缺关键信息（查哪里的天气、什么时候、给谁、哪个文件），先用一句话问清楚，不要猜，也不要先转出去。',
    '2. 一次只问一个最关键的问题；用户补全后立刻转交，不要反复确认。',
    '3. 信息齐了就马上调 dsh_task，把用户原话（含地点、时间、条件）完整放进 objective。',
    '二、话术要自然，别解说机制。',
    '4. 不要再说「我转过去」「已经转过去了」「任务已经排上了」这类话——用户不关心你有没有后台。',
    '5. 用自然的短句，例如「我查一下」「好，我看看」「马上告诉你」；结果回来后直接说结果。',
    '6. 不要每句都用同一个句式，按场景换着说；拿不准就简短些。',
    '三、其他。',
    '7. 用户问进展时调用 dsh_tasks，用口语汇总。',
    '8. 用户问你是谁或用什么模型：听和说是 MOSS-Live，思考和执行是 DSH 上的 DeepSeek；不要自称「小默」。',
  ].join('\n'),
  persona: {
    name: 'DSH 语音助手',
    prompt: '你是 DSH 的语音助手。说话像一个靠谱的同事：先听清楚，必要时问一句，然后把事办了，回来把结果讲清楚。不要自称「小默」，也不要解释自己背后有什么系统。语气自然、简洁、口语化。',
  },
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

/** Turn a delegation task into the prompt the DSH agent receives. */
function buildPrompt(task) {
  const lines = []
  if (task.purpose === 'reasoning') {
    lines.push('语音通话中，用户希望你先把这个问题想清楚再回答；下面的结果会直接被念出来，请用适合口语朗读的短句作答。')
  } else {
    lines.push('语音通话中，用户交给了你一个任务。做完后请用一段适合直接朗读的中文口语回复（结论在前，200 字以内，不要 Markdown、不要代码块、不要罗列文件路径）。')
  }
  lines.push('')
  lines.push('任务：' + task.objective)
  lines.push('')
  lines.push('执行方式由你决定：能马上做完就做；需要等、需要定时、需要明天提醒的，用 DSH 自己的调度能力安排，不要空等。')

  const context = Array.isArray(task.context) ? task.context.slice(-4) : []
  if (context.length) {
    lines.push('')
    lines.push('最近对话：')
    for (const item of context) {
      const role = item.role === 'user' ? '用户' : item.role === 'assistant' ? '助手' : item.role
      lines.push(`- ${role}: ${item.content}`)
    }
  }
  return lines.join('\n')
}

/** Pick the last assistant text out of the Session records returned by `wait`. */
function extractReply(waited) {
  const records = waited && waited.output && Array.isArray(waited.output.records) ? waited.output.records : []
  let text = ''
  for (const record of records) {
    const event = record && record.type === 'event' ? record.event : null
    if (!event || event.type !== 'assistant/message') continue
    const message = event.data && event.data.message
    const content = message && Array.isArray(message.content) ? message.content : []
    const parts = content.filter(block => block && block.type === 'text').map(block => block.text)
    if (parts.length) text = parts.join('\n')
  }
  return text.trim()
}

function readKeyFile(path) {
  if (!path) return ''
  try {
    const target = isAbsolute(path) ? path : join(HERE, path)
    return readFileSync(target, 'utf8').trim()
  } catch {
    return ''
  }
}

/** Stable per-install token so an open call page survives a relay restart. */
function relayToken() {
  const file = join(HERE, '.relay-token')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(existing)) return existing
  } catch { /* create below */ }
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
  try { writeFileSync(file, token + '\n', { mode: 0o600 }) } catch { /* fall back to a random one */ }
  return token
}

function debugLog(ctx, entry) {
  try {
    appendFileSync(join(HERE, '.run-debug.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
  } catch { /* diagnostics only */ }
  ctx.logger?.info?.('speech agent: ' + JSON.stringify(entry))
}

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config }
  const apiKey = settings.apiKey || process.env.MOSS_API_KEY || readKeyFile(settings.keyFile)
  const state = { server: null, starting: null, boundSessionId: null, sandboxSessionId: null, subagentDisabled: false }
  const missingDependency = missingRuntimeDependency()
  if (missingDependency) {
    // The panel still opens; clicking the phone button reports the fix instead
    // of the plugin silently failing to import.
    ctx.logger?.warn?.(`speech agent: 缺少运行时依赖 ${missingDependency}。在插件目录 ${HERE} 执行 npm ci；运行 npm run doctor 可检查。`)
  }

  /** Preferred child provider: one that can start a local subagent run. */
  function subagentProvider() {
    if (!ctx.subagents) return null
    const names = ctx.subagents.list()
    if (!names.length) return null
    for (const candidate of names) {
      const provider = ctx.subagents.getProvider(candidate)
      if (provider && typeof provider.start === 'function') return candidate
    }
    return names[0]
  }

  function textOf(result) {
    const blocks = result && Array.isArray(result.output) ? result.output : []
    return blocks.filter(block => block && block.type === 'text').map(block => block.text).join('\n').trim()
  }

  /**
   * Every voice task runs in its own subagent under the bound session: the
   * subagent does the work, the main conversation only carries the result.
   */
  async function runInSubagent(task, { signal }) {
    const sessionId = state.boundSessionId
    const provider = subagentProvider()
    if (!provider) return null
    // The bound conversation may be cold (sandbox, or simply not open in the
    // browser); resolve resumes it so it can own a child agent.
    let parent = ctx.agents && ctx.agents.get(sessionId)
    if (!parent) {
      const resolved = await ctx.sessionController.resolveAgent(sessionId)
      parent = resolved && resolved.agent ? resolved.agent : undefined
    }
    if (!parent) return null

    const session = ctx.sessions.get(sessionId)
    const activation = await ctx.subagents.startActivation({
      provider,
      label: 'voice-task',
      delivery: 'caller',
      signal,
      request: {
        prompt: [{ type: 'text', text: buildPrompt(task) }],
        parent,
        cwd: (session && session.header && session.header.cwd) || undefined,
        agentPreset: (session && session.header && session.header.agentPreset) || undefined,
      },
    })

    const onAbort = () => {
      try { ctx.subagents.interrupt(activation.childId, { kind: 'ancestor', agent: parent }) } catch { /* gone */ }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await activation.result
      const text = textOf(result)
      if (!text) return '这个任务在子代理里跑完了，但没有产出可以直接念出来的结论。'
      return text
    } finally {
      signal.removeEventListener('abort', onAbort)
      Promise.resolve(activation.dispose()).catch(() => {})
    }
  }

  async function run(task, { signal }) {
    const sessionId = state.boundSessionId
    if (!sessionId) throw new Error('没有绑定 DSH 会话：请从 DSH 对话里的电话按钮进入语音通话')
    if (!ctx.sessions.get(sessionId)) throw new Error('绑定的 DSH 会话已关闭，请回到对话重新发起通话')
    signal.throwIfAborted()

    if (!state.subagentDisabled) {
      try {
        const viaSubagent = await runInSubagent(task, { signal })
        if (viaSubagent !== null) {
          debugLog(ctx, { mode: 'subagent', provider: subagentProvider(), providers: ctx.subagents ? ctx.subagents.list() : [] })
          return viaSubagent
        }
        state.subagentDisabled = true
        debugLog(ctx, { mode: 'fallback', reason: 'no-provider-or-parent', providers: ctx.subagents ? ctx.subagents.list() : [] })
      } catch (error) {
        if (signal.aborted) throw error
        debugLog(ctx, { mode: 'fallback', reason: 'subagent-error', error: String(error && error.message ? error.message : error) })
      }
    }

    const session = ctx.sessions.get(sessionId)
    const afterSeq = session ? session.seq : 0
    const requestId = 'speech-' + randomUUID()

    const onAbort = () => {
      try { ctx.sessionController.cancel({ sessionId }) } catch { /* session already gone */ }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      signal.throwIfAborted()
      await ctx.sessionController.prompt({
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: buildPrompt(task) }],
        clientTimeZone: 'Asia/Shanghai',
      }, signal)

      const waited = await ctx.sessionController.wait({
        sessionId,
        timeoutMs: task.timeoutMs || settings.sessionTimeoutMs,
        afterSeq,
        maxMessages: 80,
      }, signal)

      if (waited.reason === 'input-required') {
        return '这个任务在 DSH 里等你确认一下（审批或提问），处理完我马上继续。'
      }
      if (waited.reason === 'timeout') {
        return '这个任务还在跑，我过一会儿再把结果告诉你。'
      }
      const reply = extractReply(waited)
      return reply || '做完了，但这次没有产出可以直接念出来的结论，详情看对话里的记录。'
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** After each call, write a Markdown record and leave only its path in chat. */
  async function writeCallRecord(entries) {
    try {
      const sessionId = state.boundSessionId
      const dir = join(HERE, 'calls')
      mkdirSync(dir, { recursive: true })
      const now = new Date()
      const pad = value => String(value).padStart(2, '0')
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
      const file = join(dir, `${stamp}.md`)
      const lines = [
        '# 语音通话记录',
        '',
        `- 时间：${now.toLocaleString('zh-CN')}`,
        `- DSH 会话：${sessionId || '未绑定'}`,
        '',
      ]
      for (const entry of entries) {
        const text = String(entry.text || '').trim()
        if (!text) continue
        if (entry.kind === 'user') lines.push(`**我**：${text}`, '')
        else if (entry.kind === 'assistant') lines.push(`**助手**：${text}`, '')
        else if (entry.kind === 'task') lines.push(`> 转给后台的任务：${text}`, '')
        else if (entry.kind === 'result') lines.push(`> 后台结果：${text}`, '')
      }
      writeFileSync(file, lines.join('\n'), { mode: 0o600 })

      const session = sessionId ? ctx.sessions.get(sessionId) : undefined
      if (session) {
        session.append(
          'user/message',
          {
            role: 'user',
            content: [{ type: 'text', text: `📞 通话记录已保存：${file}` }],
            source: { kind: 'user' },
          },
          { surfaceOp: 'append' },
        )
      }
    } catch (error) {
      debugLog(ctx, { mode: 'call-record-failed', error: String(error && error.message ? error.message : error) })
    }
  }

  function ensureServer() {
    if (state.server) return Promise.resolve(state.server)
    if (state.starting) return state.starting
    state.starting = loadRuntime().then(startLocalClient => startLocalClient({
      listen: settings.listen,
      url: settings.mossUrl,
      apiKey,
      model: settings.model,
      user: settings.user,
      delegation: 'client',
      run,
      token: relayToken(),
      historyDir: join(HERE, '.calls'),
      onCallEnd: writeCallRecord,
      frameAncestors: (() => {
        const origin = (() => { try { return ctx.webServer.getOrigin() } catch { return '' } })()
        // dsh-app://app is the desktop shell's origin for the Web UI.
        return ['dsh-app://app', origin].filter(Boolean).join(' ')
      })(),
      allowedOrigins: (() => { try { return [ctx.webServer.getOrigin()] } catch { return [] } })(),
      instructions: SESSION_POLICY.instructions,
      persona: SESSION_POLICY.persona,
      maxConcurrency: 1,
      maxQueue: 8,
      executionTimeoutMs: settings.sessionTimeoutMs,
      maxProgressBytes: 600,
      maxPendingWrites: 256,
      maxTaskRecords: 4096,
      ackTimeoutMs: 15000,
      cancelGraceMs: 5000,
    })).then(server => {
      state.server = server
      state.starting = null
      ctx.logger?.info?.(`speech agent: MOSS demo listening on ${server.url.split('#')[0]}`)
      return server
    }).catch(error => {
      state.starting = null
      throw error
    })
    return state.starting
  }

  ctx.effect(() => () => {
    const server = state.server
    state.server = null
    if (server) Promise.resolve(server.close()).catch(() => {})
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/speech/call/open',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const sessionId = url.searchParams.get('session')
      if (!apiKey) {
        json(res, 400, { error: { message: '缺少 MOSS API Key：在插件「语音通话」的配置里填 apiKey，或设置环境变量 MOSS_API_KEY，或在插件目录放一行 .moss-api-key；然后运行 npm run doctor 复检。' } })
        return
      }
      if (!sessionId) {
        json(res, 400, { error: { message: '缺少 session 参数' } })
        return
      }
      if (!ctx.sessions.get(sessionId)) {
        json(res, 404, { error: { message: '找不到这个会话，请先打开一个对话' } })
        return
      }
      state.boundSessionId = sessionId
      try {
        const server = await ensureServer()
        const embed = url.searchParams.get('embed') === '1'
        // Same-origin page: the parent (harness) page owns the microphone and
        // injects its stream, because the shell denies getUserMedia in frames.
        const token = server.url.split('#')[1] || ''
        const relayOrigin = `ws://${settings.listen}`
        const target = embed
          ? `/speech/app/product/embed.html?relay=${encodeURIComponent(relayOrigin)}#${token}`
          : server.url
        json(res, 200, { url: target, sessionId, embed })
      } catch (error) {
        json(res, 500, { error: { code: 'RELAY_START_FAILED', message: describeStartError(error, settings) } })
      }
    },
  }))

  // Test/demo sandbox: a throwaway session in a temp cwd, so automated checks
  // never write tasks into the user's own conversations.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/speech/call/sandbox',
    handler: async (req, res) => {
      if (!apiKey) {
        json(res, 400, { error: { message: '缺少 MOSS API Key' } })
        return
      }
      const cwd = join(tmpdir(), 'dsh-voice-sandbox')
      try {
        mkdirSync(cwd, { recursive: true })
        if (state.sandboxSessionId) {
          await ctx.workspaceController.archiveSession({ sessionId: state.sandboxSessionId, stopActivity: true }).catch(() => {})
        }
        const created = await ctx.sessionController.create({ cwd })
        state.sandboxSessionId = created.sessionId
        state.boundSessionId = created.sessionId
        const server = await ensureServer()
        json(res, 200, { url: server.url, sessionId: created.sessionId, sandbox: true })
      } catch (error) {
        json(res, 500, { error: { code: 'RELAY_START_FAILED', message: describeStartError(error, settings) } })
      }
    },
  }))

  // Serve the call page from the harness origin so the panel can embed it
  // (cross-origin iframes are blocked by the desktop shell).
  const WEB_DIR = join(HERE, 'vendor', 'web')
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/speech/app',
    handler: async (req, res) => {
      const requestUrl = new URL(req.url, 'http://127.0.0.1')
      let rel = decodeURIComponent(requestUrl.pathname.replace(/^\/speech\/app\/?/, ''))
      if (!rel) rel = 'product/index.html'
      const file = join(WEB_DIR, rel)
      if (!file.startsWith(WEB_DIR)) {
        res.writeHead(403)
        res.end()
        return
      }
      let body
      try {
        body = readFileSync(file)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      }
      if (rel.endsWith('.html')) {
        body = Buffer.from(body.toString('utf8')
          .replaceAll('"/product/', '"/speech/app/product/')
          .replaceAll('"/js/', '"/speech/app/js/'))
      }
      res.writeHead(200, {
        'content-type': MIME[extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
      })
      res.end(body)
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/speech/call/sandbox/close',
    handler: async (_req, res) => {
      const id = state.sandboxSessionId
      state.sandboxSessionId = null
      if (!id) {
        json(res, 200, { closed: null })
        return
      }
      if (state.boundSessionId === id) state.boundSessionId = null
      try {
        await ctx.workspaceController.archiveSession({ sessionId: id, stopActivity: true })
        json(res, 200, { closed: id })
      } catch (error) {
        json(res, 500, { error: { code: 'SANDBOX_CLOSE_FAILED', message: '关闭沙箱会话失败：' + String(error && error.message ? error.message : error) } })
      }
    },
  }))
}
