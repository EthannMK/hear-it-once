// Caller simulator: drives the SAME backend workflows as any voice channel would.
import { api, h, mount, chip, humanise, fmtTime, uid, topbar } from './lib.js';

const $ = (id) => document.getElementById(id);
mount($('chrome'), topbar('lab'));

const state = { scenarios: [], selected: null, sessionId: null, view: null, seen: 0, poll: null, voice: false, toolResult: null, busy: false };
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

/* ------------------------------------------------------------------ scenarios */
async function loadScenarios() {
  state.scenarios = (await api('/api/scenarios')).items;
  renderScenarioList();
  renderStart();
}

function renderScenarioList() {
  mount(
    $('scenarios'),
    state.scenarios.map((s) =>
      h('li', h('button', { 'aria-pressed': state.selected?.id === s.id ? 'true' : 'false', onclick: () => selectScenario(s) }, h('span.sid', s.id), h('span', s.title))),
    ),
  );
}

function selectScenario(s) {
  state.selected = s;
  renderScenarioList();
  renderScenarioDetail();
  if (!state.sessionId) renderStart();
}

function renderScenarioDetail() {
  const s = state.selected;
  if (!s) return mount($('scenario-detail'));
  mount(
    $('scenario-detail'),
    h(
      'div.scenario-detail',
      h('h3', `${s.id} · ${s.customerName}`),
      h('p.small.muted', `Synthetic caller ID ${s.callerAni} · customer no. ${s.customerNumber}${s.dob ? ` · DOB ${s.dob}` : ''}`),
      h('p.small', h('strong', 'Expected: '), s.expected),
      h('p.small.muted', 'Changes persist (e.g. a blocked card stays blocked). Reset demo data from Operations → Admin to replay a scenario.'),
      h('p.small.muted', 'Suggested lines — click to use:'),
      h(
        'ul.script',
        s.script.map((line) => h('li', h('button', { onclick: () => useLine(line) }, line))),
      ),
    ),
  );
}

function useLine(line) {
  const dob = line.match(/date of birth:\s*([\d-]+)/);
  if (dob) return fill(dob[1]);
  if (/passcode/.test(line)) {
    const code = state.view?.demoDevice?.code;
    return code ? fill(code) : null;
  }
  if (/Send consent twice/.test(line)) return sendConsentTwice();
  if (/Attempt without consent/.test(line)) return attemptWithoutConsent();
  if (line.startsWith('<') && line.endsWith('>')) return fill(line.replace(/^<[^:]*:?\s*/, '').replace(/>$/, ''));
  fill(line);
}

function fill(text) {
  const input = document.querySelector('#say');
  if (!input) return;
  input.value = text;
  input.focus();
}

/* ------------------------------------------------------------------ start */
function renderStart() {
  const s = state.selected;
  const mood = h('select#mood', h('option', { value: '' }, 'Not set'), ['calm', 'worried', 'frustrated', 'upset'].map((m) => h('option', { value: m }, humanise(m))));
  const ani = h('input#ani', { type: 'text', placeholder: '+1 (555) 010-0101', value: s?.callerAni ?? '', size: 22 });
  mount(
    $('call-body'),
    h(
      'div.start-screen',
      h('h2', s ? `Call as ${s.customerName}` : 'Place a simulated call'),
      h('p', s ? s.title : 'Pick a scenario on the left, or call with any synthetic caller ID. The assistant answers immediately — there is no menu.'),
      h(
        'div.row',
        h('div', h('label', { for: 'ani' }, 'Caller ID (synthetic)'), h('br'), ani),
        h('div', h('label', { for: 'mood' }, 'Caller mood (simulated label)'), h('br'), mood),
        h('button.primary', { onclick: () => startCall(ani.value.trim(), mood.value) }, 'Start call'),
      ),
    ),
  );
  mount($('call-status'));
  mount($('call-id'));
}

