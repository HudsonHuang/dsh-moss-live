#!/usr/bin/env node
/**
 * Barge-in check through the bundled MOSS demo relay.
 *
 * Speaks one request, waits for the model to start talking, then speaks again
 * while it is still talking. Passes when the server stops the reply
 * (response.audio.stop / response.interrupted) and the follow-up is answered.
 *
 *   node test/barge-e2e.mjs <demoUrl> <first.wav> <barge.wav>
 */
import fs from 'node:fs'
import { WebSocket } from 'ws'

const [demoUrl, firstWav, bargeWav] = process.argv.slice(2)
if (!demoUrl || !firstWav || !bargeWav) {
  console.error('usage: node test/barge-e2e.mjs <demoUrl> <first.wav> <barge.wav>')
  process.exit(2)
}
const base = new URL(demoUrl)
const wsUrl = `ws://${base.host}/connect?token=${encodeURIComponent(base.hash.slice(1))}`

function parseWav(file) {
  const buf = fs.readFileSync(file)
  let offset = 12, data = null
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'data') data = buf.subarray(offset + 8, offset + 8 + size)
    offset += 8 + size + (size % 2)
  }
  return data
}

const first = parseWav(firstWav)
const barge = parseWav(bargeWav)
const FRAME = 640
const sleep = ms => new Promise(r => setTimeout(r, ms))
const t0 = Date.now()
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a)

const ws = new WebSocket(wsUrl, { origin: `http://${base.host}` })
ws.binaryType = 'arraybuffer'
const pending = []
const state = { speaking: false, bargeSent: false, stop: null, interrupted: null, replies: [], bargedAt: 0 }

ws.on('open', () => log('connected'))
ws.on('error', err => log('ws error', err.message))
ws.on('close', (code, reason) => log('ws closed', code, reason?.toString()))

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    state.bin = (state.bin || 0) + 1
    if (state.bin === 1) log('first binary chunk', data.byteLength)
    const ctx = pending.shift()
    if (!state.bargeSent) {
      log('model started talking; will barge in shortly')
      void bargeInSoon()
    }
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
      ws.send(JSON.stringify({ action: 'mic_state', enabled: true }))
      void stream(first, 'first')
      break
    case 'input.transcript.done':
      log('ASR →', d.text)
      break
    case 'output.transcript.done':
      log('模型 →', d.text)
      state.replies.push(d.text)
      break
    case 'response.audio.context':
      pending.push(d)
      break
    case 'response.audio.started':
      state.speaking = true
      break
    case 'response.audio.stop':
      state.stop = d
      log('response.audio.stop', d.reason || '')
      break
    case 'response.interrupted':
      state.interrupted = d
      log('response.interrupted', d.reason || '')
      break
    case 'response.ended':
      state.speaking = false
      break
    case 'error':
      log('server error', JSON.stringify(d))
      break
    default:
      if (event.action) log('·', event.action)
  }
})

async function stream(pcm, label) {
  const frames = Math.ceil(pcm.length / FRAME)
  log(`streaming ${label} (${(pcm.length / 32000).toFixed(1)}s)`)
  for (let i = 0; i < frames; i++) {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(pcm.subarray(i * FRAME, (i + 1) * FRAME))
    await sleep(20)
  }
  const silence = Buffer.alloc(FRAME)
  for (let i = 0; i < 400; i++) {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(silence)
    await sleep(20)
  }
}

async function bargeInSoon() {
  if (state.bargeSent) return
  state.bargeSent = true
  await sleep(1200) // let a little of the reply actually play
  state.bargedAt = Date.now()
  log('user talks over the model (barge-in)')
  await stream(barge, 'barge')
}

setTimeout(() => {
  console.log('\n================ result ================')
  console.log('audio.stop        :', state.stop ? state.stop.reason || 'yes' : 'NO')
  console.log('interrupted       :', state.interrupted ? state.interrupted.reason || 'yes' : 'NO')
  console.log('replies           :', state.replies.length)
  state.replies.forEach((r, i) => console.log(`  [${i}]`, r.slice(0, 90)))
  console.log('=======================================')
  const ok = Boolean(state.stop || state.interrupted) && state.replies.length >= 2
  ws.close()
  process.exit(ok ? 0 : 1)
}, Number(process.env.BARGE_WAIT_MS || 75000))
