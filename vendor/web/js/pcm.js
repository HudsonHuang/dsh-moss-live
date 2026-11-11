

export const MIC_RATE = 16000;
export const MIC_FRAME_MS = 20;


export class LowPassFIR {
  
  constructor(cutoff, taps = 48) {
    this.taps = taps;
    this.h = new Float32Array(taps);
    const c = (taps - 1) / 2;
    let sum = 0;
    for (let n = 0; n < taps; n++) {
      const x = n - c;
      const s = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (taps - 1));
      this.h[n] = s * w;
      sum += this.h[n];
    }
    for (let n = 0; n < taps; n++) this.h[n] /= sum; // unity gain at DC
    this.history = new Float32Array(taps - 1);
  }

  
  process(x) {
    const n = x.length;
    if (n === 0) return new Float32Array(0);
    const t = this.taps;
    const ext = new Float32Array(t - 1 + n);
    ext.set(this.history, 0);
    ext.set(x, t - 1);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let k = 0; k < t; k++) acc += this.h[k] * ext[i + t - 1 - k];
      out[i] = acc;
    }
    this.history = ext.slice(ext.length - (t - 1));
    return out;
  }
}


export class LinearResampler {
  constructor(inputRate, outputRate) {
    this.step = inputRate / outputRate;
    this.pos = 0;   // read position in the current block; -1 addresses `prev`
    this.prev = 0;  // last sample of the previous block
    this.primed = false;
  }

  
  process(x) {
    if (x.length === 0) return new Float32Array(0);
    const out = [];
    let pos = this.pos;
    const last = x.length - 1;
    while (pos < last) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i < 0 ? this.prev : x[i];
      const b = x[i + 1];
      out.push(a + (b - a) * frac);
      pos += this.step;
    }
    this.pos = pos - x.length;
    this.prev = x[last];
    this.primed = true;
    return Float32Array.from(out);
  }
}


export function floatToPCM16(x) {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = Math.max(-1, Math.min(1, x[i]));
    out[i] = Math.round(v < 0 ? v * 0x8000 : v * 0x7fff);
  }
  return out;
}


export function rms(x) {
  if (x.length === 0) return 0;
  let acc = 0;
  for (let i = 0; i < x.length; i++) acc += x[i] * x[i];
  return Math.sqrt(acc / x.length);
}


export class MicFramer {
  constructor({ inputRate, outputRate = MIC_RATE, frameMs = MIC_FRAME_MS } = {}) {
    if (!inputRate) throw new Error('MicFramer needs the capture rate');
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    this.frameSamples = Math.round((outputRate * frameMs) / 1000);
    this.fir = inputRate > outputRate ? new LowPassFIR((0.45 * outputRate) / inputRate) : null;
    this.resampler = inputRate === outputRate ? null : new LinearResampler(inputRate, outputRate);
    this.tail = new Float32Array(0);
  }

  
  push(block) {
    let x = block;
    if (this.fir) x = this.fir.process(x);
    if (this.resampler) x = this.resampler.process(x);
    if (x.length === 0 && this.tail.length < this.frameSamples) return [];
    const merged = new Float32Array(this.tail.length + x.length);
    merged.set(this.tail, 0);
    merged.set(x, this.tail.length);
    const frames = [];
    let off = 0;
    while (merged.length - off >= this.frameSamples) {
      frames.push(floatToPCM16(merged.subarray(off, off + this.frameSamples)).buffer);
      off += this.frameSamples;
    }
    this.tail = merged.slice(off);
    return frames;
  }

  
  silentFrame() {
    return new Int16Array(this.frameSamples).buffer;
  }
}


export function pcm16ToFloat(bytes) {
  const view = new DataView(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
  const n = Math.floor(view.byteLength / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}
