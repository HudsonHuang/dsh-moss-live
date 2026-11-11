/**
 * Compact call panel for the DSH speech plugin.
 *
 * Reuses MOSS's audio machinery (PublicSession protocol, Speaker playback,
 * Microphone capture) and owns only the small piece of UI a voice call needs:
 * a VAD dot, the two-sided transcript, task chips and two buttons.
 */
import { PublicSession } from './public-session.js'
import { Speaker } from './speaker.js'
import { Microphone } from './mic.js'

const $ = id => document.getElementById(id)
const logEl = $('log')
const emptyEl = $('empty')
const tasksEl = $('tasks')
const dot = $('dot')
const label = $('label')
const startBtn = $('start')
const stopBtn = $('stop')
const muteBtn = $('mute')
const hint = $('hint')

const token = location.hash.slice(1)
history.replaceState(null, '', location.pathname + location.search)
const relay = new URLSearchParams(location.search).get('relay')

let ws = null
let ctx = null
let mic = null
let session = null
let ticker = 0
let muted = false
let live = false
let ending = false
let fatal = ''

const bubbles = { user: null, assistant: null }
const lastBubbleAt = { user: 0, assistant: 0 }
const tasks = new Map()

function setState(next, text) {
  dot.className = 'dot' + (next ? ' ' + next : '')
  label.textContent = text
}

function scaleDot(level) {
  dot.style.transform = `scale(${1 + Math.min(1, level) * 0.9})`
  dot.style.boxShadow = `0 0 0 ${Math.round(Math.min(1, level) * 8)}px rgba(47,109,246,.16)`
}

let lastUserEl = null
let lastUserAt = 0

function bubble(role, text, partial) {
  // Consecutive ASR segments of one breath read better as a single message.
  if (role === 'user' && !partial && lastUserEl && Date.now() - lastUserAt < 5000) {
    lastUserEl.textContent = `${lastUserEl.textContent}\n${text}`.trim()
    lastUserAt = Date.now()
    emptyEl.hidden = true
    logEl.scrollTop = logEl.scrollHeight
    return
  }
  let el = bubbles[role]
  if (!el) {
    el = document.createElement('div')
    el.className = `msg ${role}`
    logEl.appendChild(el)
    bubbles[role] = el
  }
  el.textContent = text || '…'
  el.classList.toggle('partial', Boolean(partial))
  if (!partial) bubbles[role] = null
  if (role === 'user' && !partial) {
    lastUserEl = el
    lastUserAt = Date.now()
  }
  emptyEl.hidden = true
  logEl.scrollTop = logEl.scrollHeight
}

function renderTasks() {
  if (!tasks.size) {
    tasksEl.hidden = true
    return
  }
  tasksEl.hidden = false
  tasksEl.replaceChildren(...Array.from(tasks.values()).map(task => {
    const row = document.createElement('div')
    row.className = 'task'
    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = task.title || '后台任务'
    const state = document.createElement('span')
    const done = ['completed', 'returning'].includes(task.status)
    state.className = 'state' + (done ? ' done' : task.status === 'failed' ? ' failed' : '')
    state.textContent = done ? '完成' : task.status === 'failed' ? '失败' : '执行中'
    row.append(title, state)
    return row
  }))
}

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
}

