// Screen 3: safety and controls. What stops this assistant doing the wrong thing, shown live rather
// than described — the off switch as it stands now, the audit log checked against its own hashes
// while you watch, the last accuracy run with its date and commit, and the fraud patterns the call
// policy is built against with what enforces each.
//
// It is an operations screen, so it signs in as the operations role rather than the agent one. That
// is not decoration: an agent has neither the permission to read policy nor the permission to stop
// the assistant, and the server would refuse. Going back to screen 2 signs in as the agent again.
import { api, h } from '/js/lib.js';

let K = null; // { render, icon, toast }
export function initSafety(kit) { K = kit; }

const S = { me: null, safety: null, chain: null, card: null, patterns: null, busy: false };

const pct = (p, of) => (of ? `${Math.round((p / of) * 100)}%` : '—');
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null);

const MODES = [
  { id: 'normal', label: 'Working normally', blurb: 'Answering calls and carrying out the actions it is allowed to.' },
  { id: 'actions_paused', label: 'Actions paused', blurb: 'Still answering and still looking things up, but changing nothing. Anything that would alter an account goes to a person with the work so far written down.' },
  { id: 'assistant_off', label: 'Switched off', blurb: 'Not taking calls. Every caller goes straight to a person, before Lily introduces herself.' },
];

const MEASURES = {
  intent: 'Worked out what the call was about',
  actions: 'Did exactly the right things to the account',
  escalation: 'Took the right course about passing the call to a person',
  verification: 'Changed nothing before identity was confirmed',
  disclosure: 'Said no account detail to an unverified caller',
};

const STATE_TONE = { enforced: ['mint', 'Enforced'], partial: ['amber', 'Partly enforced'], out_of_scope: ['lav', 'Out of scope'] };

/** Operations sign-in. The agent role cannot read this screen, and should not be able to. */
async function ensureOps() {
  let me = await api('/api/auth/me');
  if (!me.authenticated || me.role !== 'admin') {
    await api('/api/auth/demo-login', { method: 'POST', body: { userId: 'STF-ADMIN-1' } });
    me = await api('/api/auth/me');
  }
  S.me = me;
}

export async function safetyRoute() {
  K.render('safety', h('main.sf', h('section.card', h('p.muted', 'Loading the controls…'))));
  try {
    await ensureOps();
  } catch (e) {
    return K.render('safety', h('main.sf', h('section.card', { role: 'alert' }, h('h2', 'Could not sign in to the operations screen'), h('p', e.message))));
  }
  await load();
}

async function load() {
  const [safety, chain, card, patterns] = await Promise.all([
    api('/api/safety').catch((e) => ({ error: e.message })),
    api('/api/audit/verify').catch((e) => ({ error: e.message })),
    api('/api/scorecard').catch((e) => ({ error: e.message })),
    api('/api/fraud-patterns').catch((e) => ({ error: e.message })),
  ]);
  Object.assign(S, { safety, chain, card, patterns });
  draw();
}

function draw() {
  K.render('safety',
    h('main.sf',
      h('header.sf-head',
        h('h1', 'Safety and controls'),
        h('p', 'Everything on this page is read from the running system, not written into it. The switch below is live: change it and the next caller is treated differently.')),
      switchCard(),
      chainCard(),
      accuracyCard(),
      patternsCard()));
}

/* ------------------------------------------------------------------ the off switch */

