import {createOrbRenderer} from '../product/orb-renderer.js';
export class TranscriptTimeline {
  constructor() { this.rows = []; this.pending = null; this.caption = ''; }
  accept({action, data: d = {}}) {
    const input = action.startsWith('input.transcript.');
    if (!input && !action.startsWith('output.transcript.')) return false;
    if (typeof d.text !== 'string') return false;
    const revised = action === 'input.transcript.revised';
    const key = input ? (d.turn == null ? null : `user:${d.turn}`) : `assistant:${d.run_id ?? d.turn_id ?? 'current'}`;
    let row = key == null ? null : this.rows.find(r => r.key === key);
    if (!row && input && !revised) row = this.pending;
    if (!row) {
      row = {key, role: input ? 'user' : 'assistant', text: ''};
      this.rows.push(row);
      if (this.rows.length > 512) this.rows.shift();
    }
    if (key != null) row.key = key;
    row.text = d.text; // updated.text is a complete snapshot, never a delta.
    if (input && !revised) this.pending = action.endsWith('.updated') ? row : null;
    if (!input) this.caption = d.text;
    return true;
  }
}

export class TaskStatusList {
  constructor() { this.tasks = new Map(); }
  accept({id,status,title}) {
    if(typeof id !== 'string' || !id || !['queued','running','progress','returning','completed','failed','cancelled'].includes(status))return false;
    const previous=this.tasks.get(id);
    if(previous && ['completed','failed','cancelled','interrupted'].includes(previous.status))return false;
    const label=typeof title==='string' ? Array.from(title.trim()).slice(0,41).join('') : '';
    this.tasks.set(id,{id,status,title:previous?.title || label || '后台任务'});
    return true;
  }
  disconnect() {
    for(const task of this.tasks.values())if(['queued','running','progress','returning'].includes(task.status))task.status='interrupted';
  }
}

export class SessionHistory {
  constructor(storage) {
    this.storage = storage; this.entries = []; this.error = false;
    try {
      const data = JSON.parse(storage?.getItem('mosslive.sessionHistory.v1') || '[]');
      if (!Array.isArray(data)) throw Error('Invalid history');
      this.entries = data.filter(e => e && typeof e.id === 'string' && Number.isFinite(e.createdAt) && Array.isArray(e.rows)).slice(0, 50).map(e => ({
        id: e.id, createdAt: e.createdAt, rows: e.rows.filter(r => r && ['user','assistant'].includes(r.role) && typeof r.text === 'string').slice(-512).map(r => ({role:r.role, text:r.text})),
      }));
    } catch { this.error = true; }
  }
  save(id, rows, createdAt = Date.now()) {
    if (!id) return;
    const previous = this.entries.find(e => e.id === id);
    const entry = {id, createdAt:previous?.createdAt ?? createdAt, rows:rows.map(r => ({role:r.role, text:r.text}))};
    this.entries = [entry, ...this.entries.filter(e => e.id !== id)].sort((a,b) => b.createdAt-a.createdAt).slice(0,50);
    try {
      if (!this.storage) throw Error('Storage unavailable');
      this.storage.setItem('mosslive.sessionHistory.v1', JSON.stringify(this.entries)); this.error = false;
    } catch { this.error = true; }
  }
}

