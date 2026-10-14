// Hear It Once — landing, live call workspace and resolution brief (one page, hash routes).
// Everything shown comes from the backend: the call view, the live timeline stream (SSE) and the
// brief are built from recorded state. Nothing here fabricates an outcome.
import { api, h, mount, chip, humanise, fmtTime, uid, topbar } from './lib.js';
import { icon } from './icons.js';
import { createOrb } from './orb.js';
import { VoiceInput, VoiceOutput, voiceSupport } from './voice.js';

const app = document.getElementById('app');
const live = document.getElementById('sr-live');

const STAGES = ['understand', 'verify', 'investigate', 'explain', 'confirm', 'act', 'record', 'resolve', 'handoff'];
const STAGE_LABEL = { understand: 'Understand', verify: 'Verify', investigate: 'Investigate', explain: 'Explain', confirm: 'Confirm', act: 'Act', record: 'Record', resolve: 'Resolve', handoff: 'Handoff' };
const PROMPTS = [
  "I don't recognise a transaction for $84.50.",
  "I've lost my card. Can you block it?",
  "I made a payment yesterday, but it hasn't appeared.",
  'Why was I charged this fee?',
  'I think I was charged twice for the same purchase.',
];
const JUDGE_SCENARIOS = [
  { id: 'S01', ic: 'receipt', title: 'Unrecognised transaction', line: 'Verifies you, checks six systems at once, then blocks, replaces and disputes — only after you confirm.' },
  { id: 'S02', ic: 'card', title: 'Lost or stolen card', line: 'Identity first, then the block, before any other question.' },
  { id: 'S04', ic: 'clock', title: 'Payment not showing', line: 'Says exactly what the payment system returned. No invented posting dates.' },
  { id: 'S05', ic: 'receipt', title: 'Fee query — eligible reversal', line: 'A rule-checked courtesy reversal, confirmed by the fee ledger.' },
  { id: 'S06', ic: 'shield', title: 'Fee query — not eligible', line: 'Explains which rule applies and offers a person.' },
  { id: 'S08', ic: 'headset', title: 'Ask for a person', line: 'Immediate warm handoff with a complete agent brief.' },
  { id: 'S10', ic: 'lock', title: 'Verification fails', line: 'Nothing disclosed, nothing changed, safe escalation.' },
  { id: 'S11', ic: 'alert', title: 'A bank system is down', line: 'One lookup fails — the assistant won’t decide on partial data.' },
  { id: 'S13', ic: 'alert', title: 'Card block fails', line: 'Never reports success it didn’t get. Urgent escalation.' },
  { id: 'S15', ic: 'repeat', title: 'Duplicate request', line: 'Confirm twice at once — the card is blocked exactly once.' },
];

const S = {
  scenarios: [],
  env: null,
  call: null, // { id, token, scenario, view, timeline[], es, lastEvent, renderedIds:Set }
  voiceMode: false,
  readAloud: false,
  listening: false,
  interim: '',
  busy: false,
  queue: [],
  voiceNote: null,
  orb: null,
};

/* ------------------------------------------------------------------ voice */
const vIn = new VoiceInput({
  onStart: () => {
    S.listening = true;
    S.voiceNote = null;
    S.orb?.setState('listening', 'Listening — tap to stop');
    renderStatus();
    renderComposer();
  },
  onInterim: (t) => {
    S.interim = t;
    renderInterim();
  },
  onFinal: (t, conf) => {
    S.interim = '';
    renderInterim();
    sendUtterance(t, conf);
  },
  onError: (code, msg) => {
    S.voiceNote = { code, msg };
    S.listening = false;
    S.orb?.setState('error', 'Microphone unavailable — type instead');
    if (code === 'not-allowed' || code === 'unsupported' || code === 'service-not-allowed' || code === 'audio-capture') S.voiceMode = false;
    renderStatus();
    renderComposer();
  },
  onEnd: () => {
    S.listening = false;
    if (S.orb?.state === 'listening') S.orb.setState(S.busy ? 'processing' : 'idle');
    renderStatus();
    renderComposer();
  },
  onLevels: (lv) => S.orb?.setLevels(lv),
});
const vOut = new VoiceOutput({
  onStart: () => {
    S.orb?.setState('speaking', 'Assistant speaking — tap to interrupt');
    renderStatus();
  },
  onBoundary: () => S.orb?.pulse(1),
  onEnd: () => {
    if (S.orb?.state === 'speaking') S.orb.setState(callEnded() ? 'done' : 'idle');
    renderStatus();
    maybeListenAgain();
  },
});

function startListening() {
  if (!voiceSupport.input) {
    S.voiceNote = { code: 'unsupported', msg: 'Voice input isn’t supported in this browser (try Chrome or Edge). Type below — it works the same way.' };
    renderComposer();
    return;
  }
  if (speechSynthesis?.speaking) vOut.cancel();
  if (S.call && !callEnded()) api(`/api/calls/${S.call.id}/input`, { method: 'POST', body: { kind: 'interrupt' } }).catch(() => {});
  S.voiceMode = true;
  if (S.readAloud === false && voiceSupport.output) S.readAloud = true;
  vOut.enabled = S.readAloud;
  S.orb?.setState('processing', 'Requesting microphone…');
  S.voiceNote = { code: 'requesting', msg: 'Waiting for microphone permission…' };
  renderComposer();
  vIn.start();
}
function stopListening() {
  vIn.stop();
  S.voiceMode = false;
}
function maybeListenAgain() {
  if (S.voiceMode && S.call && !callEnded() && !S.listening && !S.busy && S.call.view?.session.stage !== 'handoff') setTimeout(() => S.voiceMode && !S.listening && !S.busy && vIn.start(), 350);
}

/* ------------------------------------------------------------------ routing */
window.addEventListener('hashchange', route);
async function route() {
  const hash = location.hash || '#/';
  if (hash.startsWith('#/brief/')) return renderBrief(hash.slice(8));
  if (hash.startsWith('#/call')) return renderWorkspace();
  return renderLanding();
}

