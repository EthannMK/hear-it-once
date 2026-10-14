// Replaceable browser voice adapters. Input: Web Speech recognition (+ optional mic level meter
// via getUserMedia — requested only when the user starts listening). Output: speechSynthesis.
// No audio is recorded or sent to this app's server: only the recognised text is submitted.

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export const voiceSupport = {
  input: !!SR,
  output: 'speechSynthesis' in window,
  levels: !!(navigator.mediaDevices?.getUserMedia && (window.AudioContext || window.webkitAudioContext)),
};

const ERRORS = {
  'not-allowed': 'Microphone access was blocked. Allow the microphone for this site in your browser’s address bar, then try again — or just type below.',
  'service-not-allowed': 'Speech recognition isn’t allowed in this browser profile. You can type instead.',
  'no-speech': 'I didn’t hear anything. Tap the microphone and speak, or type below.',
  'audio-capture': 'No microphone was found. Connect one, or type below.',
  network: 'Your browser’s speech service couldn’t be reached. Type below instead.',
  aborted: null,
};

export class VoiceInput {
  constructor({ onStart, onInterim, onFinal, onError, onEnd, onLevels }) {
    Object.assign(this, { onStart, onInterim, onFinal, onError, onEnd, onLevels });
    this.listening = false;
  }
  async start() {
    if (!SR) {
      this.onError?.('unsupported', 'Voice input isn’t supported in this browser (try Chrome or Edge). Type below — it works the same way.');
      return;
    }
    if (this.listening) return;
    const rec = new SR();
    this.rec = rec;
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onstart = () => {
      this.listening = true;
      this.onStart?.();
    };
    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) this.onFinal?.(r[0].transcript.trim(), Math.round((r[0].confidence || 0.9) * 100) / 100);
        else interim += r[0].transcript;
      }
      if (interim) this.onInterim?.(interim.trim());
    };
    rec.onerror = (ev) => {
      const msg = ERRORS[ev.error];
      if (msg !== null) this.onError?.(ev.error, msg ?? `Speech recognition stopped (${ev.error}). Type below instead.`);
    };
    rec.onend = () => {
      this.listening = false;
      this.stopLevels();
      this.onEnd?.();
    };
    try {
      rec.start();
    } catch (e) {
      this.onError?.('start', 'Couldn’t start listening. Tap the microphone again, or type below.');
      return;
    }
    this.startLevels();
  }
  stop() {
    try {
      this.rec?.stop();
    } catch {
      /* already stopped */
    }
    this.stopLevels();
  }
  async startLevels() {
    if (!voiceSupport.levels || !this.onLevels) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ac = new AC();
      const src = this.ac.createMediaStreamSource(this.stream);
      const an = this.ac.createAnalyser();
      an.fftSize = 128;
      an.smoothingTimeConstant = 0.7;
      src.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      const out = new Float32Array(24);
      const loop = () => {
        if (!this.stream) return;
        an.getByteFrequencyData(buf);
        for (let i = 0; i < out.length; i++) out[i] = buf[i + 1] / 255;
        this.onLevels(out);
        this.levelRaf = requestAnimationFrame(loop);
      };
      loop();
    } catch {
      // Level meter is optional; recognition itself reports permission problems.
    }
  }
  stopLevels() {
    cancelAnimationFrame(this.levelRaf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.ac?.close?.();
    this.ac = null;
    this.onLevels?.(null);
  }
}

export class VoiceOutput {
  constructor({ onStart, onEnd, onBoundary } = {}) {
    Object.assign(this, { onStart, onEnd, onBoundary });
    this.enabled = false;
  }
  speak(text) {
    if (!this.enabled || !voiceSupport.output) return;
    const clean = text.replace(/[✓✗?…•]\s?/g, '').replace(/\[[^\]]*\]/g, '').trim();
    if (!clean) return;
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = 'en-US';
    const v = speechSynthesis.getVoices().find((x) => /en-(US|GB)/.test(x.lang) && /Natural|Google|Samantha|Aria|Jenny/i.test(x.name));
    if (v) u.voice = v;
    u.rate = 1.03;
    u.onstart = () => this.onStart?.();
    u.onend = () => {
      if (!speechSynthesis.speaking) this.onEnd?.();
    };
    u.onboundary = () => this.onBoundary?.();
    speechSynthesis.speak(u);
  }
  cancel() {
    if (voiceSupport.output) speechSynthesis.cancel();
    this.onEnd?.();
  }
}
