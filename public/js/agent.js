// Agent workspace (Northstar Bank demo): queue, customer and call, conversation, AI suggestion,
// knowledge base, prefilled CRM search and case management. Everything shown comes from
// GET /api/handoffs/:id/workspace; every edit goes back through PATCH and is audited server-side.
import { api, h, mount, fmtTime, fmtDateTime, staffSignin } from './lib.js';
const app = document.getElementById('app');
// Embedded in the customer page: signed in automatically as the demo agent and focused on one call.
const params = new URLSearchParams(location.search);
const EMBED = params.get('embed') === '1';
const FOCUS = params.get('session');
// Opened from the judge page: sign in as the demo agent automatically, keep the full workspace chrome.
const AUTO = EMBED || params.get('demo') === '1';
if (EMBED) document.body.classList.add('embed');

const state = { me: null, items: [], selected: null, ws: null, form: null, crm: null, es: null, live: false, timer: null, flash: null };
const liveEl = h('span.wx-small.wx-muted', { role: 'status' });
const signinEl = h('div');
const queueEl = h('aside.wx-card.wx-q', { 'aria-label': 'Call queue' });
const centerEl = h('main.wsx-main', { 'aria-label': 'Case' });
const sideEl = h('aside.wsx-side', { 'aria-label': 'Case management' });
mount(app, h('div.wsx-bar', h('a.wx-brand', { href: '/' }, 'Hear It Once'), h('h1', 'Agent workspace'), h('span.wx-chip', 'Northstar Bank · demo'), liveEl, h('span.spacer'), h('a.wx-link', { href: '/', target: '_blank', rel: 'noopener' }, 'Open customer page ↗'), signinEl), h('div.wsx', queueEl, centerEl, sideEl));

const PHASE = { waiting: ['warn', 'Waiting'], accepted: ['ok', 'Accepted'], completed: ['neutral', 'Completed'], no_agent: ['bad', 'No agent'], cancelled: ['neutral', 'Cancelled'] };
const TONE = { ok: 'ok', passed: 'ok', failed: 'bad', locked: 'bad', warn: 'warn', pending: 'warn', blocked: 'bad', issued: 'ok', running: 'warn' };
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

async function start() {
  if (AUTO) {
    try {
      const me = await api('/api/auth/me');
      if (!me.authenticated) await api('/api/auth/demo-login', { method: 'POST', body: { userId: 'STF-AGENT-1' } });
    } catch { /* the sign-in strip below still works */ }
  }
  signIn();
}

function signIn() { staffSignin(signinEl, {
  roles: ['agent'],
  onChange: (me) => {
    state.me = me;
    clearInterval(state.timer);
    state.es?.close();
    if (me.authenticated && me.role === 'agent') {
      loadQueue();
      connectLive();
      // Safety net only: the live stream normally delivers changes instantly.
      state.timer = setInterval(() => { tickDuration(); state.tick = (state.tick ?? 0) + 1; if (state.tick % 5 === 0) loadQueue(); if (!state.live) { loadQueue(); if (state.selected) loadWorkspace(true); } }, 1000);
    } else {
      mount(queueEl, h('div.wx-empty', me.authenticated ? 'This workspace needs the agent role.' : 'Sign in with a demo agent to see the queue.'));
      mount(centerEl); mount(sideEl);
    }
  },
}); }
start();

function connectLive() {
  const es = new EventSource('/api/handoffs/stream');
  state.es = es;
  let pending = null;
  es.addEventListener('handoff', (ev) => {
    state.live = true; setLive();
    let d = {}; try { d = JSON.parse(ev.data); } catch { /* ignore */ }
    clearTimeout(pending);
    pending = setTimeout(() => {
      loadQueue();
      if (state.selected && state.ws && (!d.sessionId || d.sessionId === state.ws.call.sessionId)) loadWorkspace(true);
    }, 200);
  });
  es.onopen = () => { state.live = true; setLive(); loadQueue(); };
  es.onerror = () => { state.live = false; setLive(); };
}
function setLive() { liveEl.textContent = state.live ? '● Live — new cases and updates arrive instantly' : '○ Reconnecting…'; liveEl.className = 'wx-small ' + (state.live ? 'live-on' : 'live-off'); }

