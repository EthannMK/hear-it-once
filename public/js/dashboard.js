// Operations dashboard: KPIs from persisted events, filters, QA review, audit, admin.
import { api, h, mount, chip, humanise, fmtDateTime, fmtTime, topbar, staffSignin } from './lib.js';

mount(document.getElementById('chrome'), topbar('dash'));
const app = document.getElementById('app');
const state = { me: null, filters: { origin: 'all' }, kpi: null, callsCursor: [], callsPage: null, selectedCall: null };

const ISSUES = { unrecognised_transaction: 'Unrecognised transaction', lost_stolen_card: 'Lost or stolen card', wrong_or_duplicate_charge: 'Wrong or duplicate charge', payment_not_showing: 'Payment not showing', fee_query: 'Fee query' };
const OUTCOMES = ['resolved', 'handed_off', 'ended_unresolved', 'verification_failed', 'fallback', 'abandoned', 'in_progress'];
const REASONS = ['customer_requested', 'verification_failed', 'ai_uncertain', 'system_unavailable', 'conflicting_data', 'social_engineering_suspected', 'account_takeover_suspected', 'out_of_policy', 'approval_required', 'action_failed', 'communication_breakdown', 'assistant_unavailable', 'customer_accepted_offer'];
const EXTRA = { median: 'Median', pctWithin60s: 'Within 60 s', pctWithinTarget: 'Within target', pctWithin30s: 'Within 30 s', medianSeconds: 'Median', p90Seconds: 'p90', confirmed: 'Confirmed', failedOrUnknown: 'Failed or unknown', safetyIncidents: 'Safety incidents', submitted: 'Submitted', pending: 'Pending', failedOrRejected: 'Failed or rejected' };
const GROUPS = [
  ['Volume and speed', ['call_volume', 'eligible_volume', 'aht', 'wait_time', 'stage_retrieval', 'stage_proposal', 'stage_execution', 'handoff_join']],
  ['Resolution', ['fcr', 'repeat_7d', 'repetition', 'case_before_end', 'handoff_rate']],
  ['Safety and quality', ['block_rate', 'action_correctness', 'dispute_no_rework', 'unresolved_ops']],
  ['Customer experience', ['csat']],
  ['Systems and AI', ['integration_failure', 'ai_failures']],
  ['Workforce', ['agent_calls']],
];

const signin = h('div');
const body = h('div.dash');
mount(app, h('div.dash', h('div.panel.filters', h('h1', 'Operations'), h('span.data-label', 'Demo / synthetic data — not measured bank performance'), h('span.grow'), signin)), body);

staffSignin(signin, {
  roles: ['qa', 'admin'],
  onChange: (me) => {
    state.me = me;
    if (me.authenticated && (me.permissions ?? []).includes('kpi.read')) renderShell();
    else mount(body, h('div.panel.section.empty', me.authenticated ? 'This page needs the QA or admin role.' : 'Sign in as the demo QA reviewer or administrator to view operations data.'));
  },
});

let el = {};
function renderShell() {
  el = { live: h('div.panel.live-ops'), filters: h('div.panel.filters'), ledger: h('div.panel'), charts: h('div.grid-2'), calls: h('div.panel'), audit: h('div.panel'), admin: h('div') };
  mount(body, el.live, h('h2.dash-h', 'Pilot KPIs'), el.filters, el.ledger, el.charts, el.calls, el.audit, el.admin);
  loadLive();
  clearInterval(state.liveTimer);
  state.liveTimer = setInterval(() => document.visibilityState === 'visible' && loadLive(), 5000);
  renderFilters();
  refresh();
  loadCalls();
  loadAudit();
  if ((state.me.permissions ?? []).includes('demo.reset')) loadAdmin();
}

