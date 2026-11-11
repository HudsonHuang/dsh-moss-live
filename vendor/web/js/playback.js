// Tracks queued and played PCM chunks using the public playback receipts.

export const SPEAKER_RATE = 48000;


export function chunkDurationMS(byteLength, rate = SPEAKER_RATE) {
  return ((byteLength / 2) / rate) * 1000;
}






class Scope {
  constructor() {
    this.turnId = '';
    this.finished = false;
    this.drained = false;
    this.stopped = false;
    this.outstanding = 0;
    this.playedMS = 0;
  }
}

export class PlaybackLedger {
  
  constructor() {
    
    this.pending = [];
    
    this.queue = [];
    
    this.inFlight = new Map();
    
    this.scopes = new Map();
    this.seq = 0;
  }

  scopeFor(runId, turnId) {
    let s = this.scopes.get(runId);
    if (!s) {
      s = new Scope();
      this.scopes.set(runId, s);
    }
    if (turnId) s.turnId = turnId;
    return s;
  }

  
  onStart(runId, turnId) {
    const s = this.scopeFor(runId, turnId);
    s.finished = false;
    s.drained = false;
    s.stopped = false;
    s.playedMS = 0;
  }

  
  onContext(ref) {
    if (!ref.chunkId || !ref.runId || !ref.turnId) throw Error("Audio context requires correlation identifiers");
    this.pending.push({ chunkId: ref.chunkId || '', runId: ref.runId || '', turnId: ref.turnId || '' });
  }

  
  onAudio(byteLength, payload = null) {
    if (!this.pending.length) throw Error("Audio received without context");
    const ref = this.pending.shift();
    if (ref.runId) this.scopeFor(ref.runId, ref.turnId).outstanding++;
    const chunk = { seq: ++this.seq, ref, bytes: byteLength, durationMS: chunkDurationMS(byteLength), payload };
    this.queue.push(chunk);
    return chunk;
  }

  
  takeNext() {
    const chunk = this.queue.shift();
    if (!chunk) return null;
    this.inFlight.set(chunk.seq, chunk);
    return chunk;
  }

  
  played(chunk) {
    this.inFlight.delete(chunk.seq);
    const msgs = [this.ackChunk(chunk.ref)];
    if (!chunk.ref.runId) return msgs;
    const s = this.scopeFor(chunk.ref.runId, chunk.ref.turnId);
    if (s.outstanding > 0) s.outstanding--;
    return msgs.concat(this.maybeDrain(chunk.ref.runId, s));
  }

  
  onFinished(runId, turnId) {
    const s = this.scopeFor(runId, turnId);
    s.finished = true;
    return this.maybeDrain(runId, s);
  }

  
  cancelInFlight(runId, partialMS = 0) {
    const dropped = [];
    for (const [seq, chunk] of this.inFlight) {
      if (chunk.ref.runId !== runId) continue;
      this.inFlight.delete(seq);
      dropped.push(chunk);
    }
    if (partialMS > 0) this.scopeFor(runId, '').playedMS += partialMS;
    return dropped;
  }

  
  onStop(runId, turnId, reason) {
    const dropped = [];
    this.queue = this.queue.filter((c) => {
      if (c.ref.runId !== runId) return true;
      dropped.push(c);
      return false;
    });
    const s = this.scopeFor(runId, turnId);
    s.outstanding = 0;
    s.finished = true;
    s.stopped = true;
    s.drained = true;
    const played = s.playedMS;
    s.playedMS = 0;
    return {
      messages: [{
        action: 'playback.stopped',
        reason,
        run_id: runId,
        turn_id: s.turnId,
        played_audio_ms: played,
      }],
      dropped,
    };
  }

  
  idle() {
    return this.queue.length === 0 && this.inFlight.size === 0;
  }

  
  outstandingMS() {
    let ms = 0;
    for (const c of this.queue) ms += c.durationMS;
    for (const c of this.inFlight.values()) ms += c.durationMS;
    return ms;
  }

  maybeDrain(runId, s) {
    if (!s.finished || s.drained || s.stopped || s.outstanding > 0) return [];
    s.drained = true;
    return [this.ackDrained(runId, s.turnId)];
  }

  
  ackChunk(ref) {
    return { action: 'playback.chunk.completed', chunk_id: ref.chunkId, run_id: ref.runId, turn_id: ref.turnId };
  }

  ackDrained(runId, turnId) {
    return { action: 'playback.completed', run_id: runId, turn_id: turnId };
  }
}
