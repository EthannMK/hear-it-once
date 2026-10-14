// Agent console: queue, structured handoff brief, live transcript, approvals, outcome.
import { api, h, mount, chip, humanise, fmtTime, fmtDateTime, topbar, staffSignin } from './lib.js';

mount(document.getElementById('chrome'), topbar('agent'));
const app = document.getElementById('app');
const state = { me: null, items: [], selected: null, detail: null, timer: null, filter: 'active' };

const signin = h('div');
const liveEl = h('span.small.muted', { role: 'status' });
const queueEl = h('div');
const briefEl = h('div');
const sideEl = h('div');
mount(
  app,
  h('div.dash', h('div.panel.filters', h('h1', 'Agent console'), liveEl, h('span.grow'), signin)),
  h(
    'main.console',
    h('aside.panel', h('header', h('h2', 'Calls waiting'), h('span.grow'), h('div.segmented', { role: 'group', 'aria-label': 'Queue filter' }, ['active', 'all'].map((f) => h('button', { 'aria-pressed': String(state.filter === f), onclick: (e) => setFilter(f, e) }, f === 'active' ? 'Active' : 'All')))), queueEl),
    h('section.panel', briefEl),
    h('aside.panel', sideEl),
  ),
);

function setFilter(f, e) {
  state.filter = f;
  e.target.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.textContent.toLowerCase() === f)));
  loadQueue();
}

staffSignin(signin, {
  roles: ['agent'],
  onChange: (me) => {
    state.me = me;
    clearInterval(state.timer);
    state.es?.close();
    if (me.authenticated && me.role === 'agent') {
      loadQueue();
      connectLive();
      // Safety net only: updates normally arrive instantly over the live stream below.
      state.timer = setInterval(() => { if (!state.live) { loadQueue(); if (state.selected) loadDetail(state.selected, true); } }, 15000);
    } else {
      mount(queueEl, h('div.section.empty', me.authenticated ? 'This console needs the agent role.' : 'Sign in with a demo agent to see the queue.'));
      mount(briefEl, h('div.section.empty', 'No call selected.'));
      mount(sideEl);
    }
  },
});

function connectLive() {
  const es = new EventSource('/api/handoffs/stream');
  state.es = es;
  let pending = null;
  es.addEventListener('handoff', (ev) => {
    state.live = true; setLive();
    let d = {}; try { d = JSON.parse(ev.data); } catch { /* ignore */ }
    clearTimeout(pending);
    pending = setTimeout(() => { loadQueue(); if (state.selected && state.detail?.handoff?.session_id === d.sessionId) loadDetail(state.selected, true); else if (state.selected && !d.sessionId) loadDetail(state.selected, true); }, 150);
  });
  es.onopen = () => { state.live = true; setLive(); loadQueue(); };
  es.onerror = () => { state.live = false; setLive(); };
}
function setLive() { signin.dataset.live = state.live ? 'on' : 'off'; liveEl.textContent = state.live ? '● Live — updates instantly' : '○ Reconnecting…'; liveEl.className = 'small ' + (state.live ? 'live-on' : 'live-off'); }

async function loadQueue() {
  try {
    const { items } = await api('/api/handoffs');
    state.items = state.filter === 'active' ? items.filter((i) => ['queued', 'connected', 'requested'].includes(i.status)) : items;
    renderQueue();
  } catch (e) {
    mount(queueEl, h('div.section.notice.bad', e.message));
  }
}

function renderQueue() {
  if (!state.items.length) return mount(queueEl, h('div.section.empty', state.filter === 'active' ? 'No one is waiting. Place a call in the simulator and ask for a person.' : 'No handoffs yet.'));
  mount(
    queueEl,
    h(
      'ul.queue',
      state.items.map((i) =>
        h(
          'li',
          h(
            'button',
            { 'aria-pressed': String(state.selected === i.id), onclick: () => { state.selected = i.id; renderQueue(); loadDetail(i.id); } },
            h('div.line1', h('strong', i.issueLabel ?? 'Issue not identified'), chip(i.status)),
            h('div.small', i.reasonLabel),
            h('div.small.muted', `${fmtDateTime(i.requestedAt)} · ${i.priority === 'urgent' ? 'Urgent · ' : ''}${humanise(i.verification)}${i.dataOrigin === 'seeded_illustrative' ? ' · seeded' : ''}`),
          ),
        ),
      ),
    ),
  );
}

