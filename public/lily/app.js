// Hear It Once × Lily (Northstar Bank) — one page: demo customers and test data beside the live call, then a summary.
import { api, h } from '/js/lib.js';
import { Mic, Player } from '/lily/audio.js';
import { t, tList, LANGS, getLang, setLang } from '/lily/i18n.js';

const root = document.getElementById('root');
const live = document.getElementById('sr-live');
const say = (m) => { live.textContent = m; };
const S = { cards: [], demoData: true, status: null, selected: null, call: null };
const fmtTime = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return ''; } };

const NS = 'http://www.w3.org/2000/svg';
function svg(path, { fill = false, vb = '0 0 24 24' } = {}) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', vb); s.setAttribute('aria-hidden', 'true');
  s.setAttribute('fill', fill ? 'currentColor' : 'none'); s.setAttribute('stroke', fill ? 'none' : 'currentColor');
  s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  for (const d of [].concat(path)) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
}
const ICON = {
  mic: () => svg(['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M5 11a7 7 0 0 0 14 0', 'M12 18v3']),
  micOff: () => svg(['M3 3l18 18', 'M9 9v3a3 3 0 0 0 5 2.2', 'M15 10V6a3 3 0 0 0-5.7-1.3', 'M5 11a7 7 0 0 0 11 5.7', 'M12 18v3']),
  end: () => svg(['M4 15c5-4 11-4 16 0l-2 3-3-1.5v-2.5c-2-.7-4-.7-6 0V16.5L6 18z']),
  person: () => svg(['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21a8 8 0 0 1 16 0']),
  cc: () => svg(['M4 6h16v12H4z', 'M9 10.5a2 2 0 1 0 0 3', 'M16 10.5a2 2 0 1 0 0 3']),
  wave: () => svg(['M3 12h2', 'M7 8v8', 'M11 5v14', 'M15 8v8', 'M19 12h2'], { vb: '0 0 24 24' }),
};
const brandSvg = () => svg(['M4 12h2', 'M8 7v10', 'M12 4v16', 'M16 8v8', 'M20 12h0']);

function langPicker() {
  const sel = h('select.langsel', { 'aria-label': t('lang'), disabled: !!(S.call && !S.call.ended), title: t('langHint'), onchange: (e) => setLang(e.target.value) },
    LANGS.map(([c, n]) => h('option', { value: c, ...(c === getLang() ? { selected: '' } : {}), lang: c === 'fil' ? 'fil' : c }, n)));
  return h('label.langwrap', h('span.sr-only', t('lang')), sel);
}
function top(extra) {
  return h('header.top', h('a.brand', { href: '/' }, brandSvg(), 'Hear It Once'), h('span.grow'), extra ?? null, langPicker(),
    h('a.link', { href: '/agent.html', target: '_blank', rel: 'noopener' }, t('openAgent')));
}
function render(...n) { root.replaceChildren(...n.flat().filter(Boolean)); window.scrollTo(0, 0); }


/* ------------------------------------------------------------------ single page: demo customers + live call */
const groupPan = (n) => String(n ?? '').replace(/\D/g, '').replace(/(.{4})(?=.)/g, '$1 ');
const standing = (k) => ({ good: t('good'), watch: t('watch'), restricted: t('restricted') }[k] ?? k);

async function home() {
  S.call?.destroy?.(); S.call = null;
  render(top(), h('main.single', h('div.skeleton', { role: 'status', 'aria-label': t('loading') }, h('span.sk.w60'), h('span.sk.w90'), h('span.sk.w75'), h('span.sk.w90'))));
  try {
    const [j, st] = await Promise.all([api('/api/demo/customers'), api('/api/live/status')]);
    S.cards = j.items; S.demoData = true; S.disclaimer = j.disclaimer; S.bank = j.bank; S.status = st;
  } catch (e) { S.cards = []; S.status = { available: false, reason: e.message }; S.loadError = e.message; }
  if (!S.selected || !S.cards.find((c) => c.id === S.selected)) S.selected = S.cards[0]?.id ?? null;
  drawHome();
}

