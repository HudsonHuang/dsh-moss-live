// Schedules output PCM and acknowledges actual playback using the audio clock.

import { pcm16ToFloat, } from './pcm.js';
import { SPEAKER_RATE } from './playback.js';


const LEAD_SECONDS = 0.08;


export class Speaker {
  
  constructor({ ctx, ledger, destination = null, onMessages }) {
    this.ctx = ctx;
    this.ledger = ledger;
    this.node = destination || ctx.destination;
    this.gainNode = ctx.createGain();
    this.gainNode.connect(this.node);
    this.onMessages = onMessages;
    
    this.live = [];
    this.nextStart = 0;
    this.gaps = 0;
  }

  
  schedule() {
    const now = this.ctx.currentTime;
    if (this.nextStart < now + LEAD_SECONDS) {
      if (this.live.length > 0 || this.nextStart > 0) this.gaps++;
      this.nextStart = now + LEAD_SECONDS;
    }
    for (;;) {
      const chunk = this.ledger.takeNext();
      if (!chunk) break;
      const samples = chunk.payload instanceof Float32Array ? chunk.payload : pcm16ToFloat(chunk.payload);
      const buf = this.ctx.createBuffer(1, Math.max(1, samples.length), SPEAKER_RATE);
      buf.getChannelData(0).set(samples);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gainNode);
      const start = this.nextStart;
      const end = start + chunk.durationMS / 1000;
      src.start(start);
      src.onended = () => this.tick();
      this.live.push({ chunk, src, start, end });
      this.nextStart = end;
    }
  }

  
  tick(now = this.ctx.currentTime) {
    for (const rec of this.live) {
      if (rec.start > now) break;
      if (!rec.onsetReported) {
        rec.onsetReported = true;
        this.onPlayback?.(rec.chunk.ref, rec.start);
      }
    }
    const msgs = [];
    while (this.live.length > 0 && this.live[0].end <= now) {
      const rec = this.live.shift();
      const played = this.ledger.played(rec.chunk);
      msgs.push(...played);
    }
    if (msgs.length > 0) this.onMessages(msgs);
    return msgs;
  }

  
  stopScope(runId) {
    const now = this.ctx.currentTime;
    this.tick(now);
    let partialMS = 0;
    let cancelled = 0;
    const keep = [];
    for (const rec of this.live) {
      if (rec.chunk.ref.runId !== runId) {
        keep.push(rec);
        continue;
      }
      if (rec.start <= now && now < rec.end) partialMS += (now - rec.start) * 1000;
      rec.src.onended = null;
      try {
        rec.src.stop();
      } catch {
        
      }
      cancelled++;
    }
    this.live = keep;
    this.nextStart = keep.length > 0 ? Math.max(now, keep[keep.length - 1].end) : now;
    this.ledger.cancelInFlight(runId, partialMS);
    return { partialMS, cancelled };
  }

  
  reset() {
    for (const rec of this.live) {
      rec.src.onended = null;
      try {
        rec.src.stop();
      } catch {
        
      }
    }
    this.live = [];
    this.nextStart = 0;
    const gain = this.gainNode.gain;
    gain.cancelScheduledValues?.(this.ctx.currentTime);
    if (gain.setValueAtTime) gain.setValueAtTime(1, this.ctx.currentTime);
    else gain.value = 1;
  }

  
  metrics() {
    return { scheduled_ms: this.scheduledMS(), gaps: this.gaps };
  }

  
  scheduledMS(now = this.ctx.currentTime) {
    let ms = 0;
    for (const rec of this.live) ms += Math.max(0, rec.end - Math.max(now, rec.start)) * 1000;
    return ms;
  }
}