function switchCard() {
  const s = S.safety ?? {};
  if (s.error) return h('section.card.sf-sec', h('h2', 'The off switch'), h('p.bad', s.error));
  const current = s.mode ?? 'normal';
  const tone = current === 'normal' ? 'mint' : current === 'actions_paused' ? 'amber' : 'coral';
  const reason = h('textarea', { rows: '2', maxlength: '300', 'aria-label': 'Why you are changing it', placeholder: 'Why — the next shift reads this, and so does the audit log' });

  return h('section.card.sf-sec',
    h('div.sf-h', h('h2', K.icon('lock'), 'The off switch'), h(`span.badge.${tone}`, MODES.find((m) => m.id === current)?.label ?? current)),
    h('p.sf-now', s.description ?? ''),
    s.reason ? h('p.small.muted', `Set ${s.changedBy ? `by ${s.changedBy}` : ''}${s.changedAt ? ` at ${when(s.changedAt)}` : ''} — “${s.reason}”`) : null,
    s.degraded ? h('p.bad.small', 'The stored position could not be read, so the assistant is treated as switched off. A control that reverts to “on” when its own storage is damaged is not a control.') : null,
    h('div.sf-modes', MODES.map((m) => h(`label.sf-mode${m.id === current ? '.on' : ''}`,
      h('input', { type: 'radio', name: 'sf-mode', value: m.id, checked: m.id === current || null, disabled: !s.mayChange || null }),
      h('div', h('b', m.label), h('span', m.blurb))))),
    s.mayChange
      ? h('div.sf-act', reason,
          h('button.btn.dark', { type: 'button', onclick: (e) => apply(e.currentTarget, reason) }, 'Apply'))
      : h('p.small.muted', 'Your role may read this but not change it. Operations and administrators can.'),
    h('p.small.muted', 'Enforced where the decision is made, not here: a paused switch is refused by the policy engine before any eligibility rule is read, so nothing a caller says and nothing a model returns can route around it. Staff are not affected — the switch stops the assistant, not the bank.'));
}