function renderFilters() {
  const f = state.filters;
  const field = (label, node) => h('div.field', h('label', label), node);
  const date = (k) => h('input', { type: 'date', value: f[k] ?? '', onchange: (e) => setF(k, e.target.value || undefined) });
  const select = (k, opts, labels = {}) => h('select', { onchange: (e) => setF(k, e.target.value || undefined) }, h('option', { value: '' }, 'All'), opts.map((o) => h('option', { value: o, selected: f[k] === o }, labels[o] ?? humanise(o))));
  mount(
    el.filters,
    field('From', date('from')),
    field('To', date('to')),
    field('Issue type', select('issueType', Object.keys(ISSUES), ISSUES)),
    field('Call outcome', select('outcome', OUTCOMES)),
    field('Handoff reason', select('handoffReason', REASONS)),
    field(
      'Data',
      h(
        'div.segmented',
        { role: 'group', 'aria-label': 'Data origin' },
        [['all', 'All'], ['demo_session', 'Measured demo calls'], ['seeded_illustrative', 'Seeded illustrative']].map(([k, l]) => h('button', { 'aria-pressed': String(f.origin === k), onclick: () => setF('origin', k) }, l)),
      ),
    ),
  );
}

function setF(k, v) {
  state.filters[k] = v;
  renderFilters();
  refresh();
  state.callsCursor = [];
  loadCalls();
}

async function refresh() {
  const q = new URLSearchParams(Object.entries(state.filters).filter(([, v]) => v));
  state.kpi = await api(`/api/kpis?${q}`);
  renderLedger();
  renderCharts();
}

function fmtValue(m) {
  if (m.value === null || m.value === undefined) return '—';
  const v = m.value;
  if (m.unit === '%') return `${v}%`;
  if (m.unit === 's') return v >= 120 ? `${Math.floor(v / 60)}m ${Math.round(v % 60)}s` : `${v}s`;
  if (m.unit === 'score') return `${v} / 5`;
  return String(v);
}

function renderLedger() {
  const k = state.kpi;
  const byId = Object.fromEntries(k.metrics.map((m) => [m.id, m]));
  const targets = Object.fromEntries(k.targets.map((t) => [t.id, t]));
  const rows = [];
  for (const [g, ids] of GROUPS) {
    rows.push(h('tr.group', h('th', { colspan: 5 }, g)));
    for (const id of ids) {
      const m = byId[id];
      if (!m) continue;
      const t = m.targetId ? targets[m.targetId] : null;
      const extra = m.extra && !m.extra.bySource && !m.extra.reasons && !m.extra.moodStart ? Object.entries(m.extra).filter(([, v]) => typeof v !== 'object').map(([kk, v]) => `${EXTRA[kk] ?? humanise(kk)}: ${v ?? '—'}${/^pct/.test(kk) ? '%' : /Seconds$|^median$/.test(kk) ? ' s' : ''}`).join(' · ') : '';
      rows.push(
        h(
          'tr',
          h('td.metric', m.label, extra ? h('div.small.muted', extra) : null),
          h('td.value.num', fmtValue(m)),
          h('td.num.small.muted', `n=${m.n}`),
          h('td.target', t ? [t.statement, h('div.small.muted', t.locallyTestable ? 'Testable locally' : 'Needs real pilot data')] : h('span.muted', '—')),
          h('td.def', m.definition),
        ),
      );
    }
  }
  mount(
    el.ledger,
    h('header', h('h2', 'Measures'), h('span.grow'), h('span.small.muted', `${k.origins.demo_session} measured demo calls · ${k.origins.seeded_illustrative} seeded illustrative calls · computed ${fmtDateTime(k.generatedAt)}`)),
    h('div.section', h('p.small.muted', 'Observed values are calculated from stored events for the selected filters. Proposed pilot targets come from the BRD and are shown for reference only — synthetic data cannot show whether a real pilot meets them.')),
    h('div', { style: 'overflow-x:auto' }, h('table.ledger', h('thead', h('tr', h('th', 'Measure'), h('th.num', 'Observed'), h('th.num', 'Sample'), h('th', 'Proposed pilot target'), h('th', 'How it is calculated'))), h('tbody', rows))),
  );
}