function profilePanel(locked) {
  const sel = S.cards.find((c) => c.id === S.selected);
  const tabs = h('div.ptabs', { role: 'radiogroup', 'aria-label': t('pickIdentity') }, S.cards.map((c) =>
    h('button.ptab', { type: 'button', role: 'radio', 'aria-checked': String(c.id === S.selected), disabled: locked, onclick: () => { S.selected = c.id; drawHome(); } }, c.name.split(' ')[0])));
  const body = !sel ? h('p.muted', S.loadError ?? t('noProfiles')) : h('div.pbody',
    h('div.pname', h('h3', sel.name), h('span.chip' + (sel.cardStatus === 'active' ? '.ok' : '.warn'), t('cardStatus', { s: sel.cardStatus === 'active' ? t('active') : sel.cardStatus }))),
    h('p.small.muted', sel.blurb),
    h('dl.facts',
      h('div', h('dt', t('phone')), h('dd.mono', sel.phone)),
      h('div', h('dt', t('account')), h('dd.mono', sel.accountRef)),
      h('div', h('dt', t('standing')), h('dd', standing(sel.accountStanding)))),
    h('div.pan', h('span.label', `${sel.cardNetwork ?? ''} ${sel.cardProduct ?? ''} · ${t('panLabel')}`.trim()), h('b.mono.pannum', groupPan(sel.cardNumber)), h('span.small', t('panHelp'))),
    sel.restrictions.length ? h('div', h('span.label', t('restrictions')), h('ul.plain', sel.restrictions.map((r) => h('li', r)))) : null,
    h('div', h('span.label', t('recent')), sel.recentTransactions.length ? h('ul.tx', sel.recentTransactions.map((x) => h('li', h('span', x.merchant), h('span.mono', x.amount), h('span.small.muted', `${x.at}${x.kind === 'fee' ? ' · fee' : ''}${x.status && x.status !== 'posted' ? ' · ' + x.status : ''}`)))) : h('p.small.muted', t('none'))),
    sel.declines.length ? h('div', h('span.label', t('declined')), h('ul.tx', sel.declines.map((d) => h('li', h('span', d.merchant), h('span.mono', d.amount), h('span.small.muted', `${d.at} · ${d.reason}`))))) : null);
  return h('aside.panel.demo', { 'aria-label': t('panelTitle') },
    h('header', h('h3', t('panelTitle')), h('span.grow'), h('span.chip.demo', S.bank ?? 'Northstar Bank')),
    h('p.disc', t('disclaimer')),
    tabs, body,
    h('p.small.muted', locked ? t('lockedNote') : t('hintNote')));
}

function drawHome() {
  const st = S.status ?? {};
  const voiceOk = !!st.available;
  const host = h('section.callhost', { 'aria-label': 'Call with Lily' });
  S.host = host;
  const sel = S.cards.find((c) => c.id === S.selected);
  host.append(
    h('div.panel.idle',
      h('div.aurora', { 'aria-hidden': 'true' }, h('span.blob.b1'), h('span.blob.b2'), h('span.blob.b3')),
      h('div.hero-orb', heroOrb().el),
      h('div.status-row', h('span.chip', [h('span.dot' + (voiceOk ? '.ok' : '.warn')), ' ' + (voiceOk ? t('voiceOk') : t('voiceOff'))]), h('span.chip.demo', t('ai'))),
      h('h1', t('heroTitle')),
      h('p.lead', t('heroLead')),
      sel ? h('div.cta', h('button.btn.primary.lg', { type: 'button', onclick: () => startCall(sel) }, t('start')),
        h('p.small.muted', t('startNote'))) : null,
      h('div.tries', h('span.label', t('tryTitle')), h('ul.plain.tryl', tList('ex').map((x) => h('li', x)))),
      !voiceOk ? h('p.banner', st.reason ?? 'Live voice is not configured on this server. You can still type to Lily.') : null));
  render(top(), h('main.single', profilePanel(false), host));
}

/** Idle hero orb: a slow breathing ring so the page feels alive before the call starts. */
function heroOrb() {
  S.heroOrb?.destroy?.();
  const orb = orbEl('listening');
  orb.attach(() => 0.16 + 0.1 * Math.sin(performance.now() / 900) + 0.04 * Math.sin(performance.now() / 310));
  S.heroOrb = orb;
  return orb;
}