async function apply(btn, reason) {
  const mode = document.querySelector('input[name="sf-mode"]:checked')?.value;
  const why = reason.value.trim();
  if (!mode) return K.toast('Choose a position first.');
  if (why.length < 3) { reason.focus(); return K.toast('Say why. It goes in the audit log.'); }
  btn.disabled = true;
  try {
    await api('/api/safety', { method: 'PUT', body: { mode, reason: why } });
    K.toast(mode === 'normal' ? 'The assistant is working normally again.' : 'Done. The next caller is treated differently.');
    await load();
  } catch (e) {
    K.toast(`Could not change it: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ the audit log */

function chainCard() {
  const c = S.chain ?? {};
  if (c.error) return h('section.card.sf-sec', h('h2', 'The audit log'), h('p.bad', c.error));
  const ok = c.ok && c.checked > 0;
  return h('section.card.sf-sec',
    h('div.sf-h', h('h2', K.icon('check'), 'The audit log'),
      h(`span.badge.${c.ok ? 'mint' : 'coral'}`, c.ok ? (c.checked ? 'Verified' : 'Nothing logged yet') : 'Does not verify')),
    h('p.sf-now', c.ok
      ? `${c.checked} row${c.checked === 1 ? '' : 's'} checked. Each one carries a keyed hash of itself and of the row before it, and the last hash is kept outside the table — so an edit, a deleted row, a renumbering, or rows removed from the end all show up here.`
      : 'The log does not agree with its own hashes. Each problem below names the row.'),
    c.problems?.length ? h('ul.sf-probs', c.problems.map((p) => h('li', p.id ? h('b', `row ${p.id}: `) : null, p.problem))) : null,
    h('dl.sf-kv',
      h('dt', 'Last hash'), h('dd', h('code.sf-hash', c.head?.hash ?? '—')),
      h('dt', 'Key held'), h('dd', c.keyAnchor === 'environment'
        ? 'Outside the database, in the environment. Someone who can write to the database cannot recompute the chain, so an edit cannot be covered up.'
        : 'In the database, beside the log — no AUDIT_CHAIN_KEY is set. Edits made outside the application still show up; someone who reads the key and recomputes the whole chain would not be caught. Set AUDIT_CHAIN_KEY to close that.'),
      c.sealedRetroactivelyThrough ? h('dt', 'Sealed after the fact') : null,
      c.sealedRetroactivelyThrough ? h('dd', `Rows up to ${c.sealedRetroactivelyThrough} were written before the log was chained and were hashed in place afterwards.`) : null),
    h('div.sf-act',
      h('button.btn', { type: 'button', onclick: (e) => recheck(e.currentTarget) }, K.icon('retry'), 'Check it again'),
      ok ? h('p.small.muted', 'Copy that last hash somewhere it cannot be rewritten and the log becomes checkable against an outside record, which is what a real deployment would do.') : null));
}

async function recheck(btn) {
  btn.disabled = true;
  try {
    S.chain = await api('/api/audit/verify');
    draw();
    K.toast(S.chain.ok ? `Checked ${S.chain.checked} rows. Intact.` : 'The log does not verify.');
  } catch (e) { K.toast(e.message); }
  finally { btn.disabled = false; }
}

/* ------------------------------------------------------------------ accuracy */

function accuracyCard() {
  const c = S.card ?? {};
  if (c.error) return h('section.card.sf-sec', h('h2', 'Accuracy'), h('p.bad', c.error));
  if (!c.recorded) {
    return h('section.card.sf-sec', h('h2', K.icon('activity'), 'Accuracy'),
      h('p.sf-now', c.note ?? 'No accuracy run has been recorded for this build.'),
      h('p.small.muted', 'There is deliberately no number here rather than a zero that could be read as a result.'));
  }
  const rows = Object.entries(c.measures ?? {}).map(([k, m]) => h('tr',
    h('th', { scope: 'row' }, MEASURES[k] ?? k),
    h('td.n', `${m.passed}/${m.of}`),
    h('td.n', h(`span.badge.${m.of && m.passed === m.of ? 'mint' : 'coral'}`, pct(m.passed, m.of)))));
  return h('section.card.sf-sec',
    h('div.sf-h', h('h2', K.icon('activity'), 'Accuracy'), h('span.badge.lav', `Run ${when(c.at)}${c.commit ? ` · ${c.commit}` : ''}`)),
    h('p.sf-now', 'Every demo scenario played against the real API, one fresh database each, graded on what the records show. Re-run it with ', h('code', 'npm run scorecard'), ' and you should get the same table.'),
    h('div.tablewrap', h('table.sf-table', h('tbody', rows))),
    h('p.small', h('b', `Finished without a person: ${c.containment?.without}/${c.containment?.of} (${pct(c.containment?.without ?? 0, c.containment?.of ?? 0)}).`), ' A business figure rather than a score — a bank may want it lower, and an assistant that escalates nothing is not a good one.'),
    h('p.small.muted', 'Worth knowing when reading a high row: the identity and disclosure rules were fixed before anything ran, and the issue each scenario is about comes from its definition. The course to take about a person was judged after watching the first run, which is weaker evidence than the rest.'),
    c.skipped?.length ? h('p.small.muted', `Not scored: ${c.skipped.map((s) => `${s.id} (${s.why})`).join('; ')}. Both have tests of their own.`) : null);
}

/* ------------------------------------------------------------------ fraud patterns */

function patternsCard() {
  const p = S.patterns ?? {};
  if (p.error) return h('section.card.sf-sec', h('h2', 'Fraud patterns'), h('p.bad', p.error));
  const items = p.items ?? [];
  return h('section.card.sf-sec',
    h('div.sf-h', h('h2', K.icon('alert'), 'What the call policy is built against'), h('span.badge.lav', `${items.length} documented patterns`)),
    h('p.sf-now', 'Each of these is an attack contact centres actually see. The control beside it is enforced in the back end, never by asking the model nicely. A pattern marked out of scope is named so it is not mistaken for a solved problem.'),
    h('div.sf-pats', items.map((x) => {
      const [tone, label] = STATE_TONE[x.state] ?? ['lav', x.state];
      return h('details.sf-pat',
        h('summary', h('span.sf-pid', x.id), h('b', x.name), h(`span.badge.${tone}`, label)),
        h('div.sf-patb',
          h('p', h('b', 'How it runs. '), x.howItWorks),
          h('p', h('b', 'What we do. '), x.control),
          x.signals?.length ? h('p.small', h('b', 'What we can see: '), x.signals.join('; ')) : null,
          x.enforcedIn?.length ? h('p.small.muted', h('b', 'Enforced in: '), x.enforcedIn.join(', ')) : null,
          x.source ? h('p.small.muted', h('b', 'Source: '), x.source) : null));
    })),
    p.note ? h('p.small.muted', p.note) : null);
}