async function boot() {
  try {
    [S.scenarios, S.env] = await Promise.all([api('/api/scenarios').then((r) => r.items), api('/api/demo/environment')]);
  } catch {
    S.scenarios = [];
  }
  // Resume an in-progress call after refresh (state always comes from the server).
  try {
    const saved = JSON.parse(sessionStorage.getItem('hio.call') ?? 'null');
    if (saved && (location.hash.startsWith('#/call') || location.hash.startsWith('#/brief'))) {
      S.call = { ...saved, timeline: [], renderedIds: new Set(), lastEvent: 0 };
      S.call.scenario = S.scenarios.find((x) => x.id === saved.scenarioId) ?? null;
      await refreshView();
      openStream();
    }
  } catch {
    S.call = null;
  }
  route();
}

/* ------------------------------------------------------------------ calls */
const callEnded = () => S.call?.view?.session.stage === 'ended';

async function startCall({ scenarioId = null, free = false, voice = false, firstUtterance = null } = {}) {
  closeStream();
  vOut.cancel();
  S.call = { id: null, token: null, scenario: S.scenarios.find((x) => x.id === scenarioId) ?? null, view: null, timeline: [], renderedIds: new Set(), lastEvent: 0, starting: true };
  S.readAloud = voice && voiceSupport.output;
  vOut.enabled = S.readAloud;
  location.hash = '#/call';
  if (voice) startListening(); // keep the click's user gesture for the permission prompt
  try {
    const body = { channel: voice ? 'voice_browser' : 'text_simulator' };
    if (scenarioId) Object.assign(body, { scenarioId, resetScenario: true });
    else if (free) body.mode = 'free';
    const r = await api('/api/calls', { method: 'POST', body });
    Object.assign(S.call, { id: r.sessionId, token: r.callToken, view: r.view, starting: false });
    sessionStorage.setItem('hio.call', JSON.stringify({ id: r.sessionId, scenarioId }));
    S.call.seenTurns = 0;
    openStream();
    renderWorkspace();
    speakNew(r.view);
    if (firstUtterance) await sendUtterance(firstUtterance);
    for (const q of S.queue.splice(0)) await sendUtterance(q.text, q.conf);
  } catch (e) {
    toast(`Couldn’t start the call: ${e.message}`);
    S.call.starting = false;
    renderWorkspace();
  }
}

async function send(input) {
  if (!S.call?.id) return;
  S.busy = true;
  if (!S.listening) S.orb?.setState('processing', 'Understanding…');
  renderStatus();
  renderComposer();
  try {
    const view = await api(`/api/calls/${S.call.id}/input`, { method: 'POST', body: input });
    applyView(view);
  } catch (e) {
    toast(e.status === 429 ? 'Too many requests — wait a moment and retry.' : `That didn’t go through: ${e.message}. Use Retry to send it again.`);
    S.lastFailed = input;
  } finally {
    S.busy = false;
    if (S.orb?.state === 'processing') S.orb.setState(callEnded() ? 'done' : 'idle');
    renderStatus();
    renderComposer();
    maybeListenAgain();
  }
}

function sendUtterance(text, conf) {
  if (!S.call?.id) {
    S.queue.push({ text, conf });
    return;
  }
  S.lastSaid = text;
  return send({ kind: 'utterance', text, clientMessageId: uid(), ...(conf != null ? { asrConfidence: conf } : {}) });
}

async function refreshView() {
  if (!S.call?.id) return;
  const v = await api(`/api/calls/${S.call.id}`);
  applyView(v, true);
}

function applyView(view, quiet = false) {
  const prevOps = new Map((S.call.view?.operations ?? []).map((o) => [o.id, o.status]));
  S.call.view = view;
  S.call.justConfirmed = new Set(view.operations.filter((o) => o.status === 'succeeded' && prevOps.get(o.id) && prevOps.get(o.id) !== 'succeeded').map((o) => o.id));
  if (location.hash.startsWith('#/call')) renderWorkspaceParts();
  if (!quiet) speakNew(view);
  if (callEnded()) S.orb?.setState('done', 'Call ended');
}

function speakNew(view) {
  const fresh = view.transcript.slice(S.call.seenTurns ?? 0);
  S.call.seenTurns = view.transcript.length;
  const said = fresh.filter((t) => t.speaker === 'assistant' || t.speaker === 'agent').map((t) => t.text);
  if (said.length) live.textContent = said.join(' ');
  if (S.readAloud) for (const t of said) vOut.speak(t);
}

/* ------------------------------------------------------------------ live stream */
function openStream() {
  if (!S.call?.id || S.call.es) return;
  const es = new EventSource(`/api/calls/${S.call.id}/stream`);
  S.call.es = es;
  es.addEventListener('timeline', (m) => {
    const e = JSON.parse(m.data);
    if (S.call.timeline.some((x) => x.id === e.id)) return;
    S.call.timeline.push(e);
    S.call.lastEvent = e.id;
    if (location.hash.startsWith('#/call')) {
      renderLanes();
      renderStream();
      renderStepper();
    }
    if (/^(action\.|handoff\.connected|handoff\.completed|call\.closed)/.test(e.type)) debounceRefresh();
  });
  es.onerror = () => {
    /* EventSource reconnects automatically with Last-Event-ID */
  };
}
function closeStream() {
  S.call?.es?.close();
  if (S.call) S.call.es = null;
}
let refreshTimer = 0;
function debounceRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => !S.busy && refreshView().catch(() => {}), 250);
}

