// Browser audio engine: microphone capture (16 kHz PCM16) and gap-free playback (24 kHz PCM16).
// Levels exposed to the UI come from the real streams, never from an animation timer.

const b64 = (buf) => {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
};

export class Mic {
  constructor(onChunk) {
    this.onChunk = onChunk;
    this.level = 0;
    this.ctx = null;
    this.node = null;
    this.stream = null;
  }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule('/lily/capture-worklet.js');
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 0 });
    this.node.port.onmessage = (e) => {
      this.level = Math.min(1, e.data.level * 6);
      this.onChunk(b64(e.data.pcm));
    };
    src.connect(this.node);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }
  setMuted(m) {
    this.node?.port.postMessage({ muted: m });
    if (m) this.level = 0;
  }
  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node?.disconnect();
    this.ctx?.close().catch(() => {});
    this.stream = this.node = this.ctx = null;
    this.level = 0;
  }
}

export class Player {
  constructor() {
    this.ctx = new AudioContext({ sampleRate: 24000 });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.connect(this.ctx.destination);
    this.next = 0;
    this.sources = new Set();
    this.buf = new Uint8Array(this.analyser.fftSize);
  }
  resume() { return this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve(); }
  /** Queue a base64 PCM16 chunk right after what is already scheduled. */
  push(data) {
    const bin = atob(data);
    const n = bin.length >> 1;
    if (!n) return;
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
      f[i] = (v > 32767 ? v - 65536 : v) / 32768;
    }
    const ab = this.ctx.createBuffer(1, n, 24000);
    ab.copyToChannel(f, 0);
    const s = this.ctx.createBufferSource();
    s.buffer = ab;
    s.connect(this.analyser);
    const t = Math.max(this.ctx.currentTime + 0.04, this.next);
    s.start(t);
    this.next = t + ab.duration;
    this.sources.add(s);
    s.onended = () => this.sources.delete(s);
  }
  /** Barge-in: stop everything queued immediately. */
  flush() {
    for (const s of this.sources) { try { s.stop(); } catch { /* already ended */ } }
    this.sources.clear();
    this.next = 0;
  }
  get speaking() { return this.sources.size > 0 && this.next > this.ctx.currentTime; }
  get level() {
    if (!this.speaking) return 0;
    this.analyser.getByteTimeDomainData(this.buf);
    let s = 0;
    for (const v of this.buf) { const d = (v - 128) / 128; s += d * d; }
    return Math.min(1, Math.sqrt(s / this.buf.length) * 4);
  }
  close() { this.flush(); this.ctx.close().catch(() => {}); }
}