async function startCall(ani, mood) {
  const body = { channel: state.voice ? 'voice_browser' : 'text_simulator' };
  if (state.selected) body.scenarioId = state.selected.id;
  if (ani && (!state.selected || ani !== state.selected.callerAni)) body.callerAni = ani;
  if (mood) body.moodStart = mood;
  const r = await api('/api/calls', { method: 'POST', body });
  state.sessionId = r.sessionId;
  state.seen = 0;
  state.toolResult = null;
  render(r.view);
}

/* ------------------------------------------------------------------ input */
async function send(input) {
  if (!state.sessionId || state.busy) return;
  state.busy = true;
  setBusy(true);
  try {
    const view = await api(`/api/calls/${state.sessionId}/input`, { method: 'POST', body: input });
    render(view);
  } catch (e) {
    showError(e);
  } finally {
    state.busy = false;
    setBusy(false);
  }
}
const say = (text, extra = {}) => send({ kind: 'utterance', text, clientMessageId: uid(), ...extra });

function setBusy(b) {
  document.querySelectorAll('#call-body button, #call-body input').forEach((el) => {
    if (!el.dataset.always) el.disabled = b;
  });
}

function showError(e) {
  const box = document.querySelector('#call-error');
  if (box) mount(box, h('div.notice.bad', `${e.message}${e.code ? ` (${e.code})` : ''}`));
}

async function sendConsentTwice() {
  const p = state.view?.proposal;
  if (!p) return setTool('No proposal is waiting for consent yet.');
  const one = () => api(`/api/calls/${state.sessionId}/input`, { method: 'POST', body: { kind: 'consent', proposalId: p.id, decision: 'accept', clientMessageId: uid() } });
  const results = await Promise.allSettled([one(), one()]);
  const view = results.find((r) => r.status === 'fulfilled')?.value;
  if (view) render(view);
  const ops = (view?.operations ?? []).filter((o) => p.actions.some((a) => a.type === o.type));
  setTool(`Sent two identical confirmations concurrently.\nOperations created for this proposal: ${ops.length}\n${ops.map((o) => `${o.id} ${o.type}: ${o.status} (attempts ${o.attempts})`).join('\n')}\nThe duplicate was ignored by the backend (see audit: consent.duplicate_ignored).`);
}

async function attemptWithoutConsent() {
  const op = state.view?.operations?.[0];
  if (!op) return setTool('Verify first so there is a proposed action to target.');
  const params = op.type === 'reverse_fee' ? { ruleCode: 'FP-LATE-01' } : op.type === 'block_card' ? { reason: 'lost' } : op.type === 'order_replacement' ? { deliveryAddress: 'address_on_file' } : {};
  try {
    const r = await api(`/api/calls/${state.sessionId}/actions`, { method: 'POST', headers: { 'idempotency-key': `ui-noconsent-${uid().slice(0, 12)}` }, body: { type: op.type, targetRef: op.targetRef, params } });
    setTool(`Unexpected: accepted\n${JSON.stringify(r.operation?.status)}`);
  } catch (e) {
    const decision = e.data?.error?.details?.operation?.policy_decision;
    setTool(`Backend rejected the direct API call: HTTP ${e.status} ${e.code}\n${e.message}\n\nPolicy checks:\n${(decision?.checks ?? []).map((c) => `${c.passed ? 'pass' : 'FAIL'}  ${c.check}${c.passed ? '' : ' — ' + c.detail}`).join('\n')}`);
  }
  await refresh();
}

function setTool(text) {
  state.toolResult = text;
  renderBehind(state.view);
}

async function refresh() {
  if (!state.sessionId) return;
  render(await api(`/api/calls/${state.sessionId}`));
}

