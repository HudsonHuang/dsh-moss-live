import {MicFramer, MIC_FRAME_MS, rms} from './pcm.js';

// Captures one mono stream and converts it to the public 16 kHz PCM format.
export class Microphone {
  static async open(opts) {
    // Wrapper change: when embedded in the harness, the parent page owns the
    // microphone permission (the iframe origin is denied by the shell) and
    // injects its stream here.
    const injected = typeof window !== 'undefined' ? window.__dshMicStream : null;
    if (injected && injected.getAudioTracks().some(track => track.readyState === 'live')) {
      const mic = new Microphone(injected, opts);
      mic.injected = true;
      return mic;
    }
    const stream = await navigator.mediaDevices.getUserMedia({audio: {
      echoCancellation: true, noiseSuppression: opts.noiseSuppression === true,
      autoGainControl: opts.autoGainControl !== false, channelCount: 1,
      ...(opts.deviceId ? {deviceId: {exact: opts.deviceId}} : {}),
    }, video: false});
    return new Microphone(stream, opts);
  }
  constructor(stream, {ctx, onFrame, onLevel = () => {}}) {
    Object.assign(this, {stream, ctx, onFrame, onLevel});
    this.framer = new MicFramer({inputRate: ctx.sampleRate});
    this.nextInputFrame = null; this.closed = false; this.muted = false;
  }
  async start() {
    await this.ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
    if (this.closed) return;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'mic-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1,
      processorOptions: {blockSamples: Math.round(this.ctx.sampleRate * MIC_FRAME_MS / 1000)},
    });
    this.node.port.onmessage = ev => this.onBlock(ev.data);
    this.sink = this.ctx.createGain(); this.sink.gain.value = 0;
    this.source.connect(this.node); this.node.connect(this.sink); this.sink.connect(this.ctx.destination);
  }
  onBlock(block) {
    if (this.closed) return;
    const samples = block.samples;
    if (Number.isSafeInteger(block.startFrame)) {
      if (this.nextInputFrame !== null && block.startFrame !== this.nextInputFrame)
        this.framer = new MicFramer({inputRate: this.ctx.sampleRate});
      this.nextInputFrame = block.startFrame + samples.length;
    }
    this.onLevel(Math.min(1, rms(samples) * 4));
    for (const frame of this.framer.push(samples))
      this.onFrame(this.muted ? this.framer.silentFrame() : frame);
  }
  setMuted(value) { this.muted = value; }
  close() {
    this.closed = true;
    if (this.node) this.node.port.onmessage = null;
    for (const node of [this.source, this.node, this.sink]) {try {node?.disconnect();} catch {}}
    if (!this.injected) for (const track of this.stream.getTracks()) track.stop();
  }
}
