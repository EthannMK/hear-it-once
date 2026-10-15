// Hear It Once × Lily (Northstar Bank) — the judge experience, two screens:
//   1) #/        Talk to Lily: test-data panel, live call, "Behind the conversation"
//   2) #/crm…    Agent CRM: the human agent's case workspace (see crm.js)
// The call ends → the page flips to the CRM case for that same call automatically.
// Everything shown comes from the server: WebSocket messages, the call view, the timeline and
// the agent workspace read model. Nothing is simulated in the browser.
import { api, h } from '/js/lib.js';
import { Mic, Player } from '/lily/audio.js';
import { t, tList } from '/lily/i18n.js';
import { initCrm, crmRoute } from '/lily/crm.js';

const root = document.getElementById('root');
const srLive = document.getElementById('sr-live');
const say = (m) => { srLive.textContent = m; };
const S = { cards: [], selected: null, status: null, bank: 'Northstar Bank', call: null, lastCall: null };
try { S.lastCall = sessionStorage.getItem('hio.lastCall'); } catch { /* storage blocked */ }
const fmtTime = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return ''; } };
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;
const group4 = (d) => String(d ?? '').replace(/\D/g, '').replace(/(.{4})(?=.)/g, '$1 ');
const STAGES = ['understand', 'verify', 'investigate', 'explain', 'confirm', 'act', 'record', 'resolve', 'handoff'];
const STAGE_LABEL = { understand: 'Understand', verify: 'Verify', investigate: 'Investigate', explain: 'Explain', confirm: 'Confirm', act: 'Act', record: 'Record', resolve: 'Resolve', handoff: 'Handover' };

