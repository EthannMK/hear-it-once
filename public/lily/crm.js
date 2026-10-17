// Screen 2: the bank agent's workspace for ONE caller at a time.
//   #/crm                    opens the latest call (a waiting or live one first)
//   #/crm/case/:id           the case: caller, account, balance, usage, case, tickets, AI back office
//   #/crm/customer/:id       any customer, found with the search box (same layout, no call)
//   #/crm/call/:sessionId    the case for a call (where the call screen hands over)
// Everything shown comes from the API (bank records, case store, back-office agent). Every change
// goes back through the API, which checks permissions, validates, saves and audits it.
import { api, h, uid } from '/js/lib.js';

let K = null; // { render, icon, toast }
export function initCrm(kit) { K = kit; }

const C = { me: null, timer: null, ws: null, dirty: false, openTicketForm: null, openRec: null, side: 'ai', cust: 'account', ai: {}, joined: null, joinedFor: null, lastCall: null };
const fmtWhen = (iso) => { try { const d = new Date(iso); const today = new Date().toDateString() === d.toDateString(); return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }); } catch { return ''; } };
const fmtFull = (iso) => { try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const initials = (n) => String(n ?? '?').split(' ').map((x) => x[0]).join('').slice(0, 2).toUpperCase();
const PRI = { urgent: ['coral', 'Urgent'], high: ['amber', 'High'], normal: ['lav', 'Normal'] };
const ST = { new: 'lav', in_progress: 'violet', awaiting_customer: 'amber', awaiting_bank: 'amber', escalated: 'coral', resolved: 'mint' };
const ACT = { completed: 'mint', awaiting_customer: 'lav', awaiting_approval: 'amber', in_progress: 'amber', failed: 'coral', unknown: 'coral', declined: 'lav' };
const badge = (tone, text) => h(`span.badge.${tone}`, text);
const cap = (s) => String(s ?? '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** A small in-page confirmation box (a native <dialog>). Resolves true / false, or the typed text when `ask` is set. */
function confirmBox({ title, body, confirmLabel = 'Confirm', ask = null, tone = 'dark' }) {
  return new Promise((resolve) => {
    const dlg = h('dialog.crm-dlg', { 'aria-labelledby': 'crm-dlg-title' });
    const field = ask ? h('textarea', { rows: '3', maxlength: '300', 'aria-label': ask, placeholder: ask }) : null;
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    const ok = h('button.btn.' + tone, { type: 'submit' }, confirmLabel);
    dlg.append(h('form', { method: 'dialog', onsubmit: (e) => { e.preventDefault(); if (field && field.value.trim().length < 3) { field.focus(); return; } done(field ? field.value.trim() : true); } },
      h('h2#crm-dlg-title', title), body ? h('p', body) : null, field,
      h('div.row3', ok, h('button.btn', { type: 'button', onclick: () => done(false) }, 'Cancel'))));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    document.body.append(dlg);
    dlg.showModal();
    (field ?? ok).focus();
  });
}

function stop() { clearInterval(C.timer); C.timer = null; }

/** Demo sign-in: the CRM is a staff screen, so the judge is signed in as the demo agent. */
async function ensureAgent() {
  let me = await api('/api/auth/me');
  if (!me.authenticated || me.role !== 'agent') {
    await api('/api/auth/demo-login', { method: 'POST', body: { userId: 'STF-AGENT-1' } });
    me = await api('/api/auth/me');
  }
  C.me = me;
}

export async function crmRoute(hash) {
  stop();
  const m = hash.match(/^#\/crm(?:\/(case|customer|call)\/([^/?#]+))?/);
  const kind = m?.[1]; const id = m?.[2] ? decodeURIComponent(m[2]) : null;
  if (!document.querySelector('main.cx')) K.render('crm', h('main.cx', h('section.card.cx-empty', h('p.muted', 'Loading the agent workspace…'))));
  try { await ensureAgent(); } catch (e) { return shell(null, errorBox('The agent workspace could not sign in.', e)); }
  if (kind === 'call') {
    try { const r = await api(`/api/crm/calls/${encodeURIComponent(id)}`); location.replace(`#/crm/case/${encodeURIComponent(r.caseId)}`); }
    catch { shell(null, h('section.card.cx-empty', h('h2', 'No case for that call'), h('p', 'Lily didn’t get as far as recording an issue on that call, so no case was opened. Search for a customer above, or start another call.'), h('a.btn.dark', { href: '#/' }, K.icon('phone'), 'Start another call'))); }
    return;
  }
  if (kind === 'case') return casePage(id);
  if (kind === 'customer') return customerPage(id);
  try {
    const r = await api('/api/crm/latest');
    if (r.caseId) return location.replace(`#/crm/case/${encodeURIComponent(r.caseId)}`);
  } catch { /* fall through to the empty state */ }
  shell(null, h('section.card.cx-empty',
    h('span.badge.dark', K.icon('headset'), 'Agent workspace'),
    h('h1', 'No calls yet.'),
    h('p', 'When a customer talks to Lily and asks for a person, their case opens here with everything already filled in. You can also search for any customer above.'),
    h('a.btn.dark', { href: '#/' }, K.icon('phone'), 'Talk to Lily')));
}

/* ------------------------------------------------------------------ layout */

/** The page frame: who is on the line and a search box on top, then the content. */
function shell(head, ...content) {
  K.render('crm', h('main.cx', h('div.cx-bar', head ?? h('div.cx-who', h('div', h('div.nm', h('span', 'Agent workspace')))), search()), ...content));
}

function errorBox(title, e) {
  return h('section.card.cx-empty', { role: 'alert' }, h('h2', title), h('p', e?.status === 404 ? 'It may have been removed when the demo data was reset.' : 'Please try again in a moment.'), h('button.btn', { type: 'button', onclick: () => crmRoute(location.hash) }, K.icon('retry'), 'Try again'));
}

/** Find any customer or case: the judge can look beyond the caller. */
function search() {
  const input = h('input', { type: 'search', placeholder: 'Find a customer or case', 'aria-label': 'Search customers by name, account reference, phone or case reference', maxlength: '120', autocomplete: 'off' });
  const out = h('div.cx-results', { role: 'listbox', hidden: true });
  let t = 0;
  const close = () => { out.hidden = true; };
  const load = async () => {
    const q = input.value.trim();
    if (!q) { out.replaceChildren(); return close(); }
    try {
      const [cu, cs] = await Promise.all([api(`/api/crm/customers?q=${encodeURIComponent(q)}`), api(`/api/crm/cases?view=all&q=${encodeURIComponent(q)}&limit=6`)]);
      const items = [
        ...cu.items.slice(0, 6).map((c) => h('a.cx-hit', { role: 'option', href: `#/crm/customer/${encodeURIComponent(c.id)}`, onclick: close },
          h('span.av2', initials(c.name)), h('div', h('b', c.name), h('span', `${c.accountRef} · ${c.cards[0]?.masked ?? 'no card'} · ${c.totalCases ? `${c.totalCases} case${c.totalCases > 1 ? 's' : ''}` : 'no cases'}`)))),
        ...cs.items.slice(0, 4).map((c) => h('a.cx-hit', { role: 'option', href: `#/crm/case/${encodeURIComponent(c.id)}`, onclick: close },
          h('span.av2.case', K.icon('headset')), h('div', h('b', `${c.id} · ${c.customer ?? 'Unidentified caller'}`), h('span', `${c.issueType} · ${c.statusLabel} · ${fmtWhen(c.updatedAt)}`)))),
      ];
      out.replaceChildren(...(items.length ? items : [h('p.small.muted.pad', `Nothing matches “${q}”.`)]));
    } catch (e) { out.replaceChildren(h('p.small.pad', e.message)); }
    out.hidden = false;
  };
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 220); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = ''; close(); } });
  input.addEventListener('blur', () => setTimeout(close, 200));
  input.addEventListener('focus', () => { if (input.value.trim()) out.hidden = false; });
  return h('div.cx-search', K.icon('search'), input, out);
}

