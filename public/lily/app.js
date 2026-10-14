// Hear It Once × Lily (Northstar Bank) — one page: demo customers and test data beside the live call, then a summary.
import { api, h } from '/js/lib.js';
import { Mic, Player } from '/lily/audio.js';

const root = document.getElementById('root');
const live = document.getElementById('sr-live');
const say = (t) => { live.textContent = t; };
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

function top(extra) {
  return h('header.top', h('a.brand', { href: '/' }, brandSvg(), 'Hear It Once'), h('span.grow'), extra ?? null,
    h('a.link', { href: '/agent.html' }, 'Agent console'), h('a.link', { href: '/dashboard.html' }, 'Dashboard'), h('a.link', { href: '/classic.html' }, 'Classic demo'));
}
function render(...n) { root.replaceChildren(...n.flat().filter(Boolean)); window.scrollTo(0, 0); }


/* ------------------------------------------------------------------ single page: demo customers + live call */
const groupPan = (n) => String(n ?? '').replace(/\D/g, '').replace(/(.{4})(?=.)/g, '$1 ');
const STANDING = { good: 'In good standing', watch: 'On watch', restricted: 'Restricted' };

async function home() {
  S.call?.destroy?.(); S.call = null;
  render(top(), h('main.single', h('p.pad.muted', 'Loading Northstar Bank demo customers…')));
  try {
    const [j, st] = await Promise.all([api('/api/demo/customers'), api('/api/live/status')]);
    S.cards = j.items; S.demoData = true; S.disclaimer = j.disclaimer; S.bank = j.bank; S.status = st;
  } catch (e) { S.cards = []; S.status = { available: false, reason: e.message }; S.loadError = e.message; }
  if (!S.selected || !S.cards.find((c) => c.id === S.selected)) S.selected = S.cards[0]?.id ?? null;
  drawHome();
}

function profilePanel(locked) {
  const sel = S.cards.find((c) => c.id === S.selected);
  const tabs = h('div.ptabs', { role: 'radiogroup', 'aria-label': 'Choose the demo customer you are calling as' }, S.cards.map((c) =>
    h('button.ptab', { type: 'button', role: 'radio', 'aria-checked': String(c.id === S.selected), disabled: locked, onclick: () => { S.selected = c.id; drawHome(); } }, c.name.split(' ')[0])));
  const body = !sel ? h('p.muted', S.loadError ?? 'No demo customers are available.') : h('div.pbody',
    h('div.pname', h('h3', sel.name), h('span.chip' + (sel.cardStatus === 'active' ? '.ok' : '.warn'), `Card ${sel.cardStatus}`)),
    h('p.small.muted', sel.blurb),
    h('dl.facts',
      h('div', h('dt', 'Phone (fictional)'), h('dd.mono', sel.phone)),
      h('div', h('dt', 'Account reference'), h('dd.mono', sel.accountRef)),
      h('div', h('dt', 'Standing'), h('dd', STANDING[sel.accountStanding] ?? sel.accountStanding))),
    h('div.pan', h('span.label', `${sel.cardNetwork ?? 'Card'} ${sel.cardProduct ?? ''} · full demo card number`.trim()), h('b.mono.pannum', groupPan(sel.cardNumber)), h('span.small', 'Dummy number for testing. Read it to Lily when she asks. Try a wrong one first to see the retry.')),
    sel.restrictions.length ? h('div', h('span.label', 'Restrictions and alerts'), h('ul.plain', sel.restrictions.map((r) => h('li', r)))) : null,
    h('div', h('span.label', 'Recent transactions'), sel.recentTransactions.length ? h('ul.tx', sel.recentTransactions.map((t) => h('li', h('span', t.merchant), h('span.mono', t.amount), h('span.small.muted', `${t.at}${t.kind === 'fee' ? ' · fee' : ''}${t.status && t.status !== 'posted' ? ' · ' + t.status : ''}`)))) : h('p.small.muted', 'None.')),
    sel.declines.length ? h('div', h('span.label', 'Declined payments'), h('ul.tx', sel.declines.map((d) => h('li', h('span', d.merchant), h('span.mono', d.amount), h('span.small.muted', `${d.at} · ${d.reason}`))))) : null);
  return h('aside.panel.demo', { 'aria-label': 'Demo customers and test data' },
    h('header', h('h3', 'Demo customers and test data'), h('span.grow'), h('span.chip.demo', S.bank ?? 'Northstar Bank')),
    h('p.disc', S.disclaimer ?? 'Synthetic data only. Every customer, phone number and card number here is invented for this demonstration.'),
    tabs, body,
    locked ? h('p.small.muted', 'The customer is fixed while the call is live. End the call to switch.') : h('p.small.muted', 'Pick who you are calling as. Then just talk. Ask about a charge, a decline, a fee, or anything else.'));
}