/* ================================================================== LANDING */
function renderLanding() {
  S.orb?.destroy();
  const orb = createOrb({ label: 'Talk to the AI — starts your microphone', onActivate: () => startCall({ free: true, voice: true }) });
  S.orb = orb;
  const input = h('input', { type: 'text', placeholder: 'Or type what you’d say…', 'aria-label': 'Type what you would say to the assistant', autocomplete: 'off' });
  const caption = h('div.orb-caption', voiceSupport.input ? [h('strong', 'Tap to talk.'), ' Your browser will ask to use the microphone.'] : 'Voice input isn’t available in this browser — type instead. Everything else works the same.');
  const proofEl = h('div');
  mount(
    app,
    topbar('home'),
    h(
      'main.landing',
      h(
        'section.hero',
        h(
          'div',
          h('h1', h('span', 'One conversation.'), h('span', 'Every action handled.'), h('span', 'Nothing lost.')),
          h('p.lede', 'An AI-powered card services assistant that resolves customer issues, follows contact-center procedures, and gives human agents the full context when they need to step in.'),
          h(
            'div.ctas',
            h('button.primary.lg', { onclick: () => startCall({ free: true, voice: voiceSupport.input }) }, icon('mic'), 'Talk to the AI'),
            h('a.btn.lg', { href: '/dashboard.html' }, icon('layers'), 'Explore the operations view'),
          ),
          h('p.honesty', 'Demo environment: synthetic customers and simulated bank systems. No real card, payment or dispute is ever touched, and no audio is stored.'),
        ),
        h(
          'div.hero-stage',
          orb.el,
          caption,
          h(
            'div.try',
            h('form', { onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (v) startCall({ free: true, firstUtterance: v }); } }, input, h('button', { type: 'submit' }, icon('send'), 'Start')),
            h('div.prompts', { role: 'group', 'aria-label': 'Example requests' }, PROMPTS.map((p) => h('button', { type: 'button', onclick: () => startCall({ free: true, firstUtterance: p }) }, p))),
          ),
        ),
      ),
      h(
        'section.l-section',
        h('h2', 'Try a scenario'),
        h('p.sub', 'Each one starts a fresh call with its own synthetic customer and resets that customer’s data, so you can replay it as often as you like. Successful paths and failure paths are both real.'),
        h(
          'div.scenario-table',
          JUDGE_SCENARIOS.map((sc) =>
            h('div.scenario-row', h('span.ic', icon(sc.ic)), h('div', h('h3', sc.title), h('p', sc.line)), h('button', { onclick: () => startCall({ scenarioId: sc.id }), 'aria-label': `Start scenario: ${sc.title}` }, 'Start')),
          ),
        ),
        h('p.small.muted', { style: 'margin-top:14px' }, 'All 18 test scenarios, with scripted lines, are in the ', h('a', { href: '/lab.html' }, 'scenario lab'), '.'),
      ),
      h(
        'section.l-section',
        h('h2', 'What happens behind every call'),
        h('p.sub', 'The assistant follows the same procedure every time. Each step writes a real event you can watch live in the operations stream.'),
        h(
          'ol.flow',
          [
            ['Understand', 'Captures the issue in your words, once'],
            ['Verify', 'Two factors before any account data'],
            ['Investigate', 'Checks six systems in parallel'],
            ['Explain', 'Facts, rules and options in plain language'],
            ['Confirm', 'Nothing happens without your yes'],
            ['Act', 'Policy-checked, idempotent actions'],
            ['Record', 'Case and summary written during the call'],
            ['Resolve', 'Says what is done and what is pending'],
            ['Handoff', 'A person gets the full brief'],
          ].map(([b, t]) => h('li', h('b', b), t)),
        ),
        proofEl,
      ),
      h(
        'section.l-section',
        h('h2', 'What’s real and what’s simulated'),
        h('p.sub', 'Every connector is a replaceable adapter. In this demo they are deterministic simulations over synthetic data; the workflows, policy checks and safety rules are the real application.'),
        h('div.connectors', (S.env?.connectors ?? []).map((c) => h('div', h('span', c.label), chip(c.status === 'simulated' ? 'pending' : 'ok', humanise(c.status))))),
      ),
      h('footer.l-foot', h('span', 'Hear It Once — prototype for demonstration. Not a bank product; no compliance claims.'), h('span', h('a', { href: '/agent.html' }, 'Agent console'), ' · ', h('a', { href: '/dashboard.html' }, 'Operations'), ' · ', h('a', { href: '/lab.html' }, 'Scenario lab'))),
    ),
  );
  loadProof(proofEl);
}

async function loadProof(el) {
  try {
    const a = await api('/api/demo/activity');
    mount(
      el,
      h(
        'div.proof',
        h('div.stat-list', h('div', h('b.num', a.calls), h('span', 'demo calls in the last 24 hours')), h('div', h('b.num', a.resolved), h('span', 'resolved by the assistant')), h('div', h('b.num', a.handedOff), h('span', 'handed to a person')), h('div', h('b.num', a.actionsConfirmed), h('span', 'actions confirmed by (simulated) systems'))),
        h(
          'div',
          h('div.ops-h', h('h2', 'The most recent demo call, step by step'), h('span', a.label)),
          a.lastCallTrail.length
            ? h('ul.stream', a.lastCallTrail.slice(-14).map((e) => h('li', h('span.t', fmtTime(e.at)), h('span', { class: `dot ${e.status}` }), h('div.what', h('b', e.title), h('div.meta', STAGE_LABEL[e.stage])))))
            : h('p.empty', 'No demo calls have finished yet. Yours will appear here.'),
        ),
      ),
    );
  } catch {
    mount(el);
  }
}