/* ---------------------------------------------------------------- charts (inline SVG) */
const tip = h('div.tooltip.hidden', { role: 'tooltip' });
document.body.append(tip);
function showTip(e, text) {
  tip.textContent = text;
  tip.classList.remove('hidden');
  tip.style.left = `${Math.min(window.innerWidth - 270, e.clientX + 12)}px`;
  tip.style.top = `${e.clientY + 12}px`;
}
const hideTip = () => tip.classList.add('hidden');
const svg = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};

function callsPerDayChart(days) {
  const W = 640, H = 240, L = 34, B = 26, T = 10, R = 8;
  const series = [
    ['resolved', 'Resolved by assistant', 'var(--series-1)'],
    ['handedOff', 'Handed to an agent', 'var(--series-2)'],
    ['other', 'Other outcomes', 'var(--series-3)'],
  ];
  const data = days.map((d) => ({ day: d.day, resolved: d.resolved, handedOff: d.handedOff, other: Math.max(0, d.calls - d.resolved - d.handedOff), calls: d.calls }));
  const max = Math.max(1, ...data.map((d) => d.calls));
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / step) * step;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const bw = (W - L - R) / Math.max(1, data.length);
  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Calls per day by outcome' });
  for (let v = 0; v <= top; v += top / 4) g.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'gridline' }), svg('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, Math.round(v)));
  data.forEach((d, i) => {
    let acc = 0;
    const x = L + i * bw + 1;
    for (const [key, label, color] of series) {
      const v = d[key];
      if (!v) continue;
      const y1 = y(acc + v);
      const hgt = y(acc) - y1 - (acc ? 2 : 0); // 2px surface gap between stacked segments
      acc += v;
      g.append(svg('rect', { x, y: y1, width: Math.max(1, bw - 2), height: Math.max(1, hgt), fill: color, rx: acc === d.calls ? 2 : 0, onmousemove: (e) => showTip(e, `${d.day}: ${label} ${v} of ${d.calls}`), onmouseleave: hideTip }));
    }
    if (data.length <= 14 || i % Math.ceil(data.length / 10) === 0) g.append(svg('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle' }, d.day.slice(5)));
  });
  g.append(svg('line', { x1: L, x2: W - R, y1: y(0), y2: y(0), class: 'axis' }));
  return h('div', h('div.legend', series.map(([, label, color]) => h('span', h('i', { style: `background:${color}` }), label))), g);
}

function renderCharts() {
  const k = state.kpi;
  const reasons = k.metrics.find((m) => m.id === 'handoff_rate').extra.reasons;
  const maxR = Math.max(1, ...reasons.map((r) => r.count));
  const integ = k.metrics.find((m) => m.id === 'integration_failure').extra.bySource;
  const maxP95 = Math.max(1, ...integ.map((s) => s.p95ms ?? 0));
  mount(
    el.charts,
    h('section.panel', h('header', h('h2', 'Calls per day by outcome')), h('div.section', k.breakdowns.byDay.length ? callsPerDayChart(k.breakdowns.byDay) : h('p.empty', 'No calls in this range.'))),
    h(
      'section.panel',
      h('header', h('h2', 'Why calls went to a person')),
      h('div.section', reasons.length ? reasons.map((r) => h('div.hbar', { onmousemove: (e) => showTip(e, `${r.label}: ${r.count}`), onmouseleave: hideTip }, h('span', r.label), h('span', h('div.bar', { style: `width:${(100 * r.count) / maxR}%` })), h('span.num', r.count))) : h('p.empty', 'No handoffs in this range.')),
    ),
    h(
      'section.panel',
      { style: 'grid-column: 1 / -1' },
      h('header', h('h2', 'Integration latency and failures'), h('span.grow'), h('span.small.muted', 'Mock adapters — simulated latency')),
      h(
        'div.section',
        { style: 'overflow-x:auto' },
        h(
          'table',
          h('thead', h('tr', h('th', 'Source'), h('th', 'Direction'), h('th.num', 'Calls'), h('th.num', 'Failure rate'), h('th.num', 'p50'), h('th.num', 'p95'), h('th', 'p95 relative'))),
          h('tbody', integ.map((s) => h('tr', h('td', humanise(s.source)), h('td', s.direction), h('td.num', s.calls), h('td.num', `${s.failureRatePct}%`), h('td.num', `${s.p50ms} ms`), h('td.num', `${s.p95ms} ms`), h('td', h('div.hbar', { style: 'grid-template-columns:1fr;margin:0' }, h('div.bar', { style: `width:${(100 * (s.p95ms ?? 0)) / maxP95}%` })))))),
        ),
      ),
    ),
  );
}