/* ------------------------------------------------------------------ queue */
async function loadQueue() {
  try { state.items = (await api('/api/handoffs')).items; state.done = (await api('/api/completed-calls')).items; renderQueue();
    // Embedded view: open the handover for the call on the customer's page as soon as it exists.
    if (FOCUS && !state.selected && !state.selectedCall) {
      const hit = state.items.find((i) => i.sessionId === FOCUS && i.status !== 'cancelled') ?? state.items.find((i) => i.sessionId === FOCUS);
      if (hit) select(hit.id);
      else if ((state.done ?? []).some((d) => d.sessionId === FOCUS)) selectCall(FOCUS);
    }
  }
  catch (e) { mount(queueEl, h('div.wx-empty', e.message)); }
}
function renderQueue() {
  const groups = [
    ['Waiting', state.items.filter((i) => ['requested', 'queued'].includes(i.status))],
    ['Accepted', state.items.filter((i) => i.status === 'connected')],
    ['Completed', state.items.filter((i) => ['completed', 'no_agent', 'failed', 'cancelled'].includes(i.status)).slice(0, 12)],
  ];
  mount(queueEl, h('header', h('h2', 'Call queue'), h('span.spacer'), h('span.wx-chip', `${groups[0][1].length} waiting`)),
    groups.map(([label, list]) => [
      h('h3', `${label} (${list.length})`),
      list.length ? h('ul', list.map((i) => h('li', h('button', { type: 'button', 'aria-pressed': String(state.selected === i.id), onclick: () => select(i.id) },
        h('span.nm', i.customerName ?? 'Unidentified caller'),
        h('span.wx-small', i.issueLabel ?? 'Issue not identified'),
        h('span.wx-small.wx-muted', `${i.reasonLabel} · ${fmtTime(i.requestedAt)}${i.priority === 'urgent' ? ' · urgent' : ''}`))))) : h('div.wx-empty', label === 'Waiting' ? 'No one is waiting. Ask Lily for a person on the customer page.' : 'None.'),
    ]),
    h('h3', `Ended calls (${(state.done ?? []).length})`),
    (state.done ?? []).length ? h('ul', state.done.map((d) => h('li', h('button', { type: 'button', 'aria-pressed': String(state.selectedCall === d.sessionId), onclick: () => selectCall(d.sessionId) },
      h('span.nm', d.customerName ?? 'Unidentified caller'),
      h('span.wx-small', d.reason ?? 'Reason not recorded'),
      h('span.wx-small.wx-muted', `${(d.resolution ?? 'not analysed').replace('_', ' ')} · analysis ${d.analysisStatus} · ${fmtTime(d.endedAt)}`))))) : h('div.wx-empty', 'None yet.'));
}

/** An ended call: the saved transcript and the post-call analysis, with a retry if the analysis failed. */
async function selectCall(id) {
  state.selected = null; state.ws = null; state.selectedCall = id; renderQueue();
  mount(sideEl);
  try {
    const [a, t] = await Promise.all([api(`/api/calls/${id}/analysis`), api(`/api/calls/${id}/transcript`)]);
    const body = a.status === 'ready' ? [
      h('p', a.summary),
      h('div.wx-two',
        h('div.wx-box', h('div.wx-sub', 'Call reason'), h('p', `${a.reason?.label ?? 'Unknown'}${a.reason?.secondary?.length ? ' (also: ' + a.reason.secondary.join(', ') + ')' : ''}`), h('div.wx-sub', 'Resolution'), h('p', (a.resolution ?? '').replace('_', ' '))),
        h('div.wx-box', h('div.wx-sub', 'Suggested solutions'), h('ul', a.suggestedSolutions.map((x) => h('li', x))), a.unresolved.length ? [h('div.wx-sub', 'Still open'), h('ul', a.unresolved.map((x) => h('li', x)))] : null)),
      h('div.wx-sub', 'Tags'), h('p', a.tags.map((x) => h('span.wx-chip', x))),
      a.knowledge.length ? [h('div.wx-sub', 'Relevant guidance'), h('ul', a.knowledge.map((k) => h('li', k.title)))] : null,
    ] : a.status === 'failed' ? [
      h('p.wx-note.bad', 'The analysis failed. The transcript and call record are saved.'),
      h('button.wx-btn', { type: 'button', onclick: async () => { await api(`/api/calls/${id}/analysis/retry`, { method: 'POST', body: {} }); selectCall(id); loadQueue(); } }, 'Retry analysis'),
    ] : [h('p.wx-muted', 'The analysis is still running or has not started.')];
    mount(centerEl, h('div.wsx-stack',
      h('section.wx-card', { 'aria-label': 'Post-call analysis' }, h('header', h('h2', 'Ended call'), h('span.wx-chip', `Analysis ${a.status}`)), h('div.wx-pad', body)),
      h('section.wx-card', { 'aria-label': 'Full transcript' }, h('header', h('h2', 'Full transcript'), h('span.wx-chip', `${t.count} turns`)),
        h('div.wx-log', t.segments.map((s) => h('div', h('b', (s.speaker === 'ai' ? 'Lily' : s.speaker) + ': '), s.text))))));
  } catch (e) { mount(centerEl, h('div.wx-note.bad', e.message)); }
}

