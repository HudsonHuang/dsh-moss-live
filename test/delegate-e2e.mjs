#!/usr/bin/env node
/**
 * Delegation end-to-end check for the Host bridge.
 *
 * Acts as the browser for the bundled MOSS demo: connects to the demo's
 * /connect?token=… socket, streams a spoken task (16 kHz PCM16 WAV), acks the
 * reply audio, and prints the transcripts. If the model delegates the task to
 * the backend, the demo calls our `run()`, which prompts the bound DSH session,
 * waits for the agent, and speaks the agent's answer back.
 *
 *   node test/delegate-e2e.mjs <demoUrlWithToken> <task.wav>
 */
import fs from 'node:fs'
import { WebSocket } from 'ws'

const [demoUrl, wavPath] = process.argv.slice(2)
if (!demoUrl || !wavPath) {
  console.error('usage: node test/delegate-e2e.mjs http://127.0.0.1:17861/#<token> /tmp/task16.wav')
  process.exit(2)
}
const base = new URL(demoUrl)
const wsUrl = `ws://${base.host}/connect?token=${encodeURIComponent(base.hash.slice(1))}`

function parseWav(file) {
  const buf = fs.readFileSync(file)
  let offset = 12, fmt = null, data = null
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = buf.subarray(offset + 8, offset + 8 + size)
    if (id === 'fmt ') fmt = { rate: body.readUInt32LE(4), channels: body.readUInt16LE(2) }
    else if (id === 'data') data = body
    offset += 8 + size + (size % 2)
  }
  return { ...fmt, data }
}

const wav = parseWav(wavPath)
const frame = 640 // 20 ms @ 16 kHz mono
const sleep = ms => new Promise(r => setTimeout(r, ms))
const t0 = Date.now()
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a)

const ws = new WebSocket(wsUrl, { origin: `http://${base.host}` })
ws.binaryType = 'arraybuffer'
const pending = []
const audio = []
let reply = ''

ws.on('open', () => log('connected to demo relay'))
ws.on('error', err => log('ws error', err.message))
ws.on('close', (code, reason) => log('ws closed', code, reason?.toString()))

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    const ctx = pending.shift()
    audio.push(Buffer.from(data))
    if (ctx) {
      const ms = Math.round((data.byteLength / 2 / 48000) * 1000)
      setTimeout(() => ws.send(JSON.stringify({
        action: 'playback.chunk.completed', run_id: ctx.run_id, turn_id: ctx.turn_id, chunk_id: ctx.chunk_id,
      })), ms)
    }
    return
  }
  const event = JSON.parse(data.toString())
  const d = event.data || {}
  switch (event.action) {
    case 'session_attached':
      log('session attached')
      if (process.env.BROWSER_MODE === '1') {
        ws.send(JSON.stringify({ action: 'media.mode', binary_protocol: 'tagged-v1' }))
        ws.send(JSON.stringify({ action: 'session.update', session: { tools: [{
          type: 'function', name: 'get_local_time', description: 'Get the time on the customer device',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        }] } }))
      }
      ws.send(JSON.stringify({ action: 'mic_state', enabled: true }))
      void speak()
      break
    case 'input.transcript.done':
      log('ASR →', d.text)
      break
    case 'output.transcript.updated':
      reply = d.text
      break
    case 'output.transcript.done':
      reply = d.text
      log('模型 →', d.text)
      break
    case 'response.audio.context':
      pending.push(d)
      break
    case 'response.audio.done':
      setTimeout(() => {
        ws.send(JSON.stringify({ action: 'playback.completed', run_id: d.run_id, turn_id: d.turn_id }))
      }, 200)
      break
    case 'response.interrupted':
      log('interrupted', d.reason)
      break
    case 'error':
      log('server error', JSON.stringify(d))
      break
    default:
      if (event.action && !event.action.startsWith('pong')) log('event', event.action)
  }
})

function tagged(pcm) {
  if (process.env.BROWSER_MODE !== '1') return pcm
  const out = Buffer.alloc(pcm.length + 1)
  out[0] = 0
  pcm.copy(out, 1)
  return out
}

async function speak() {
  const frames = Math.ceil(wav.data.length / frame)
  log(`streaming ${(wav.data.length / 32000).toFixed(1)}s of speech`)
  for (let i = 0; i < frames; i++) {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(tagged(wav.data.subarray(i * frame, (i + 1) * frame)))
    await sleep(20)
  }
  log('speech ended; streaming silence')
  const silence = tagged(Buffer.alloc(frame))
  for (let i = 0; i < 600; i++) {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(silence)
    await sleep(20)
  }
}

setTimeout(() => {
  console.log('\n================ result ================')
  console.log('reply :', reply || '(none)')
  console.log('audio :', audio.length, 'chunks')
  console.log('=======================================')
  ws.close()
  process.exit(reply ? 0 : 1)
}, Number(process.env.E2E_WAIT_MS || 90000))
