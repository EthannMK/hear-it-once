// Runs on the audio thread: downsamples microphone audio to 16 kHz mono PCM16 in ~100 ms chunks
// and reports a level for the visualiser. No audio ever leaves the browser except through the
// authenticated call WebSocket.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
    this.sum = 0;
    this.cnt = 0;
    this.muted = false;
    this.port.onmessage = (e) => { if (e.data && 'muted' in e.data) this.muted = !!e.data.muted; };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i] * ch[i];
      this.cnt++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const s = this.muted ? 0 : Math.max(-1, Math.min(1, ch[i]));
        this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === this.out.length) {
          const buf = this.out.slice().buffer;
          this.port.postMessage({ pcm: buf, level: Math.sqrt(this.sum / Math.max(1, this.cnt)) }, [buf]);
          this.n = 0; this.sum = 0; this.cnt = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('capture', Capture);
