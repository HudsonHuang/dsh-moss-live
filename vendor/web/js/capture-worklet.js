// Collect fixed-duration microphone blocks on the browser audio thread.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(); this.blockSamples = options?.processorOptions?.blockSamples || 512;
    this.buf = new Float32Array(this.blockSamples); this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) { this.n = 0; return true; }
    for (let i = 0; i < ch.length; i++) {
      if (this.n === 0) this.startFrame = currentFrame + i;
      this.buf[this.n++] = ch[i];
      if (this.n === this.blockSamples) {
        const samples = this.buf.slice();
        this.port.postMessage({samples, startFrame: this.startFrame}, [samples.buffer]); this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('mic-capture', CaptureProcessor);