/* ---------------------------------------------------------------- calls + QA review */
async function loadCalls(cursor) {
  const q = new URLSearchParams({ limit: '15' });
  for (const k of ['issueType', 'outcome']) if (state.filters[k]) q.set(k, state.filters[k]);
  if (state.filters.origin !== 'all') q.set('origin', state.filters.origin);
  if (cursor) q.set('cursor', cursor);
  state.callsPage = await api(`/api/calls?${q}`);
  renderCalls();
}

function renderCalls() {
  const p = state.callsPage;
  const canQa = (state.me.permissions ?? []).includes('qa.review');
  mount(
    el.calls,
    h('header', h('h2', 'Recent calls'), h('span.grow'), canQa ? h('span.small.muted', 'Select a call to review it') : null),
    h(
      'div',
      { style: 'overflow-x:auto' },
      h(
        'table',
        h('thead', h('tr', h('th', 'Answered'), h('th', 'Issue'), h('th', 'Outcome'), h('th', 'Verification'), h('th', 'Handoff'), h('th', 'Case'), h('th', 'Data'), h('th', ''))),
        h(
          'tbody',
          p.items.map((c) =>
            h(
              'tr',
              h('td.small', fmtDateTime(c.answered_at)),
              h('td', ISSUES[c.issue_type] ?? '—'),
              h('td', chip(c.outcome ?? 'in_progress')),
              h('td.small', humanise(c.verification_status)),
              h('td.small', c.handoff_reason ? humanise(c.handoff_reason) : '—'),
              h('td.small.num', c.case_id ?? '—'),
              h('td.small', c.data_origin === 'seeded_illustrative' ? 'Seeded' : 'Demo call'),
              h('td', canQa ? h('button.quiet', { onclick: () => openReview(c) }, c.qa_flagged ? 'Reviewed' : 'Review') : null),
            ),
          ),
        ),
      ),
    ),
    h(
      'div.pager',
      state.callsCursor.length ? h('button', { onclick: () => { state.callsCursor.pop(); loadCalls(state.callsCursor.at(-1)); } }, 'Newer') : null,
      p.nextCursor ? h('button', { onclick: () => { state.callsCursor.push(p.nextCursor); loadCalls(p.nextCursor); } }, 'Older') : null,
    ),
    h('div#review'),
  );
}