/* ================================================================== WORKSPACE */
const W = {};
function renderWorkspace() {
  if (!S.call) {
    location.hash = '#/';
    return;
  }
  S.orb?.destroy();
  const orb = createOrb({ label: 'Tap to talk', onActivate: () => (S.listening ? stopListening() : S.orb?.state === 'speaking' ? (vOut.cancel(), startListening()) : startListening()) });
  S.orb = orb;
  if (S.listening) orb.setState('listening');
  else if (callEnded()) orb.setState('done');
  Object.assign(W, {
    stepper: h('ol.stepper', { 'aria-label': 'Call stage' }),
    status: h('div.status', { 'aria-live': 'polite' }),
    persona: h('div'),
    convo: h('div.convo', { role: 'log', 'aria-label': 'Conversation' }),
    interim: h('div'),
    consent: h('div'),
    cta: h('div'),
    composer: h('div.composer2'),
    tags: h('section'),
    lanes: h('section'),
    acts: h('section'),
    stream: h('section'),
    kb: h('section'),
    caseEl: h('section'),
  });
  mount(
    app,
    h(
      'div.ws-bar',
      h('a.wordmark', { href: '#/', onclick: () => vIn.stop() }, h('b', 'Hear It Once')),
      W.stepper,
      h('span.env-pill', 'Demo · synthetic data'),
      h('button.ghost', { onclick: replay, title: 'Reset this scenario’s data and start again' }, icon('retry'), 'Reset & replay'),
      h('button.danger', { onclick: () => send({ kind: 'hangup' }), disabled: callEnded() || !S.call.id }, icon('end'), 'End call'),
    ),
    h(
      'main.ws',
      h('div.ws-left', h('div.ws-head', orb.el, W.status), W.persona, W.convo, W.interim, W.cta, W.consent, W.composer),
      h('aside.ws-right', { 'aria-label': 'Operations view' }, W.tags, W.lanes, W.acts, W.stream, W.kb, W.caseEl),
    ),
  );
  if (!S.call.timeline.length && S.call.id) {
    api(`/api/calls/${S.call.id}/timeline`).then((r) => {
      for (const e of r.items) if (!S.call.timeline.some((x) => x.id === e.id)) S.call.timeline.push(e);
      renderLanes();
      renderStream();
      renderStepper();
    }).catch(() => {});
  }
  renderWorkspaceParts();
}

function renderWorkspaceParts() {
  if (!W.convo || !S.call) return;
  renderStepper();
  renderStatus();
  renderPersona();
  renderConvo();
  renderInterim();
  renderConsent();
  renderCta();
  renderComposer();
  renderTags();
  renderLanes();
  renderActs();
  renderStream();
  renderKb();
  renderCase();
}

function renderStepper() {
  if (!W.stepper) return;
  const v = S.call.view;
  const now = v?.workflow.stage ?? 'understand';
  const visited = new Set([...(v?.workflow.visited ?? []), ...S.call.timeline.map((e) => e.stage)]);
  const stages = STAGES.filter((s) => s !== (visited.has('handoff') || now === 'handoff' ? 'resolve' : 'handoff') || s === now);
  mount(W.stepper, stages.map((s) => h(`li.${s === now ? 'now' : visited.has(s) ? 'done' : 'todo'}`, { 'aria-current': s === now ? 'step' : null }, h('span.pip'), STAGE_LABEL[s])));
}

function renderStatus() {
  if (!W.status) return;
  const v = S.call?.view;
  let title = 'Connecting…';
  let sub = '';
  if (S.call?.id) {
    const stage = v?.session.stage;
    if (S.listening) [title, sub] = ['Listening…', 'Speak naturally. Tap the orb when you’re done.'];
    else if (S.busy) [title, sub] = ['Understanding…', 'Checking what you said against the procedure.'];
    else if (S.orb?.state === 'speaking') [title, sub] = ['Speaking', 'Tap the orb to interrupt.'];
    else if (stage === 'ended') [title, sub] = ['Call ended', humanise(v.session.outcome)];
    else if (stage === 'handoff') [title, sub] = [v.handoff?.status === 'connected' ? 'Connected to an agent' : 'Waiting for an agent', v.handoff?.status === 'connected' ? 'Simulated agent desk' : 'Simulated desk — accept it in the agent console'];
    else if (v?.pending?.kind === 'consent') [title, sub] = ['Waiting for your confirmation', 'Nothing changes until you say yes.'];
    else if (stage === 'awaiting_dob' || stage === 'awaiting_otp' || stage === 'identifying') [title, sub] = ['Verifying your identity', stage === 'awaiting_otp' ? 'Read the passcode from the simulated phone.' : 'Your date of birth, then a passcode.'];
    else [title, sub] = ['Your turn', S.voiceMode ? 'Tap the orb to speak.' : voiceSupport.input ? 'Tap the orb to speak, or type below.' : 'Type below.'];
  }
  mount(W.status, h('b', title), h('span', sub));
}

function renderPersona() {
  const v = S.call.view;
  const p = v?.persona;
  const dev = v?.demoDevice;
  mount(
    W.persona,
    p
      ? h(
          'div.persona',
          icon('user'),
          h('span', 'Calling as ', h('b', p.name), ' — synthetic customer', S.call.scenario ? ` · scenario ${S.call.scenario.id}` : ''),
          p.dob ? h('span', 'Date of birth ', h('b.num', p.dob), ' ', h('button.ghost', { onclick: () => sendUtterance(`My date of birth is ${p.dob}`), disabled: !['awaiting_dob'].includes(v.session.stage) }, 'Say it')) : null,
        )
      : v?.freeMode && !v.session.issueType
        ? h('div.persona', icon('user'), h('span', 'Free-talk demo: describe any card problem. A synthetic customer that fits your request is chosen for you.'))
        : null,
    dev ? h('div.phone', { role: 'region', 'aria-label': 'Simulated phone' }, icon('lock'), h('div', h('div.lbl', 'Simulated phone — text message'), h('div.code', dev.code)), h('button.quiet', { onclick: () => sendUtterance(dev.code) }, 'Read it to the assistant')) : null,
  );
}

function renderConvo() {
  const v = S.call.view;
  if (!v) return mount(W.convo, h('p.empty', S.call.starting ? 'Connecting the call…' : 'The call couldn’t be started.'));
  const who = { assistant: 'Assistant (AI)', customer: 'You', agent: 'Agent (simulated)', system: 'Notice' };
  const prev = Number(W.convo.dataset.count ?? 0);
  mount(W.convo, v.transcript.map((t, i) => h(`div.msg.${t.speaker}${i >= prev ? '.fresh' : ''}`, h('div.who', `${who[t.speaker]} · ${fmtTime(t.at)}`), h('div.say', t.text))));
  W.convo.dataset.count = v.transcript.length;
  W.convo.scrollTop = W.convo.scrollHeight;
}