/** Keep each panel's scroll position across a refresh. */
function keepScroll(fn) {
  const sel = ['.cx-cust', '.cx-case', '.cx-side .cx-pane'];
  const pos = sel.map((s) => document.querySelector(s)?.scrollTop ?? 0);
  fn();
  sel.forEach((s, i) => { const el = document.querySelector(s); if (el) el.scrollTop = pos[i]; });
}

/* ------------------------------------------------------------------ case page */

async function casePage(id, opts = {}) {
  let w;
  try { w = await api(`/api/crm/cases/${encodeURIComponent(id)}`); }
  catch (e) { return shell(null, errorBox('This case couldn’t be loaded.', e)); }
  C.ws = w;
  if (C.joinedFor !== id) { C.joinedFor = id; C.joined = null; C.openTicketForm = null; C.openRec = null; }
  if (w.case.live || ['requested', 'queued', 'connected'].includes(w.handoff?.status)) C.lastCall = id;
  keepScroll(() => shell(caseHead(w), joinedNote(w), handoverBar(w), h('div.cx-grid', customerCol(w), caseCol(w), sideCol({ caseId: id }, w))));
  if (!opts.refresh && C.joined) document.querySelector('.cx-hand.wait button')?.focus({ preventScroll: true });
  // A live call or a waiting customer keeps the page current; edits in progress are never overwritten.
  if (w.case.live || ['requested', 'queued', 'connected'].includes(w.handoff?.status)) {
    C.timer = setInterval(async () => {
      if (C.dirty || document.querySelector('dialog[open]') || document.activeElement?.closest?.('form, .cx-search, .cx-rec')) return;
      try {
        const n = await api(`/api/crm/cases/${encodeURIComponent(id)}`);
        if (n.case.updatedAt !== C.ws.case.updatedAt || n.case.live !== C.ws.case.live || n.handoff?.status !== C.ws.handoff?.status || n.transcript.length !== C.ws.transcript.length) { stop(); casePage(id, { refresh: true }); }
      } catch { /* next tick */ }
    }, 4000);
  }
}

function caseHead(w) {
  const cu = w.customer; const eff = w.tags.effective;
  return h('div.cx-who',
    h('span.av3', initials(cu?.name)),
    h('div',
      h('div.nm', cu ? h('a', { href: `#/crm/customer/${encodeURIComponent(cu.id)}` }, cu.name) : h('span', 'Unidentified caller'),
        cu ? (cu.identityVerified ? badge('mint', 'Identity verified') : badge('amber', 'Not verified')) : null,
        w.case.live ? badge('mint', '● On the line') : null),
      h('div.meta2', h('span.mono', w.case.id), h('span', `${eff.category} · ${eff.issueType}`), h('span', `Opened ${fmtFull(w.case.createdAt)}`),
        badge(ST[eff.status] ?? 'lav', eff.statusLabel), badge(PRI[eff.priority][0], `${PRI[eff.priority][1]} priority`),
        ...w.tickets.slice(0, 1).map((t) => h('span.mono', `Ref ${t.id}`)))));
}

