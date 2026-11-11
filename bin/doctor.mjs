#!/usr/bin/env node
/**
 * dsh-moss-live doctor.
 *
 * Checks what can honestly be checked without starting a call:
 *   Node version, required files, runtime dependencies, the vendored relay's
 *   module load, the local relay port, the MOSS key, and (unless --offline)
 *   one real MOSS WebSocket handshake + attach_session.
 *
 * It never prints the key. It exits 1 when an executed check fails, and it
 * always prints what was NOT covered: a passing run is not a promise that a
 * call will work. Audio, the microphone, DSH delegation and billing are out
 * of scope here.
 */
import { createServer } from 'node:net'
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_LISTEN = '127.0.0.1:17861'
const DEFAULT_URL = 'wss://api.mosi.cn/v1/realtime'
const DEFAULT_MODEL = 'moss-live-1.0'
const MIN_NODE = [22, 19, 0]
const RUNTIME_DEPENDENCIES = ['ws', '@mossai/mosslive']
const REQUIRED_FILES = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'vendor/runtime/server.mjs',
  'vendor/runtime/public-api.mjs',
  'vendor/web/product/embed.html',
]

const checks = []
function record(status, name, detail = '', fix = '') {
  checks.push({ status, name, detail, fix })
  const label = status === 'ok' ? '[ok]  ' : status === 'fail' ? '[fail]' : '[skip]'
  console.log(`${label} ${name}${detail ? '：' + detail : ''}`)
  if (fix) console.log(`       修：${fix}`)
}

function parseArgs(argv) {
  const options = {
    offline: false,
    keyFile: '',
    listen: DEFAULT_LISTEN,
    url: DEFAULT_URL,
    model: DEFAULT_MODEL,
    timeout: 12000,
    help: false,
  }
  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index]
    const equals = raw.startsWith('--') ? raw.indexOf('=') : -1
    const flag = equals === -1 ? raw : raw.slice(0, equals)
    const inline = equals === -1 ? undefined : raw.slice(equals + 1)
    const value = () => {
      if (inline !== undefined) return inline
      const next = argv[++index]
      if (next === undefined) throw new Error(`${flag} 需要一个值`)
      return next
    }
    if (flag === '--offline') options.offline = true
    else if (flag === '--help' || flag === '-h') options.help = true
    else if (flag === '--key-file') options.keyFile = value()
    else if (flag === '--listen') options.listen = value()
    else if (flag === '--url') options.url = value()
    else if (flag === '--model') options.model = value()
    else if (flag === '--timeout') {
      const timeout = Number(value())
      if (!Number.isFinite(timeout) || timeout < 1000) throw new Error('--timeout 必须是 >=1000 的毫秒数')
      options.timeout = timeout
    } else throw new Error(`未知参数：${raw}（--help 查看用法）`)
  }
  return options
}

function printHelp() {
  console.log(`dsh-moss-live doctor — 可运行性自检（不启动通话、不发送音频）

用法：
  npm run doctor -- [options]

选项：
  --offline           跳过 MOSS 握手；结论会明确写“未验证 key/可达性”
  --key-file <path>   从这个文件读 key（默认依次：MOSS_API_KEY、.moss-api-key）
  --listen <host:port> 检查的本地 relay 地址（默认 ${DEFAULT_LISTEN}）
  --url <wss://...>   MOSS 地址（默认 ${DEFAULT_URL}）
  --model <id>        MOSS 模型（默认 ${DEFAULT_MODEL}）
  --timeout <ms>      握手/attach 超时（默认 12000）
  -h, --help

检查项：Node 版本、必需文件、ws/@mossai/mosslive 依赖、runtime 加载、
relay 端口、MOSS key、一次真实 WS 握手 + attach_session。
不覆盖：音频收发、麦克风权限、DSH 子代理委派、桌面壳 iframe 注入、计费。`)
}

function parseListen(value) {
  try {
    const parsed = new URL('http://' + value)
    if (!parsed.hostname || !parsed.port) return null
    return { host: parsed.hostname.replace(/^\[|\]$/g, ''), port: Number(parsed.port) }
  } catch {
    return null
  }
}