function renderInterim() {
  if (!W.interim) return;
  mount(W.interim, S.interim ? h('div.convo', { style: 'flex:none;padding-top:0' }, h('div.msg.customer.interim', h('div.who', 'You (hearing…)'), h('div.say', S.interim))) : null);
}

function renderConsent() {
  const v = S.call.view;
  if (!v?.proposal || v.pending?.kind !== 'consent') return mount(W.consent);
  const p = v.proposal;
  mount(
    W.consent,
    h(
      'div.consent2',
      { role: 'group', 'aria-label': 'Confirm proposed actions' },
      h('b', 'The assistant needs your confirmation'),
      h('ol', p.actions.map((a) => h('li', a.label))),
      h('p.small.muted', `Policy-checked again at the moment of execution${p.ruleRefs.length ? ` · rule ${p.ruleRefs.join(', ')}` : ''}. You can also just say “yes” or “no”.`),
      h(
        'div.row',
        h('button.primary', { onclick: () => send({ kind: 'consent', proposalId: p.id, decision: 'accept', clientMessageId: uid() }) }, icon('check'), 'Yes, go ahead'),
        h('button', { onclick: () => send({ kind: 'consent', proposalId: p.id, decision: 'decline', clientMessageId: uid() }) }, 'No'),
        h('button.ghost', { onclick: () => send({ kind: 'request_human', clientMessageId: uid() }) }, icon('headset'), 'Talk to a person'),
        S.call.scenario?.id === 'S15' ? h('button.ghost', { onclick: confirmTwice, title: 'Demo: send two identical confirmations at the same time' }, icon('repeat'), 'Confirm twice at once') : null,
      ),
    ),
  );
}

async function confirmTwice() {
  const p = S.call.view.proposal;
  const one = () => api(`/api/calls/${S.call.id}/input`, { method: 'POST', body: { kind: 'consent', proposalId: p.id, decision: 'accept', clientMessageId: uid() } });
  S.busy = true;
  renderStatus();
  const rs = await Promise.allSettled([one(), one()]);
  S.busy = false;
  const v = rs.find((r) => r.status === 'fulfilled')?.value;
  if (v) applyView(v);
  const blocks = (v?.operations ?? []).filter((o) => o.type === 'block_card');
  toast(`Two confirmations sent at once → ${blocks.length} block operation, ${blocks[0]?.attempts ?? 0} submission. The duplicate was ignored.`);
}

function renderCta() {
  const v = S.call.view;
  if (!v) return mount(W.cta);
  const ended = v.session.stage === 'ended';
  const handoff = v.handoff && v.handoff.status !== 'cancelled';
  if (!ended && !handoff) return mount(W.cta);
  mount(
    W.cta,
    h(
      'div.handoff-cta',
      icon(handoff ? 'headset' : 'doc'),
      h('div.grow', h('b', handoff ? (v.handoff.status === 'connected' ? 'An agent has joined with the full brief' : 'Agent brief prepared') : 'Resolution summary ready'), h('span.small.muted', handoff && v.handoff.status === 'queued' ? 'Simulated desk: open the agent console in another tab and accept the call to see the handoff complete.' : 'Built from what actually happened on this call.')),
      h('a.btn.primary', { href: `#/brief/${S.call.id}` }, 'Open the brief'),
      handoff && v.handoff.status === 'queued' ? h('a.btn', { href: '/agent.html', target: '_blank', rel: 'noopener' }, 'Agent console') : null,
    ),
  );
}

function renderComposer() {
  if (!W.composer || !S.call) return;
  const v = S.call.view;
  const ended = v?.session.stage === 'ended';
  const input = h('input', { type: 'text', placeholder: ended ? 'Call ended' : 'Type what you’d say…', 'aria-label': 'Your message', autocomplete: 'off', disabled: ended || !S.call.id });
  input.addEventListener('input', () => S.orb?.state === 'speaking' && vOut.cancel());
  const yesno = v?.choices?.length && v.pending?.kind !== 'consent'
    ? h('div.choices2', v.choices.map((c) => h('button.quiet', { onclick: () => (c.id === '__yes' ? sendUtterance('Yes') : c.id === '__no' ? sendUtterance('No') : send({ kind: 'choice', optionId: c.id, clientMessageId: uid() })) }, c.label)))
    : null;
  const survey = v?.session.stage === 'awaiting_survey' ? h('div.choices2', h('span.small.muted', 'Rate this call (demo survey):'), [1, 2, 3, 4, 5].map((n) => h('button.quiet', { onclick: () => send({ kind: 'survey', score: n }) }, String(n)))) : null;
  const said = new Set((v?.transcript ?? []).filter((t) => t.speaker === 'customer').map((t) => t.text.trim().toLowerCase()));
  const next = S.call.scenario && !ended && v?.pending?.kind !== 'consent' && v?.session.stage !== 'awaiting_dob' && v?.session.stage !== 'awaiting_otp'
    ? S.call.scenario.script.filter((l) => !l.startsWith('<') && !said.has(l.trim().toLowerCase()) && !/^(yes|no)\b/i.test(l)).slice(0, 2)
    : [];
  const script = next.length ? h('div.choices2', h('span.small.muted', 'Try saying:'), next.map((l) => h('button.ghost', { onclick: () => sendUtterance(l) }, `“${l}”`))) : null;
  const note = S.voiceNote && S.voiceNote.code !== 'requesting' ? h('div', { class: `voice-note${S.voiceNote.code === 'not-allowed' || S.voiceNote.code === 'unsupported' || S.voiceNote.code === 'audio-capture' ? ' bad' : ''}` }, icon('alert'), ' ', S.voiceNote.msg) : S.voiceNote ? h('div.voice-note', S.voiceNote.msg) : null;
  mount(
    W.composer,
    yesno,
    survey,
    script,
    note,
    h(
      'form',
      { onsubmit: (e) => { e.preventDefault(); const t = input.value.trim(); if (t) { input.value = ''; sendUtterance(t); } } },
      h('button.mic-btn', { type: 'button', 'aria-pressed': String(S.listening), 'aria-label': S.listening ? 'Stop listening' : 'Start listening', onclick: () => (S.listening ? stopListening() : startListening()), disabled: ended || !S.call.id }, icon(S.listening ? 'stop' : 'mic')),
      input,
      h('button.primary', { type: 'submit', disabled: ended || !S.call.id || S.busy }, icon('send'), 'Send'),
    ),
    h(
      'div.tools',
      h('button.ghost', { onclick: retry, disabled: ended || !S.call.id, title: S.lastFailed ? 'Send the last message again' : 'Listen again' }, icon('retry'), 'Retry'),
      h('button.ghost', { onclick: () => send({ kind: 'request_human', clientMessageId: uid() }), disabled: ended || !S.call.id || v?.session.stage === 'handoff' }, icon('headset'), 'Talk to a person'),
      voiceSupport.output ? h('button.ghost', { 'aria-pressed': String(S.readAloud), onclick: () => { S.readAloud = !S.readAloud; vOut.enabled = S.readAloud; if (!S.readAloud) vOut.cancel(); renderComposer(); } }, icon(S.readAloud ? 'volume' : 'mute'), S.readAloud ? 'Reading replies aloud' : 'Replies muted') : null,
      h('span.grow'),
      h('button.ghost', { onclick: () => { vIn.stop(); vOut.cancel(); closeStream(); sessionStorage.removeItem('hio.call'); S.call = null; location.hash = '#/'; } }, 'Clear & start over'),
    ),
  );
  if (!ended && !S.listening && document.activeElement === document.body) input.focus({ preventScroll: true });
}