/* ------------------------------------------------------------------ voice (optional, browser-only) */
let recog = null;
function listen() {
  if (!SR) return;
  speechSynthesis.cancel();
  if (state.view && state.view.session.stage !== 'ended') send({ kind: 'interrupt' });
  recog = new SR();
  recog.lang = 'en-US';
  recog.interimResults = false;
  recog.onresult = (ev) => {
    const r = ev.results[0][0];
    say(r.transcript, { asrConfidence: Math.round(r.confidence * 100) / 100 });
  };
  recog.onerror = () => setTool('Speech recognition error — type instead.');
  recog.start();
}
function speak(text) {
  if (!state.voice || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text.replace(/[✓✗?…]\s/g, ''));
  u.lang = 'en-US';
  speechSynthesis.speak(u);
}

/* ------------------------------------------------------------------ render */
function render(view) {
  const fresh = view.transcript.slice(state.seen);
  state.view = view;
  const s = view.session;
  mount($('call-status'), chip(s.stage === 'ended' ? s.outcome ?? 'ended' : s.stage === 'handoff' ? 'queued' : 'in_progress', s.stage === 'ended' ? `Ended · ${humanise(s.outcome)}` : humanise(s.stage)));
  mount($('call-id'), s.id);
  renderCall(view, fresh);
  renderBehind(view);
  for (const t of fresh) if (t.speaker !== 'customer') speak(t.text);
  if (fresh.length) $('sr-live').textContent = fresh.filter((t) => t.speaker !== 'customer').map((t) => t.text).join(' ');
  state.seen = view.transcript.length;
  clearInterval(state.poll);
  if (s.stage === 'handoff') state.poll = setInterval(refresh, 2000);
}

function renderCall(view, fresh) {
  const freshSeq = new Set(fresh.map((t) => t.seq));
  const speakerName = { assistant: 'Assistant (AI)', customer: 'You', agent: 'Agent', system: 'Notice' };
  const transcript = h(
    'div.transcript#transcript',
    { role: 'log', 'aria-label': 'Call transcript' },
    view.transcript.map((t) => h(`div.turn.${t.speaker}${freshSeq.has(t.seq) ? '.fresh' : ''}`, h('div.speaker', `${speakerName[t.speaker]} · ${fmtTime(t.at)}`), h('div.text', t.text))),
  );
  const ended = view.session.stage === 'ended';

  let consent = null;
  if (view.proposal && view.pending?.kind === 'consent') {
    consent = h(
      'div.consent',
      { role: 'group', 'aria-label': 'Confirm proposed actions' },
      h('strong', 'The assistant is asking for your confirmation'),
      h('ol', view.proposal.actions.map((a) => h('li', a.label))),
      view.proposal.ruleRefs.length ? h('p.small.muted', `Based on rule ${view.proposal.ruleRefs.join(', ')}`) : null,
      h(
        'div.row',
        h('button.primary', { onclick: () => send({ kind: 'consent', proposalId: view.proposal.id, decision: 'accept', clientMessageId: uid() }) }, 'Yes, go ahead'),
        h('button', { onclick: () => send({ kind: 'consent', proposalId: view.proposal.id, decision: 'decline', clientMessageId: uid() }) }, 'No, don’t'),
        h('button.ghost', { onclick: () => send({ kind: 'request_human', clientMessageId: uid() }) }, 'Talk to a person'),
      ),
    );
  }
  const choices = view.choices.length && view.pending?.kind !== 'consent'
    ? h(
        'div.choices',
        view.choices.map((c) =>
          h('button.quiet', { onclick: () => (c.id === '__yes' ? say('Yes') : c.id === '__no' ? say('No') : send({ kind: 'choice', optionId: c.id, clientMessageId: uid() })) }, c.label),
        ),
      )
    : null;
  const survey = view.session.stage === 'awaiting_survey'
    ? h('div.choices', [1, 2, 3, 4, 5].map((n) => h('button.quiet', { onclick: () => send({ kind: 'survey', score: n }) }, String(n))))
    : null;

  const input = h('input#say', { type: 'text', placeholder: ended ? 'Call ended' : 'Type what the caller says…', autocomplete: 'off', 'aria-label': 'What the caller says', disabled: ended });
  input.addEventListener('input', () => speechSynthesis?.cancel?.());
  const form = h(
    'form',
    { onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (v) { input.value = ''; say(v); } } },
    input,
    h('button.primary', { type: 'submit', disabled: ended }, 'Send'),
    SR ? h('button', { type: 'button', onclick: listen, disabled: ended, title: 'Speak using your browser’s speech recognition' }, 'Speak') : null,
  );
  const tools = h(
    'div.tools',
    h('button.ghost', { onclick: () => send({ kind: 'silence' }), disabled: ended, title: 'Simulate the caller saying nothing' }, 'Stay silent'),
    view.canReconcile ? h('button', { onclick: () => send({ kind: 'reconcile', clientMessageId: uid() }), disabled: ended }, 'Check action status') : null,
    h('button', { onclick: () => send({ kind: 'request_human', clientMessageId: uid() }), disabled: ended || view.session.stage === 'handoff' }, 'Talk to a person'),
    h('span.spacer'),
    h('label.small', h('input', { type: 'checkbox', checked: state.voice, 'data-always': '1', onchange: (e) => { state.voice = e.target.checked; if (!state.voice) speechSynthesis?.cancel?.(); } }), ' Read replies aloud'),
    ended
      ? h('button.primary', { 'data-always': '1', onclick: () => { state.sessionId = null; state.view = null; clearInterval(state.poll); renderStart(); mount($('behind'), h('div.section.empty', 'Start a call to see what happens behind it.')); } }, 'New call')
      : h('button.danger', { onclick: () => send({ kind: 'hangup' }) }, 'End call'),
  );
  mount($('call-body'), transcript, consent, choices, survey, h('div#call-error'), h('div.composer', form, tools));
  const tEl = $('transcript');
  tEl.scrollTop = tEl.scrollHeight;
  if (!ended && !consent) input.focus({ preventScroll: true });
}