/* ------------------------------------------------------------------ icons */
const NS = 'http://www.w3.org/2000/svg';
const P = {
  wave: ['M4 10v4', 'M8 7v10', 'M12 4v16', 'M16 7v10', 'M20 10v4'],
  mic: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M19 11a7 7 0 0 1-14 0', 'M12 18v3'],
  micOff: ['M3 3l18 18', 'M9 9v3a3 3 0 0 0 5 2.2', 'M15 10V6a3 3 0 0 0-5.7-1.3', 'M5 11a7 7 0 0 0 11 5.7', 'M12 18v3'],
  phone: ['M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z'],
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
  end: ['M5 15c4-4 10-4 14 0l-2 3-3-1v-2a10 10 0 0 0-4 0v2l-3 1z'],
  person: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21a8 8 0 0 1 16 0'],
  headset: ['M4 14v-2a8 8 0 0 1 16 0v2', 'M4 14h3v6H4z', 'M17 14h3v6h-3z'],
  cc: ['M3 6h18v12H3z', 'M10 10.5a2 2 0 1 0 0 3', 'M17 10.5a2 2 0 1 0 0 3'],
  send: ['M4 12l16-8-6 16-2-7z'],
  check: ['M5 12l5 5 9-10'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  alert: ['M12 3l10 18H2z', 'M12 10v4', 'M12 17v.5'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5', 'M12 8v.5'],
  lock: ['M6 11h12v9H6z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  flask: ['M9 3h6', 'M10 3v6L4 19a1.5 1.5 0 0 0 1.3 2h13.4A1.5 1.5 0 0 0 20 19l-6-10V3'],
  activity: ['M3 12h4l3-8 4 16 3-8h4'],
  volume: ['M4 9h4l5-4v14l-5-4H4z', 'M17 9a4 4 0 0 1 0 6'],
  keyboard: ['M3 6h18v12H3z', 'M7 10h.01', 'M11 10h.01', 'M15 10h.01', 'M7 14h10'],
  retry: ['M4 12a8 8 0 1 0 2.4-5.7', 'M4 4v4h4'],
  copy: ['M9 9h11v11H9z', 'M5 15V4h11'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
};
function icon(name) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'i');
  s.setAttribute('aria-hidden', 'true');
  for (const d of P[name] ?? []) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
}

/* ------------------------------------------------------------------ chrome */
function header(active) {
  const callLive = S.call && !S.call.ended;
  return h('header.top',
    h('a.brand', { href: '#/' }, h('span.mk', icon('wave')), h('b', 'Hear It Once')),
    h('span.badge.lav.bank', S.bank),
    h('nav.tabs', { 'aria-label': 'Screens' },
      h('a', { href: '#/', 'aria-current': active === 'talk' ? 'page' : null }, '1 · Talk to Lily'),
      h('a', { href: callLive ? `/#/crm/call/${encodeURIComponent(S.call.id)}` : S.lastCall ? `#/crm/call/${encodeURIComponent(S.lastCall)}` : '#/crm', target: callLive ? '_blank' : null, rel: callLive ? 'noopener' : null, 'aria-current': active === 'crm' ? 'page' : null, title: 'The human agent’s case workspace' }, '2 · Agent CRM')),
    h('span.grow'),
  );
}
function render(active, ...nodes) {
  root.replaceChildren(header(active), ...nodes.flat().filter(Boolean));
}
let toastT = 0;
function toast(m) {
  document.querySelector('.toast')?.remove();
  const el = h('div.toast', { role: 'status' }, m);
  document.body.append(el);
  clearTimeout(toastT);
  toastT = setTimeout(() => el.remove(), 3800);
}

/* ------------------------------------------------------------------ routing */
window.addEventListener('hashchange', route);
async function route() {
  const hash = location.hash;
  // Old links to the agent view go to the CRM case for that call.
  const old = hash.match(/^#\/agent\/([^/]+)/);
  if (old) return location.replace(`#/crm/call/${old[1]}`);
  if (hash.startsWith('#/crm')) {
    if (S.call && !S.call.ended) S.call.destroy();
    return crmRoute(hash);
  }
  if (S.call && !S.call.ended) return; // the call screen is already on the page
  return home();
}
initCrm({ render, icon, toast });

/* ================================================================== SCREEN 1 · talk to Lily */
async function home() {
  S.call = null;
  render('talk', h('main.judge', h('div.card.td', h('p.muted', t('loading'))), h('div')));
  try {
    const [j, st] = await Promise.all([api('/api/demo/customers'), api('/api/live/status')]);
    S.cards = j.items; S.bank = j.bank ?? S.bank; S.status = st;
  } catch (e) {
    S.cards = []; S.status = { available: false, reason: e.message }; S.loadError = e.message;
  }
  if (!S.selected || !S.cards.some((c) => c.id === S.selected)) S.selected = S.cards[0]?.id ?? null;
  drawHome();
}
const card = () => S.cards.find((c) => c.id === S.selected);

/** Test data for judges: compact, clearly framed as dummy data to type or read to Lily. */
function testPanel(locked) {
  const c = card();
  const copy = (v, label) => h('button.copy', { type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(v); toast(`${label} copied`); } catch { toast('Copy is not available here.'); } } }, 'Copy');
  S.tdOpen ??= !!window.matchMedia?.('(min-width: 901px)').matches;
  const box = h('details.tdbox', { ...(S.tdOpen ? { open: '' } : {}), ontoggle: (e) => { S.tdOpen = e.currentTarget.open; } },
    h('summary', icon('flask'), h('span.tt', h('b', 'Test customer'), c ? h('small', `${c.name} · card number and details`) : null)),
    h('p.how', 'Fictional details for testing. Read the card number to Lily when she asks. Try a wrong one first to see her retry.'),
    h('div.ptabs', { role: 'radiogroup', 'aria-label': 'Choose a test customer' }, S.cards.map((x) =>
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(x.id === S.selected), disabled: locked, onclick: () => { S.selected = x.id; drawHome(); } }, x.name.split(' ')[0]))),
    !c ? h('p.small.muted', S.loadError ?? 'No test customers are available.') : [
      h('div.who', h('b', c.name), h(`span.chip${c.cardStatus === 'active' ? '.ok' : '.warn'}`, `Card ${c.cardStatus}`)),
      h('p.blurb', c.blurb),
      h('dl',
        h('div', h('dt', 'Card number to read out'), h('dd', h('span.pan', group4(c.cardNumber)), copy(c.cardNumber, 'Card number'))),
        h('div', h('dt', 'Caller ID'), h('dd.mono', c.phone)),
        h('div', h('dt', 'Account reference'), h('dd.mono', c.accountRef, ' ', copy(c.accountRef, 'Account reference')))),
      c.restrictions?.length ? h('div.lockn', c.restrictions.join(' · ')) : null,
      h('details', h('summary', `What the bank's systems hold (${(c.recentTransactions?.length ?? 0) + (c.declines?.length ?? 0)} records)`),
        h('ul.tx', (c.recentTransactions ?? []).map((x) => h('li', h('span.m', x.merchant), h('span.mono', x.amount), h('span.s', `${x.at}${x.kind === 'fee' ? ' · fee' : ''}${x.status && x.status !== 'posted' ? ' · ' + x.status : ''}`))),
          (c.declines ?? []).map((d) => h('li', h('span.m', `Declined: ${d.merchant}`), h('span.mono', d.amount), h('span.s', `${d.at} · ${d.reason}`))))),
    ],
    locked ? h('p.lockn', 'The test customer is fixed during a call.') : null,
    h('p.fine', `${S.bank} is a fictional bank. Never enter real card details.`));
  return h('aside.td', { 'aria-label': 'Test customer' }, box);
}