function retry() {
  if (S.lastFailed) {
    const i = S.lastFailed;
    S.lastFailed = null;
    return send({ ...i, clientMessageId: i.clientMessageId ? uid() : undefined });
  }
  if (voiceSupport.input) return startListening();
  if (S.lastSaid) return sendUtterance(S.lastSaid);
}

async function replay() {
  vIn.stop();
  vOut.cancel();
  const sc = S.call?.scenario?.id ?? S.call?.view?.persona?.scenarioId ?? null;
  if (sc && S.call?.scenario) return startCall({ scenarioId: sc });
  if (sc) await api(`/api/demo/scenarios/${sc}/reset`, { method: 'POST', body: {} }).catch(() => {});
  return startCall({ free: true });
}

/* ------------------------------------------------------------------ operations panel */
function opsHead(title, aside) {
  return h('div.ops-h', h('h2', title), aside ? h('span', aside) : null);
}

function renderTags() {
  const t = S.call.view?.tags;
  if (!t) return mount(W.tags);
  const prev = W.tags._prev ?? {};
  const cell = (k, label, value) => h('div', h('dt', label), h('dd', { class: prev[k] !== undefined && prev[k] !== value ? 'changed' : null, title: value }, value));
  mount(
    W.tags,
    opsHead('Call tags', 'updated live'),
    h(
      'dl.tags',
      cell('intent', 'Intent', t.intentLabel),
      cell('category', 'Category', t.category),
      cell('urgency', 'Urgency', humanise(t.urgency)),
      cell('identity', 'Identity', humanise(t.identity)),
      cell('sentiment', 'Sentiment (indicative)', humanise(t.sentiment)),
      cell('outcome', 'Outcome', humanise(t.outcome)),
      cell('caseStatus', 'Case', humanise(t.caseStatus)),
      cell('conf', 'Intent confidence', t.intentConfidence == null ? '—' : t.intentConfidence.toFixed(2)),
    ),
  );
  W.tags._prev = { intent: t.intentLabel, category: t.category, urgency: humanise(t.urgency), identity: humanise(t.identity), sentiment: humanise(t.sentiment), outcome: humanise(t.outcome), caseStatus: humanise(t.caseStatus), conf: t.intentConfidence == null ? '—' : t.intentConfidence.toFixed(2) };
}

function renderLanes() {
  if (!W.lanes || !S.call) return;
  const tl = S.call.timeline;
  const q = [...tl].reverse().find((e) => e.type === 'systems.queried');
  if (!q) {
    const verified = S.call.view?.tags?.identity === 'verified';
    return mount(W.lanes, opsHead('Parallel system checks'), h('p.empty', verified ? 'No lookups needed yet.' : 'Starts the moment identity is verified — nothing is read before that.'));
  }
  const after = tl.filter((e) => e.id > q.id);
  const done = new Map(after.filter((e) => e.type === 'source.completed').map((e) => [e.data.source, e]));
  const fin = after.find((e) => e.type === 'systems.completed');
  const conflicts = after.filter((e) => e.type === 'systems.conflict');
  const max = Math.max(60, ...[...done.values()].map((e) => e.data.latencyMs));
  mount(
    W.lanes,
    opsHead('Parallel system checks', 'simulated connectors'),
    h(
      'div.lanes',
      q.data.sources.map((src) => {
        const e = done.get(src);
        const st = !e ? 'running' : e.data.status !== 'ok' ? 'fail' : e.data.stale ? 'stale' : 'ok';
        return h(
          `div.lane.${st}`,
          { title: e ? `${e.title} — ${e.detail}` : 'Running…' },
          h('span', e ? e.title.split(':')[0] : humanise(src)),
          h('span.track', h('span.bar', { style: `width:${e ? Math.max(2, (100 * e.data.latencyMs) / max) : 100}%` })),
          h('span.ms', !e ? 'running' : st === 'fail' ? humanise(e.data.status) : st === 'stale' ? 'stale' : `${e.data.latencyMs} ms`),
        );
      }),
    ),
    h('div.lanes-foot', fin ? [h('span', fin.title), h('span', fin.detail.split(';')[0].replace('Finished in', 'Elapsed'))] : h('span', `${done.size} of ${q.data.sources.length} returned…`)),
    conflicts.map((c) => h('div.conflict', h('b', 'Conflict: '), c.detail)),
  );
}