function select(id) { state.selectedCall = null; state.selected = id; state.form = null; state.crm = null; state.flash = null; renderQueue(); loadWorkspace(false); }

/* ------------------------------------------------------------------ workspace */
async function loadWorkspace(quiet) {
  const id = state.selected;
  if (!id) return;
  try {
    const ws = await api(`/api/handoffs/${id}/workspace`);
    if (id !== state.selected) return;
    state.ws = ws;
    ensureForm(ws);
    syncForm(ws);
    render();
  } catch (e) {
    if (!quiet) mount(centerEl, h('div.wx-note.bad', e.message));
  }
}

const mineOf = (ws) => ws.handoff.agentId && ws.handoff.agentId === state.me?.userId;
const editable = (ws) => ws.handoff.phase === 'accepted' && mineOf(ws);

/** Edit controls live for the whole time a case is open, so typing is never lost on a refresh. */
function ensureForm(ws) {
  if (state.form?.id === ws.handoff.id) return;
  const dirty = {};
  const mark = (k) => () => { dirty[k] = true; };
  const ta = (k, ph, rows = 3) => { const el = h('textarea', { rows, placeholder: ph, maxlength: k === 'notes' ? 3000 : k === 'suggestion' || k === 'resolution' ? 1500 : 800, 'aria-label': ph }); el.addEventListener('input', mark(k)); return el; };
  const tagInput = h('input', { type: 'text', placeholder: 'Add a tag and press Enter', maxlength: 40, 'aria-label': 'Add tag' });
  const f = {
    id: ws.handoff.id, dirty, tags: [], tagsBox: h('div.wx-tags'), tagInput,
    reason: ta('reason', 'Call-reason summary'), suggestion: ta('suggestion', 'Revised suggested solution (leave empty to keep the AI suggestion)', 4),
    notes: ta('notes', 'Agent notes (never include card numbers)', 3), resolution: ta('resolution', 'Resolution', 3), nextSteps: ta('nextSteps', 'Next steps', 2),
    outcome: h('select', { 'aria-label': 'Outcome' }, h('option', { value: 'resolved' }, 'Resolved'), h('option', { value: 'follow_up_required' }, 'Follow-up required'), h('option', { value: 'unresolved' }, 'Unresolved')),
  };
  tagInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = tagInput.value.trim();
    if (v && !f.tags.includes(v) && f.tags.length < 12) { f.tags.push(v); dirty.tags = true; tagInput.value = ''; drawTags(f); }
  });
  state.form = f;
}
function drawTags(f) {
  const on = state.ws && editable(state.ws);
  f.tagsBox.replaceChildren(...f.tags.map((t, i) => h('span.wx-tag', t, on ? h('button', { type: 'button', 'aria-label': `Remove tag ${t}`, onclick: () => { f.tags.splice(i, 1); f.dirty.tags = true; drawTags(f); } }, '×') : null)), f.tagInput);
}
function syncForm(ws) {
  const f = state.form;
  if (!f.dirty.tags) { f.tags = [...(ws.tags.effective ?? [])]; }
  if (!f.dirty.reason) f.reason.value = ws.reason.agent ?? ws.reason.effective ?? '';
  if (!f.dirty.suggestion) f.suggestion.value = ws.suggestion.override ?? '';
  if (!f.dirty.notes) f.notes.value = ws.notes ?? '';
  if (!f.dirty.resolution) f.resolution.value = ws.resolution.text ?? '';
  if (!f.dirty.nextSteps) f.nextSteps.value = ws.resolution.nextSteps ?? '';
  const on = editable(ws);
  for (const k of ['reason', 'suggestion', 'notes', 'resolution', 'nextSteps']) f[k].disabled = !on;
  f.tagInput.disabled = !on; f.outcome.disabled = !on;
  drawTags(f);
}