function drawHome() {
  const st = S.status ?? {};
  const voiceOk = !!st.available;
  const host = h('section.callhost', { 'aria-label': 'Call with Lily' });
  S.host = host;
  const sel = S.cards.find((c) => c.id === S.selected);
  host.append(
    h('div.panel.idle',
      h('div.status-row', h('span.chip', [h('span.dot' + (voiceOk ? '.ok' : '.warn')), voiceOk ? ' Live voice ready' : ' Live voice unavailable — typing works']), h('span.chip.demo', 'AI assistant · synthetic demo')),
      h('h1', 'Say it once. Lily handles the rest.'),
      h('p.lead', `Talk to Lily at ${S.bank ?? 'Northstar Bank'} Card Services. There is nothing to pick. Say what you need, in your own words, and change your mind any time.`),
      sel ? h('div.cta', h('button.btn.primary.lg', { type: 'button', onclick: () => startCall(sel) }, `Call as ${sel.name.split(' ')[0]}`),
        h('p.small.muted', 'You are speaking with an AI assistant. Your browser will ask for the microphone. Nothing here touches a real account.')) : null,
      !voiceOk ? h('p.banner', st.reason ?? 'Live voice is not configured on this server. You can still type to Lily.') : null));
  render(top(), h('main.single', profilePanel(false), host));
}