/** Arriving from the caller's screen: says plainly whose seat the viewer is now in, until the handover is accepted. */
function joinedNote(w) {
  const sessionId = w.case.sessionId;
  let flag = null;
  try { flag = sessionStorage.getItem('hio_joined_as_agent'); sessionStorage.removeItem('hio_joined_as_agent'); } catch { /* private mode */ }
  if (flag && flag === sessionId) C.joined = sessionId;
  if (C.joined !== sessionId) return null;
  if (!['requested', 'queued'].includes(w.handoff?.status)) return null;
  return h('p.cx-joined', { role: 'status' }, K.icon('headset'), h('span', h('b', 'You are now the bank agent. '), 'The customer is on hold and everything Lily found is below. Read it, then accept the handover to talk to them.'));
}

function handoverBar(w) {
  const hd = w.handoff;
  if (!hd || hd.status === 'cancelled') return null;
  const mine = hd.agent_id === C.me?.userId;
  if (hd.status === 'queued' || hd.status === 'requested') {
    return h('section.cx-hand.wait', { role: 'status' }, K.icon('headset'),
      h('div.grow', h('b', 'The customer is waiting for you'), h('span', `${hd.reasonLabel}. Lily told them a colleague will pick up with the full case, so they won’t repeat anything.`)),
      h('button.btn.dark.cta', { type: 'button', onclick: (e) => act(e.currentTarget, () => api(`/api/handoffs/${hd.id}/accept`, { method: 'POST', body: {} }), 'Handover accepted. The customer has been told you joined.') }, 'Accept handover'));
  }
  if (hd.status === 'connected') {
    const input = h('input', { type: 'text', maxlength: '500', placeholder: mine ? 'Message the customer…' : 'Accepted by another agent', 'aria-label': 'Message to the customer', disabled: !mine });
    const ck = w.agentCheck ?? null;
    return h('section.cx-hand.on', K.icon('headset'),
      h('div.grow', h('b', `You’re with the customer${hd.agentName && !mine ? ` (${hd.agentName})` : ''}`),
        h('form.row3', { onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (!v) return; act(e.submitter, () => api(`/api/handoffs/${hd.id}/message`, { method: 'POST', body: { text: v } }), 'Message sent.'); } }, input, h('button.btn', { type: 'submit', disabled: !mine }, 'Send'))),
      h('div.row3',
        h('button.btn.sm', { type: 'button', disabled: !mine || ck?.status === 'awaiting' || ck?.status === 'passed', title: 'A passcode goes to the registered phone; the customer types it in.', onclick: (e) => act(e.currentTarget, () => api(`/api/handoffs/${hd.id}/identity-check`, { method: 'POST', body: {} }), 'Passcode sent. Ask the customer to type it in.') },
          K.icon('lock'), ck?.status === 'awaiting' ? 'Passcode sent' : ck?.status === 'passed' ? 'Verified by passcode' : ck?.status === 'failed' ? 'Passcode failed' : 'Verify by passcode'),
        h('button.btn.dark', { type: 'button', disabled: !mine, onclick: (e) => finishHandover(e.currentTarget, hd) }, 'Finish call')));
  }
  return h('section.cx-hand', K.icon('headset'), h('div.grow', h('b', hd.status === 'completed' ? `Handled by ${hd.agentName ?? 'an agent'}` : 'No agent was available'), h('span', hd.status === 'completed' ? `Outcome: ${cap(hd.outcome)}` : 'A callback was requested.')));
}

async function finishHandover(btn, hd) {
  const outcome = h('select', { 'aria-label': 'Outcome' }, h('option', { value: 'resolved' }, 'Resolved'), h('option', { value: 'follow_up_required' }, 'Follow-up needed'), h('option', { value: 'unresolved' }, 'Not resolved'));
  const notes = h('textarea', { rows: '3', maxlength: '1000', 'aria-label': 'Notes for the case', placeholder: 'Notes for the case (optional)' });
  const ok = await new Promise((resolve) => {
    const dlg = h('dialog.crm-dlg', { 'aria-labelledby': 'fin-t' });
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(h('form', { onsubmit: (e) => { e.preventDefault(); done(true); } },
      h('h2#fin-t', 'Finish this call'), h('p', 'The outcome and your notes are saved on the case.'),
      h('label.fld', h('span', 'Outcome'), outcome), h('label.fld', h('span', 'Notes'), notes),
      h('div.row3', h('button.btn.dark', { type: 'submit' }, 'Finish'), h('button.btn', { type: 'button', onclick: () => done(false) }, 'Cancel'))));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    document.body.append(dlg); dlg.showModal(); outcome.focus();
  });
  if (ok) act(btn, () => api(`/api/handoffs/${hd.id}/complete`, { method: 'POST', body: { outcome: outcome.value, notes: notes.value.trim(), customerRepeatedIssue: false } }), 'Call finished and saved on the case.');
}