let durEl = null;
function tickDuration() {
  const ws = state.ws;
  if (!ws || !durEl || ws.call.status === 'ended') return;
  durEl.textContent = fmtDur(Math.max(0, Math.round((Date.now() - Date.parse(ws.call.startedAt)) / 1000)));
}

function render() {
  const ws = state.ws;
  const f = state.form;
  const [ptone, plabel] = PHASE[ws.handoff.phase] ?? ['neutral', ws.handoff.phase];
  const secs = ws.call.status === 'ended' ? ws.call.durationSeconds : Math.max(0, Math.round((Date.now() - Date.parse(ws.call.startedAt)) / 1000));
  durEl = h('b.wx-mono', fmtDur(secs));
  const vTone = ws.verification.status === 'verified' ? 'ok' : ws.verification.status === 'failed' || ws.verification.failedCardAttempts >= 3 ? 'bad' : 'warn';

  // The suggestion keeps its own revision box; the AI text is never overwritten.
  const sg = ws.suggestion;
  const suggestion = h('section.wx-card.wx-sugg', { 'aria-label': 'Suggested solution' },
    h('header', h('h2', 'Suggested solution'), h('span.wx-chip.ai', 'AI recommendation'), h('span.wx-chip.warn', 'Not a confirmed action'), h('span.spacer'), sg.override ? h('span.wx-chip.ok', 'Revised by agent') : null),
    h('div.wx-pad',
      h('p.wx-small.wx-muted', sg.notice),
      sg.override ? h('div.wx-box', h('div.wx-sub', 'Agent’s revised solution'), h('p.wx-sugg-text', sg.override)) : null,
      h('div', h('div.wx-sub', sg.override ? 'Original AI suggestion' : 'Lily’s suggested next step'), h('p.wx-sugg-text', sg.text)),
      h('div.wx-two',
        h('div.wx-box', h('div.wx-sub', 'Why this is suggested'), h('ul', sg.reasoning.map((r) => h('li', r)))),
        h('div.wx-box', h('div.wx-sub', 'Facts it relies on'), sg.supportingFacts.length ? h('ul', sg.supportingFacts.map((r) => h('li', r))) : h('p.wx-small.wx-muted', 'No account facts confirmed yet.'))),
      h('div.wx-two',
        h('div.wx-box.confirmed', h('div.wx-sub', 'Confirmed by bank systems'), sg.confirmedActions.length ? h('ul', sg.confirmedActions.map((r) => h('li', r))) : h('p.wx-small.wx-muted', 'No action has been confirmed.')),
        h('div.wx-box', h('div.wx-sub', 'Not confirmed — do not tell the customer it happened'), sg.notConfirmed.length ? h('ul', sg.notConfirmed.map((r) => h('li', r))) : h('p.wx-small.wx-muted', 'Nothing pending.'))),
      h('div.wx-form', h('label', 'Revise the suggestion'), f.suggestion)));

  const custCard = h('section.wx-card', { 'aria-label': 'Customer and call' },
    h('header', h('h2', 'Customer and call'), h('span.spacer'), h('span.wx-chip.' + ptone, plabel), h('span.wx-chip.' + (ws.call.status === 'live' ? 'ok' : 'neutral'), ws.call.status === 'live' ? 'Call live' : 'Call ended')),
    h('div.wx-pad.wx-cust',
      h('div.wx-cust-top', h('h2', ws.customer.name), h('span.wx-chip.' + vTone, `Verification: ${ws.verification.status.replace(/_/g, ' ')}`), h('span.wx-chip.neutral', ['Duration ', durEl])),
      h('dl.wx-grid',
        h('div', h('dt', 'Phone (fictional)'), h('dd.wx-mono', ws.customer.phone ?? '—')),
        h('div', h('dt', 'Account reference'), h('dd.wx-mono', ws.customer.accountRef ?? '—')),
        h('div', h('dt', 'Card status'), h('dd', ws.customer.cardStatus ?? '—')),
        h('div', h('dt', 'Demo card number'), h('dd', h('span.wx-pan', ws.customer.cardNumber ?? '—'), h('div.wx-pan-note', ws.customer.notice)))),
      h('div', h('div.wx-sub', 'Intents'), h('div.wx-chips', h('span.wx-chip', `Primary: ${ws.intents.primary.label}`), ws.intents.secondary.map((s) => h('span.wx-chip.neutral', `Also: ${s.label ?? s}`)))),
      h('div.wx-small.wx-muted', `Handover reason: ${ws.handoff.reasonLabel}. Requested ${fmtTime(ws.handoff.requestedAt)}.`)));

  const convo = h('section.wx-card', { 'aria-label': 'Conversation' },
    h('header', h('h2', 'Conversation'), h('span.spacer'), h('span.wx-small.wx-muted', `${ws.transcript.length} messages`)),
    h('div.wx-pad',
      h('div', h('div.wx-sub', 'AI summary'), h('p', ws.aiSummary)),
      h('div.wx-two',
        h('div.wx-box', h('div.wx-sub', 'Customer concerns'), ws.concerns.length ? h('ul', ws.concerns.map((c) => h('li', c))) : h('p.wx-small.wx-muted', 'None captured.')),
        h('div.wx-box', h('div.wx-sub', 'Unresolved'), ws.unresolved.length ? h('ul', ws.unresolved.map((c) => h('li', typeof c === 'string' ? c : c.text))) : h('p.wx-small.wx-muted', 'Nothing flagged.')))),
    h('div.wx-log', { role: 'log', 'aria-label': 'Transcript' }, ws.transcript.map((t) => {
      const sp = t.speaker === 'customer' ? 'customer' : t.speaker === 'assistant' ? 'assistant' : t.speaker === 'agent' ? 'agent' : 'system';
      return h(`div.wx-msg.${sp}${t.hidden ? '.hidden' : ''}`, h('div.who', { 'aria-label': `${sp} at ${fmtTime(t.at)}` }, { customer: 'Customer', assistant: 'Lily (AI)', agent: 'Agent', system: 'System' }[sp], h('small', fmtTime(t.at))), h('div.txt', t.hidden ? 'Sensitive answer given — not stored' : t.text));
    })));

  const verif = h('section.wx-card', { 'aria-label': 'Verification and activity' },
    h('header', h('h2', 'Verification and backend activity'), h('span.spacer'), h('span.wx-chip.neutral', 'Synthetic demo check')),
    h('div.wx-pad',
      ws.verification.attempts.length ? h('table.wx-table', h('thead', h('tr', h('th', 'Time'), h('th', 'Step'), h('th', 'Method'), h('th', 'Result'))),
        h('tbody', ws.verification.attempts.map((a) => h('tr', h('td.wx-mono', fmtTime(a.at)), h('td', a.step), h('td', a.method), h('td', h('span.wx-chip.' + (TONE[a.outcome] ?? 'neutral'), a.outcome + (a.reason ? ` · ${a.reason}` : ''))))))) : h('p.wx-small.wx-muted', 'No verification attempts recorded.'),
      ws.verification.failedCardAttempts ? h('p.wx-small', `Failed card-number attempts: ${ws.verification.failedCardAttempts} of 3. The expected number is never shown to Lily or the customer.`) : null,
      h('div.wx-sub', 'Lookups and actions'),
      h('ul.wx-act', ws.activity.filter((e) => !/^voice\./.test(e.type)).map((e) => h('li', h('span.wx-dot' + ({ ok: '.ok', warn: '.warn', pending: '.warn', failed: '.bad', blocked: '.bad' }[e.status] ?? ''), ''), h('div', h('div', e.title), e.detail ? h('div.d', e.detail) : null), h('span.wx-small.wx-muted', fmtTime(e.at))))),
      ws.actions.length ? h('div.wx-sub', 'Operations') : null,
      ws.actions.length ? h('ul.wx-list', ws.actions.map((a) => h('li', typeof a === 'string' ? a : `${a.label ?? a.text ?? JSON.stringify(a)}${a.statusLabel ? ` — ${a.statusLabel}` : ''}`))) : null));

  mount(centerEl, h('div.wsx-stack', custCard, suggestion, convo, verif));
  mount(sideEl, h('div.wsx-stack', caseCard(ws, f), kbCard(ws), crmCard(ws)));
}