function drawHome() {
  const ready = !!S.status?.available;
  const bars = h('div.bars', { 'aria-hidden': 'true' }, [14, 26, 38, 48, 34, 44, 24, 16].map((n) => h('i', { style: `height:${n}px` })));
  const c = card();
  render('talk', h('main.judge',
    testPanel(false),
    h('section', { 'aria-label': 'Talk to Lily' },
      h('div.hero',
        h('div',
          h('h1', 'Meet Lily.', h('br'), h('em', 'Your banking questions,'), ' heard.'),
          h('p.lede', `Talk to Lily, ${S.bank}'s voice assistant, the way you'd talk to a person. She verifies who you are, checks the bank's systems while you talk, and hands you to a human with the full story whenever you ask.`),
          h('ul.langs', { 'aria-label': 'Languages and agents' }, [['en', 'English', 'Lily'], ['my', 'Burmese', 'Hnin'], ['fil', 'Tagalog', 'Maya']].map(([k, n, a]) => h('li', h(`i.flag.${k}`), h('span', h('b', n), h('small', a))))),
          h('p.langnote', 'Lily speaks English. Speak Burmese or Tagalog and she will offer Hnin or Maya.'),
          h('button.connect', { type: 'button', disabled: !c, onclick: () => startCall(c) },
            h('span.ic', icon('phone')), h('span', h('b', 'Connect with Lily'), h('small', c ? `As test customer ${c.name}` : 'Choose a test customer first')), icon('arrow')),
          h('div.subs',
            h(`div.st${ready ? '' : '.off'}`, h('i'), ready ? 'Lily is ready to talk' : 'Voice isn’t available right now. You can type to Lily instead.'),
            h('p', icon('info'), h('span', 'You are speaking with an AI. Your browser will ask for the microphone and no audio is stored. No microphone? Start anyway and type.')))),
        h('div.pod-wrap',
          h('div.pod', h('div', bars, h('div.mic', icon('wave')), h('h3', 'Lily'), h(`div.ready${ready ? '' : '.off'}`, ready ? 'Ready to listen' : 'Typing only'))),
          h('div.float.f1', icon('lock'), 'Verifies you before any account detail'),
          h('div.float.f2', icon('headset'), 'Human handover any time'))),
      !ready && S.status?.reason && !/scripted/i.test(S.status.reason) ? h('p.banner.warn', S.status.reason) : null,
      h('div.card.asks', h('span.cap', 'Things to try'), h('div.chips', [...(tList('ex') ?? []), 'How are you today?'].map((x) => h('span', `“${x}”`)))),
      h('div.flow',
        h('div.card', h('b', h('span', '1'), 'Talk'), h('p', 'Speak naturally. Interrupt, change topic, ask follow-ups. Lily verifies you with the test card number.')),
        h('div.card', h('b', h('span', '2'), 'Watch'), h('p', '“Behind the conversation” shows each step as it happens: checks, decisions, actions and handover.')),
        h('div.card', h('b', h('span', '3'), 'Agent CRM'), h('p', 'When you end the call, you land in the agent’s case workspace: summary, verified facts, suggested next step and tickets.'))))));
}

/* ------------------------------------------------------------------ connecting */
function sheet(steps, extra = {}) {
  document.querySelector('.overlay')?.remove();
  const ov = h('div.overlay', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'conn-t' },
    h('div.sheet',
      h('h2#conn-t', extra.title ?? 'Connecting with Lily'),
      h('p.lead', extra.lead ?? 'This takes a few seconds.'),
      h('ol.steps', steps.map((s) => h(`li.${s.state}`, h('span.s', s.state === 'ok' ? icon('check') : s.state === 'fail' ? icon('x') : null), h('div', h('b', s.label), h('span', s.detail ?? ''))))),
      extra.error ? h('p.banner.bad', { role: 'alert' }, extra.error) : null,
      extra.actions?.length ? h('div.acts', extra.actions) : null));
  document.body.append(ov);
  ov.querySelector('button')?.focus();
}
const closeSheet = () => document.querySelector('.overlay')?.remove();

async function startCall(c) {
  const live = !!S.status?.available;
  const steps = [
    { k: 'mic', label: 'Microphone', detail: 'Your browser will ask for permission.', state: live ? 'run' : 'skip' },
    { k: 'call', label: 'Starting your call', detail: `Test customer ${c.name}`, state: 'todo' },
    { k: 'lily', label: 'Connecting to Lily', detail: live ? 'Live voice' : 'Voice isn’t available right now', state: 'todo' },
  ];
  const set = (k, state, detail) => { const s = steps.find((x) => x.k === k); s.state = state; if (detail) s.detail = detail; };
  const call = new Call(c);
  let cancelled = false;
  const cancelBtn = () => h('button.btn', { type: 'button', onclick: () => { cancelled = true; call.destroy(); closeSheet(); } }, 'Cancel');
  sheet(steps, { actions: [cancelBtn()] });

  // 1. Microphone (inside the click, so the permission prompt is allowed). Lily still talks if it's refused.
  if (live) {
    try { await call.startAudio(); set('mic', 'ok', 'Microphone ready.'); }
    catch (e) { call.micDenied = true; set('mic', 'fail', e.name === 'NotAllowedError' ? 'Blocked — you can type instead; Lily will still speak.' : 'Not available — you can type instead.'); }
  }
  if (cancelled) return;
  // 2. Create the call.
  set('call', 'run'); sheet(steps, { actions: [cancelBtn()] });
  try { await call.create(); set('call', 'ok', `Call ${call.id}`); }
  catch (e) { set('call', 'fail', e.message); sheet(steps, { error: `The call could not start: ${e.message}`, actions: [h('button.btn.primary', { type: 'button', onclick: () => { closeSheet(); startCall(c); } }, icon('retry'), 'Try again'), cancelBtn()] }); call.destroy(); return; }
  if (cancelled) return;
  // 3. Live voice.
  if (!live) {
    set('lily', 'fail', S.status?.reason ?? 'Live voice is not configured.');
    call.textOnly = true;
    sheet(steps, { error: 'Lily’s voice isn’t available right now. You can still have the whole conversation by typing; everything works the same way.', actions: [h('button.btn.primary', { type: 'button', onclick: () => { closeSheet(); callScreen(call); } }, icon('keyboard'), 'Continue by typing'), cancelBtn()] });
    return;
  }
  set('lily', 'run'); sheet(steps, { actions: [cancelBtn()] });
  const r = await call.openVoice();
  if (cancelled) return;
  if (!r.ok) {
    set('lily', 'fail', r.message);
    sheet(steps, { error: `Lily’s voice could not connect: ${r.message}`, actions: [h('button.btn.primary', { type: 'button', onclick: () => { closeSheet(); callScreen(call); } }, icon('keyboard'), 'Continue by typing'), cancelBtn()] });
    return;
  }
  set('lily', 'ok', 'Connected');
  sheet(steps, { actions: [] });
  setTimeout(() => { closeSheet(); callScreen(call); }, 400);
}