async function start() {
  startBtn.disabled = true
  ending = false
  fatal = ''
  lastUserEl = null
  lastUserAt = 0
  stopBtn.hidden = true
  hint.textContent = ''
  setState('connecting', '正在接通…')
  try {
    ctx = new AudioContext({ sampleRate: 48000 })
    await ctx.resume()
    ws = new WebSocket(`${relay || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`}/connect?token=${encodeURIComponent(token)}`)
    ws.binaryType = 'arraybuffer'
    session = new PublicSession(send)
    session.speaker = new Speaker({ ctx, ledger: session.ledger, onMessages: messages => session.messages(messages) })
    ticker = setInterval(() => session.speaker.tick(ctx.currentTime), 10)

    ws.onopen = () => setState('connecting', '已连接，等待会话')
    ws.onmessage = async event => {
      if (typeof event.data !== 'string') {
        session.audio(event.data)
        return
      }
      const message = JSON.parse(event.data)
      if (message.type === 'demo.task') {
        tasks.set(message.id, message)
        renderTasks()
        return
      }
      if (message.type === 'relay.error') {
        fail(message.message || '本地中继报告连接失败：运行 npm run doctor 检查依赖、端口和 key。')
        return
      }
      session.text(message)
      handle(message)
    }
    ws.onclose = () => {
      if (ending || fatal) return
      if (live) stop('与 MOSS 的连接已断开：检查网络后重新开始通话；可运行 npm run doctor 复检。')
      else fail('本地中继没有响应：先运行 npm run doctor 检查依赖、端口和 key，再重试。')
    }
    ws.onerror = () => {
      if (ending || fatal) return
      if (!live) fail('连不上本地中继：先运行 npm run doctor 检查依赖、端口和 key。')
    }
  } catch (error) {
    fail('无法开始通话：' + (error.message || String(error)) + '。运行 npm run doctor 可复检。')
  }
}

async function openMic() {
  if (mic) return
  const opened = await Microphone.open({
    ctx,
    onLevel: level => scaleDot(level),
    onFrame: frame => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      const pcm = new Uint8Array(frame)
      const tagged = new Uint8Array(pcm.length + 1)
      tagged.set(pcm, 1) // tagged-v1 PCM tag is zero
      ws.send(tagged)
    },
  })
  mic = opened
  await mic.start()
  send({ action: 'mic_state', enabled: true })
  live = true
  startBtn.hidden = true
  stopBtn.hidden = false
  muteBtn.hidden = false
  setState('live', '在听')
  hint.textContent = '说完了它会接话；你插话它会停。'
}

function handle(message) {
  const d = message.data || {}
  switch (message.action) {
    case 'session_attached':
      send({ action: 'media.mode', binary_protocol: 'tagged-v1' })
      send({ action: 'session.update', session: { tools: [{
        type: 'function',
        name: 'get_local_time',
        description: 'Get the time on the customer device',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      }] } })
      break
    case 'session.updated':
      if (d.error) {
        fail('会话配置失败：' + (d.error.message || d.error) + '。检查插件配置 model/mossUrl，或运行 npm run doctor。')
        return
      }
      void openMic().catch(error => {
        const name = error && error.name ? error.name : 'Error'
        const text = name === 'NotAllowedError'
          ? '麦克风被拒绝：在浏览器或系统设置里允许本页使用麦克风，再点开始。'
          : name === 'NotFoundError'
            ? '没有找到麦克风：连接一个输入设备后重试。'
            : '麦克风不可用（' + name + '）：检查系统输入设备和权限后重试。'
        fail(text)
      })
      break
    case 'input.speech.started':
      setState('live', '你说')
      break
    case 'input.speech.stopped':
      setState('connecting', '在想…')
      break
    case 'input.transcript.updated':
      bubble('user', d.text, true)
      break
    case 'input.transcript.done':
      bubble('user', d.text, false)
      break
    case 'output.transcript.updated':
      bubble('assistant', d.text, true)
      break
    case 'output.transcript.done':
      bubble('assistant', d.text, false)
      break
    case 'response.audio.started':
      setState('speaking', '我在说')
      break
    case 'response.ended':
    case 'response.interrupted':
      if (live) setState('live', '在听')
      break
    case 'error': {
      const code = d.error?.code || 'unknown'
      const reason = d.error?.message ? '：' + d.error.message : ''
      hint.textContent = 'MOSS 返回错误 ' + code + reason + '。运行 npm run doctor 复检 key/model/网络。'
      break
    }
  }
}

function fail(text) {
  fatal = text
  hint.textContent = text
  setState('', '连接未完成')
  startBtn.disabled = false
  live = false
  try { ws?.close() } catch {}
}

function stop(text) {
  ending = true
  live = false
  clearInterval(ticker)
  try { ws?.close() } catch {}
  mic?.close()
  mic = null
  ctx?.close?.().catch?.(() => {})
  ctx = null
  ws = null
  startBtn.hidden = false
  startBtn.disabled = false
  stopBtn.hidden = true
  muteBtn.hidden = true
  setState('', text || '准备就绪')
  hint.textContent = text || '说完了直接停，它会接话；你插话它会停。'
}

startBtn.onclick = () => { tasks.clear(); renderTasks(); void start() }
stopBtn.onclick = () => stop()
muteBtn.onclick = () => {
  muted = !muted
  mic?.setMuted(muted)
  muteBtn.textContent = muted ? '取消静音' : '静音'
  send({ action: 'mic_state', enabled: !muted })
  setState('live', muted ? '已静音' : '在听')
}

setState('', '准备就绪')