const LIFE = ['Proposed', 'You confirmed', 'Authorised', 'Submitted', 'Confirmed'];
function lifecycle(o) {
  const cls = Array(5).fill('');
  const label = [...LIFE];
  const on = (n) => { for (let i = 0; i < n; i++) cls[i] = 'on'; };
  switch (o.status) {
    case 'requested': case 'validated': case 'awaiting_confirmation': on(1); break;
    case 'awaiting_approval': on(2); cls[2] = 'warn'; label[2] = 'Needs human approval'; break;
    case 'submitted': on(4); cls[3] = 'warn'; label[3] = 'Pending'; break;
    case 'succeeded': cls.fill('ok'); break;
    case 'failed': on(3); cls[3] = 'bad'; label[3] = 'Failed'; break;
    case 'unknown': on(3); cls[3] = 'warn'; label[3] = 'Outcome unknown'; break;
    case 'rejected':
      on(1);
      if (o.errorCode === 'CUSTOMER_DECLINED' || o.errorCode === 'SUPERSEDED') { cls[1] = 'blocked'; label[1] = 'Declined'; }
      else if (o.errorCode === 'DEPENDENCY_FAILED') { on(2); cls[2] = 'blocked'; label[2] = 'Not attempted'; }
      else { on(2); cls[2] = 'blocked'; label[2] = 'Blocked by policy'; }
      break;
  }
  return h('div.lifecycle', label.map((l, i) => h('span', { class: cls[i] }, l)));
}

function renderActs() {
  const ops = S.call.view?.operations ?? [];
  const gov = { customer_confirmation: 'Requires your confirmation · re-checked by policy at execution', human_approval: 'Requires approval by a human agent', automatic: 'Automatic' };
  mount(
    W.acts,
    opsHead('Actions and authorisation', 'read-only checks need no confirmation'),
    ops.length
      ? h(
          'div.acts',
          ops.map((o) =>
            h(
              `div.act${S.call.justConfirmed?.has(o.id) ? '.confirmed' : ''}`,
              h('div.top', h('b', o.label), chip(o.status === 'submitted' ? 'pending' : o.status === 'rejected' ? 'blocked' : o.status, o.status === 'submitted' ? 'Pending' : o.status === 'rejected' ? (o.errorCode === 'CUSTOMER_DECLINED' ? 'Declined' : 'Blocked') : humanise(o.status))),
              h('div.gov', gov[o.governance] ?? '', o.externalRef ? ` · ref ${o.externalRef}` : '', ` · attempts ${o.attempts}`),
              lifecycle(o),
              o.errorCode && o.status !== 'succeeded' ? h('div.err', `${o.errorCode}: ${o.errorMessage ?? ''}`) : null,
              (o.status === 'unknown' || o.status === 'submitted') && !callEnded() ? h('div.row', h('button', { onclick: () => send({ kind: 'reconcile', clientMessageId: uid() }) }, icon('search'), 'Check its real status')) : null,
            ),
          ),
        )
      : h('p.empty', 'No actions proposed yet. The assistant only proposes actions that the policy engine allows, and only executes them after you confirm.'),
  );
}

function renderStream() {
  if (!W.stream || !S.call) return;
  const tl = S.call.timeline;
  const items = [...tl].reverse();
  mount(
    W.stream,
    opsHead('Live operations stream', `${tl.length} events · newest first`),
    tl.length
      ? h(
          'ul.stream',
          items.map((e) => {
            const isNew = !S.call.renderedIds.has(e.id);
            S.call.renderedIds.add(e.id);
            return h(
              `li${isNew ? '.new' : ''}`,
              h('span.t', fmtTime(e.at)),
              h('span', { class: `dot ${e.status}`, 'aria-label': e.status }),
              h('div.what', h('b', e.title), h('div.meta', h('span.stg', STAGE_LABEL[e.stage]), [e.source, e.ref].filter(Boolean).join(' · ')), e.detail ? h('div.det', e.detail) : null),
            );
          }),
        )
      : h('p.empty', 'Events appear here as the call happens.'),
  );
}

function renderKb() {
  const kb = S.call.view?.knowledge ?? [];
  mount(
    W.kb,
    opsHead('Knowledge used', 'synthetic demo guidance'),
    kb.length
      ? h('div.kb', kb.map((k) => h('article', h('h4', `${k.id} · ${k.title}`), h('p', k.excerpt), h('div.why', `Why: ${k.reason}`, k.supportsNextStep ? ' · supports the proposed next step' : '', k.agentReview ? ' · flagged for agent review' : ''))))
      : h('p.empty', 'Relevant guidance is retrieved once the issue is understood. If nothing matches, the stream says so.'),
  );
}

function renderCase() {
  const c = S.call.view?.case;
  mount(
    W.caseEl,
    opsHead('Case'),
    c
      ? h('div', h('dl.kv', h('dt', 'Case'), h('dd.num', c.id), h('dt', 'Status'), h('dd', chip(c.status)), c.riskFlags.length ? [h('dt', 'Risk flags'), h('dd', c.riskFlags.map(humanise).join(', '))] : null), h('div.row', h('a.btn', { href: `#/brief/${S.call.id}` }, icon('doc'), 'Open the brief')))
      : h('p.empty', 'A case is opened as soon as the caller is verified (or when the call is escalated).'),
  );
}