/* ------------------------------------------------------------------ case management */
function caseCard(ws, f) {
  const ph = ws.handoff.phase;
  const on = editable(ws);
  const note = state.flash ? h('div.wx-note.' + state.flash.kind, { role: 'status' }, state.flash.text) : null;
  const accept = ph === 'waiting' ? h('button.wx-btn.primary', { type: 'button', onclick: () => accept_(ws) }, 'Accept handover') : null;
  const state_ = ph === 'waiting' ? h('div.wx-note.warn', 'Waiting. The customer sees “Waiting for a human agent” until you accept.')
    : ph === 'accepted' ? (mineOf(ws) ? h('div.wx-note.ok', `Accepted${ws.handoff.connectedAt ? ' at ' + fmtTime(ws.handoff.connectedAt) : ''}. You can edit the case.`) : h('div.wx-note', 'Accepted by another agent. Read-only.'))
      : h('div.wx-note', `Completed${ws.handoff.outcome ? ': ' + ws.handoff.outcome.replace(/_/g, ' ') : ''}. Read-only.`);
  return h('section.wx-card', { 'aria-label': 'Case management' },
    h('header', h('h2', 'Case management'), h('span.spacer'), h('span.wx-chip.' + (PHASE[ph]?.[0] ?? 'neutral'), PHASE[ph]?.[1] ?? ph)),
    h('div.wx-pad.wx-form',
      state_, accept, note,
      h('div', h('label', 'Call tags'), f.tagsBox),
      h('div', h('label', 'Call-reason summary'), f.reason),
      h('div', h('label', 'Agent notes'), f.notes),
      h('div', h('label', 'Resolution'), f.resolution),
      h('div', h('label', 'Next steps'), f.nextSteps),
      h('div.wx-row', h('button.wx-btn.primary', { type: 'button', disabled: !on, onclick: save }, 'Save changes'), h('span.wx-small.wx-muted', ws.editedAt ? `Last saved ${fmtTime(ws.editedAt)}` : 'Not edited yet')),
      h('div', h('label', 'Outcome when finishing'), f.outcome),
      h('div.wx-row', h('button.wx-btn', { type: 'button', disabled: !on, onclick: complete }, 'Complete case')),
      ws.edits.length ? h('details', h('summary.wx-small', `Edit history (${ws.edits.length}, audited)`), h('ul.wx-trail', ws.edits.map((e) => h('li', `${fmtTime(e.at)} — ${e.field.replace(/_/g, ' ')} by ${e.by}`)))) : null));
}

