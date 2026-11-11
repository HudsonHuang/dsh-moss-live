import {PlaybackLedger} from './playback.js';

export class PublicSession {
  constructor(send) {
    this.send = send;
    this.ledger = new PlaybackLedger();
    this.speaker = null;
    this.contexts = [];
    this.stopped = new Set();
    this.inputs = new Map();
    this.outputs = new Map();
    this.calls = new Map();
    this.transcript = '';
  }

  messages(messages) {
    for (const message of messages) this.send(message);
  }

  text({action, data: d = {}}) {
    switch (action) {
      case 'response.audio.started':
        if (!this.stopped.has(d.run_id)) this.ledger.onStart(d.run_id, d.turn_id);
        break;
      case 'response.audio.context':
        this.contexts.push(d);
        if (this.contexts.length > 256) throw Error('audio context queue full');
        break;
      case 'response.audio.done':
        if (!this.stopped.has(d.run_id)) this.messages(this.ledger.onFinished(d.run_id, d.turn_id));
        break;
      case 'response.audio.stop':
        this.stopped.add(d.run_id);
        this.speaker?.stopScope(d.run_id);
        this.messages(this.ledger.onStop(d.run_id, d.turn_id, d.reason).messages);
        break;
      case 'input.transcript.updated':
        this.transcript = d.text;
        break;
      case 'input.transcript.done':
      case 'input.transcript.revised':
        if (d.turn) this.inputs.set(d.turn, d.text);
        break;
      case 'output.transcript.updated':
      case 'output.transcript.done':
        this.outputs.set(d.run_id || 'current', d.text);
        break;
      case 'response.function_call_arguments.done':
        this.call(d);
        break;
      case 'response.done':
        for (const call of d.response?.output || []) {
          if (call.type === 'function_call') this.call(call);
        }
        break;
      case 'conversation.item.created':
        if (this.calls.get(d.item?.call_id) === 'submitted') {
          this.calls.set(d.item.call_id, 'continued');
          this.send({action: 'response.create', response: {call_ids: [d.item.call_id]}});
        }
        break;
    }
    if ([this.stopped, this.inputs, this.outputs, this.calls].some(collection => collection.size > 512)) {
      throw Error('demo session history limit reached; start a new session');
    }
  }

  audio(buffer) {
    const d = this.contexts.shift();
    if (!d) throw Error('audio without context');
    if (this.stopped.has(d.run_id)) return;
    this.ledger.onContext({runId: d.run_id, turnId: d.turn_id, chunkId: d.chunk_id});
    this.ledger.onAudio(buffer.byteLength, buffer);
    this.speaker?.schedule();
  }
  call(d) {
    if (this.calls.has(d.call_id)) return;
    if (d.name !== 'get_local_time') throw Error('unsupported demo tool');
    JSON.parse(d.arguments || '{}');
    this.calls.set(d.call_id, 'submitted');
    this.send({
      action: 'conversation.item.create',
      item: {type: 'function_call_output', call_id: d.call_id, output: JSON.stringify({time: new Date().toISOString()})},
    });
  }

  close() {
    this.speaker?.reset();
    this.contexts = [];
  }
}