async function openReview(c) {
  const box = el.calls.querySelector('#review');
  let view = null;
  try {
    view = await api(`/api/calls/${c.id}`);
  } catch {
    /* seeded calls have no transcript */
  }
  const correct = h('select', h('option', { value: '' }, 'No consequential action'), h('option', { value: 'true' }, 'Correct'), h('option', { value: 'false' }, 'Incorrect'));
  const safety = h('input', { type: 'checkbox' });
  const repeated = h('input', { type: 'checkbox' });
  const score = h('input', { type: 'number', min: 0, max: 100, placeholder: '0–100' });
  const notes = h('textarea', { rows: 2 });
  const status = h('span.small');
  mount(
    box,
    h(
      'div.section',
      h('h3', `QA review · ${c.id}`),
      view ? h('details', h('summary', `Transcript (${view.transcript.length} turns, redacted)`), h('div.transcript', view.transcript.map((t) => h(`div.turn.${t.speaker}`, h('div.speaker', humanise(t.speaker)), h('div.text', t.text))))) : h('p.small.muted', 'Seeded illustrative call — no transcript.'),
      view?.case?.summary ? h('details', h('summary', 'Case summary'), h('div.summary-text', view.case.summary)) : null,
      h('div.row', h('label', 'Action correctness ', correct), h('label', safety, ' Safety incident (wrong or unauthorised action)'), h('label', repeated, ' Customer had to repeat the issue'), h('label', 'Score ', score)),
      h('label', 'Notes'), notes,
      h('div.row', h('button.primary', { onclick: async () => {
        try {
          await api('/api/qa/reviews', { method: 'POST', body: { sessionId: c.id, actionCorrect: correct.value === '' ? null : correct.value === 'true', safetyIncident: safety.checked, customerRepeatedIssue: repeated.checked, score: score.value === '' ? null : Number(score.value), notes: notes.value } });
          status.textContent = 'Review saved.';
          refresh();
          loadCalls(state.callsCursor.at(-1));
        } catch (e) {
          status.textContent = e.message;
        }
      } }, 'Save review'), status),
    ),
  );
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------------------------------------------------------------- audit */
async function loadAudit(cursor, event) {
  if (!(state.me.permissions ?? []).includes('audit.read')) return mount(el.audit);
  const q = new URLSearchParams({ limit: '25' });
  if (cursor) q.set('cursor', cursor);
  if (event) q.set('event', event);
  const r = await api(`/api/audit?${q}`);
  const filter = h('input', { type: 'text', placeholder: 'Event prefix, e.g. action.', value: event ?? '', onchange: (e) => loadAudit(undefined, e.target.value || undefined) });
  mount(
    el.audit,
    h('header', h('h2', 'Audit log'), h('span.grow'), filter),
    h('div', { style: 'overflow-x:auto' }, h('table', h('thead', h('tr', h('th', 'Time'), h('th', 'Actor'), h('th', 'Event'), h('th', 'Status'), h('th', 'Resource'), h('th', 'Details (redacted)'))), h('tbody', r.items.map((a) => h('tr', h('td.small', fmtDateTime(a.ts)), h('td.small', `${a.actor_type}:${a.actor_id}`), h('td.small', a.event), h('td', chip(a.status === 'ok' ? 'ok' : a.status === 'denied' ? 'rejected' : a.status === 'info' ? 'in_progress' : a.status)), h('td.small.num', a.resource_id ?? '—'), h('td.small.muted', JSON.stringify(a.metadata).slice(0, 140))))))),
    h('div.pager', r.nextCursor ? h('button', { onclick: () => loadAudit(r.nextCursor, event) }, 'Older') : null),
  );
}

/* ---------------------------------------------------------------- admin */
async function loadAdmin() {
  const r = await api('/api/admin/faults');
  const confirmInput = h('input', { type: 'text', placeholder: 'RESET SYNTHETIC DATA', 'aria-label': 'Type RESET SYNTHETIC DATA to confirm' });
  const msg = h('span.small');
  const targets = ['customer_profile', 'card_status', 'transactions', 'fraud_alerts', 'prior_cases', 'dispute_rules', 'payment_status', 'fee_policy', 'card_control', 'replacement', 'dispute_intake', 'fee_ledger', 'assistant'];
  const nf = { scope: h('select', ['customer', 'scenario', 'global'].map((s) => h('option', { value: s }, humanise(s)))), ref: h('input', { type: 'text', placeholder: 'e.g. CUS-1002 or S05', size: 14 }), target: h('select', targets.map((t) => h('option', { value: t }, humanise(t)))), fault: h('select', ['unavailable', 'timeout', 'stale', 'fail', 'timeout_after_submit', 'pending', 'error'].map((t) => h('option', { value: t }, humanise(t)))) };
  const saveFault = async (body) => {
    try {
      await api('/api/admin/faults', { method: 'PUT', body });
      loadAdmin();
    } catch (e) {
      msg.textContent = e.message;
    }
  };
  mount(
    el.admin,
    h(
      'section.panel',
      h('header', h('h2', 'Admin: demo controls'), h('span.grow'), h('span.small.muted', 'Affects synthetic demo data only')),
      h(
        'div.section',
        h('h3', 'Reset demo data'),
        h('p.small', 'Wipes every demo call, case and action and re-seeds the synthetic customers and illustrative history. This cannot be undone.'),
        h('div.row', confirmInput, h('button.danger', { onclick: async () => {
          try {
            await api('/api/admin/reset', { method: 'POST', body: { confirm: confirmInput.value } });
            msg.textContent = 'Demo data reset.';
            refresh();
            loadCalls();
            loadAdmin();
          } catch (e) {
            msg.textContent = e.code === 'VALIDATION_FAILED' ? 'Type RESET SYNTHETIC DATA exactly to confirm.' : e.message;
          }
        } }, 'Reset demo data'), msg),
      ),
      h('div.section', h('h3', 'Agent availability (simulated desk)'), h('label', h('input', { type: 'checkbox', checked: r.settings.agentsAvailable, onchange: async (e) => { await api('/api/admin/settings', { method: 'PUT', body: { agentsAvailable: e.target.checked } }); } }), ' Agents are available to take handoffs'), h('p.small.muted', 'Turn off to demonstrate the no-agent callback fallback.')),
      h(
        'div.section',
        h('h3', 'Injected faults'),
        h('table', h('thead', h('tr', h('th', 'Scope'), h('th', 'Applies to'), h('th', 'System'), h('th', 'Fault'), h('th', 'Enabled'))), h('tbody', r.items.map((f) => h('tr', h('td', humanise(f.scope)), h('td.num', f.scope_ref), h('td', humanise(f.target)), h('td', humanise(f.fault)), h('td', h('input', { type: 'checkbox', checked: !!f.enabled, 'aria-label': 'Enabled', onchange: (e) => saveFault({ scope: f.scope, scopeRef: f.scope_ref, target: f.target, fault: f.fault, enabled: e.target.checked }) })))))),
        h('div.row', nf.scope, nf.ref, nf.target, nf.fault, h('button', { onclick: () => saveFault({ scope: nf.scope.value, scopeRef: nf.scope.value === 'global' ? '*' : nf.ref.value, target: nf.target.value, fault: nf.fault.value, enabled: true }) }, 'Add fault')),
      ),
    ),
  );
}

/* ---------------------------------------------------------------- live operations overview */
const STAGE_LABEL = { understand: 'Understand', verify: 'Verify', investigate: 'Investigate', explain: 'Explain', confirm: 'Confirm', act: 'Act', record: 'Record', resolve: 'Resolve', handoff: 'Handoff' };
const OUT_TONE = { succeeded: 'ok', failed: 'bad', unknown: 'warn', submitted: 'warn', rejected: 'blocked', awaiting_confirmation: 'pending', awaiting_approval: 'warn' };
async function loadLive() {
  let o;
  try {
    o = await api('/api/ops/overview');
  } catch {
    return;
  }
  const open = state.openTrail;
  const maxStage = Math.max(1, ...o.stageDistribution.map((s) => s.active));
  const maxAct = Math.max(1, ...o.actionOutcomes.map((a) => a.count));
  const maxCat = Math.max(1, ...o.categories.map((c) => c.count));
  const trailBox = h('div.trail-box');
  mount(
    el.live,
    h('header', h('h2', 'Live operations'), h('span.grow'), h('span.small.muted', `${o.label} · refreshes every 5 s`)),
    h(
      'div.section',
      h('div.live-stats', [['Sessions', o.totals.sessions], ['Active now', o.totals.active], ['Completed', o.totals.completed], ['Handed to a person', o.totals.handedOff]].map(([l, n]) => h('div', h('b.num', n), h('span', l)))),
      h(
        'div.live-grid',
        h('div', h('h3', 'Active calls by stage'), h('div.stage-strip', o.stageDistribution.map((s) => h('div', { class: s.active ? 'has' : null, title: `${STAGE_LABEL[s.stage]}: ${s.active} active` }, h('span.col', h('span.fill', { style: `height:${(100 * s.active) / maxStage}%` })), h('b.num', s.active), h('span', STAGE_LABEL[s.stage]))))),
        h('div', h('h3', 'Action outcomes'), o.actionOutcomes.length ? o.actionOutcomes.map((a) => h(`div.hbar.${OUT_TONE[a.status] ?? 'neutral'}`, h('span', a.label), h('span', h('div.bar', { style: `width:${(100 * a.count) / maxAct}%` })), h('span.num', a.count))) : h('p.empty', 'No actions yet.')),
        h('div', h('h3', 'Issue categories'), o.categories.length ? o.categories.map((c) => h('div.hbar', h('span', c.label), h('span', h('div.bar', { style: `width:${(100 * c.count) / maxCat}%` })), h('span.num', c.count))) : h('p.empty', 'No calls yet.')),
      ),
      h('h3', { style: 'margin-top:18px' }, 'Recent interactions'),
      o.recent.length
        ? h(
            'div',
            { style: 'overflow-x:auto' },
            h(
              'table',
              h('thead', h('tr', h('th', 'Started'), h('th', 'Issue'), h('th', 'Stage'), h('th', 'Outcome'), h('th', 'Latest event'), h('th', ''))),
              h(
                'tbody',
                o.recent.map((r) =>
                  h(
                    'tr',
                    h('td.small', fmtTime(r.answeredAt), r.scenarioId ? h('div.small.muted', r.scenarioId) : null),
                    h('td', r.issueLabel ?? '—'),
                    h('td', r.active ? h('span.live-dot', STAGE_LABEL[r.stage]) : STAGE_LABEL[r.stage]),
                    h('td', chip(r.outcome ?? 'in_progress'), r.handoff ? h('div.small.muted', r.handoff.reasonLabel) : null),
                    h('td.small', r.lastEvent ? r.lastEvent.title : '—'),
                    h('td', h('div.row', { style: 'margin:0;flex-wrap:nowrap' }, h('button.quiet', { 'aria-expanded': String(open === r.id), onclick: () => showTrail(r.id, trailBox) }, `Event trail (${r.events})`), h('a.btn.quiet', { href: `/#/brief/${r.id}` }, 'Brief'))),
                  ),
                ),
              ),
            ),
          )
        : h('p.empty', 'No demo calls in the last 24 hours. Start one from the home page.'),
      trailBox,
    ),
  );
  if (open) showTrail(open, trailBox, true);
}
async function showTrail(id, box, keep = false) {
  if (!keep && state.openTrail === id) {
    state.openTrail = null;
    mount(box);
    return;
  }
  state.openTrail = id;
  const r = await api(`/api/calls/${id}/timeline`);
  mount(
    box,
    h('h3', { style: 'margin-top:16px' }, `Event trail · ${id}`),
    h('ul.stream', r.items.map((e) => h('li', h('span.t', fmtTime(e.at)), h('span', { class: `dot ${e.status}` }), h('div.what', h('b', e.title), h('div.meta', h('span.stg', STAGE_LABEL[e.stage]), [e.source, e.ref].filter(Boolean).join(' · ')), e.detail ? h('div.det', e.detail) : null)))),
  );
}