async function startCall(card) {
  S.heroOrb?.destroy?.(); S.heroOrb = null;
  const orb = orbEl('connecting');
  const labels = [t('c1'), t('c2'), t('connecting')];
  const list = h('ol.steps', labels.map((l) => h('li', h('span.ic'), l)));
  S.host.replaceChildren(h('div.panel.connect', orb.el, h('h2', t('connecting')), list));
  const mark = (i) => [...list.children].forEach((li, k) => { li.className = k < i ? 'done' : k === i ? 'now' : ''; li.firstChild.textContent = k < i ? '✓' : ''; });
  mark(0);
  // The microphone prompt must come from the click that started the call.
  const call = new CallController(card);
  S.call = call;
  orb.stop = orb.attach(() => 0.15 + Math.random() * 0.08);
  try {
    await new Promise((r) => setTimeout(r, 350)); mark(1);
    await call.create(); mark(2);
    await call.openVoice();
    orb.stop?.();
    callScreen(call);
  } catch (e) {
    orb.stop?.();
    S.host.replaceChildren(h('div.panel.connect', h('h2', t('failed')), h('p.banner.bad', e.message || 'Connection failed.'), h('div.cta', h('button.btn.primary', { onclick: home }, t('retry')))));
  }
}

/* ------------------------------------------------------------------ orb */
function orbEl(state) {
  const el = h('div.orb', { 'data-state': state, role: 'img', 'aria-label': 'Lily voice indicator' });
  const cv = document.createElement('canvas'); cv.width = 600; cv.height = 600;
  const av = h('div.avatar', brandSvgWhite());
  el.append(cv, av);
  const ctx = cv.getContext('2d');
  const BARS = 64; const vals = new Array(BARS).fill(0);
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let raf = 0; let getLevel = () => 0; let color = '#5846c9';
  function frame(t) {
    const lv = getLevel(); ctx.clearRect(0, 0, 600, 600); ctx.lineCap = 'round'; ctx.lineWidth = 6; ctx.strokeStyle = color;
    for (let i = 0; i < BARS; i++) {
      const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
      const target = reduced ? lv * 0.5 : lv * (0.45 + 0.55 * Math.abs(Math.sin(i * 1.7 + t / 140))) ;
      vals[i] += (target - vals[i]) * 0.35;
      const r1 = 150; const r2 = r1 + 8 + vals[i] * 120;
      ctx.globalAlpha = 0.25 + vals[i] * 0.75;
      ctx.beginPath(); ctx.moveTo(300 + Math.cos(a) * r1, 300 + Math.sin(a) * r1); ctx.lineTo(300 + Math.cos(a) * r2, 300 + Math.sin(a) * r2); ctx.stroke();
    }
    raf = requestAnimationFrame(frame);
  }
  return {
    el,
    setState(s, c) { el.dataset.state = s; if (c) color = c; },
    attach(fn) { getLevel = fn; cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); return () => cancelAnimationFrame(raf); },
    destroy() { cancelAnimationFrame(raf); },
  };
}
const brandSvgWhite = () => { const s = svg(['M4 12h2', 'M8 7v10', 'M12 4v16', 'M16 8v8', 'M20 12h0']); s.setAttribute('stroke-width', '2.4'); s.style.color = '#fff'; return s; };