/* ================================================================== BRIEF */
async function renderBrief(id) {
  vIn.stop();
  S.orb?.destroy();
  S.orb = null;
  mount(app, topbar('home'), h('div.doc-wrap', h('p.empty', 'Loading the brief…')));
  let b;
  try {
    b = await api(`/api/calls/${id}/brief`);
  } catch (e) {
    mount(app, topbar('home'), h('div.doc-wrap', h('div.notice.bad', `This brief isn’t available: ${e.message}. Briefs open in the browser that made the call, or for signed-in staff.`)));
    return;
  }
  const br = b.brief;
  const urgent = br.priority === 'urgent';
  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(b.copyText);
      toast('Summary copied');
    } catch {
      toast('Copy isn’t available here — select the summary text instead.');
    }
  };
  const sc = S.call?.id === id ? S.call.scenario : null;
  const list = (cls, items, empty) => (items.length ? h(`ul.plain.${cls}`, items.map((x) => h('li', typeof x === 'string' ? x : [x.text, x.basis ? h('span.src', ` — ${x.basis}`) : null]))) : h('p.src', empty));
  mount(
    app,
    topbar('home'),
    h(
      'div.doc-wrap',
      h(
        'article.doc',
        { 'aria-label': 'Resolution and agent brief' },
        h(
          'div.doc-top',
          h('div', h('h1', b.headline), h('div.meta', `Case ${b.case?.id ?? "—"} · ${br.issue.label} · call ${b.sessionId} · demo, synthetic data`)),
          h(
            'div.doc-actions',
            h('button.primary', { onclick: doCopy }, icon('copy'), 'Copy summary'),
            S.call?.id === id && !callEnded() ? h('a.btn', { href: '#/call' }, 'Back to the call') : null,
            sc ? h('button', { onclick: () => startCall({ scenarioId: sc.id }) }, icon('retry'), 'Replay scenario') : null,
            h('a.btn', { href: '#/', onclick: () => { sessionStorage.removeItem('hio.call'); } }, 'New call'),
          ),
        ),
        h(
          'div.doc-body',
          h(
            'div.doc-main',
            h('section', h('h2', 'In the customer’s words'), b.customerSaid.length ? [h('p.quote', `“${b.customerSaid[0].text}”`), b.customerSaid.length > 1 ? list('', b.customerSaid.slice(1).map((x) => x.text), '') : null] : h('p.src', 'No statement captured.')),
            h('section', h('h2', 'Summary'), h('p', { style: 'white-space:pre-wrap;font-size:0.93rem' }, b.case?.summary ?? 'No case summary yet.')),
            h('section', h('h2', 'Verified by bank systems (simulated)'), list('facts', b.verifiedFacts, b.brief.customer.verification === 'verified' ? 'Nothing confirmed.' : 'Nothing was read: the caller was not verified.')),
            h('section', h('h2', 'AI interpretation — not facts'), list('interp', b.interpretations, 'None.')),
            h(
              'section',
              h('h2', 'Actions'),
              b.actions.length
                ? h('table', h('thead', h('tr', h('th', 'Action'), h('th', 'Asked for by customer'), h('th', 'Outcome'), h('th', 'Reference'))), h('tbody', b.actions.map((a) => h('tr', h('td', a.label, a.error ? h('div.src', a.error) : null), h('td', a.requestedByCustomer ? 'Yes' : 'No'), h('td', h('span', { class: `pill ${a.bucket}` }, a.statusLabel)), h('td.num', a.reference ?? '—')))))
                : h('p.src', 'No actions were proposed.'),
            ),
            h('section', h('h2', 'Unresolved or pending'), list('unres', b.unresolved, 'Nothing outstanding.')),
            b.evidence.length ? h('section', h('h2', 'Evidence collected'), list('', b.evidence.map((e) => `${humanise(e.type)} — ${e.description} (dispute ${e.dispute})`), '')) : null,
            b.knowledge.length ? h('section', h('h2', 'Knowledge references'), h('div.kb', b.knowledge.map((k) => h('article', h('h4', `${k.id} · ${k.title}`), h('p', k.excerpt), h('div.src', `Why: ${k.reason}${k.agentReview ? ' · agent should review' : ''}${k.supportsNextStep ? ' · supports the next step' : ''}`))))) : null,
            h('section', h('details', h('summary', `Event history (${b.timeline.length} events)`), h('ul.stream', { style: 'margin-top:10px' }, b.timeline.map((e) => h('li', h('span.t', fmtTime(e.at)), h('span', { class: `dot ${e.status}` }), h('div.what', h('b', e.title), h('div.meta', h('span.stg', STAGE_LABEL[e.stage]), [e.source, e.ref].filter(Boolean).join(' · ')), e.detail ? h('div.det', e.detail) : null)))))),
          ),
          h(
            'aside.doc-rail',
            h('div.rail-block', h('h2', b.escalation ? 'Recommended next step for the agent' : 'What happens next'), h('div', { class: `next${urgent ? ' urgent' : ''}` }, b.nextStep ?? br.recommendedNextStep)),
            h(
              'dl.rail-block',
              h('dt', 'Issue'),
              h('dd', br.issue.label),
              h('dt', 'Priority'),
              h('dd', humanise(br.priority)),
              h('dt', 'Identity'),
              h('dd', humanise(br.customer.verification), br.customer.name ? ` · ${br.customer.name}` : ''),
              b.escalation ? [h('dt', 'Escalation reason'), h('dd', b.escalation.reasonLabel, b.escalation.detail ? h('div.src', b.escalation.detail) : null), h('dt', 'Handoff status'), h('dd', humanise(b.escalation.status), ' (simulated desk)')] : null,
              h('dt', 'Case status'),
              h('dd', humanise(b.case?.status ?? 'none')),
              b.case?.riskFlags?.length ? [h('dt', 'Risk flags'), h('dd', b.case.riskFlags.map(humanise).join(', '))] : null,
              b.tags ? [h('dt', 'Sentiment (indicative)'), h('dd', humanise(b.tags.sentiment))] : null,
            ),
            h('p.src', 'Generated from the recorded call state and events — not from free text. Simulated systems; synthetic data.'),
          ),
        ),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ misc */
let toastTimer = 0;
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = h('div.toast', { role: 'status' }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 4200);
}

boot();