export function createProductView(doc = document) {
  if (!doc.querySelector('#orb-canvas')) return null;
  const $ = id => doc.querySelector('#' + id);
  const orb = $('orb'), status = $('status'), hint = $('stream-status');
  const start = $('start'), stop = $('stop'), mute = $('btn-mute');
  const list = $('transcript'), panel = $('transcript-wrap');
  let timeline = new TranscriptTimeline(), rendered = new Map(), taskList = new TaskStatusList();
  function renderTasks() {
    const rows=[...taskList.tasks.values()], active=rows.filter(t=>['queued','running','progress','returning'].includes(t.status));
    $('task-panel').hidden = !rows.length;
    $('task-summary').textContent = active.length ? `${active.length} 个任务处理中` : '后台任务';
    const list=$('task-list');list.replaceChildren();
    const labels={queued:'排队中',running:'执行中',progress:'执行中 · 已有新进展',returning:'正在回传结果',completed:'已完成',failed:'执行失败',cancelled:'已取消',interrupted:'连接已断开，状态未确认'};
    for(const task of [...active,...rows.filter(t=>!active.includes(t)).slice(-3).reverse()]) {
      const item=doc.createElement('li');item.className='task-row';item.dataset.status=task.status;
      const title=doc.createElement('span');title.className='task-title';title.textContent=task.title;title.title=task.title;
      const state=doc.createElement('span');state.className='task-state';state.textContent=labels[task.status];
      item.append(title,state);list.append(item);
    }
  }
  let storage; try { storage = localStorage; } catch {}
  const archive = new SessionHistory(storage);
  let sessionId = null, sessionCreatedAt = 0, saveTimer, selectedHistoryId = null;
  function saveHistory() {
    clearTimeout(saveTimer);
    if (sessionId) archive.save(sessionId, timeline.rows, sessionCreatedAt);
    if (!$('drawer-history').inert) renderHistory();
  }
  function renderHistory() {
    const sessions = $('history-list'), messages = $('history-messages');
    sessions.replaceChildren(); messages.replaceChildren();
    $('history-notice').hidden = !archive.error;
    $('history-notice').textContent = archive.error ? '浏览器存储不可用或已满，新增记录仅保留在当前页面。' : '';
    const entries = archive.entries;
    let selected = entries.find(e => e.id === selectedHistoryId) || entries[0];
    selectedHistoryId = selected?.id ?? null;
    $('history-empty').hidden = entries.length > 0;
    $('history-detail').hidden = entries.length === 0;
    for (const entry of entries) {
      const title = entry.rows.find(r => r.role === 'user' && r.text.trim())?.text || '新会话';
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'history-item';
      button.setAttribute('aria-pressed', String(entry.id === selectedHistoryId));
      const label = doc.createElement('span'); label.className = 'history-item-title'; label.textContent = title.slice(0,48);
      const date = doc.createElement('span'); date.className = 'history-date'; date.textContent = new Date(entry.createdAt).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) + (entry.id === sessionId ? ' · 当前页面会话' : '');
      button.append(label,date); button.onclick = () => { selectedHistoryId = entry.id; renderHistory(); sessions.querySelector('[aria-pressed="true"]')?.focus(); };
      sessions.append(button);
    }
    if (selected) {
      $('history-detail-title').textContent = selected.rows.find(r => r.role === 'user' && r.text.trim())?.text.slice(0,60) || '新会话';
      $('history-detail-date').textContent = new Date(selected.createdAt).toLocaleString('zh-CN');
      if (!selected.rows.length) { const empty = doc.createElement('p'); empty.className = 'history-empty'; empty.textContent = '这个会话还没有对话文字。'; messages.append(empty); }
      for (const row of selected.rows) {
        const item = doc.createElement('div'); item.className = 'history-message';
        const who = doc.createElement('span'); who.className = 'history-role'; who.textContent = row.role === 'user' ? '你' : 'MOSS';
        const text = doc.createElement('p'); text.textContent = row.text; item.append(who,text); messages.append(item);
      }
    }
  }
  let connected = false, muted = false, level = 0, speaking = false, frame;
  const renderer = createOrbRenderer($('orb-canvas'));
  const toggleTranscript = (show = panel.hidden) => {
    panel.hidden = !show;
    doc.querySelector('.stage').classList.toggle('transcript-expanded', show);
    orb.setAttribute('aria-expanded', String(show));
    if (show) $('btn-close-transcript').focus(); else orb.focus();
  };
  $('btn-close-transcript').onclick = () => toggleTranscript(false);
  orb.onclick = () => toggleTranscript();
  orb.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTranscript(); } };
  const drawer = $('drawer-dev'), historyDrawer = $('drawer-history'), scrim = $('drawer-scrim');
  let openDrawer = null, drawerTrigger = null;
  function closeDrawer() {
    if (!openDrawer) return;
    openDrawer.inert = true; openDrawer.setAttribute('aria-hidden','true'); openDrawer.classList.remove('is-open');
    scrim.hidden = true; scrim.classList.remove('is-visible');
    openDrawer = null; drawerTrigger?.focus();
  }
  function showDrawer(target, trigger, closeButton) {
    closeDrawer(); openDrawer = target; drawerTrigger = trigger;
    target.inert = false; target.setAttribute('aria-hidden','false'); target.classList.add('is-open');
    scrim.hidden = false; scrim.classList.add('is-visible'); closeButton.focus();
  }
  $('btn-dev').onclick = () => showDrawer(drawer, $('btn-dev'), $('btn-close-dev'));
  $('btn-history').onclick = () => { saveHistory(); renderHistory(); showDrawer(historyDrawer, $('btn-history'), $('btn-close-history')); };
  $('btn-close-dev').onclick = $('btn-close-history').onclick = scrim.onclick = closeDrawer;
  doc.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (openDrawer) closeDrawer(); else if (!panel.hidden) toggleTranscript(false); }
    if (e.key === 'Tab' && openDrawer) {
      const controls = [...openDrawer.querySelectorAll('button, summary')].filter(el => el.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('pagehide', saveHistory);
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') saveHistory(); });
  const skins = [['moss','青岚','薄荷轻雾'], ['azure','晴空','蓝白浮云'], ['ember','晨曦','暖杏柔光'], ['aurora','暮霭','淡紫云纱']];
  const buttons = [];
  function select(name) {
    orb.dataset.planet = name;
    for (const button of buttons) {
      const selected = button.dataset.planetOption === name;
      button.classList.toggle('is-selected', selected); button.setAttribute('aria-pressed', String(selected));
    }
    try { localStorage.setItem('mosslive.voiceAppearance', name); } catch {  }
  }
  for (const [name, label, description] of skins) {
    const button = doc.createElement('button'); button.type = 'button';
    button.className = 'planet-option skin-card'; button.dataset.planetOption = name;
    button.setAttribute('aria-label', `${label} · ${description}`);
    for (const [cls, text] of [['skin-preview',''], ['skin-title',label], ['skin-description',description]]) {
      const span = doc.createElement('span'); span.className = cls; span.textContent = text; span.dataset.planet = name; button.append(span);
    }
    button.onclick = () => select(name); buttons.push(button); $('planet-bar').append(button);
  }
  let saved; try { saved = localStorage.getItem('mosslive.voiceAppearance'); } catch {  }
  select(skins.some(([name]) => name === saved) ? saved : 'moss');
  function animate(now) {
    const state = !connected ? 'idle' : speaking ? 'speaking' : muted ? 'idle' : 'listening';
    orb.dataset.state = connected ? state : 'disconnected';
    renderer.update(connected ? level : 0, state, orb.dataset.planet, now);
    frame = requestAnimationFrame(animate);
  }
  frame = requestAnimationFrame(animate);
  window.addEventListener('pagehide', () => { cancelAnimationFrame(frame); renderer.dispose(); }, {once:true});
  return {
    state(next, message) {
      if (next === 'offline' || next === 'error') { saveHistory(); taskList.disconnect(); renderTasks(); }
      connected = next === 'connected';
      doc.body.dataset.call = next === 'offline' || next === 'error' ? 'offline' : 'live';
      $('conn-dot').classList.toggle('is-live', connected);
      $('conn-dot').classList.toggle('is-reconnecting', next === 'connecting');
      $('btn-new-session').disabled = next === 'connecting';
      start.hidden = connected; start.disabled = next === 'connecting';
      stop.disabled = next === 'offline' || next === 'error'; mute.disabled = !connected;
      if (!connected) { muted = false; speaking = false; level = 0; }
      status.textContent = message || ({offline:'准备就绪', connecting:'正在连接', connected:'已连接', error:'连接未完成'}[next]);
      hint.textContent = connected ? '我在听，你可以随时说话' : next === 'connecting' ? '正在准备对话…' : next === 'error' ? (message || '请检查连接或麦克风权限后重试') : '今天想聊些什么？';
      mute.setAttribute('aria-pressed', 'false');
    },
    waitingForMicrophone() { status.textContent = "等待麦克风授权"; hint.textContent = "请在浏览器中允许使用麦克风"; },
    task(message) { if(taskList.accept(message)) renderTasks(); },
    reset() { taskList = new TaskStatusList(); renderTasks(); saveHistory(); sessionId = null; closeDrawer(); panel.hidden = true; doc.querySelector('.stage').classList.remove('transcript-expanded'); orb.setAttribute('aria-expanded', 'false'); timeline = new TranscriptTimeline(); rendered = new Map(); list.replaceChildren(); $('live-caption').textContent = ''; $('transcript-empty').hidden = false; },
    muted(value) {
      muted = value; mute.setAttribute('aria-pressed', String(value));
      mute.title = value ? '打开麦克风' : '关闭麦克风'; mute.setAttribute('aria-label', mute.title);
      status.textContent = value ? '麦克风已静音' : '已连接';
      hint.textContent = value ? '麦克风已静音，仍可收听回复' : '我在听，你可以随时说话';
    },
    level(value) { if (!speaking) level = muted ? 0 : value; },
    playback(speaker, time) {
      const live = speaker.live.find(item => item.start <= time && item.end > time);
      speaking = !!live;
      if (live) {
        const samples = live.src.buffer.getChannelData(0), offset = Math.floor((time-live.start)*48000);
        const end = Math.min(samples.length, offset+256); let energy = 0;
        for (let i=offset;i<end;i++) energy += samples[i]*samples[i];
        level = Math.min(1, Math.sqrt(energy/Math.max(1,end-offset))*4);
      }
    },
    message(message) {
      if (message.action === 'session_attached') {
        sessionId = message.data?.session_id; sessionCreatedAt = Date.now(); saveHistory(); return;
      }
      if (!timeline.accept(message)) return;
      clearTimeout(saveTimer);
      if (message.action.endsWith('.done') || message.action.endsWith('.revised')) saveHistory();
      else saveTimer = setTimeout(saveHistory, 300);
      const follow = panel.scrollHeight-panel.scrollTop-panel.clientHeight < 64;
      for (const row of timeline.rows) {
        let el = rendered.get(row);
        if (!el) { el = doc.createElement('div'); el.className = 'message message-'+row.role; rendered.set(row,el); list.append(el); }
        el.textContent = row.text;
      }
      for (const [row, el] of rendered) { if (!timeline.rows.includes(row)) { el.remove(); rendered.delete(row); } }
      if (message.action.startsWith('output.transcript.')) {
        const caption = $('live-caption');
        caption.textContent = timeline.caption;
        caption.scrollTop = caption.scrollHeight;
      }
      $('transcript-empty').hidden = timeline.rows.length > 0;
      if (follow) panel.scrollTop = panel.scrollHeight;
    },
  };
}