async function loadDetail(id, quiet = false) {
  try {
    state.detail = await api(`/api/handoffs/${id}`);
    renderDetail(quiet);
  } catch (e) {
    mount(briefEl, h('div.section.notice.bad', e.message));
  }
}

const list = (items, empty = 'None') => (items?.length ? h('ul.facts', items.map((t) => h('li.confirmed', t))) : h('p.small.muted', empty));

function renderDetail(quiet) {
  const { handoff: hd, call, case: cs } = state.detail;
  const b = hd.brief;
  const mine = hd.agent_id === state.me?.userId;
  const actions = h(
    'div.row',
    hd.status === 'queued' ? h('button.primary', { onclick: () => act(`/api/handoffs/${hd.id}/accept`) }, 'Accept call') : null,
    hd.status === 'connected' && !mine ? h('span.small.muted', 'Connected to another agent.') : null,
  );
  const opsTable = b.actions.length
    ? h(
        'table',
        h('thead', h('tr', h('th', 'Action'), h('th', 'Status'), h('th', 'Reference'), h('th', ''))),
        h(
          'tbody',
          (call?.operations ?? []).map((o) =>
            h(
              'tr',
              h('td', o.label),
              h('td', chip(o.status === 'submitted' ? 'pending' : o.status, o.statusLabel)),
              h('td.num.small', o.externalRef ?? o.errorCode ?? '—'),
              h(
                'td',
                o.status === 'awaiting_approval' && mine ? [h('button.primary', { onclick: () => act(`/api/actions/${o.id}/approve`) }, 'Approve'), ' ', h('button', { onclick: () => act(`/api/actions/${o.id}/reject`, { reason: 'Rejected by agent after review' }) }, 'Reject')] : null,
                (o.status === 'unknown' || o.status === 'submitted') && mine ? h('button', { onclick: () => act(`/api/actions/${o.id}/reconcile`) }, 'Check status') : null,
              ),
            ),
          ),
        ),
      )
    : h('p.small.muted', 'No actions were proposed or attempted.');

  mount(
    briefEl,
    h(
      'header.brief-head',
      h('h2', b.issue.label),
      chip(hd.status),
      b.priority === 'urgent' ? chip('failed', 'Urgent') : null,
      h('span.grow'),
      h('span.small.muted.num', `Case ${b.caseId ?? '—'} · waited ${hd.waitedSeconds}s`),
    ),
    h('div.section', h('div', { class: `next-step${b.priority === 'urgent' ? ' urgent' : ''}` }, b.recommendedNextStep), h('p.small.muted', `Why you have this call: ${b.reasonLabel}${b.reasonDetail ? ` — ${b.reasonDetail}` : ''}`), actions),
    h(
      'div.section',
      h('h3', 'Customer and verification'),
      h('dl.kv', h('dt', 'Customer'), h('dd', b.customer.name ? `${b.customer.name} (${b.customer.reference})` : 'Not verified — do not discuss the account until you verify the caller'), h('dt', 'Verification'), h('dd', chip(b.customer.verification === 'verified' ? 'verified' : b.customer.verification === 'failed' ? 'failed' : 'pending', humanise(b.customer.verification)))),
    ),
    h('div.section', h('h3', 'What the customer said'), b.issue.customerStatement ? h('p.statement', `“${b.issue.customerStatement}”`) : h('p.small.muted', 'No statement captured.')),
    b.transactions.length
      ? h('div.section', h('h3', 'Transactions in question'), h('table', h('thead', h('tr', h('th', 'Merchant'), h('th.num', 'Amount'), h('th', 'Date'), h('th', 'Status'), h('th', 'Card'))), h('tbody', b.transactions.map((t) => h('tr', h('td', t.merchant), h('td.num', t.amount), h('td', t.date), h('td', t.status), h('td.num', t.cardLast4 ? `•••• ${t.cardLast4}` : '—'))))))
      : null,
    h('div.section', h('h3', 'Confirmed by bank systems'), list(b.findings.confirmed, 'Nothing confirmed yet.'), b.findings.inferred.length ? [h('h3', 'Inferred (not confirmed)'), list(b.findings.inferred)] : null, b.findings.unavailable.length || b.conflicts.length ? [h('h3', 'Unavailable or conflicting'), list([...b.findings.unavailable, ...b.conflicts])] : null),
    h('div.section', h('h3', 'Actions'), opsTable),
    b.missingInformation.length ? h('div.section', h('h3', 'Missing information'), list(b.missingInformation)) : null,
    b.riskFlags.length || b.previousCases.length ? h('div.section', h('h3', 'Risk and history'), h('dl.kv', b.riskFlags.length ? [h('dt', 'Risk flags'), h('dd', b.riskFlags.map(humanise).join(', '))] : null, b.previousCases.length ? [h('dt', 'Previous cases'), h('dd.num', b.previousCases.join(', '))] : null)) : null,
    b.systemsChecked.length
      ? h('div.section', h('details', h('summary', `Systems checked (${b.systemsChecked.length}, simulated)`), h('table', h('thead', h('tr', h('th', 'Source'), h('th', 'Status'), h('th.num', 'Latency'), h('th', 'As of'))), h('tbody', b.systemsChecked.map((s) => h('tr', h('td', humanise(s.source)), h('td', chip(s.status === 'ok' && s.stale ? 'pending' : s.status, s.stale ? 'Stale' : humanise(s.status))), h('td.num', `${s.latencyMs} ms`), h('td.small', fmtDateTime(s.asOf))))))))
      : null,
  );
  if (quiet && sideEl.contains(document.activeElement)) {
    // Don't disturb an agent who is typing: refresh only the transcript.
    const t = sideEl.querySelector('.transcript');
    if (t) mount(t, (call?.transcript ?? []).map((x) => h(`div.turn.${x.speaker}`, h('div.speaker', `${humanise(x.speaker)} · ${fmtTime(x.at)}`), h('div.text', x.text))));
    return;
  }
  renderSide(hd, call, cs, mine, quiet);
}