function flash(kind, text) { state.flash = { kind, text }; if (state.ws) render(); }

async function accept_(ws) {
  try { await api(`/api/handoffs/${ws.handoff.id}/accept`, { method: 'POST', body: {} }); state.flash = { kind: 'ok', text: 'Handover accepted. The customer has been told an agent has joined.' }; await loadQueue(); await loadWorkspace(); }
  catch (e) { flash('bad', e.message); }
}

function patchBody(f) {
  const b = {};
  if (f.dirty.tags) b.tags = f.tags;
  if (f.dirty.reason) b.reasonSummary = f.reason.value;
  if (f.dirty.suggestion) b.suggestion = f.suggestion.value;
  if (f.dirty.notes) b.notes = f.notes.value;
  if (f.dirty.resolution) b.resolution = f.resolution.value;
  if (f.dirty.nextSteps) b.nextSteps = f.nextSteps.value;
  return b;
}
async function save() {
  const f = state.form; const ws = state.ws;
  const body = patchBody(f);
  if (!Object.keys(body).length) return flash('warn', 'Nothing has changed.');
  try {
    await api(`/api/handoffs/${ws.handoff.id}/workspace`, { method: 'PATCH', body });
    for (const k of Object.keys(f.dirty)) delete f.dirty[k];
    state.flash = { kind: 'ok', text: `Saved at ${fmtTime(new Date().toISOString())}. The change is recorded in the audit log.` };
    await loadWorkspace();
  } catch (e) { flash('bad', e.details?.issues?.[0]?.message ?? e.message); }
}
async function complete() {
  const f = state.form; const ws = state.ws;
  try {
    if (Object.keys(patchBody(f)).length) { await api(`/api/handoffs/${ws.handoff.id}/workspace`, { method: 'PATCH', body: patchBody(f) }); for (const k of Object.keys(f.dirty)) delete f.dirty[k]; }
    await api(`/api/handoffs/${ws.handoff.id}/complete`, { method: 'POST', body: { outcome: f.outcome.value, notes: (f.resolution.value || f.notes.value || '').slice(0, 2000), customerRepeatedIssue: false } });
    state.flash = { kind: 'ok', text: 'Case completed.' };
    await loadQueue(); await loadWorkspace();
  } catch (e) { flash('bad', e.message); }
}

