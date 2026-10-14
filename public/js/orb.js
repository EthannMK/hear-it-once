// Signature "sound field" orb. States: idle · listening · processing · speaking · done · error.
// Listening is driven by real microphone levels (Web Audio analyser) when available; the other
// states use restrained procedural motion. Reduced-motion users get a static, labelled orb.
import { icon } from './icons.js';

const NS = 'http://www.w3.org/2000/svg';
const BARS = 72;
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function createOrb({ label = 'Talk to the AI', onActivate } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'orb';
  btn.dataset.state = 'idle';
  btn.setAttribute('aria-label', label);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '-100 -100 200 200');
  const mk = (tag, attrs) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    svg.append(e);
    return e;
  };
  mk('circle', { r: 96, class: 'ring r2' });
  mk('circle', { r: 78, class: 'ring r1' });
  const bars = [];
  for (let i = 0; i < BARS; i++) {
    const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
    bars.push({ el: mk('line', { class: 'bar' }), cos: Math.cos(a), sin: Math.sin(a), v: 0 });
  }
  mk('circle', { r: 46, class: 'core' });
  const sweep = mk('path', { d: 'M 0 -58 A 58 58 0 0 1 50 -29', class: 'sweep' });
  void sweep;
  btn.append(svg);
  const glyph = document.createElement('span');
  glyph.className = 'glyph';
  glyph.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;pointer-events:none';
  const g = icon('mic');
  g.style.cssText = 'width:22%;height:22%;stroke-width:1.4';
  glyph.append(g);
  btn.append(glyph);
  if (onActivate) btn.addEventListener('click', onActivate);

  let state = 'idle';
  let levels = null; // Float32 0..1 from analyser
  let speakPulse = 0;
  let raf = 0;
  let t0 = performance.now();

  function frame(now) {
    const t = (now - t0) / 1000;
    const rm = reduced();
    for (let i = 0; i < BARS; i++) {
      const b = bars[i];
      let target;
      if (rm) target = state === 'listening' ? 0.35 : 0.18;
      else if (state === 'listening' && levels) {
        const bin = levels[Math.floor((i < BARS / 2 ? i : BARS - i) / (BARS / 2) * (levels.length - 1))] ?? 0;
        target = 0.12 + bin * 1.1;
      } else if (state === 'listening') target = 0.25 + 0.2 * Math.abs(Math.sin(t * 6 + i * 0.5));
      else if (state === 'processing') target = 0.12 + 0.5 * Math.max(0, Math.cos(i / BARS * Math.PI * 2 - t * 5)) ** 6;
      else if (state === 'speaking') target = 0.15 + speakPulse * (0.35 + 0.35 * Math.abs(Math.sin(i * 1.7 + t * 9)));
      else if (state === 'done') target = 0.16;
      else if (state === 'error') target = 0.1 + 0.08 * Math.abs(Math.sin(i * 0.9));
      else target = 0.1 + 0.07 * (0.5 + 0.5 * Math.sin(t * 1.3 + i * 0.35)) * (0.6 + 0.4 * Math.sin(t * 0.7));
      b.v += (Math.min(1, target) - b.v) * (rm ? 1 : 0.25);
      const r0 = 52, len = 6 + b.v * 34;
      b.el.setAttribute('x1', (b.cos * r0).toFixed(2));
      b.el.setAttribute('y1', (b.sin * r0).toFixed(2));
      b.el.setAttribute('x2', (b.cos * (r0 + len)).toFixed(2));
      b.el.setAttribute('y2', (b.sin * (r0 + len)).toFixed(2));
    }
    speakPulse *= 0.93;
    raf = rm ? 0 : requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    el: btn,
    setState(s, aria) {
      state = s;
      btn.dataset.state = s;
      if (aria) btn.setAttribute('aria-label', aria);
      g.replaceWith(g);
      if (reduced()) requestAnimationFrame(frame);
    },
    get state() {
      return state;
    },
    setLevels(arr) {
      levels = arr;
    },
    pulse(strength = 1) {
      speakPulse = Math.max(speakPulse, strength);
    },
    destroy() {
      cancelAnimationFrame(raf);
    },
  };
}