const VSTEPS = [
  ['identified', 'Caller identified (not proof of identity)'],
  ['dob', 'Knowledge check: date of birth'],
  ['otp', 'Possession check: one-time passcode'],
  ['verified', 'Verified'],
];

function renderBehind(view) {
  if (!view) return;
  const s = view.session;
  const vs = s.verificationStatus;
  const stage = s.stage;
  const pos = vs === 'verified' ? 4 : stage === 'awaiting_otp' ? 2 : stage === 'awaiting_dob' ? 1 : vs === 'identified' ? 1 : 0;
  const steps = h(
    'ul.steps',
    VSTEPS.map(([, label], i) => h(`li.${vs === 'failed' && i === pos ? 'failed' : i < pos ? 'done' : i === pos && vs !== 'not_started' ? 'current' : 'todo'}`, h('span.dot'), label)),
  );

  const device = view.demoDevice
    ? h('div.device', { role: 'region', 'aria-label': 'Simulated phone' }, h('div.label', view.demoDevice.label), h('div.small', view.demoDevice.message), h('div.code', view.demoDevice.code), h('button.quiet', { onclick: () => say(view.demoDevice.code) }, 'Read the code to the assistant'))
    : null;

  const issue = s.issueStatement
    ? h('div.section', h('h3', 'Issue, in the caller’s words'), h('p.small', `“${s.issueStatement}”`), s.issueLabel ? chip('open', s.issueLabel) : chip('neutral', 'Not yet classified'))
    : null;

  let lookups = null;
  if (view.sources) {
    const max = Math.max(50, ...view.sources.items.map((i) => i.latencyMs));
    lookups = h(
      'div.section',
      h('h3', 'Parallel system lookups'),
      h('p.small.muted', 'All sources start together at the left edge. Mock adapters — not real bank systems.'),
      h(
        'div.lanes',
        view.sources.items.map((i) => {
          const failed = i.status !== 'ok';
          return h(
            `div.lane${failed ? '.fail' : i.stale ? '.stale' : ''}`,
            { title: `${i.label}: ${i.status}${i.stale ? ' (stale)' : ''}, ${i.latencyMs} ms, ${i.attempts} attempt(s), as of ${i.asOf ?? 'n/a'}` },
            h('span', i.label),
            h('span.track', h('span.bar', { style: `width:${Math.max(2, (100 * i.latencyMs) / max)}%` })),
            h('span.ms', failed ? humanise(i.status) : i.stale ? 'stale' : `${i.latencyMs} ms`),
          );
        }),
      ),
      h('div.lanes-foot', h('span', `Elapsed ${view.sources.wallMs} ms`), h('span', `Sum of sources ${view.sources.sumSourceMs} ms`)),
      view.sources.conflicts.map((c) => h('div.conflict', h('strong', 'Conflict: '), c.detail)),
    );
  }

  let facts = null;
  if (view.findings && (view.findings.confirmed.length || view.findings.inferred.length || view.findings.unavailable.length)) {
    facts = h(
      'div.section',
      h('h3', 'What the bank systems say'),
      h(
        'ul.facts',
        view.findings.confirmed.map((f) => h('li.confirmed', f.text, ' ', h('span.src', `confirmed · ${f.source}`))),
        view.findings.inferred.map((f) => h('li.inferred', f.text, ' ', h('span.src', 'inferred, not confirmed'))),
        view.findings.unavailable.map((f) => h('li.unavailable', f.text, ' ', h('span.src', 'unavailable'))),
      ),
    );
  }

  const ops = view.operations.length
    ? h(
        'div.section',
        h('h3', 'Actions'),
        h(
          'ul.ops',
          view.operations.map((o) =>
            h(
              'li.op',
              h('div.top', h('strong.small', o.label), chip(o.status === 'submitted' ? 'pending' : o.status, o.status === 'submitted' ? 'Pending' : humanise(o.status))),
              h('div.small.muted.num', `${o.id}${o.externalRef ? ` · ref ${o.externalRef}` : ''} · attempts ${o.attempts}`),
              o.errorCode ? h('div.err', `${o.errorCode}: ${o.errorMessage ?? ''}`) : null,
              h('div.hist', o.history.map((x) => h('span', { title: x.note ?? '' }, humanise(x.to_status)))),
            ),
          ),
        ),
      )
    : null;

  const cs = view.case
    ? h(
        'div.section',
        h('h3', 'Case'),
        h('dl.kv', h('dt', 'Case'), h('dd.num', view.case.id), h('dt', 'Status'), h('dd', chip(view.case.status)), view.case.recurring ? [h('dt', 'Recurring'), h('dd', 'Yes — flagged')] : null, view.case.riskFlags.length ? [h('dt', 'Risk flags'), h('dd', view.case.riskFlags.join(', '))] : null),
        view.case.summary ? h('details', { open: s.stage === 'ended' }, h('summary.small', 'Grounded case summary'), h('div.summary-text', view.case.summary)) : null,
      )
    : null;

  const handoff = view.handoff
    ? h('div.section', h('h3', 'Human handoff (simulated desk)'), h('dl.kv', h('dt', 'Status'), h('dd', chip(view.handoff.status)), h('dt', 'Reason'), h('dd', view.handoff.reasonLabel), view.handoff.agentName ? [h('dt', 'Agent'), h('dd', view.handoff.agentName)] : null), view.handoff.status === 'queued' ? h('p.small.muted', 'Open the Agent console in another tab and accept this call.') : null)
    : null;

  const tool = state.toolResult ? h('div.section', h('h3', 'Scenario tool result'), h('div.tool-result', state.toolResult)) : null;

  mount($('behind'), h('div.section', h('h3', 'Identity verification'), steps), device, issue, lookups, facts, ops, cs, handoff, tool);
}

loadScenarios().catch((e) => mount($('call-body'), h('div.notice.bad', e.message)));