/* ------------------------------------------------------------------ knowledge base */
function kbCard(ws) {
  return h('section.wx-card', { 'aria-label': 'Knowledge base' },
    h('header', h('h2', 'Relevant knowledge'), h('span.spacer'), h('span.wx-chip.warn', 'Illustrative demo policy')),
    h('div.wx-pad',
      ws.knowledge.length ? ws.knowledge.map((k) => h('article.wx-kb',
        h('h4', `${k.id} · ${k.title}`),
        h('p.wx-small', k.excerpt),
        h('p.wx-small', h('b', 'Why it is relevant: '), k.reason || 'matches the call'),
        k.ruleRefs?.length ? h('div.wx-chips', k.ruleRefs.map((r) => h('span.wx-chip.neutral', r))) : null,
        k.steps?.length ? h('details', h('summary', 'Steps'), h('ol.wx-list', k.steps.map((s) => h('li', s)))) : null,
        h('p.wx-small.wx-muted', k.notice))) : h('p.wx-small.wx-muted', 'No article matched this call.')));
}

/* ------------------------------------------------------------------ CRM */
function crmCard(ws) {
  if (!state.crm) state.crm = { q: ws.crm.query, input: h('input', { type: 'text', 'aria-label': 'CRM search', maxlength: 200 }), result: null, err: null, busy: false, id: ws.handoff.id };
  const c = state.crm;
  if (!c.touched) { c.q = ws.crm.query; c.input.value = c.q; }
  c.input.oninput = () => { c.touched = true; c.q = c.input.value; };
  c.input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } };
  async function search() {
    c.q = c.input.value; c.busy = true; c.err = null;
    try { c.result = await api(`/api/crm/search?q=${encodeURIComponent(c.q)}&sessionId=${encodeURIComponent(ws.call.sessionId)}`); }
    catch (e) { c.err = e.message; c.result = null; }
    c.busy = false;
    render();
  }
  const r = c.result;
  return h('section.wx-card', { 'aria-label': 'CRM search' },
    h('header', h('h2', 'CRM search'), h('span.spacer'), h('span.wx-chip.neutral', 'Synthetic records')),
    h('div.wx-pad.wx-form',
      h('p.wx-small.wx-muted', 'Prefilled from the call: name, phone, account reference and intent. Edit it freely. Card numbers are refused.'),
      h('div.wx-row', c.input, h('button.wx-btn.primary', { type: 'button', onclick: search, disabled: c.busy }, c.busy ? 'Searching…' : 'Search')),
      c.err ? h('div.wx-note.bad', c.err) : null,
      r ? [
        h('div.wx-sub', `Customers (${r.customers.length})`),
        r.customers.length ? r.customers.map((x) => h('div.wx-rec', h('b', x.name), h('span.wx-small', `Account ${x.accountRef} · ${x.phone}`), h('span.wx-small.wx-muted', `Card ••••${x.cardLast4 ?? '—'} (${x.cardStatus ?? '—'}) · matched on ${x.matchedOn.join(', ')}`))) : h('p.wx-small.wx-muted', 'No matching customers.'),
        h('div.wx-sub', `Cases (${r.cases.length})`),
        r.cases.length ? r.cases.map((x) => h('div.wx-rec', h('b', `${x.id} · ${x.issue}`), h('span.wx-small', `${x.customer ?? 'Unidentified'} · ${x.status} · ${fmtDateTime(x.createdAt)}`), x.summary ? h('span.wx-small.wx-muted', x.summary) : null)) : h('p.wx-small.wx-muted', 'No matching cases.'),
      ] : null));
}