function isLoopback(host) {
  return ['127.0.0.1', 'localhost', '::1'].includes(host)
}

async function canBind({ host, port }) {
  await new Promise((resolveBind, rejectBind) => {
    const server = createServer()
    server.once('error', rejectBind)
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolveBind()))
  })
}

function validateMossUrl(value) {
  let parsed
  try { parsed = new URL(value) } catch { return '不是合法 URL' }
  if (parsed.protocol !== 'wss:' && !(parsed.protocol === 'ws:' && isLoopback(parsed.hostname))) {
    return '必须是 wss://（本机开发可用 ws://127.0.0.1）'
  }
  if (parsed.username || parsed.password) return '不能带用户名/密码'
  if (parsed.search || parsed.hash) return '不能带 query 或 hash'
  return ''
}

async function resolveKey(options) {
  if (options.keyFile) {
    const path = isAbsolute(options.keyFile) ? options.keyFile : resolve(process.cwd(), options.keyFile)
    try {
      const value = (await readFile(path, 'utf8')).trim()
      return value ? { value, source: path } : { error: `${path} 是空文件` }
    } catch (error) {
      return { error: `读不到 ${path}（${error.code || error.message}）` }
    }
  }
  const fromEnv = String(process.env.MOSS_API_KEY || '').trim()
  if (fromEnv) return { value: fromEnv, source: '环境变量 MOSS_API_KEY' }
  const path = join(HERE, '.moss-api-key')
  try {
    const value = (await readFile(path, 'utf8')).trim()
    return value ? { value, source: '.moss-api-key' } : { error: '.moss-api-key 是空文件' }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { value: '', source: '' }
    return { error: `读不到 ${path}（${error.code || error.message}）` }
  }
}

function httpFailure(statusCode) {
  if (statusCode === 401 || statusCode === 403) {
    return { status: 'fail', detail: `HTTP ${statusCode}：MOSS 拒绝了这个 key`, fix: '更新插件配置 apiKey、环境变量 MOSS_API_KEY 或插件目录 .moss-api-key' }
  }
  if (statusCode === 404) {
    return { status: 'fail', detail: `HTTP ${statusCode}：握手路径不存在`, fix: '检查 mossUrl（默认 wss://api.mosi.cn/v1/realtime）' }
  }
  if (statusCode >= 500) {
    return { status: 'fail', detail: `HTTP ${statusCode}：MOSS 服务端错误`, fix: '稍后重试；持续 5xx 时检查 MOSS 服务状态' }
  }
  return { status: 'fail', detail: `HTTP ${statusCode}`, fix: '检查 mossUrl 与网络/代理' }
}

function socketFailure(error) {
  const code = String((error && error.code) || '')
  const network = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']
  if (network.includes(code)) return `网络层 ${code}：检查网络/代理、mossUrl；本机 DNS 或 TLS 也可能拦截`
  return `连接失败（${code || (error && error.message) || 'unknown'}）：检查网络/代理与 mossUrl`
}

