// Screen 3: guardrails. What stops this assistant doing the wrong thing — how each safeguard is
// built, and then the fraud patterns the call policy is written against, read live from the running
// system along with the file that enforces each one.
//
// The page is read-only. Operational detail that belongs to whoever runs the service — the off
// switch, the audit log check, the last accuracy run — is reached through the API and deliberately
// not surfaced here, because a screen people read over someone's shoulder is the wrong place for
// controls and for figures that need their context explained.
//
// It still signs in as the operations role rather than the agent one, because an agent has no
// permission to read policy and the server would refuse. Going back to screen 2 signs in as the
// agent again.
import { api, h } from '/js/lib.js';

let K = null; // { render, icon, toast }
export function initSafety(kit) { K = kit; }

const S = { me: null, patterns: null };




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
  K.render('guardrails', h('main.sf', h('section.card', h('p.muted', 'Loading the controls…'))));
  try {
    await ensureOps();
  } catch (e) {
    return K.render('guardrails', h('main.sf', h('section.card', { role: 'alert' }, h('h2', 'Could not sign in to the operations screen'), h('p', e.message))));
  }
  await load();
}

async function load() {
  S.patterns = await api('/api/fraud-patterns').catch((e) => ({ error: e.message }));
  draw();
}

function draw() {
  K.render('guardrails',
    h('main.sf',
      h('header.sf-head',
        h('h1', 'How the guardrails are built'),
        h('p', 'An assistant that can block a card and move a dispute has to be stopped from doing it wrongly. This page sets out how that is done, and then the attacks the call policy was written against. The patterns are read from the running system as you open the page.')),
      howCard(),
      patternsCard()));
}

/* ------------------------------------------------------------------ the explanation */

const HOW = [
  ['The model never decides anything that matters.',
    'Lily holds the conversation. Every banking decision — whether a caller is verified, whether a dispute is eligible, whether an action may run — is made by the back end from the records, and the model is told the answer. A tool call that arrives without the customer’s own words behind it changes nothing, so a model that is persuaded, confused or simply wrong cannot act on it.'],
  ['Consent is read from what the caller actually said.',
    'An action runs only after the customer’s own spoken yes, matched against the turn it belongs to. A “yes” the assistant produced herself is not consent, and a yes to one question is not consent to the next.'],
  ['Nothing about an account is said before identity is proven.',
    'Balances, charges and card status stay hidden until the security check passes, and the check is a back-end decision recorded against the call. The agent screen shows one wording — Verified, Pending, Failed, Not verified — and never infers it from what the caller claimed.'],
  ['The caller names the charge; the bank confirms it.',
    'The assistant does not read out a list of recent purchases to someone who has described nothing. The caller says what they are querying and the records confirm or contradict it, so a stranger learns nothing by calling.'],
  ['Every action is reversible on paper, and an unknown outcome stays unknown.',
    'If a downstream system times out, the operation is recorded as Unknown rather than guessed either way, is never silently resent, and is reconciled against the truth afterwards. The agent screen keeps a suggestion and a completed action visibly apart.'],
  ['Everything is written down, and the log can be checked.',
    'Every read, every change and every refusal is appended to an audit log. Each row carries a keyed hash of itself and of the row before it, so an edit, a deletion or a renumbering breaks the chain and fails the check the operations team runs against it.'],
  ['The assistant can be switched off without a deploy.',
    'One stored setting decides whether it takes calls, takes calls but changes nothing, or hands every caller straight to a person. The policy engine reads it before any rule, so nothing a caller says and nothing a model returns can route around it, and switching it costs nothing but the call it is on.'],
];

function howCard() {
  return h('section.card.sf-sec',
    h('div.sf-h', h('h2', K.icon('lock'), 'The seven things that hold it together')),
    h('div.sf-how', HOW.map(([q, a], i) => h('div.sf-howi', h('span.sf-n', String(i + 1)), h('div', h('b', q), h('p', a))))));
}

/* ------------------------------------------------------------------ fraud patterns */

function patternsCard() {
  const p = S.patterns ?? {};
  if (p.error) return h('section.card.sf-sec', h('h2', 'Fraud patterns'), h('p.bad', p.error));
  const items = p.items ?? [];
  return h('section.card.sf-sec',
    h('div.sf-h', h('h2', K.icon('alert'), 'What the call policy is built against'), h('span.badge.lav', `${items.length} documented patterns`)),
    h('p.sf-now', 'Each of these is an attack contact centres actually see. The control beside it runs in the back end; none of it is left to the model’s judgement. A pattern marked out of scope is named so it is not mistaken for a solved problem.'),
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
