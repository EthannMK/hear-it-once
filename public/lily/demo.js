// Screen 0: demo instructions. The page a judge reads before they talk to Lily — how to drive the
// demo, the five accounts with everything ready to copy, what each one is set up to show, where
// the data comes from and what the prototype deliberately does not do.
//
// It is read-only and needs no endpoints of its own: /api/demo/customers already returns the
// accounts, their situation, a phrase to try and their recent transactions.
import { api, h } from '/js/lib.js';

let K = null; // { render, icon, toast }
export function initDemo(kit) { K = kit; }

const S = { data: null, error: null };

/** Copy a value to the clipboard, saying so on the button itself. */
const copy = (v, label) => h('button.copy', {
  type: 'button', 'aria-label': `Copy ${label}`,
  onclick: async (e) => {
    const b = e.currentTarget;
    try {
      await navigator.clipboard.writeText(v);
      b.textContent = 'Copied'; b.classList.add('done');
      setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done'); }, 1400);
    } catch { K.toast('Copy is not available here. Select the text instead.'); }
  },
}, 'Copy');

const field = (label, value, what) => (value ? h('div.dm-f', h('dt', label), h('dd', h('span.dm-v', value), copy(value, what))) : null);

export async function demoRoute() {
  K.render('demo', h('main.dm', h('section.card', h('p.muted', 'Loading the demo data…'))));
  try { S.data = await api('/api/demo/customers'); S.error = null; }
  catch (e) { S.error = e.message; }
  draw();
}

function draw() {
  const d = S.data ?? {};
  const items = d.items ?? [];
  K.render('demo',
    h('main.dm',
      h('header.dm-head',
        h('h1', 'How to run this demo'),
        h('p.dm-lead', 'Two kinds of question, and only one of them needs the data on this page.'),
        h('p.fine', d.disclaimer ?? 'Northstar Bank is fictional. Every customer, phone number, account reference and card number here is invented. Never enter real card details.')),

      h('section.card.dm-sec.dm-how',
        h('h2', K.icon('info'), 'The two kinds of question'),
        h('div.dm-two',
          h('div.dm-half',
            h('h3', 'Ask anything — no data needed'),
            h('p', 'Branches, opening hours, how to deposit cash, transfer fees, interest rates, how to block or replace a card, scam advice, opening an account. Lily answers these from the bank’s own information and looks nothing up, so you can say it however you like and use any name you want.'),
            h('p.small.muted', 'If it is not something the bank has told her, she says so rather than inventing it. That refusal is the feature — try asking for something obscure.')),
          h('div.dm-half',
            h('h3', 'Anything about a real account — use the data below'),
            h('p', 'An unfamiliar charge, a declined card, a duplicate payment, a fee, a lost card, a balance. These are checked against the bank’s records, so the caller has to be one of the five accounts below and has to pass the security check.'),
            h('p.small.muted', 'In BigQuery mode those records are read live from BigQuery. A card number, phone number or account number that is not on this page will not match: Lily lets you try again, then offers a person.')))),

      h('section.card.dm-sec',
        h('h2', K.icon('flask'), `The five demo accounts (${items.length})`),
        h('p', 'Pick one and keep it for the whole call. Copy the card number before you start — Lily works out who you are from it. Open a row for that account’s transactions.'),
        S.error ? h('p.bad', `The demo data could not be loaded: ${S.error}`)
          : items.length ? h('div.dm-cards', items.map(person))
            : h('p.small.muted', 'No demo accounts are available.')),

      h('p.dm-src', 'All of it is synthetic: the accounts are written for this prototype, the longer transaction history comes from the Sparkov dataset on Kaggle (CC0), and nothing here moves real money or reaches a real bank.'),

      h('p.dm-foot', 'Pick an account above and press ', h('b', 'Start a call as this persona'), '. This page stays open behind it.')));
}

/**
 * One demo account: who they are, what is true of them, and their transactions behind a fold.
 *
 * The same card is used twice — on this page, and pinned beside the live call once a persona has
 * been chosen (see personaRail in app.js). Keeping it one function is deliberate: a judge who has
 * memorised the layout here should not have to re-read a different one during the call, and the
 * card number has to be copyable in both places.
 *
 * `compact` drops the launch button and tightens the spacing for the narrow rail.
 */
export function person(x, { compact = false } = {}) {
  const txns = x.recentTransactions ?? [];
  const extra = [
    ...(x.declines ?? []).map((d) => `Declined: ${d.merchant} ${d.amount} on ${d.at} — ${d.reason}`),
    ...(x.fees ?? []).map((f) => `Fee: ${f.type} ${f.amount} on ${f.at}${f.reversed ? ' (reversed)' : ''}`),
  ];
  return h(`article.dm-card${compact ? '.compact' : ''}`,
    h('div.dm-top',
      h('div', h('h3', x.name), h('p.small.muted', x.blurb)),
      h(`span.badge.${x.cardStatus === 'active' ? 'mint' : 'coral'}`, `Card ${x.cardStatus}`)),
    h('dl.dm-fields',
      field('Card number', x.cardNumber, `${x.name} card number`),
      field('Phone number', x.phone, `${x.name} phone number`),
      field('Account number', x.accountRef, `${x.name} account number`),
      field('NRC last 4', x.nrcLast4, `${x.name} NRC digits`)),
    h('p.dm-sit', h('b', 'What is true of this account: '), x.situation),
    x.tryPhrase ? h('p.dm-try', h('span', 'Try saying'), h('q', x.tryPhrase), copy(x.tryPhrase, `${x.name} phrase`)) : null,
    extra.length ? h('ul.dm-extra', extra.map((e) => h('li', e))) : null,
    compact ? null : h('button.btn.dark.dm-go', {
      type: 'button',
      title: 'Copies the card number and opens the call in a new tab, with this account pinned beside it',
      onclick: async (e) => {
        const btn = e.currentTarget;
        try { await navigator.clipboard.writeText(x.cardNumber); btn.replaceChildren(K.icon('check'), 'Card number copied — opening…'); }
        catch { btn.replaceChildren(K.icon('phone'), 'Opening…'); K.toast('Copy is not available here; copy the card number by hand.'); }
        // The persona travels with the call, so the new tab shows this account beside Lily and
        // nobody has to keep a second tab open to read their own card number back.
        window.open(`/?persona=${encodeURIComponent(x.id)}#/`, '_blank', 'noopener');
        setTimeout(() => btn.replaceChildren(K.icon('phone'), 'Start a call as this persona'), 2200);
      },
    }, K.icon('phone'), 'Start a call as this persona'),
    txns.length
      ? h('details.dm-txd',
        h('summary', `Transactions on file (${txns.length})`),
        h('div.tablewrap', h('table.dm-txt',
          h('thead', h('tr', ['Date', 'Merchant', 'Type', 'Status', 'Amount'].map((c) => h('th', { scope: 'col' }, c)))),
          h('tbody', txns.map((t) => h('tr',
            h('td', t.at),
            h('td', h('b', t.merchant)),
            h('td', t.kind),
            h('td', h(`span.st.${t.status}`, t.status)),
            h('td.amt', h('b.mono', t.amount))))))),
        h('p.small.muted', 'The agent screen shows the full history behind these, with the bank-system detail on each entry.'))
      : h('p.small.muted', 'No transactions on file for this account.'));
}