/** Run a change, then reload. Buttons are disabled while it runs, so a double click can’t send it twice. */
async function act(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try {
    await fn();
    if (okMsg) K.toast(okMsg);
    C.dirty = false;
    stop();
    if (location.hash.startsWith('#/crm/case/') && C.ws?.case) await casePage(C.ws.case.id, { refresh: true });
    else await crmRoute(location.hash);
  } catch (e) { K.toast(e.status === 409 ? e.message : `That didn’t go through: ${e.message}`); if (btn) btn.disabled = false; }
}

/* ------------------------------------------------------------------ left column: the customer */

function customerCol(w) {
  const cu = w.customer;
  if (!cu || !w.account) {
    return h('aside.cx-cust', { 'aria-label': 'Customer' },
      h('section.card.cx-sec.cx-unver',
        h('h2', K.icon('lock'), 'Caller not verified'),
        h('p', cu ? `Lily matched the caller to ${cu.name}, but they have not passed the security check, so the account stays hidden.` : 'Lily could not match the caller to a customer, so no account is shown.'),
        h('p.small.muted', 'Accept the handover, then use “Verify by passcode” before discussing the account. Or search for the customer above.'),
        w.summary.reported ? h('p.cx-said', `“${w.summary.reported}”`) : null));
  }
  return custPanel(w, cu);
}

/**
 * The customer's side of the screen, as one panel with tabs rather than a stack of cards: the
 * account at a glance, the transactions behind it, and what happened on earlier calls. An agent
 * works one of these at a time, and the screen stays on one page.
 */
function custPanel(w, cu) {
  const earlier = (w.previousCases ?? []).filter((x) => x.id !== w.case?.id);
  const tabs = [
    ['account', 'Account'],
    ['tx', `Transactions${w.transactions?.length ? ` (${w.transactions.length})` : ''}`],
    ['history', `History${earlier.length ? ` (${earlier.length})` : ''}`],
  ];
  if (!tabs.some(([k]) => k === C.cust)) C.cust = 'account';
  const pane = h('div.cx-pane');
  const btns = tabs.map(([k, label]) => h('button', { type: 'button', role: 'tab', 'data-k': k, onclick: () => { C.cust = k; draw(); } }, label));
  function draw() {
    for (const b of btns) b.setAttribute('aria-selected', String(b.dataset.k === C.cust));
    pane.replaceChildren(
      C.cust === 'tx' ? h('div.cx-stack', txCard(w.transactions, cu))
        : C.cust === 'history' ? h('div.cx-stack', interactionsCard(w.previousCases ?? [], w.case?.id))
          : h('div.cx-stack', accountCard(cu, w.focus?.cardRef), balanceCard(w.account), usageCard(w.account, w.history)),
    );
  }
  draw();
  return h('aside.card.cx-cust', { 'aria-label': 'Customer' }, h('div.cx-tabs', { role: 'tablist' }, btns), pane);
}

function accountCard(cu, focusRef) {
  const card = cu.cards.find((k) => k.ref === focusRef) ?? cu.cards[0];
  const others = cu.cards.filter((k) => k !== card);
  const tone = (s) => (s === 'active' ? 'mint' : 'coral');
  return h('section.card.cx-sec',
    h('h2', 'Account status'),
    h('div.cx-kv',
      h('span', 'Standing'), h('b', cu.standing === 'good' ? badge('mint', 'Good standing') : badge('coral', cap(cu.standing))),
      h('span', focusRef ? 'Card on this call' : 'Card'), h('b', card ? [`${card.network} ${card.masked} `, badge(tone(card.status), cap(card.status) + (card.statusReason ? ` · ${card.statusReason.replace(/_/g, ' ')}` : ''))] : '—'),
      others.length ? [h('span', 'Other cards'), h('b', others.map((k) => `${k.masked} ${k.status}`).join(', '))] : null,
      h('span', 'Fraud alerts'), h('b', cu.openFraudAlerts ? badge('coral', `${cu.openFraudAlerts} open`) : badge('mint', 'None open')),
      h('span', 'Contact'), h('b.small', `${cu.phone} · ${cu.accountRef}`)));
}

function balanceCard(a) {
  const bar = h('span.fill');
  bar.style.width = `${a.utilisation}%`;
  return h('section.card.cx-sec.cx-bal',
    h('h2', 'Balance'),
    h('div.cx-money', h('div', h('span', 'Current balance'), h('b', a.balance)), h('div', h('span', 'Available credit'), h(`b${a.lowCredit || a.utilisation > 90 ? '.warn' : ''}`, a.available))),
    h(`div.cx-meter${a.utilisation > 90 ? '.hot' : ''}`, { role: 'img', 'aria-label': `${a.utilisation}% of the ${a.limit} limit used` }, bar),
    h('p.small.muted', `${a.utilisation}% of ${a.limit} limit used${a.pending ? ` · ${a.pending} pending` : ''}${a.lastPayment ? ` · last payment ${a.lastPayment.amount}, ${fmtWhen(a.lastPayment.at)}` : ''}`));
}

