import {createProductView} from './product-view.js';
import {PublicSession} from './public-session.js';
import {Speaker} from './speaker.js';
import {Microphone} from './mic.js';

const status = document.querySelector('#status');
const transcript = document.querySelector('#transcript');
if (new URLSearchParams(location.search).has('embed')) document.documentElement.classList.add('embed');

const startButton = document.querySelector('#start');
let token = location.hash.slice(1);
try {
  if (token) sessionStorage.setItem('mosslive.connectionToken', token);
  else token = sessionStorage.getItem('mosslive.connectionToken') || '';
} catch {}
// Wrapper change: keep the query string — it carries ?embed and ?relay, which
// the in-harness panel relies on after the token has been moved to storage.
history.replaceState(null, '', location.pathname + location.search);
let socket, mic, ctx, timer, session;
let epoch = 0;
const view = typeof createProductView === 'function' ? createProductView() : null;
view?.state('offline');
let muted = false;
const muteButton = document.querySelector('#btn-mute');
if (muteButton) muteButton.onclick = () => {
  if (!mic || !socket || socket.readyState !== WebSocket.OPEN) return;
  muted = !muted; mic.setMuted(muted);
  socket.send(JSON.stringify({action: 'mic_state', enabled: !muted}));
  view?.muted(muted);
};

function stop() {
  ++epoch;
  mic?.close();
  mic = null;
  session?.close();
  clearInterval(timer);
  const oldSocket = socket; socket = null;
  const closed = new Promise(resolve => {
    if (!oldSocket || oldSocket.readyState === WebSocket.CLOSED) return resolve();
    const timeout = setTimeout(resolve, 5000);
    oldSocket.addEventListener('close', () => { clearTimeout(timeout); resolve(); }, {once: true});
    if (oldSocket.readyState < WebSocket.CLOSING) oldSocket.close();
  });
  if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {});
  startButton.disabled = false;
  muted = false;
  return closed;
}
document.querySelector('#stop').onclick = () => {
  status.textContent = 'Disconnected; task cancellation requested';
  stop();
  view?.state('offline', '对话已结束');
};

async function startConversation() {
  const current = ++epoch;
  try {
    startButton.disabled = true;
    view?.reset(); view?.state('connecting');
    ctx = new AudioContext({sampleRate: 48000});
    await ctx.resume();
    if (current !== epoch) return;
    // Wrapper change: when the page is served by the harness, the relay lives
    // on another port; ?relay=ws://127.0.0.1:17861 points at it.
    const relay = new URLSearchParams(location.search).get('relay');
    const ws = new WebSocket(`${relay || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`}/connect?token=${encodeURIComponent(token)}`);
    socket = ws;
    ws.binaryType = 'arraybuffer';
    const send = message => {
      if (current === epoch && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    session = new PublicSession(send);
    session.speaker = new Speaker({ctx, ledger: session.ledger, onMessages: messages => session.messages(messages)});
    timer = setInterval(() => { session.speaker.tick(ctx.currentTime); view?.playback(session.speaker, ctx.currentTime); }, 10);
    ws.onmessage = async event => {
      if (current !== epoch) return;
      try {
        if (typeof event.data !== 'string') {
          session.audio(event.data);
          return;
        }
        const message = JSON.parse(event.data);
        if (message.type === 'demo.task') { view?.task(message); return; }
        session.text(message);
        view?.message(message);
        if (message.action === 'session_attached') {
          send({action: 'media.mode', binary_protocol: 'tagged-v1'});
          send({action: 'session.update', session: {tools: [{
            type: 'function', name: 'get_local_time', description: 'Get the time on the customer device',
            parameters: {type: 'object', properties: {}, additionalProperties: false},
          }]}});
        }
        if (message.action === 'session.updated') {
          if (message.data.error) throw Error(message.data.error);
          if (!mic) {
            view?.waitingForMicrophone();
            const opened = await Microphone.open({ctx, onLevel: level => { if (current === epoch) view?.level(level); }, onFrame: frame => {
              if (current === epoch && ws.readyState === WebSocket.OPEN) {
                const pcm = new Uint8Array(frame);
                const tagged = new Uint8Array(pcm.length + 1);
                tagged.set(pcm, 1); // tagged-v1 PCM tag is zero.
                ws.send(tagged);
              }
            }});
            if (current !== epoch) { opened.close(); return; }
            mic = opened;
            await mic.start();
            if (current !== epoch) return;
            send({action: 'mic_state', enabled: true});
            status.textContent = 'Connected — microphone active';
            view?.state('connected');
          }
        }
        if (message.action === 'error') status.textContent = 'Request error: ' + message.data?.error?.code;
        if (!view) transcript.textContent = [session.transcript, ...session.inputs.values(), ...session.outputs.values()].join('\n');
      } catch (error) {
        if (current === epoch) {
          status.textContent = error.message;
          // Wrapper change: report the real failure so the host log shows why
          // the call page dropped instead of only a generic hint.
          try {
            const base = new URLSearchParams(location.search).get('relay');
            if (base) fetch(`${base.replace(/^ws/, 'http')}/report?m=${encodeURIComponent(error.message || error)}`, { mode: 'no-cors' });
          } catch {}
          stop();
          view?.state('error', error.message || String(error));
        }
      }
    };
    ws.onerror = () => {
      if (current === epoch) {
        status.textContent = 'Connection failed';
        try {
          const base = new URLSearchParams(location.search).get('relay');
          if (base) fetch(`${base.replace(/^ws/, 'http')}/report?m=${encodeURIComponent('websocket error')}`, { mode: 'no-cors' });
        } catch {}
        stop();
        view?.state('error', '连接中继失败（WebSocket error）');
      }
    };
    ws.onclose = () => {
      if (current === epoch) { status.textContent = 'Disconnected; task cancellation requested'; stop(); view?.state('offline', '连接已断开'); }
    };
  } catch (error) {
    if (current === epoch) { status.textContent = error.message; stop(); view?.state('error'); }
  }
}

startButton.onclick = startConversation;
document.querySelector('#btn-new-session').onclick = async () => {
  const closed = stop();
  const current = epoch;
  view?.reset(); view?.state('connecting', '正在新建会话');
  await closed;
  if (current === epoch) await startConversation();
};