async function handshake({ url, model, key, timeout }) {
  let WebSocket
  try { ({ default: WebSocket } = await import('ws')) } catch (error) {
    return { status: 'fail', detail: '无法加载 ws：' + (error.message || error), fix: '在插件目录执行 npm ci' }
  }
  return await new Promise(resolveHandshake => {
    let settled = false
    let timer = null
    let ws = null
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws?.close(1000) } catch {}
      resolveHandshake(result)
    }
    const target = new URL(url)
    target.searchParams.set('model', model)
    target.searchParams.set('user', 'dsh-voice-doctor')
    try {
      ws = new WebSocket(target, {
        headers: { Authorization: `Bearer ${key}` },
        handshakeTimeout: timeout,
        followRedirects: false,
      })
    } catch (error) {
      resolveHandshake({ status: 'fail', detail: '无法发起连接：' + (error.message || error), fix: '检查 mossUrl' })
      return
    }
    timer = setTimeout(() => finish({
      status: 'fail',
      detail: `${timeout}ms 内没有完成握手/attach_session`,
      fix: '检查 mossUrl、model、网络；MOSS 服务可能繁忙，稍后重试',
    }), timeout + 2000)
    ws.on('unexpected-response', (_request, response) => {
      try { response.resume?.() } catch {}
      finish(httpFailure(response.statusCode))
    })
    ws.on('open', () => {
      try {
        ws.send(JSON.stringify({ action: 'attach_session', memory_scope: 'session', delegation: { type: 'none' } }))
      } catch (error) {
        finish({ status: 'fail', detail: '已连上但发送 attach_session 失败：' + (error.message || error), fix: '检查 mossUrl/网络后重试' })
      }
    })
    ws.on('message', (data) => {
      let event
      try { event = JSON.parse(data.toString()) } catch { return }
      if (event.action === 'session_attached') {
        finish({ status: 'ok', detail: 'WS 101 + session_attached' })
      } else if (event.action === 'error') {
        const error = (event.data && event.data.error) || {}
        finish({
          status: 'fail',
          detail: `MOSS 返回错误 ${error.code || ''}${error.message ? '：' + error.message : ''}`,
          fix: '检查 key/model/mossUrl，或稍后重试',
        })
      }
    })
    ws.on('error', (error) => finish({ status: 'fail', detail: socketFailure(error), fix: '按上面的网络/配置提示处理后重跑 npm run doctor' }))
    ws.on('close', (code, reason) => {
      if (settled) return
      const text = reason ? reason.toString() : ''
      finish({ status: 'fail', detail: `连接关闭（code ${code}${text ? '，' + text : ''}）`, fix: code === 1008 ? 'key/model 可能无权限，检查 apiKey 与 model' : '检查网络/代理与 mossUrl，稍后重试' })
    })
  })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { printHelp(); return }

  console.log('dsh-moss-live doctor')
  console.log(`插件目录：${HERE}`)
  if (!options.offline) console.log('握手会在 MOSS 建立一个空 session（不发音频），用于验证 key 与可达性。')
  console.log('')

  const [major, minor] = process.versions.node.split('.').map(Number)
  const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
  record(nodeOk ? 'ok' : 'fail', 'Node 版本', `${process.versions.node}（要求 >=${MIN_NODE.join('.')}）`, nodeOk ? '' : '升级 Node；或改用 DSH 自带的 Node 运行 doctor')

  const missingFiles = []
  for (const file of REQUIRED_FILES) {
    try { await stat(join(HERE, file)) } catch { missingFiles.push(file) }
  }
  record(missingFiles.length ? 'fail' : 'ok', '必需文件', missingFiles.length ? `缺少 ${missingFiles.join('、')}` : `${REQUIRED_FILES.length} 个文件存在`, missingFiles.length ? '重新 clone 或 npm ci，不要只拷 index.js' : '')

  const unresolved = []
  for (const dependency of RUNTIME_DEPENDENCIES) {
    try { import.meta.resolve(dependency) } catch { unresolved.push(dependency) }
  }
  record(unresolved.length ? 'fail' : 'ok', '运行时依赖', unresolved.length ? `无法解析 ${unresolved.join('、')}` : 'ws、@mossai/mosslive 可解析', unresolved.length ? `在插件目录 ${HERE} 执行 npm ci（install_bundle 只 link，不会装依赖）` : '')

  let runtimeLoaded = false
  if (unresolved.length) {
    record('skip', 'runtime 加载', '依赖未齐全，未尝试')
  } else {
    try {
      const module = await import(pathToFileURL(join(HERE, 'vendor/runtime/server.mjs')).href)
      if (typeof module.startLocalClient !== 'function') throw new Error('startLocalClient 未导出')
      runtimeLoaded = true
      record('ok', 'runtime 加载', 'vendor/runtime/server.mjs 可加载，startLocalClient 已导出')
    } catch (error) {
      record('fail', 'runtime 加载', `${error.code ? error.code + '：' : ''}${String(error.message || error).split('\n')[0]}`, '先修依赖；仍失败则重新 clone 或 npm ci')
    }
  }

  const listen = parseListen(options.listen)
  if (!listen) {
    record('fail', 'relay 端口', `listen 不合法：${options.listen}`, '写成 127.0.0.1:17861')
  } else if (!isLoopback(listen.host)) {
    record('fail', 'relay 端口', `listen 必须是 loopback：${options.listen}`, '改成 127.0.0.1:17861')
  } else {
    try {
      await canBind(listen)
      record('ok', 'relay 端口', `${listen.host}:${listen.port} 可绑定`)
    } catch (error) {
      if (error && error.code === 'EADDRINUSE') {
        const nextPort = listen.port > 0 && listen.port < 65535 ? listen.port + 1 : 17861
        const owner = process.platform === 'win32'
          ? `netstat -ano | findstr :${listen.port}`
          : `lsof -nP -iTCP:${listen.port} -sTCP:LISTEN`
        record('fail', 'relay 端口', `${listen.host}:${listen.port} 已被占用`, `把插件配置 listen 改成 127.0.0.1:${nextPort}；或查占用：${owner}，结束对应 PID`)
      } else {
        record('fail', 'relay 端口', `${listen.host}:${listen.port} 无法绑定（${(error && error.code) || error.message}）`, '检查端口合法性与本机权限')
      }
    }
  }

  const urlProblem = validateMossUrl(options.url)
  record(urlProblem ? 'fail' : 'ok', 'mossUrl', urlProblem || options.url, urlProblem ? 'mossUrl 必须是 wss://（本机开发可用 ws://127.0.0.1），且不带凭据/query/hash' : '')

  const key = await resolveKey(options)
  if (key.error) {
    record('fail', 'MOSS key', key.error, '设置 MOSS_API_KEY、写插件目录 .moss-api-key（一行），或用 --key-file；只写在 DSH 插件配置 apiKey 时 doctor 读不到（未覆盖）')
  } else if (!key.value) {
    record('fail', 'MOSS key', '未找到', '设置 MOSS_API_KEY、写插件目录 .moss-api-key（一行），或用 --key-file；只写在 DSH 插件配置 apiKey 时 doctor 读不到（未覆盖）')
  } else if (/[\r\n]/.test(key.value)) {
    record('fail', 'MOSS key', '含换行', '删掉 key 里的换行，只留一行；用 .moss-api-key 时文件末尾只保留一个换行')
  } else {
    record('ok', 'MOSS key', `非空（来源 ${key.source}，${[...key.value].length} 字符，已隐藏）`)
  }

  const keyUsable = !key.error && key.value && !/[\r\n]/.test(key.value)
  if (options.offline) {
    record('skip', 'MOSS 握手', '未执行（--offline）', '')
  } else if (!keyUsable) {
    record('skip', 'MOSS 握手', '缺有效 key，未执行', '')
  } else if (unresolved.length || !runtimeLoaded) {
    record('skip', 'MOSS 握手', 'runtime/依赖未就绪，未执行', '')
  } else if (urlProblem) {
    record('skip', 'MOSS 握手', 'mossUrl 不合法，未执行', '')
  } else {
    const result = await handshake({ url: options.url, model: options.model, key: key.value, timeout: options.timeout })
    record(result.status, 'MOSS 握手', `${result.detail}（model ${options.model}）`, result.fix || '')
  }

  const failed = checks.filter(check => check.status === 'fail').length
  const passed = checks.filter(check => check.status === 'ok').length
  const skipped = checks.filter(check => check.status === 'skip')
  console.log('')
  if (failed) console.log(`结果：${failed} 项失败，${passed} 项通过。按上面的“修”处理后重跑 npm run doctor。`)
  else console.log(`结果：已执行的 ${passed} 项检查通过。`)
  if (skipped.length) console.log(`未执行：${skipped.map(check => check.name).join('、')}。`)
  const uncovered = ['真实音频收发', '麦克风权限', 'DSH 子代理委派', '桌面壳 iframe 麦克风注入', 'MOSS 计费/额度']
  if (skipped.some(check => check.name === 'MOSS 握手')) uncovered.unshift('MOSS key 是否有效、MOSS 是否可达')
  console.log(`未覆盖：${uncovered.join('、')}。`)
  if (options.offline) console.log('注意：--offline 跳过了握手，本次不验证 key 是否有效、MOSS 是否可达。')
  if (failed) process.exitCode = 1
}

main().catch(error => {
  console.error('doctor 失败：' + (error && error.message ? error.message : error))
  process.exitCode = 1
})