function usageCard(a, history) {
  const max = Math.max(1, ...a.usage.months.map((m) => m.minor));
  const cmax = Math.max(1, ...a.usage.categories.map((c) => c.minor));
  const bars = (items, top, label, value) => h('ul.cx-bars', items.map((x) => { const f = h('i'); f.style.width = `${Math.max(2, Math.round((x.minor / top) * 100))}%`; return h('li', h('span', label(x)), h('span.track', f), h('b', value(x))); }));
  return h('section.card.cx-sec',
    h('h2', 'Transaction usage', history ? badge('lav', 'BigQuery') : null),
    h('p.small', h('b', a.usage.last30), ` spent in the last 30 days · ${a.usage.purchases30} purchase${a.usage.purchases30 === 1 ? '' : 's'}`),
    bars(a.usage.months, max, (m) => m.label, (m) => m.amount),
    a.usage.categories.length ? [h('p.cap', 'Top categories · 90 days'), bars(a.usage.categories, cmax, (c) => cap(c.category), (c) => c.amount)] : null,
    history ? h('p.small.muted', `${history.transactions.toLocaleString()} transactions on file${history.firstAt ? ` since ${fmtWhen(history.firstAt)}` : ''} · live from ${history.source}`) : null);
}

function txCard(txns, cu) {
  return h('section.card.cx-sec.cx-tx',
    h('div.cx-h', h('h2', 'Recent transactions'), location.hash.includes('/customer/') ? null : h('a.small', { href: `#/crm/customer/${encodeURIComponent(cu.id)}` }, 'See all')),
    txns.length ? h('ul.cx-txl', txns.map((t) => txRow(t)))
      : h('p.small.muted', 'No transactions.'));
}

/* ------------------------------------------------------------------ middle column: the case */

/**
 * One transaction as a card agent reads it. The row carries what identifies the entry; the detail
 * underneath carries what a dispute or a fraud check needs, and opens on click so the list stays
 * scannable.
 */
function txRow(t) {
  const when = new Date(t.at);
  const time = isNaN(when) ? '' : when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const detail = [
    ['Authorised', `${fmtWhen(t.at)}${time ? ` at ${time}` : ''}`],
    t.postedAt ? ['Settled', fmtWhen(t.postedAt)] : ['Settled', 'Not yet settled'],
    ['Type', t.typeLabel ?? t.kind],
    t.entryLabel ? ['Entry', t.entryLabel] : null,
    t.where ? ['Merchant location', t.where] : null,
    t.mcc ? ['Category code', `${t.mcc}${t.mccLabel ? ` · ${t.mccLabel}` : ''}`] : null,
    t.card ? ['Card', t.card] : null,
    t.authCode ? ['Auth code', t.authCode] : null,
    t.networkRef ? ['Acquirer reference', t.networkRef] : null,
    t.acquirer ? ['Acquirer', t.acquirer] : null,
  ].filter(Boolean);
  const open = (e) => e.currentTarget.closest('li').classList.toggle('open');
  return h(`li${t.focus ? '.focus' : ''}`,
    h('button.txh', { type: 'button', onclick: open, 'aria-label': `Details for ${t.merchant} ${t.amount}` },
      h('div.txm',
        h('b', t.merchant),
        h('span', [fmtWhen(t.at), time, t.typeLabel ?? t.kind, t.statusLabel && t.status !== 'posted' ? t.statusLabel : null, t.where].filter(Boolean).join(' · '))),
      h('div.amt', h('b.mono', t.amount), t.focus ? badge('amber', 'This call') : t.disputed ? badge('lav', 'Disputed') : null)),
    h('dl.txd', detail.map(([k, v]) => h('div', h('dt', k), h('dd.mono', v)))));
}

function caseCol(w) {
  return h('section.cx-case', { 'aria-label': 'Case' }, summaryCard(w), recommendation(w), actionsCard(w), ticketsCard(w));
}

function summaryCard(w) {
  const s = w.summary;
  const li = (items, cls, iconName) => h(`ul.list.${cls}`, items.slice(0, 4).map((x) => h('li', K.icon(iconName), h('span', x))));
  const tx = w.taxonomy; const ov = w.tags.overrides; const eff = w.tags.effective;
  const save = (key) => (e) => act(e.currentTarget, () => api(`/api/crm/cases/${w.case.id}`, { method: 'PATCH', body: { version: w.case.version, overrides: { [key]: e.currentTarget.value || null } } }), 'Case updated.');
  return h('section.card.cx-sec',
    h('div.cx-h', h('h2', 'Case summary'),
      h('div.cx-sel',
        h('select', { 'aria-label': 'Case status', onchange: save('status') }, tx.statuses.map((x) => h('option', { value: x.id, ...(eff.status === x.id ? { selected: '' } : {}) }, x.label))),
        h('select', { 'aria-label': 'Priority', onchange: save('priority') }, tx.priorities.map((p) => h('option', { value: p, ...(eff.priority === p ? { selected: '' } : {}) }, `${cap(p)} priority`))),
        ov.status || ov.priority ? h('span.small.muted', 'set by agent') : null)),
    h('p.prose.clamp', { title: 'Click to show all', onclick: (e) => e.currentTarget.classList.toggle('open') }, w.summaryText),
    s.confirmed.length || s.unresolved.length ? h('div.cx-two',
      s.confirmed.length ? h('div', h('h3', 'Confirmed'), li(s.confirmed, 'ok', 'check')) : null,
      s.unresolved.length ? h('div', h('h3', 'Still open'), li(s.unresolved, 'bad', 'alert')) : null) : null);
}