function renderSide(hd, call, cs, mine, quiet) {
  const prevDraft = sideEl.querySelector('#agent-msg')?.value ?? '';
  const prevNotes = sideEl.querySelector('#notes')?.value ?? '';
  const turns = call?.transcript ?? [];
  const msg = h('input#agent-msg', { type: 'text', placeholder: 'Message the caller', 'aria-label': 'Message to caller', value: prevDraft });
  const outcome = h('select#outcome', h('option', { value: 'resolved' }, 'Resolved'), h('option', { value: 'follow_up_required' }, 'Follow-up required'), h('option', { value: 'unresolved' }, 'Unresolved'));
  const notes = h('textarea#notes', { rows: 3, placeholder: 'Notes for the case (do not include card numbers)' });
  notes.value = prevNotes;
  const repeated = h('input#repeated', { type: 'checkbox' });
  mount(
    sideEl,
    h('header', h('h2', 'Live transcript')),
    h('div.transcript', { role: 'log' }, turns.map((t) => h(`div.turn.${t.speaker}`, h('div.speaker', `${humanise(t.speaker)} · ${fmtTime(t.at)}`), h('div.text', t.text)))),
    hd.status === 'connected' && mine
      ? h(
          'div.composer',
          h('form', { onsubmit: async (e) => { e.preventDefault(); if (!msg.value.trim()) return; await act(`/api/handoffs/${hd.id}/message`, { text: msg.value.trim() }); msg.value = ''; } }, msg, h('button.primary', { type: 'submit' }, 'Send')),
          h('div.section', h('h3', 'Finish the call'), h('label', { for: 'outcome' }, 'Outcome'), outcome, h('label', { for: 'notes' }, 'Notes'), notes, h('label', repeated, ' The customer had to repeat their issue'), h('div', h('button.primary', { onclick: () => act(`/api/handoffs/${hd.id}/complete`, { outcome: outcome.value, notes: notes.value, customerRepeatedIssue: repeated.checked }) }, 'Complete call'))),
        )
      : null,
    cs ? h('div.section', h('h3', `Case ${cs.id}`), h('div.summary-text', cs.summary ?? '—')) : null,
  );
  const t = sideEl.querySelector('.transcript');
  if (t) t.scrollTop = t.scrollHeight;
  if (quiet && document.activeElement?.id === 'agent-msg') sideEl.querySelector('#agent-msg')?.focus();
}

async function act(url, body = {}) {
  try {
    await api(url, { method: 'POST', body });
    await loadQueue();
    if (state.selected) await loadDetail(state.selected);
  } catch (e) {
    alertBox(e);
  }
}

function alertBox(e) {
  briefEl.prepend(h('div.section', h('div.notice.bad', `${e.message}${e.code ? ` (${e.code})` : ''}`)));
}