/* ------------------------------------------------------------------ call controller */
class Call {
  constructor(c) {
    this.card = c; this.id = null; this.ws = null; this.mic = null; this.player = null;
    this.muted = false; this.phase = 'idle'; this.reconnecting = false; this.ended = false; this.ending = false;
    this.voiceReady = false; this.textOnly = false; this.micDenied = false;
    this.agent = { lang: 'en', name: 'Lily' };
    this.turns = []; this.partial = {}; this.events = []; this.view = null; this.banner = null; this.ui = {}; this.latency = null;
    S.call = this;
  }
  async startAudio() {
    this.player = new Player();
    await this.player.resume().catch(() => {});
    this.mic = new Mic((b64) => { if (this.ws?.readyState === 1 && !this.muted) this.ws.send(JSON.stringify({ type: 'audio', data: b64 })); });
    try { await this.mic.start(); } catch (e) { this.mic = null; throw e; }
  }
  async create() {
    const r = await api('/api/calls', { method: 'POST', body: { channel: 'voice_browser', profileId: this.card.id } });
    this.id = r.sessionId; this.view = r.view;
    this.turns = (r.view?.transcript ?? []).map((x) => ({ seq: x.seq, speaker: x.speaker, kind: x.kind ?? '', text: x.text, at: x.at }));
    S.lastCall = this.id;
    try { sessionStorage.setItem('hio.lastCall', this.id); } catch { /* ignore */ }
  }
  openVoice() {
    if (!this.player) { this.player = new Player(); this.player.resume().catch(() => {}); }
    return new Promise((resolve) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/api/calls/${this.id}/live`);
      this.ws = ws;
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
      const timer = setTimeout(() => done({ ok: false, message: 'The voice service did not answer in time.' }), 20000);
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'ready') { this.voiceReady = true; if (m.agent) this.agent = m.agent; done({ ok: true, provider: m.model ?? m.provider }); }
        else if (m.type === 'error' && !settled) { this.textOnly = true; done({ ok: false, message: m.message }); }
        this.onMessage(m);
      };
      ws.onerror = () => { this.textOnly = !this.voiceReady; done({ ok: false, message: 'The voice connection failed.' }); };
      ws.onclose = () => {
        done({ ok: false, message: 'The voice connection closed before it was ready.' });
        if (this.voiceReady && !this.ended && !this.ending) { this.reconnecting = true; this.banner = { kind: 'warn', text: 'Voice connection lost. Your conversation is saved — keep typing, or end the call.' }; this.voiceReady = false; this.ui.refresh?.(); }
      };
    });
  }
  onMessage(m) {
    switch (m.type) {
      case 'audio': this.player?.push(m.data); break;
      case 'interrupted': this.player?.flush(); this.partial.assistant = ''; this.ui.transcript?.(); break;
      case 'partial': this.partial[m.speaker] = m.text; if (m.speaker === 'customer') this.lastHeard = performance.now(); this.ui.transcript?.(); break;
      case 'turns': {
        // The server sends only what is new, so merge by sequence number instead of replacing the list.
        const by = new Map(this.turns.filter((x) => x.seq != null).map((x) => [x.seq, x]));
        for (const x of m.turns) by.set(x.seq, x);
        this.turns = [...by.values()].sort((a, b) => a.seq - b.seq);
        this.partial = {}; this.ui.transcript?.(); break;
      }
      case 'agent':
        this.agent = { lang: m.lang, name: m.name };
        this.banner = { kind: 'ok', text: `${m.name} joined the call and has the details so far.` };
        setTimeout(() => { if (this.banner?.kind === 'ok') { this.banner = null; this.ui.refresh?.(); } }, 4500);
        this.ui.refresh?.(); this.ui.transcript?.();
        break;
      case 'phase': this.phase = m.phase; this.ui.refresh?.(); break;
      case 'timeline': this.events.push(m.event); this.ui.activity?.(); break;
      case 'view': this.view = m.view; this.ui.refresh?.(); break;
      case 'voice':
        this.reconnecting = m.status === 'reconnecting';
        this.banner = { kind: m.status === 'lost' ? 'bad' : m.status === 'restored' ? 'ok' : 'warn', text: m.message };
        if (m.status === 'restored') setTimeout(() => { if (this.banner?.kind === 'ok') { this.banner = null; this.ui.refresh?.(); } }, 3500);
        if (m.status === 'lost') this.voiceReady = false;
        this.ui.refresh?.();
        break;
      case 'ended': this.view = m.view; this.finish(); break;
      case 'error': if (this.voiceReady) { this.banner = { kind: 'bad', text: m.message }; this.ui.refresh?.(); } break;
      default: break;
    }
  }
  setMuted(v) { this.muted = v; this.mic?.setMuted(v); if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'mute', muted: v })); this.ui.refresh?.(); say(v ? 'Microphone muted' : 'Microphone on'); }
  async sendText(text) {
    if (!text.trim()) return;
    if (this.ws?.readyState === 1 && this.voiceReady) { this.player?.flush(); this.ws.send(JSON.stringify({ type: 'text', text })); return; }
    this.partial.customer = text; this.phase = 'processing'; this.ui.transcript?.(); this.ui.refresh?.();
    try {
      const v = await api(`/api/calls/${this.id}/input`, { method: 'POST', body: { kind: 'utterance', text } });
      this.absorb(v);
      await this.loadTimeline();
    } catch (e) { this.banner = { kind: 'bad', text: e.message }; }
    this.partial = {}; this.phase = 'idle'; this.ui.transcript?.(); this.ui.refresh?.();
  }
  async consent(decision) {
    if (!this.view?.proposal) return;
    try { this.absorb(await api(`/api/calls/${this.id}/input`, { method: 'POST', body: { kind: 'consent', proposalId: this.view.proposal.id, decision } })); await this.loadTimeline(); }
    catch (e) { this.banner = { kind: 'bad', text: e.message }; this.ui.refresh?.(); }
  }
  absorb(v) {
    if (!v) return;
    this.view = v;
    if (!this.voiceReady) this.turns = (v.transcript ?? []).map((x) => ({ speaker: x.speaker, kind: x.kind ?? '', text: x.text, at: x.at }));
    this.ui.transcript?.(); this.ui.refresh?.();
    if (v.session?.stage === 'ended' && !this.ended) this.finish();
  }
  async poll() {
    try { this.absorb(await api(`/api/calls/${this.id}`)); if (!this.voiceReady) await this.loadTimeline(); } catch { /* next tick */ }
  }
  async loadTimeline() {
    try { const r = await api(`/api/calls/${this.id}/timeline`); this.events = r.items ?? []; this.ui.activity?.(); } catch { /* the transcript still works */ }
  }
  async requestHuman() {
    try { this.absorb(await api(`/api/calls/${this.id}/input`, { method: 'POST', body: { kind: 'request_human' } })); await this.loadTimeline(); say('Handover requested'); }
    catch (e) { this.banner = { kind: 'bad', text: e.message }; this.ui.refresh?.(); }
  }
  async end() {
    if (this.ended || this.ending) return;
    this.ending = true; this.player?.flush(); this.ui.refresh?.();
    if (this.ws?.readyState === 1 && this.voiceReady) this.ws.send(JSON.stringify({ type: 'end' }));
    else { try { this.view = await api(`/api/calls/${this.id}/input`, { method: 'POST', body: { kind: 'hangup' } }); } catch { /* the agent view still loads */ } this.finish(); }
    setTimeout(() => { if (!this.ended) this.finish(); }, 4000);
  }
  /** The call is over: flip to screen 2 — the human agent's view of this call. */
  finish() {
    if (this.ended) return;
    this.ended = true;
    this.destroy();
    say('Call ended. Opening the agent’s case workspace.');
    location.hash = `#/crm/call/${encodeURIComponent(this.id)}`;
  }
  destroy() {
    this.mic?.stop(); this.player?.close(); this.mic = this.player = null;
    this.ended = true;
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ui.stop?.();
  }
  get state() {
    if (this.ending) return 'ending';
    if (this.reconnecting) return 'reconnecting';
    const hs = this.view?.handoff?.status;
    if (hs === 'connected') return 'agent';
    if (this.player?.speaking) return 'speaking';
    if (this.phase === 'processing') return 'processing';
    if (hs === 'queued' || hs === 'requested') return 'waiting';
    if (!this.voiceReady) return 'typing';
    if (this.muted) return 'muted';
    if (this.mic && this.mic.level > 0.12) return 'hearing';
    return this.mic ? 'listening' : 'typing';
  }
}

const STATE_TEXT = {
  speaking: ['Lily is speaking', 'Start talking to interrupt her.'],
  processing: ['Checking', 'Lily is checking that for you.'],
  listening: ['Listening', 'Speak naturally — you can interrupt Lily at any time.'],
  hearing: ['Hearing you', 'Keep going — Lily answers when you pause.'],
  muted: ['Muted', 'Lily can’t hear you. Unmute to talk, or type below.'],
  typing: ['Typing mode', 'Type below — the conversation works the same way.'],
  waiting: ['Waiting for a human agent', 'Your case is with the agent team. No one has joined yet.'],
  agent: ['Agent connected', 'A human agent accepted the handover and has the full brief.'],
  reconnecting: ['Reconnecting…', 'The voice connection dropped; your conversation is saved.'],
  ending: ['Ending call…', 'Saving the case. The agent’s workspace opens next.'],
};
const SEG = ['speaking', 'listening', 'processing', 'muted'];

/* ------------------------------------------------------------------ call screen */
function callScreen(c) {
  let captions = true;
  const canvas = h('canvas', { role: 'img', 'aria-label': 'Voice activity' });
  const pill = h('span.pill'); const sub = h('p.sub'); const lat = h('span.lat');
  const seg = Object.fromEntries(SEG.map((k) => [k, h('span', { 'aria-current': 'false' }, k[0].toUpperCase() + k.slice(1))]));
  const stage = h('div.stage', { 'aria-live': 'polite' }, lat, canvas, pill, sub, h('div.seg', { 'aria-label': 'Current voice state' }, Object.values(seg)));
  const head = h('div.card.ch'); const extras = h('div'); const consentEl = h('div'); const handEl = h('div'); const bannerEl = h('div');
  const list = h('div.tx-list', { role: 'log', 'aria-label': 'Live transcript' });
  const input = h('input', { type: 'text', placeholder: 'Type to Lily…', 'aria-label': 'Type a message to Lily', maxlength: '500', autocomplete: 'off' });
  const form = h('form.compose', { onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (v) { c.sendText(v); input.value = ''; } } }, input, h('button.btn.primary', { type: 'submit' }, icon('send'), 'Send'));
  const muteBtn = h('button.mute', { type: 'button', 'aria-pressed': 'false', onclick: () => c.setMuted(!c.muted) }, icon('mic'), h('span.lbl', 'Mute'));
  const ccBtn = h('button.cc', { type: 'button', 'aria-pressed': 'true', onclick: () => { captions = !captions; ccBtn.setAttribute('aria-pressed', String(captions)); list.hidden = !captions; } }, icon('cc'), h('span.lbl', 'Captions'));
  const humanBtn = h('button.human', { type: 'button', onclick: () => c.requestHuman() }, icon('headset'), 'Transfer to a human');
  const endBtn = h('button.endc', { type: 'button', onclick: () => c.end() }, icon('end'), 'End call');
  const tagsEl = h('dl.tags2'); const stageBar = h('div.stagebar'); const tl = h('ol.tl'); const tlSub = h('p.subt');
  const btc = h('aside.card.btc', { 'aria-label': 'Behind the conversation' }, h('h2', icon('activity'), 'Behind the conversation'), tlSub, stageBar, tagsEl, tl);