function recommendation(w) {
  const recs = w.recommendations;
  const top = recs.find((r) => r.status !== 'rejected') ?? recs[0];
  if (!top) return null;
  const rest = recs.filter((r) => r !== top);
  const stLabel = { suggested: null, accepted: ['mint', 'Accepted'], rejected: ['lav', 'Rejected'], edited: ['violet', 'Edited'] };
  const one = (r, big) => {
    const editing = C.openRec === r.kind;
    const ta = h('textarea', { rows: '2', maxlength: '500', 'aria-label': 'Your version of the next step' }, r.editedText ?? r.title);
    const post = (body, msg) => (e) => act(e.currentTarget, () => api(`/api/crm/cases/${w.case.id}/recommendations/${r.kind}`, { method: 'POST', body }), msg);
    return h(`div.cx-rec${big ? '.big' : ''}`,
      h('div.rt', h('b', r.editedText ?? r.title), stLabel[r.status] ? badge(...stLabel[r.status]) : null),
      h('p.small', h('span.why', 'Why: '), r.reason),
      editing
        ? h('form.row3', { onsubmit: (e) => { e.preventDefault(); C.openRec = null; act(e.submitter, () => api(`/api/crm/cases/${w.case.id}/recommendations/${r.kind}`, { method: 'POST', body: { decision: 'edit', text: ta.value.trim() } }), 'Your version is saved.'); } }, ta, h('button.btn.sm.dark', { type: 'submit' }, 'Save'), h('button.btn.sm', { type: 'button', onclick: () => { C.openRec = null; casePage(w.case.id, { refresh: true }); } }, 'Cancel'))
        : h('div.row3',
          h('button.btn.sm.mint', { type: 'button', disabled: r.status === 'accepted', onclick: post({ decision: 'accept' }, 'Accepted. Nothing on the account changes until you or the customer act.') }, K.icon('check'), 'Accept'),
          h('button.btn.sm', { type: 'button', onclick: () => { C.openRec = r.kind; casePage(w.case.id, { refresh: true }); } }, 'Edit'),
          h('button.btn.sm.ghost', { type: 'button', disabled: r.status === 'rejected', onclick: post({ decision: 'reject' }, 'Suggestion rejected.') }, 'Reject')));
  };
  return h('section.card.cx-sec.cx-recs', h('h2', 'Suggested next step', badge('amber', 'Not done yet')),
    one(top, true),
    rest.length ? h('details', h('summary', `${rest.length} more suggestion${rest.length > 1 ? 's' : ''}`), rest.map((r) => one(r, false))) : null);
}

function actionsCard(w) {
  if (!w.actions.length) return null;
  return h('section.card.cx-sec', h('h2', 'Actions on the account'),
    h('ul.cx-acts', w.actions.map((a) => h('li',
      h('div', h('b', a.label), h('span', a.reference ? `Ref ${a.reference}` : a.error ?? '')),
      badge(ACT[a.state] ?? 'lav', a.stateLabel),
      a.canApprove ? h('div.row3',
        h('button.btn.sm.mint', { type: 'button', onclick: async (e) => { const b = e.currentTarget; if (await confirmBox({ title: `Approve “${a.label}”?`, body: 'This sends the request to the bank. It cannot be undone from here.', confirmLabel: 'Approve and send', tone: 'mint' })) act(b, () => api(`/api/actions/${a.id}/approve`, { method: 'POST', body: {} }), 'Approved and sent.'); } }, 'Approve'),
        h('button.btn.sm.ghost', { type: 'button', onclick: async (e) => { const b = e.currentTarget; const reason = await confirmBox({ title: `Reject “${a.label}”?`, body: 'Nothing will be changed on the account.', ask: 'Why are you rejecting it?', confirmLabel: 'Reject' }); if (reason) act(b, () => api(`/api/actions/${a.id}/reject`, { method: 'POST', body: { reason } }), 'Rejected. Nothing was changed.'); } }, 'Reject')) : null,
      a.canCheck ? h('button.btn.sm', { type: 'button', onclick: (e) => act(e.currentTarget, () => api(`/api/actions/${a.id}/reconcile`, { method: 'POST', body: {} }), 'Status checked with the bank system.') }, K.icon('retry'), 'Check status') : null))));
}

const TK_NEXT = { open: [['in_progress', 'Start work']], in_progress: [['resolved', 'Mark resolved']], resolved: [['closed', 'Close']], closed: [] };
const tkTone = (s) => (s === 'closed' || s === 'resolved' ? 'mint' : s === 'in_progress' ? 'violet' : 'amber');

function ticketRow(t, editable) {
  return h('li',
    h('div.rt', h('b', `${t.typeLabel} · ${t.id}`), badge(tkTone(t.status), cap(t.status)), h('span.small.muted', `${t.team ?? ''}${t.owner ? ` · ${t.owner}` : ''} · ${fmtWhen(t.createdAt)}`)),
    h('p.small', t.reason),
    editable && TK_NEXT[t.status]?.length ? h('div.row3', TK_NEXT[t.status].map(([s, label]) => h('button.btn.sm', { type: 'button', onclick: (e) => act(e.currentTarget, () => api(`/api/crm/tickets/${t.id}`, { method: 'PATCH', body: { status: s } }), `Ticket ${t.id}: ${label.toLowerCase()}.`) }, label))) : null,
    !editable && t.caseId ? h('a.small', { href: `#/crm/case/${encodeURIComponent(t.caseId)}` }, 'Open its case') : null);
}