/* ------------------------------------------------------------------ call controller */
const spLabel = (k) => ({ customer: t('you'), assistant: t('lily'), agent: t('agent') }[k] ?? '');
class CallController {
  constructor(card) {
    this.card = card; this.id = null; this.ws = null; this.mic = null; this.player = null;
    this.muted = false; this.phase = 'idle'; this.reconnecting = false; this.ended = false; this.micDenied = false;
    this.events = []; this.turns = []; this.partial = {}; this.view = null; this.voiceReady = false; this.handoff = null;
    this.ui = {};
  }
  async create() {
    const r = await api('/api/calls', { method: 'POST', body: { channel: 'voice_browser', profileId: this.card.id } });
    this.id = r.sessionId; this.view = r.view;
  }
  async openVoice() {
    this.player = new Player(); await this.player.resume().catch(() => {});
    this.mic = new Mic((b64) => this.ws?.readyState === 1 && !this.muted && this.ws.send(JSON.stringify({ type: 'audio', data: b64 })));
    try { await this.mic.start(); } catch { this.micDenied = true; this.mic = null; }
    await new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/api/calls/${this.id}/live?lang=${getLang()}`);
      this.ws = ws; let settled = false;
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'ready') { settled = true; this.voiceReady = true; resolve(); }
        else if (m.type === 'error' && !settled) { settled = true; this.textOnly = true; this.voiceError = m.message; resolve(); }
        this.onMessage(m);
      };
      ws.onerror = () => { if (!settled) { settled = true; this.textOnly = true; this.voiceError = 'Live voice could not connect.'; resolve(); } };
      ws.onclose = () => { if (!settled) { settled = true; reject(new Error('The voice connection closed before it started.')); } else if (!this.ended) this.onDrop(); };
    });
    if (this.textOnly) { this.mic?.stop(); this.mic = null; }
  }
  onDrop() { if (this.ended) return; this.reconnecting = true; this.banner = { kind: 'warn', text: t('bLost') }; this.ui.refresh?.(); }
  onMessage(m) {
    switch (m.type) {
      case 'audio': this.player?.push(m.data); break;
      case 'interrupted': this.player?.flush(); this.partial.assistant = ''; break;
      case 'partial': this.partial[m.speaker] = m.text; this.ui.transcript?.(); break;
      case 'turns': this.turns = m.turns.filter((t) => t.speaker !== 'system' || t.text); this.partial = {}; this.ui.transcript?.(); break;
      case 'phase': this.phase = m.phase; this.ui.refresh?.(); break;
      case 'timeline': this.events.push(m.event); this.ui.activity?.(); break;
      case 'view': this.view = m.view; this.ui.refresh?.(); break;
      case 'voice': this.reconnecting = m.status === 'reconnecting'; this.banner = m.status === 'lost' ? { kind: 'bad', text: m.message } : m.status === 'restored' ? { kind: 'ok', text: m.message } : { kind: 'warn', text: m.message }; if (m.status === 'restored') setTimeout(() => { if (this.banner?.kind === 'ok') { this.banner = null; this.ui.refresh?.(); } }, 3500); this.ui.refresh?.(); break;
      case 'ended': this.view = m.view; this.finish(); break;
      case 'error': if (this.voiceReady) { this.banner = { kind: 'bad', text: m.message }; this.ui.refresh?.(); } break;
    }
  }
  setMuted(v) { this.muted = v; this.mic?.setMuted(v); this.ws?.readyState === 1 && this.ws.send(JSON.stringify({ type: 'mute', muted: v })); this.ui.refresh?.(); say(v ? t('micMuted') : t('micOn')); }
  sendText(text) {
    if (!text.trim()) return;
    if (this.ws?.readyState === 1 && this.voiceReady) this.ws.send(JSON.stringify({ type: 'text', text }));
    else api(`/api/calls/${this.id}/input`, { method: 'POST', body: { kind: 'utterance', text } }).then((v) => { this.view = v; this.turns = (v.transcript ?? []).map((t, i) => ({ seq: i, speaker: t.speaker, kind: t.kind ?? '', text: t.text })); this.ui.transcript?.(); this.ui.refresh?.(); this.loadTimeline(); }).catch((e) => { this.banner = { kind: 'bad', text: e.message }; this.ui.refresh?.(); });
  }
  /** Confirmed state from the server. Used while a handover is open and whenever the live socket is not healthy, so "agent joined" can never be missed. */
  async poll() {
    try {
      const v = await api(`/api/calls/${this.id}`);
      this.view = v; this.handoff = v.handoff;
      if (!this.voiceReady || this.reconnecting) { this.turns = (v.transcript ?? []).map((t, i) => ({ seq: i, speaker: t.speaker, kind: t.kind ?? '', text: t.text })); this.ui.transcript?.(); await this.loadTimeline(); }
      this.ui.refresh?.();
    } catch { /* try again on the next tick */ }
  }
  /** Typing-only mode has no live socket, so read the recorded backend events instead. */
  async loadTimeline() { try { const r = await api(`/api/calls/${this.id}/timeline`); this.events = r.items ?? []; this.ui.activity?.(); } catch { /* the transcript still works */ } }
  async requestHuman() {
    try { this.view = await api(`/api/calls/${this.id}/input`, { method: 'POST', body: { kind: 'request_human' } }); this.handoff = this.view.handoff; this.ui.refresh?.(); say(t('hRequested')); }
    catch (e) { this.banner = { kind: 'bad', text: e.message }; this.ui.refresh?.(); }
  }
  async end() {
    if (this.ended) return;
    this.ending = true; this.ui.refresh?.();
    if (this.ws?.readyState === 1 && this.voiceReady) this.ws.send(JSON.stringify({ type: 'end' }));
    else { try { this.view = await api(`/api/calls/${this.id}/input`, { method: 'POST', body: { kind: 'hangup' } }); } catch { /* summary will still load */ } this.finish(); }
    setTimeout(() => !this.ended && this.finish(), 4000);
  }
  async finish() { if (this.ended) return; this.ended = true; this.destroy(false); summary(this); }
  destroy(closeWs = true) { this.mic?.stop(); this.player?.close(); this.mic = this.player = null; if (closeWs) { this.ended = true; this.ws?.close(); } this.ui.stopOrb?.(); }
  get displayState() {
    if (this.ending) return 'ending'; if (this.reconnecting) return 'reconnecting'; if (this.muted) return 'muted';
    if (this.player?.speaking) return 'speaking'; if (this.phase === 'processing') return 'processing';
    if (this.mic && this.mic.level > 0.12) return 'listening-you'; return 'listening';
  }
}

/* ------------------------------------------------------------------ call screen */
const STAGE_KEYS = ['understand', 'verify', 'investigate', 'explain', 'confirm', 'act', 'record', 'resolve', 'handoff'];
function callScreen(c) {
  let captions = true; let lastStage = null;
  const orb = orbEl('listening');
  const stateEl = h('span.state', { 'aria-live': 'off' }); const subEl = h('span.small.muted');
  const bannerEl = h('div'); const transcriptEl = h('div.transcript', { role: 'log', 'aria-label': t('captions') });
  const actEl = h('ul.activity', { 'aria-label': t('behind') }); const stageEl = h('div.stagebar');
  const sideEl = h('div'); const textIn = h('input', { type: 'text', placeholder: c.textOnly ? t('typeOnly') : t('typeHere'), 'aria-label': t('typeOnly'), maxlength: '500', autocomplete: 'off' });
  const compose = h('form.compose', { onsubmit: (e) => { e.preventDefault(); const m = textIn.value.trim(); if (m) { c.sendText(m); textIn.value = ''; } } }, textIn, h('button.btn.primary', { type: 'submit' }, t('send')));
  const ctl = (icn, label, onclick, extra = {}) => h('div.ctl-wrap', h('button.ctl', { type: 'button', 'aria-label': label, onclick, ...extra }, icn), label);
  const muteBtn = h('button.ctl', { type: 'button', 'aria-label': t('muteMic'), 'aria-pressed': 'false', onclick: () => c.setMuted(!c.muted) }, ICON.mic());
  const ccBtn = h('button.ctl', { type: 'button', 'aria-label': t('captions'), 'aria-pressed': 'true', onclick: () => { captions = !captions; transcriptEl.classList.toggle('hidden', !captions); ccBtn.setAttribute('aria-pressed', String(captions)); } }, ICON.cc());
  const humanBtn = h('button.ctl', { type: 'button', 'aria-label': t('talkHuman'), onclick: () => c.requestHuman() }, ICON.person());
  const endBtn = h('button.ctl.end', { type: 'button', 'aria-label': t('endCall'), onclick: () => c.end() }, ICON.end());
  const wrapC = (b, t) => h('div.ctl-wrap', b, t);

  function drawTranscript() {
    const nodes = c.turns.map((tr) => { const btn = /^\[Pressed/.test(tr.text); const sp = btn ? 'system' : ['customer', 'assistant', 'agent'].includes(tr.speaker) ? tr.speaker : 'system'; return h('div.msg.' + sp, spLabel(sp) ? h('span.who-l', spLabel(sp)) : null, btn ? t('askedPerson') : tr.text); });
    for (const sp of ['customer', 'assistant']) if (c.partial[sp]) nodes.push(h('div.msg.partial.' + sp, h('span.who-l', spLabel(sp)), c.partial[sp]));
    transcriptEl.replaceChildren(...nodes);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
  function drawActivity() {
    if (!c.events.length) { actEl.replaceChildren(h('li', h('span.empty', t('nothingYet')))); return; }
    actEl.replaceChildren(...c.events.filter((e) => !/^voice\.(muted|unmuted)/.test(e.type)).map((e) => {
      const cls = { ok: 'ok', running: 'run', failed: 'bad', blocked: 'bad', warn: 'warn', pending: 'warn' }[e.status] ?? '';
      return h('li', h('span.dot' + (cls ? '.' + cls : '')), h('div', h('div.t', e.title), e.detail ? h('div.d', e.detail) : null), h('span.at', fmtTime(e.at)));
    }).reverse());
    const seen = new Set(c.events.map((e) => e.stage)); const last = c.events[c.events.length - 1]?.stage;
    stageEl.replaceChildren(...STAGE_KEYS.map((k, i) => h('span.sg' + (k === last ? '.on' : seen.has(k) ? '.seen' : ''), tList('stages')[i])));
  }
  function drawSide() {
    const v = c.view ?? {}; const hd = v.handoff; const bits = [];
    if (v.demoDevice) bits.push(h('div.demo-box', h('div.label', v.demoDevice.label), h('p.small', t('passcode')), h('b.mono', v.demoDevice.code)));
    if (hd && hd.status !== 'cancelled') {
      const acc = hd.status === 'connected' || hd.status === 'completed';
      const txt = acc ? t('hJoined', { n: hd.agentName ?? t('anAgent') }) : hd.status === 'no_agent' ? t('hNone') : hd.status === 'failed' ? t('hFailed') : t('hSent');
      bits.push(h('div.handover' + (acc ? '.accepted' : ''), { role: 'status' }, h('span.label', acc ? t('hConnected') : hd.status === 'requested' ? t('hRequested') : t('hWaiting')), h('p', txt), h('p.small.muted', t('hDemo'))));
    }
    sideEl.replaceChildren(...bits);
  }
  function refresh() {
    const ds = c.displayState; stateEl.textContent = t('s_' + ds);
    orb.setState(ds === 'speaking' ? 'speaking' : ds === 'processing' ? 'processing' : 'listening', ds === 'speaking' ? '#7161e4' : ds === 'muted' ? '#a9a5b8' : ds === 'processing' ? '#3e6354' : '#5846c9');
    subEl.textContent = c.textOnly ? t('typingMode') : c.micDenied ? t('micDenied') : '';
    muteBtn.setAttribute('aria-pressed', String(c.muted)); muteBtn.replaceChildren(c.muted ? ICON.micOff() : ICON.mic()); muteBtn.disabled = !c.mic;
    humanBtn.disabled = !!(c.view?.handoff && c.view.handoff.status !== 'cancelled');
    bannerEl.replaceChildren(...(c.textOnly || c.micDenied ? [h('p.banner.info', c.textOnly ? t('bTextOnly') : t('bMic'))] : []), ...(c.banner ? [h('p.banner' + (c.banner.kind === 'warn' ? '' : '.' + c.banner.kind), c.banner.text)] : []));
    drawSide();
  }
  c.ui = { refresh, transcript: drawTranscript, activity: drawActivity, stopOrb: () => orb.destroy() };
  orb.attach(() => { const ds = c.displayState; return ds === 'speaking' ? c.player?.level ?? 0 : ds === 'muted' || ds === 'reconnecting' ? 0.03 : ds === 'processing' ? 0.12 + 0.06 * Math.sin(performance.now() / 180) : (c.mic?.level ?? 0.05); });
  let n = 0;
  const tick = setInterval(() => {
    if (c.ended) return clearInterval(tick);
    refresh();
    const hs = c.view?.handoff?.status;
    if (++n % 8 === 0 && (['requested', 'queued', 'connected'].includes(hs) || !c.voiceReady || c.reconnecting)) c.poll();
  }, 250);

  const wasPanel = document.querySelector('aside.panel.demo');
  wasPanel?.replaceWith(profilePanel(true));
  S.host.replaceChildren(
    h('section.panel', { 'aria-label': t('liveCall') },
      h('header', h('span.dot.run'), h('h3', t('liveCall')), h('span.grow'), h('span.chip', t('ai'))),
      h('div.stage', orb.el, stateEl, subEl),
      h('div.controls', wrapC(muteBtn, t('mute')), wrapC(ccBtn, t('captions')), wrapC(humanBtn, t('human')), wrapC(endBtn, t('end'))),
      bannerEl, sideEl, transcriptEl, compose),
    h('section.panel', { 'aria-label': 'Behind the conversation' },
      h('header', h('h3', t('behind')), h('span.grow'), h('span.small.muted', t('behindSub'))), stageEl, actEl));
  drawTranscript(); drawActivity(); refresh();
  if (c.view?.transcript?.length && !c.turns.length) { c.turns = c.view.transcript.map((t, i) => ({ seq: i, speaker: t.speaker, kind: t.kind ?? '', text: t.text })); drawTranscript(); }
  textIn.focus({ preventScroll: true });
}

/* ------------------------------------------------------------------ summary */
/** Post-call analysis has its own status. A failed one says so and offers a retry; the call itself is already saved. */
function analysisBox(an, c) {
  if (!an || an.status === 'not_started') return null;
  if (an.status === 'failed') return h('div.box', h('h3', 'Call analysis'), h('p.banner.bad', 'The analysis did not finish. Your call and transcript are saved.'), h('button.btn', { type: 'button', onclick: async () => { try { await api(`/api/calls/${c.id}/analysis/retry`, { method: 'POST', body: {} }); } catch { /* shown again below */ } summary(c); } }, 'Retry analysis'));
  if (an.status !== 'ready') return h('div.box', h('h3', 'Call analysis'), h('p.small.muted', 'Still being prepared.'));
  return h('div.box', h('h3', 'Call analysis'), h('p', an.summary),
    h('p.small', h('b', 'Reason: '), `${an.reason?.label ?? 'Unknown'}${an.reason?.secondary?.length ? ' (also ' + an.reason.secondary.join(', ') + ')' : ''}`, ' · ', h('b', 'Resolution: '), String(an.resolution ?? '').replace('_', ' ')),
    an.tags?.length ? h('p', an.tags.map((x) => h('span.chip', x))) : null);
}

async function summary(c) {
  let r = null;
  let an = null;
  try { r = await api(`/api/calls/${c.id}/brief`); } catch { /* fall back to what we have */ }
  try { an = await api(`/api/calls/${c.id}/analysis`); } catch { /* analysis is shown only when available */ }
  const actions = r?.actions ?? []; const tl = (r?.timeline ?? c.events).filter((e) => !/^voice\./.test(e.type) || /lost|session_limit/.test(e.type));
  const esc = r?.escalation;
  const bucketCls = { completed: 'ok', blocked: 'bad', failed: 'bad', pending: 'warn', awaiting_confirmation: 'warn' };
  const list = (items, empty) => items?.length ? h('ul', items.map((i) => h('li', typeof i === 'string' ? i : i.text))) : h('p.small.muted', empty);
  render(top(),
    h('main.summary',
      h('div', h('span.chip.demo', t('demoCall')), h('h1', t('summary'))),
      h('div.box', h('span.label', t('outcome')), h('h2', r?.headline ?? t('ended')), h('p.muted', r?.nextStep ?? ''), esc ? h('p', h('span.chip' + (esc.status === 'connected' || esc.status === 'completed' ? '.ok' : '.warn'), `Handover: ${esc.status}`), ` ${esc.reasonLabel}`) : null),
      analysisBox(an, c),
      h('div.grid2',
        h('div.box', h('h3', t('told')), list(r?.customerSaid, t('noDetails'))),
        h('div.box', h('h3', t('confirmed')), list(r?.verifiedFacts, t('nothingConfirmed')))),
      h('div.box', h('h3', t('actions')),
        actions.length ? h('ul', actions.map((a) => h('li', [a.label, ' ', h('span.chip' + (bucketCls[a.bucket] ? '.' + bucketCls[a.bucket] : ''), a.statusLabel), a.reference ? h('span.small.muted.mono', ` ref ${a.reference}`) : null]))) : h('p.small.muted', t('noChanges'))),
      r?.unresolved?.length ? h('div.box', h('h3', t('stillOpen')), list(r.unresolved)) : null,
      h('div.box', h('h3', t('whatLily')),
        h('details.fold', { open: '' }, h('summary', t('steps', { n: tl.length })),
          h('ol.tl', { style: 'margin-top:.8rem' }, tl.map((e) => h('li' + (e.status ? '.' + e.status : ''), h('div.t', { style: 'font-weight:600' }, e.title), e.detail ? h('div.small.muted', e.detail) : null, h('div.small.muted.mono', fmtTime(e.at))))))),
      h('div.cta', h('button.btn.primary.lg', { onclick: () => home() }, t('again')), null)));
  say(t('summaryReady'));
}

home();