async function startCall(card) {
  const orb = orbEl('connecting');
  const labels = ['Securing the connection', 'Starting your call session', 'Connecting you with Lily'];
  const list = h('ol.steps', labels.map((l) => h('li', h('span.ic'), l)));
  S.host.replaceChildren(h('div.panel.connect', orb.el, h('h2', 'Connecting you with Lily'), list));
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
    S.host.replaceChildren(h('div.panel.connect', h('h2', 'We could not connect'), h('p.banner.bad', e.message || 'Connection failed.'), h('div.cta', h('button.btn.primary', { onclick: home }, 'Try again'))));
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
const SPEAKER_LABEL = { customer: 'You', assistant: 'Lily', agent: 'Agent', system: '' };
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
      const ws = new WebSocket(`${proto}://${location.host}/api/calls/${this.id}/live`);
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
  onDrop() { if (this.ended) return; this.reconnecting = true; this.banner = { kind: 'warn', text: 'Connection lost. Your conversation is saved — you can keep typing, or end the call.' }; this.ui.refresh?.(); }
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
  setMuted(v) { this.muted = v; this.mic?.setMuted(v); this.ws?.readyState === 1 && this.ws.send(JSON.stringify({ type: 'mute', muted: v })); this.ui.refresh?.(); say(v ? 'Microphone muted' : 'Microphone on'); }
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
    try { this.view = await api(`/api/calls/${this.id}/input`, { method: 'POST', body: { kind: 'request_human' } }); this.handoff = this.view.handoff; this.ui.refresh?.(); say('Handover requested'); }
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
const STATE_TEXT = { speaking: 'Lily is speaking', processing: 'Lily is checking…', listening: 'Listening', 'listening-you': 'Hearing you', muted: 'Microphone muted', reconnecting: 'Reconnecting…', ending: 'Ending call…' };

/* ------------------------------------------------------------------ call screen */
const STAGES = [['understand', 'Understand'], ['verify', 'Verify'], ['investigate', 'Investigate'], ['explain', 'Explain'], ['confirm', 'Confirm'], ['act', 'Act'], ['record', 'Record'], ['resolve', 'Resolve'], ['handoff', 'Handover']];
function callScreen(c) {
  let captions = true; let lastStage = null;
  const orb = orbEl('listening');
  const stateEl = h('span.state', { 'aria-live': 'off' }); const subEl = h('span.small.muted');
  const bannerEl = h('div'); const transcriptEl = h('div.transcript', { role: 'log', 'aria-label': 'Live transcript' });
  const actEl = h('ul.activity', { 'aria-label': 'Behind the conversation' }); const stageEl = h('div.stagebar');
  const sideEl = h('div'); const textIn = h('input', { type: 'text', placeholder: c.textOnly ? 'Type to Lily…' : 'Or type a message', 'aria-label': 'Message to Lily', maxlength: '500', autocomplete: 'off' });
  const compose = h('form.compose', { onsubmit: (e) => { e.preventDefault(); const t = textIn.value.trim(); if (t) { c.sendText(t); textIn.value = ''; } } }, textIn, h('button.btn.primary', { type: 'submit' }, 'Send'));
  const ctl = (icn, label, onclick, extra = {}) => h('div.ctl-wrap', h('button.ctl', { type: 'button', 'aria-label': label, onclick, ...extra }, icn), label);
  const muteBtn = h('button.ctl', { type: 'button', 'aria-label': 'Mute microphone', 'aria-pressed': 'false', onclick: () => c.setMuted(!c.muted) }, ICON.mic());
  const ccBtn = h('button.ctl', { type: 'button', 'aria-label': 'Captions', 'aria-pressed': 'true', onclick: () => { captions = !captions; transcriptEl.classList.toggle('hidden', !captions); ccBtn.setAttribute('aria-pressed', String(captions)); } }, ICON.cc());
  const humanBtn = h('button.ctl', { type: 'button', 'aria-label': 'Talk to a person', onclick: () => c.requestHuman() }, ICON.person());
  const endBtn = h('button.ctl.end', { type: 'button', 'aria-label': 'End call', onclick: () => c.end() }, ICON.end());
  const wrapC = (b, t) => h('div.ctl-wrap', b, t);

  function drawTranscript() {
    const nodes = c.turns.map((t) => { const btn = /^\[Pressed/.test(t.text); const sp = btn ? 'system' : t.speaker === 'customer' || t.speaker === 'assistant' || t.speaker === 'agent' ? t.speaker : 'system'; return h('div.msg.' + sp, SPEAKER_LABEL[sp] ? h('span.who-l', SPEAKER_LABEL[sp]) : null, btn ? 'You asked for a person.' : t.text); });
    for (const sp of ['customer', 'assistant']) if (c.partial[sp]) nodes.push(h('div.msg.partial.' + sp, h('span.who-l', SPEAKER_LABEL[sp]), c.partial[sp]));
    transcriptEl.replaceChildren(...nodes);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
  function drawActivity() {
    if (!c.events.length) { actEl.replaceChildren(h('li', h('span.empty', 'Nothing yet. As Lily looks things up, checks policy or takes an action, each step appears here.'))); return; }
    actEl.replaceChildren(...c.events.filter((e) => !/^voice\.(muted|unmuted)/.test(e.type)).map((e) => {
      const cls = { ok: 'ok', running: 'run', failed: 'bad', blocked: 'bad', warn: 'warn', pending: 'warn' }[e.status] ?? '';
      return h('li', h('span.dot' + (cls ? '.' + cls : '')), h('div', h('div.t', e.title), e.detail ? h('div.d', e.detail) : null), h('span.at', fmtTime(e.at)));
    }).reverse());
    const seen = new Set(c.events.map((e) => e.stage)); const last = c.events[c.events.length - 1]?.stage;
    stageEl.replaceChildren(...STAGES.map(([k, l]) => h('span.sg' + (k === last ? '.on' : seen.has(k) ? '.seen' : ''), l)));
  }
  function drawSide() {
    const v = c.view ?? {}; const hd = v.handoff; const bits = [];
    if (v.demoDevice) bits.push(h('div.demo-box', h('div.label', v.demoDevice.label), h('p.small', 'Lily asked for a passcode. Read it out loud:'), h('b.mono', v.demoDevice.code)));
    if (hd && hd.status !== 'cancelled') {
      const acc = hd.status === 'connected' || hd.status === 'completed';
      const txt = acc ? `${hd.agentName ?? 'A support agent'} has joined. Lily has passed on what you've discussed.` : hd.status === 'no_agent' ? 'No agent is free right now. Your request and details are saved for a callback.' : hd.status === 'failed' ? 'Handover could not be completed.' : 'Request sent. Waiting for an agent to accept in the console.';
      bits.push(h('div.handover' + (acc ? '.accepted' : ''), { role: 'status' }, h('span.label', acc ? 'Agent connected' : hd.status === 'requested' ? 'Handover requested' : 'Waiting for an agent'), h('p', txt), h('p.small.muted', 'In-app handover demo — not a telephone transfer.')));
    }
    sideEl.replaceChildren(...bits);
  }
  function refresh() {
    const ds = c.displayState; stateEl.textContent = STATE_TEXT[ds] ?? ds;
    orb.setState(ds === 'speaking' ? 'speaking' : ds === 'processing' ? 'processing' : 'listening', ds === 'speaking' ? '#7161e4' : ds === 'muted' ? '#a9a5b8' : ds === 'processing' ? '#3e6354' : '#5846c9');
    subEl.textContent = c.textOnly ? 'Voice unavailable — typing mode' : c.micDenied ? 'Microphone blocked — type instead' : '';
    muteBtn.setAttribute('aria-pressed', String(c.muted)); muteBtn.replaceChildren(c.muted ? ICON.micOff() : ICON.mic()); muteBtn.disabled = !c.mic;
    humanBtn.disabled = !!(c.view?.handoff && c.view.handoff.status !== 'cancelled');
    bannerEl.replaceChildren(...(c.textOnly || c.micDenied ? [h('p.banner.info', c.textOnly ? `${c.voiceError ?? 'Voice is unavailable.'} Type below — the conversation works the same.` : 'Microphone access was blocked. Type below, or allow the microphone in your browser and start again.')] : []), ...(c.banner ? [h('p.banner' + (c.banner.kind === 'warn' ? '' : '.' + c.banner.kind), c.banner.text)] : []));
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
    h('section.panel', { 'aria-label': 'Live call' },
      h('header', h('span.dot.run'), h('h3', `Live call with Lily — ${c.card.name}`), h('span.grow'), h('span.chip', 'AI assistant')),
      h('div.stage', orb.el, stateEl, subEl),
      h('div.controls', wrapC(muteBtn, 'Mute'), wrapC(ccBtn, 'Captions'), wrapC(humanBtn, 'Human'), wrapC(endBtn, 'End')),
      bannerEl, sideEl, transcriptEl, compose),
    h('section.panel', { 'aria-label': 'Behind the conversation' },
      h('header', h('h3', 'Behind the conversation'), h('span.grow'), h('span.small.muted', 'Real events from the backend, including each verification attempt')), stageEl, actEl));
  drawTranscript(); drawActivity(); refresh();
  if (c.view?.transcript?.length && !c.turns.length) { c.turns = c.view.transcript.map((t, i) => ({ seq: i, speaker: t.speaker, kind: t.kind ?? '', text: t.text })); drawTranscript(); }
  textIn.focus({ preventScroll: true });
}

/* ------------------------------------------------------------------ summary */
async function summary(c) {
  let r = null;
  try { r = await api(`/api/calls/${c.id}/brief`); } catch { /* fall back to what we have */ }
  const actions = r?.actions ?? []; const tl = (r?.timeline ?? c.events).filter((e) => !/^voice\./.test(e.type) || /lost|session_limit/.test(e.type));
  const esc = r?.escalation;
  const bucketCls = { completed: 'ok', blocked: 'bad', failed: 'bad', pending: 'warn', awaiting_confirmation: 'warn' };
  const list = (items, empty) => items?.length ? h('ul', items.map((i) => h('li', typeof i === 'string' ? i : i.text))) : h('p.small.muted', empty);
  render(top(),
    h('main.summary',
      h('div', h('span.chip.demo', 'Demo call — fictional data'), h('h1', 'Call summary')),
      h('div.box', h('span.label', 'Outcome'), h('h2', r?.headline ?? 'Call ended'), h('p.muted', r?.nextStep ?? ''), esc ? h('p', h('span.chip' + (esc.status === 'connected' || esc.status === 'completed' ? '.ok' : '.warn'), `Handover: ${esc.status}`), ` ${esc.reasonLabel}`) : null),
      h('div.grid2',
        h('div.box', h('h3', 'What you told Lily'), list(r?.customerSaid, 'No details were captured.')),
        h('div.box', h('h3', 'Confirmed by bank systems'), list(r?.verifiedFacts, 'Nothing was confirmed on this call.'))),
      h('div.box', h('h3', 'Actions'),
        actions.length ? h('ul', actions.map((a) => h('li', [a.label, ' ', h('span.chip' + (bucketCls[a.bucket] ? '.' + bucketCls[a.bucket] : ''), a.statusLabel), a.reference ? h('span.small.muted.mono', ` ref ${a.reference}`) : null]))) : h('p.small.muted', 'No account changes were made. Lily never claims an action happened unless a system confirmed it.')),
      r?.unresolved?.length ? h('div.box', h('h3', 'Still open'), list(r.unresolved)) : null,
      h('div.box', h('h3', 'What Lily did'),
        h('details.fold', { open: '' }, h('summary', `${tl.length} recorded steps`),
          h('ol.tl', { style: 'margin-top:.8rem' }, tl.map((e) => h('li' + (e.status ? '.' + e.status : ''), h('div.t', { style: 'font-weight:600' }, e.title), e.detail ? h('div.small.muted', e.detail) : null, h('div.small.muted.mono', fmtTime(e.at))))))),
      h('div.cta', h('button.btn.primary.lg', { onclick: () => home() }, 'Start another demo'), h('p.small.muted', 'History stays in the dashboard and audit log.'))));
  say('Call ended. Summary ready.');
}

home();