function ticketsCard(w) {
  const open = C.openTicketForm;
  const rows = [...w.tickets.map((t) => [t, true]), ...(w.customerTickets ?? []).filter((t) => t.status !== 'closed').map((t) => [t, false])];
  const form = () => {
    const reason = h('textarea', { rows: '2', maxlength: '300', 'aria-label': 'Reason', placeholder: 'What should happen, and why?' });
    const type = h('select', { 'aria-label': 'Type' }, h('option', { value: 'escalation' }, 'Service request'), h('option', { value: 'complaint' }, 'Complaint'));
    const team = h('select', { 'aria-label': 'Team' }, w.taxonomy.teams.map((t) => h('option', { value: t }, t)));
    return h('form.cx-tform', { onsubmit: (e) => {
      e.preventDefault();
      if (reason.value.trim().length < 3) return K.toast('Add a short reason.');
      act(e.submitter, async () => { const r = await api(`/api/crm/cases/${w.case.id}/tickets`, { method: 'POST', body: { type: type.value, reason: reason.value.trim(), team: team.value, requestKey: open.key } }); C.openTicketForm = null; if (r.duplicate) K.toast(`Ticket ${r.ticket.id} already exists for this case.`); return r; }, 'Service request created.');
    } },
      h('div.row3', type, team), reason,
      h('div.row3', h('button.btn.sm.dark', { type: 'submit' }, 'Create'), h('button.btn.sm', { type: 'button', onclick: () => { C.openTicketForm = null; casePage(w.case.id, { refresh: true }); } }, 'Cancel')));
  };
  return h('section.card.cx-sec.cx-tickets',
    h('div.cx-h', h('h2', `Service requests (${rows.length})`), open ? null : h('button.btn.sm', { type: 'button', onclick: () => { C.openTicketForm = { key: `ui-${uid()}` }; casePage(w.case.id, { refresh: true }); } }, '+ New')),
    open ? form() : null,
    rows.length ? h('ul.cx-tk', rows.map(([t, mine]) => ticketRow(t, mine))) : open ? null : h('p.small.muted', 'No service requests for this customer.'));
}

function interactionsCard(items, currentId) {
  const list = items.filter((x) => x.id !== currentId);
  return h('section.card.cx-sec',
    h('h2', `Earlier interactions (${list.length})`),
    list.length ? h('ul.cx-int', list.slice(0, 6).map((c) => h('li', h('a', { href: `#/crm/case/${encodeURIComponent(c.id)}` },
      h('span.d', fmtWhen(c.createdAt)), h('span.t', c.headline ?? c.issueType), badge(ST[c.status] ?? 'lav', c.statusLabel)))))
      : h('p.small.muted', 'First contact: no earlier calls or cases.'));
}

/* ------------------------------------------------------------------ right column: AI back office, timeline, conversation */

const SUGGEST_CASE = ['Has this customer disputed before?', 'Is anyone else reporting this merchant?', 'Any fees we could reverse?', 'How does the customer use the card?'];
const SUGGEST_CUST = ['Summarise this customer', 'Any fees we could reverse?', 'How does the customer use the card?', 'Has this customer disputed before?'];

function sideCol(target, w) {
  const key = target.caseId ?? target.customerId;
  const tabs = [['ai', 'AI back office'], ...(w ? [['timeline', `Timeline (${w.timeline.length})`], ['talk', `Conversation (${w.transcript.length})`]] : [])];
  if (!tabs.some(([k]) => k === C.side)) C.side = 'ai';
  const pane = h('div.cx-pane');
  const btns = tabs.map(([k, label]) => h('button', { type: 'button', role: 'tab', 'data-k': k, onclick: () => { C.side = k; draw(); } }, label));
  function draw() {
    for (const b of btns) b.setAttribute('aria-selected', String(b.dataset.k === C.side));
    pane.replaceChildren(C.side === 'timeline' ? timeline(w) : C.side === 'talk' ? conversation(w) : aiPane(target, key));
  }
  draw();
  return h('aside.card.cx-side', { 'aria-label': 'Back office, timeline and conversation' }, h('div.cx-tabs', { role: 'tablist' }, btns), pane);
}