  function drawHead() {
    const v = c.view ?? {};
    const secs = v.session?.answeredAt ? Math.round((Date.now() - Date.parse(v.session.answeredAt)) / 1000) : 0;
    const verified = v.tags?.identity === 'verified';
    head.replaceChildren(
      h('div.av', icon('wave'), h(`i${c.voiceReady ? '' : '.off'}`)),
      h('div', h('h1', c.agent.name, h(`i.flag.${c.agent.lang}`, { title: `${c.agent.name} speaks ${{ en: 'English', my: 'Burmese', fil: 'Tagalog' }[c.agent.lang]}` })), h('div.meta', h('span.t', fmtDur(secs)), h('span', '·'), h('span', c.voiceReady ? 'Live voice' : 'Typing mode'))),
      h('div.cust', h('span.mono2', c.card.name.split(' ').map((x) => x[0]).join('').slice(0, 2)), h('div', h('b', c.card.name, verified ? icon('check') : null), h('span', verified ? 'Identity verified · test customer' : v.tags?.identity === 'failed' ? 'Verification failed' : 'Not verified yet · test customer'))));
  }
  function drawTranscript() {
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    let agentNow = 'Lily';
    const nodes = c.turns.map((tr) => {
      if (tr.kind?.startsWith('agent_switch:')) agentNow = tr.kind.slice(13);
      if (/^\[Pressed|^\[Asked|^\[Confirmed|^\[Declined/.test(tr.text)) return h('div.note', tr.text.replace(/^\[|\]$/g, ''));
      if (tr.speaker === 'customer' && /^\[verification answer/.test(tr.text)) return h('div.b.cust', h('div.wl', h('b', 'You'), tr.at ? h('span', fmtTime(tr.at)) : null), h('div.txt', h('i', 'Security answer given · not stored')));
      if (tr.speaker === 'system' || !['customer', 'assistant', 'agent'].includes(tr.speaker)) return tr.text ? h('div.note', tr.text.replace(/\s*\[[^\]]*\]\s*/g, ' ').trim()) : null;
      const cls = tr.speaker === 'customer' ? 'cust' : tr.speaker === 'assistant' ? 'lily' : 'agent';
      const who = cls === 'lily' ? [h('span.av', agentNow[0]), h('b', agentNow)] : cls === 'agent' ? [h('b', 'Human agent')] : [h('b', 'You')];
      return h(`div.b.${cls}`, h('div.wl', who, tr.at ? h('span', fmtTime(tr.at)) : null), h('div.txt', tr.text));
    });
    for (const sp of ['customer', 'assistant']) if (c.partial[sp]) nodes.push(h(`div.b.partial.${sp === 'customer' ? 'cust' : 'lily'}`, h('div.wl', sp === 'customer' ? h('b', 'You') : [h('span.av', c.agent.name[0]), h('b', c.agent.name)], h('span', sp === 'customer' ? 'hearing…' : 'speaking…')), h('div.txt', c.partial[sp])));
    list.replaceChildren(...nodes.filter(Boolean));
    if (atBottom || c.partial.customer || c.partial.assistant) list.scrollTop = list.scrollHeight;
  }
  function drawActivity() {
    // Technical steps (tool calls, model confidence, knowledge lookups) stay out of the customer's view.
    const evs = c.events.filter((e) => !/^(voice\.|tool\.|kb\.|input\.|account\.read|tags\.updated|call\.tagged|analysis\.|summary\.generated|disclosure\.|demo\.|verification\.(readback|timing|card_noted))/.test(e.type));
    const ok = evs.filter((e) => e.status === 'ok').length;
    const pend = evs.filter((e) => e.status === 'pending' || e.status === 'running').length;
    tlSub.textContent = `${ok} steps done · ${pend} in progress`;
    const seen = new Set(evs.map((e) => e.stage)); const last = evs[evs.length - 1]?.stage;
    stageBar.replaceChildren(...STAGES.map((k) => h(`span${k === last ? '.on' : seen.has(k) ? '.seen' : ''}`, STAGE_LABEL[k])));
    const badge = (e) => e.type.startsWith('verification') && e.status === 'ok' ? ['ok', 'Verified'] : e.type === 'actions.proposed' ? ['pending', 'Awaiting consent'] : e.type.startsWith('handoff.') && e.status !== 'failed' ? ['escalated', e.type === 'handoff.connected' ? 'Accepted' : 'Handover'] : [e.status, { ok: 'Done', warn: 'Attention', failed: 'Failed', blocked: 'Blocked', pending: 'Pending', running: 'Running', info: 'Info' }[e.status] ?? e.status];
    tl.replaceChildren(...(evs.length ? [...evs].reverse().map((e, i) => {
      const [cls, label] = badge(e);
      return h(`li${i === 0 ? '.fresh' : ''}`, h(`span.n.${cls === 'escalated' ? 'blocked' : cls}`), h('div', h('div.top2', h('b', e.title), h(`span.st.${cls}`, label)), h('div.when', `${fmtTime(e.at)} · ${STAGE_LABEL[e.stage] ?? e.stage}`), e.detail && /^(verification\.(failed|retry)|actions?\.|consent\.|handoff\.|safety\.|case\.|ticket\.)/.test(e.type) ? h('div.det', e.detail) : null));
    }) : [h('li', h('span.n.info'), h('p.small.muted', 'Nothing yet. Each step (verification, checks, actions) appears here as it happens.'))]));
  }
  function drawSide() {
    const v = c.view ?? {};
    const tg = v.tags;
    if (tg) {
      const sec = (tg.secondaryIntents ?? []).map((x) => x.label).join(', ') || 'None';
      tagsEl.replaceChildren(...[['Primary intent', tg.intentLabel], ['Also', sec], ['Identity', tg.identity], ['Urgency', tg.urgency], ['Sentiment (indicative)', tg.sentiment], ['Case', `${tg.caseStatus}${v.case ? ' · ' + v.case.id : ''}`]].map(([k, val]) => h('div', h('dt', k), h('dd', String(val ?? '—').replace(/_/g, ' ')))));
    }
    // What Lily heard (card number capture) and simulated passcode.
    const bits = [];
    const cc = v.cardCapture;
    if (cc) bits.push(h('div.heard', { role: 'status', 'aria-live': 'polite' }, h('span.cap', 'What Lily heard'), h('b.num', group4(String(cc.digits ?? '').replace(/ /g, '').padEnd(16, '•'))), h('p', cc.confirming ? 'All 16 digits heard. Say “yes” if this is right, or say the correct digits.' : `${cc.count ?? 0} of 16 digits. Keep reading the card number from the test-data panel.`)));
    if (v.demoDevice) bits.push(h('div.passcode', icon('lock'), h('span', h('b', 'Test passcode: '), 'read this to Lily'), h('b.mono', v.demoDevice.code)));
    extras.replaceChildren(...bits);
    // Consent (buttons work in typing mode; in voice mode just say yes or no).
    if (v.proposal && v.pending?.kind === 'consent') {
      consentEl.replaceChildren(h('section.consent', { role: 'group', 'aria-label': 'Confirm the proposed actions' },
        h('span.badge.solid', 'Awaiting your consent'), h('h3', 'Lily is asking for your confirmation'),
        h('ol', v.proposal.actions.map((a) => h('li', a.label))),
        h('p.small.muted', c.voiceReady ? 'Say “yes” or “no” to Lily. Nothing happens until you clearly confirm.' : 'Nothing happens until you confirm.'),
        c.voiceReady ? null : h('div.row', h('button.btn.mint', { type: 'button', onclick: () => c.consent('accept') }, icon('check'), 'Confirm'), h('button.btn.coral-o', { type: 'button', onclick: () => c.consent('decline') }, 'Decline'))));
    } else consentEl.replaceChildren();
    // Handover status: requested → waiting → accepted, never claimed early.
    const hd = v.handoff;
    if (hd && hd.status !== 'cancelled') {
      const acc = hd.status === 'connected' || hd.status === 'completed';
      handEl.replaceChildren(h(`div.handover${acc ? '.ok' : ''}`, { role: 'status' }, h('span.ic', icon('headset')),
        h('div', h('b', acc ? `Agent connected${hd.agentName ? ' · ' + hd.agentName : ''}` : hd.status === 'no_agent' ? 'No agent available' : 'Waiting for a human agent'),
          h('span', acc ? 'A person accepted the handover and can see everything so far.' : hd.status === 'no_agent' ? 'Your details are saved for a callback.' : 'Your case is with the agent team. Open the Agent CRM to accept it as the agent.')),
        !acc && hd.status !== 'no_agent' ? h('a.btn.sm', { href: `/#/crm/call/${encodeURIComponent(c.id)}`, target: '_blank', rel: 'noopener' }, 'Accept as the agent ↗') : null));
    } else handEl.replaceChildren();
    const banners = [];
    if (c.micDenied && c.voiceReady) banners.push(h('p.banner', 'Microphone blocked — type below. Lily will still answer out loud.'));
    if (c.banner) banners.push(h(`p.banner.${c.banner.kind}`, c.banner.text));
    bannerEl.replaceChildren(...banners);
  }
  function refresh() {
    const st = c.state;
    const [label, subText] = STATE_TEXT[st] ?? [st, ''];
    stage.dataset.state = st;
    stage.classList.toggle('typing', st === 'typing');
    pill.replaceChildren(icon(st === 'speaking' ? 'volume' : st === 'muted' ? 'micOff' : st === 'processing' ? 'activity' : st === 'waiting' || st === 'agent' ? 'headset' : st === 'typing' ? 'keyboard' : 'mic'), label);
    sub.textContent = subText;
    const segKey = st === 'hearing' ? 'listening' : st;
    for (const [k, el] of Object.entries(seg)) el.setAttribute('aria-current', String(k === segKey));
    muteBtn.disabled = !c.mic || !c.voiceReady;
    muteBtn.setAttribute('aria-pressed', String(c.muted));
    muteBtn.replaceChildren(icon(c.muted ? 'micOff' : 'mic'), h('span.lbl', c.muted ? 'Unmute' : 'Mute'));
    humanBtn.disabled = !!(c.view?.handoff && c.view.handoff.status !== 'cancelled');
    endBtn.disabled = c.ending;
    drawSide();
  }

  /* visualizer: driven by the real mic / playback level */
  const ctx = canvas.getContext('2d');
  let raf = 0; const BARS = 56; const vals = new Float32Array(BARS);
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  function frame(now) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth; const hh = canvas.clientHeight;
    if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = hh * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    const st = c.state; const cx = w / 2; const cy = hh / 2; const R = Math.min(w, hh) * 0.3;
    const level = st === 'speaking' ? c.player?.level ?? 0 : st === 'hearing' || st === 'listening' ? c.mic?.level ?? 0 : 0;
    const col = st === 'speaking' || st === 'processing' ? [117, 101, 232] : st === 'hearing' || st === 'listening' || st === 'agent' ? [191, 232, 213] : st === 'reconnecting' ? [241, 138, 114] : [170, 166, 190];
    const g = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 1.9);
    g.addColorStop(0, `rgba(${col},${0.08 + level * 0.5})`); g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R * 1.9, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = `rgba(${col},0.9)`; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    if (st === 'processing' && !reduced) { const a = (now / 450) % (Math.PI * 2); ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.beginPath(); ctx.arc(cx, cy, R, a, a + 0.9); ctx.stroke(); }
    ctx.lineCap = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = `rgba(${col},0.95)`;
    for (let i = 0; i < BARS; i++) {
      const target = level * (reduced ? 0.6 : 0.45 + 0.55 * Math.abs(Math.sin(i * 1.7 + now / 140)));
      vals[i] += (target - vals[i]) * 0.35;
      if (vals[i] < 0.02) continue;
      const a = (i / BARS) * Math.PI * 2 - Math.PI / 2; const len = 4 + vals[i] * R * 0.6;
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (R + 6), cy + Math.sin(a) * (R + 6)); ctx.lineTo(cx + Math.cos(a) * (R + 6 + len), cy + Math.sin(a) * (R + 6 + len)); ctx.stroke();
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  let n = 0;
  const tick = setInterval(() => {
    if (c.ended) return clearInterval(tick);
    refresh(); if (++n % 4 === 0) drawHead();
    const hs = c.view?.handoff?.status;
    if (n % 8 === 0 && (['requested', 'queued', 'connected'].includes(hs) || !c.voiceReady)) c.poll();
  }, 250);
  c.ui = { refresh, transcript: drawTranscript, activity: drawActivity, stop: () => { cancelAnimationFrame(raf); clearInterval(tick); } };

  render('talk', h('main.judge.in-call',
    testPanel(true),
    h('section.call-main', { 'aria-label': 'Live call with Lily' }, head, stage, bannerEl, extras, handEl, consentEl,
      h('section.card.tx', h('div.tx-h', h('h2', 'Live transcript'), h('span.badge.lav', c.voiceReady ? 'Live captions' : 'Typed')), list, form),
      h('div.controls', { role: 'toolbar', 'aria-label': 'Call controls' }, muteBtn, ccBtn, h('span.sp'), humanBtn, endBtn)),
    btc));
  drawHead(); drawTranscript(); drawActivity(); refresh();
  if (!c.voiceReady) { c.loadTimeline(); input.focus({ preventScroll: true }); }
}

route();