function aiPane(target, key) {
  const st = (C.ai[key] ??= { insights: null, loading: false, thread: [], busy: false });
  const insightsEl = h('div.cx-ins');
  const thread = h('div.cx-thread', { 'aria-live': 'polite' });
  const input = h('input', { type: 'text', maxlength: '500', placeholder: 'Ask the back office…', 'aria-label': 'Question for the back-office agent', autocomplete: 'off' });
  const send = async (q) => {
    q = q.trim(); if (!q || st.busy) return;
    st.busy = true; input.value = '';
    const item = { q, a: null };
    st.thread.push(item); drawThread();
    try { item.a = await api('/api/backoffice/ask', { method: 'POST', body: { ...target, question: q } }); }
    catch (e) { item.a = { error: e.message }; }
    st.busy = false; if (thread.isConnected) drawThread();
  };
  function answerView(a) {
    if (!a) return h('p.small.muted.cx-think', 'Looking it up in the bank records…');
    if (a.error) return h('p.small.bad', a.error);
    return h('div.cx-ans',
      a.text ? h('p', a.text) : null,
      a.bullets?.length ? h('ul', a.bullets.map((b) => h('li', b))) : null,
      h('details.cx-how', h('summary', `${a.mode === 'adk' ? 'ADK agent' : 'Built-in'} · ${(a.ms / 1000).toFixed(1)} s · how it found this`),
        a.fallbackReason ? h('p.small', a.fallbackReason) : null,
        a.steps?.length ? h('ol', a.steps.map((s) => h('li', h('b', s.tool), s.detail ? (s.detail.length > 60 ? h('pre', s.detail) : h('span', ` ${s.detail}`)) : null))) : null,
        a.sources?.length ? h('p.small.muted', `Sources: ${a.sources.join(', ')}`) : null));
  }
  function drawThread() {
    thread.replaceChildren(...st.thread.map((x) => h('div.cx-qa', h('p.q', x.q), answerView(x.a))));
    thread.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }
  function drawInsights() {
    const v = st.insights;
    insightsEl.replaceChildren(
      h('div.cx-h', h('h3', K.icon('activity'), 'Before you talk'), v && !v.error ? badge(v.mode === 'adk' ? 'violet' : 'lav', v.mode === 'adk' ? 'ADK · Agent Engine' : 'Built-in') : null),
      v?.error ? h('p.small.bad', v.error)
        : v ? h('ul', v.bullets.map((b) => h('li', b)))
        : h('ul.skel', [1, 2, 3].map(() => h('li', h('span')))),
      ...(v?.fallbackReason ? [h('p.small.muted', v.fallbackReason)] : []));
  }
  if (!st.insights && !st.loading) {
    st.loading = true;
    api(`/api/backoffice/insights?${new URLSearchParams(target)}`).then((v) => { st.insights = v; }).catch((e) => { st.insights = { error: e.message, bullets: [] }; })
      .finally(() => { st.loading = false; if (insightsEl.isConnected) drawInsights(); });
  }
  drawInsights(); drawThread();
  return h('div.cx-ai', insightsEl,
    h('div.cx-chips', (target.caseId ? SUGGEST_CASE : SUGGEST_CUST).map((q) => h('button.chip', { type: 'button', onclick: () => send(q) }, q))),
    thread,
    h('form.cx-ask', { onsubmit: (e) => { e.preventDefault(); send(input.value); } }, input, h('button.btn.sm.primary', { type: 'submit' }, 'Ask')),
    h('p.small.muted.cx-ro', 'Read-only: the back office looks things up; it never changes an account.'));
}

function timeline(w) {
  const tone = { ok: 'ok', failed: 'failed', blocked: 'blocked', warn: 'warn', pending: 'pending', running: 'pending', info: 'info' };
  return h('ol.crm-tl', [...w.timeline].reverse().map((e) => h('li', h(`span.n.${tone[e.status] ?? 'info'}`), h('div', h('b', e.title), h('span.small.muted', fmtFull(e.at)), e.detail ? h('p.small', e.detail) : null))));
}

function conversation(w) {
  let agentNow = 'Lily';
  return h('div.convo', w.transcript.map((tr) => {
    if (tr.kind?.startsWith('agent_switch:')) agentNow = tr.kind.slice(13);
    if (tr.speaker === 'system') return h('div.note', tr.text.replace(/\s*\[[^\]]*\]\s*/g, ' ').trim());
    const cls = tr.speaker === 'customer' ? 'cust' : tr.speaker === 'assistant' ? 'lily' : 'agent';
    return h(`div.b.${cls}`, h('div.wl', h('b', cls === 'cust' ? 'Customer' : cls === 'lily' ? `${agentNow} (AI)` : 'Agent'), h('span', fmtFull(tr.at))), h('div.txt', tr.hidden ? 'Security answer given (not stored)' : tr.text));
  }));
}

/* ------------------------------------------------------------------ customer page (found with search) */

async function customerPage(id) {
  let p;
  try { p = await api(`/api/crm/customers/${encodeURIComponent(id)}`); }
  catch (e) { return shell(null, errorBox('This customer couldn’t be loaded.', e)); }
  const cu = p.customer;
  const head = h('div.cx-who', h('span.av3', initials(cu.name)),
    h('div', h('div.nm', h('span', cu.name), badge('lav', `${cap(cu.segment)} customer`)),
      h('div.meta2', h('span.mono', cu.accountRef), h('span', cu.phone), cu.email ? h('span', cu.email) : null,
        C.lastCall ? h('a.btn.sm', { href: `#/crm/case/${encodeURIComponent(C.lastCall)}` }, '← Back to the call') : null)));
  const txns = p.transactions.slice(0, 12).map((t) => ({ ...t, focus: false }));
  shell(head, h('div.cx-grid',
    custPanel({ transactions: txns, account: p.account, history: p.history, previousCases: p.cases, case: null, focus: null }, cu),
    h('section.cx-case', { 'aria-label': 'Customer record' },
      h('section.card.cx-sec', h('h2', 'Cards'), h('ul.cx-acts', cu.cards.map((k) => h('li', h('div', h('b', `${k.network} ${k.product}`), h('span', `${k.masked} · ${k.holder}`)), badge(k.status === 'active' ? 'mint' : 'coral', cap(k.status) + (k.statusReason ? ` · ${k.statusReason.replace(/_/g, ' ')}` : '')))))),
      h('section.card.cx-sec', h('h2', `Service requests (${p.tickets.length})`), p.tickets.length ? h('ul.cx-tk', p.tickets.map((t) => ticketRow(t, false))) : h('p.small.muted', 'No service requests.')),
      ),
    sideCol({ customerId: id }, null)));
}
