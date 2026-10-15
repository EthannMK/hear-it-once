// Screen 2 — the human agent's CRM case workspace.
//   #/crm                    case list + customer search
//   #/crm/case/:id           one case: customer, key information, suggested next step, summary,
//                            facts, tags, tickets, actions, timeline, conversation
//   #/crm/customer/:id       customer profile: cards, transactions, cases, tickets
//   #/crm/call/:sessionId    the case for a call (where the page lands when a call ends)
// Everything shown comes from /api/crm/*. Every change goes back through the API, which checks
// permissions, validates, saves and audits it. Accepting a suggestion records the agent's plan;
// it never changes the account.
import { api, h, uid } from '/js/lib.js';

let K = null; // { render, icon, toast }
export function initCrm(kit) { K = kit; }

const C = { me: null, view: 'attention', q: '', list: null, timer: null, ws: null, dirty: false, openTicketForm: null, openRec: null };
const fmtWhen = (iso) => { try { const d = new Date(iso); const today = new Date().toDateString() === d.toDateString(); return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }); } catch { return ''; } };
const fmtFull = (iso) => { try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const initials = (n) => String(n ?? '?').split(' ').map((x) => x[0]).join('').slice(0, 2).toUpperCase();
const PRI = { urgent: ['coral', 'Urgent'], high: ['amber', 'High'], normal: ['lav', 'Normal'] };
const ST = { new: 'lav', in_progress: 'violet', awaiting_customer: 'amber', awaiting_bank: 'amber', escalated: 'coral', resolved: 'mint' };
const FACT = { verified: ['mint', 'Verified'], confirmed: ['mint', 'Confirmed by bank'], provided: ['amber', 'Customer said'], conflicting: ['coral', 'Conflict'], needs_clarification: ['lav', 'Needs attention'], unknown: ['lav', 'Unknown'] };
const ACT = { completed: 'mint', awaiting_customer: 'lav', awaiting_approval: 'amber', in_progress: 'amber', failed: 'coral', unknown: 'coral', declined: 'lav' };
const badge = (tone, text) => h(`span.badge.${tone}`, text);


/**
 * A small in-page confirmation box (a native <dialog>), used instead of the browser's own pop-ups.
 * Resolves true / false, or the typed text when `ask` is set and the person confirms.
 */
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
  try {
    let me = await api('/api/auth/me');
    if (!me.authenticated || me.role !== 'agent') {
      await api('/api/auth/demo-login', { method: 'POST', body: { userId: 'STF-AGENT-1' } });
      me = await api('/api/auth/me');
    }
    C.me = me;
  } catch (e) { C.me = null; throw e; }
}

export async function crmRoute(hash) {
  stop();
  const m = hash.match(/^#\/crm(?:\/(case|customer|call)\/([^/?#]+))?/);
  const kind = m?.[1]; const id = m?.[2] ? decodeURIComponent(m[2]) : null;
  K.render('crm', h('main.crm', h('div.crm-main', h('section.card.crm-empty', h('p.muted', 'Loading the agent workspace…')))));
  try { await ensureAgent(); } catch (e) { return frame(null, errorBox('The agent workspace could not sign in.', e)); }
  if (kind === 'call') {
    try { const r = await api(`/api/crm/calls/${encodeURIComponent(id)}`); location.replace(`#/crm/case/${encodeURIComponent(r.caseId)}`); }
    catch { frame(null, h('section.card.crm-empty', h('h2', 'No case for that call'), h('p', 'Lily didn’t get as far as recording an issue on that call, so no case was opened. Every call that reaches an issue appears in the list on the left.'), h('a.btn.dark', { href: '#/' }, K.icon('phone'), 'Start another call'))); }
    return;
  }
  if (kind === 'case') return casePage(id);
  if (kind === 'customer') return customerPage(id);
  return homePage();
}

/* ------------------------------------------------------------------ layout */
function frame(activeId, ...content) {
  const rail = h('aside.crm-rail', { 'aria-label': 'Cases and customers' });
  drawRail(rail, activeId);
  const back = activeId ? h('a.crm-back', { href: '#/crm' }, K.icon('arrow'), 'All cases') : null;
  K.render('crm', h('main.crm' + (activeId ? '.has-case' : ''), rail, h('div.crm-main', back, ...content)));
}

async function drawRail(rail, activeId) {
  const search = h('input', { type: 'search', placeholder: 'Search customers or cases', 'aria-label': 'Search customers by name, account reference, phone or case reference', value: C.q, maxlength: '120' });
  const results = h('div.crm-list', { role: 'list' });
  const tabs = h('div.crm-tabs', { role: 'tablist', 'aria-label': 'Case views' },
    [['attention', 'Needs attention'], ['open', 'Open'], ['resolved', 'Resolved'], ['customers', 'Customers']].map(([k, label]) =>
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(C.view === k), onclick: () => { C.view = k; drawRail(rail, activeId); } }, label)));
  let t = 0;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { C.q = search.value.trim(); load(); }, 220); });
  rail.replaceChildren(h('div.crm-search', K.icon('search'), search), tabs, results,
    h('p.crm-me', K.icon('person'), C.me?.authenticated ? `Signed in as ${String(C.me.displayName ?? '').replace(/ \(demo agent\)/, '')}` : 'Not signed in'));
  async function load() {
    results.replaceChildren(h('p.small.muted.pad', 'Loading…'));
    try {
      if (C.view === 'customers' || (C.q && !/^case-/i.test(C.q))) {
        const r = await api(`/api/crm/customers?q=${encodeURIComponent(C.q)}`);
        const cases = C.q && C.view !== 'customers' ? (await api(`/api/crm/cases?view=all&q=${encodeURIComponent(C.q)}`)).items : [];
        const items = [
          ...r.items.map((c) => h('a.crm-item', { role: 'listitem', href: `#/crm/customer/${encodeURIComponent(c.id)}`, 'aria-current': c.id === activeId ? 'page' : null },
            h('span.av2', initials(c.name)), h('div', h('b', c.name), h('span', `${c.accountRef} · ${c.cards[0]?.masked ?? 'no card'}`), h('span', c.openCases ? `${c.openCases} open case${c.openCases > 1 ? 's' : ''}` : c.totalCases ? `${c.totalCases} earlier case${c.totalCases > 1 ? 's' : ''}` : 'No cases')))),
          ...cases.map(caseItem(activeId)),
        ];
        results.replaceChildren(...(items.length ? items : [h('p.small.muted.pad', C.q ? `Nothing matches “${C.q}”.` : 'No customers yet.')]));
      } else {
        const r = await api(`/api/crm/cases?view=${C.view}${C.q ? `&q=${encodeURIComponent(C.q)}` : ''}`);
        results.replaceChildren(...(r.items.length ? r.items.map(caseItem(activeId)) : [h('p.small.muted.pad', C.view === 'attention' ? 'Nothing needs attention. Cases from new calls appear here first.' : 'No cases in this view.')]));
      }
    } catch (e) { results.replaceChildren(h('p.banner.bad', { role: 'alert' }, `Couldn’t load the list. ${e.message}`)); }
  }
  load();
}
const caseItem = (activeId) => (c) => h('a.crm-item', { role: 'listitem', href: `#/crm/case/${encodeURIComponent(c.id)}`, 'aria-current': c.id === activeId ? 'page' : null },
  h(`span.dot.${c.live ? 'live' : c.waitingForAgent ? 'wait' : c.priority}`, { title: c.live ? 'Call in progress' : c.waitingForAgent ? 'Waiting for an agent' : `${c.priority} priority` }),
  h('div', h('b', c.customer ?? 'Unidentified caller'), h('span', `${c.issueType} · ${fmtWhen(c.updatedAt)}`), h('span.chips2', badge(ST[c.status] ?? 'lav', c.statusLabel), c.priority !== 'normal' ? badge(PRI[c.priority][0], PRI[c.priority][1]) : null, c.live ? badge('mint', 'Live') : null)));

function errorBox(title, e) {
  return h('section.card.crm-empty', { role: 'alert' }, h('h2', title), h('p', e?.status === 404 ? 'It may have been removed when the demo data was reset.' : 'Please try again in a moment.'), h('button.btn', { type: 'button', onclick: () => crmRoute(location.hash) }, K.icon('retry'), 'Try again'));
}

/* ------------------------------------------------------------------ home */
async function homePage() {
  frame(null, h('section.card.crm-empty',
    h('span.badge.dark', K.icon('headset'), 'Agent workspace'),
    h('h1', 'Every case, ready before the agent picks up.'),
    h('p', 'Pick a case on the left or search for a customer. Each case is written while the customer talks to Lily: what they said, what was verified, what the bank’s systems confirmed, what was done, and the suggested next step.'),
    h('div.acts', h('a.btn.dark', { href: '#/' }, K.icon('phone'), 'Talk to Lily to create a case'))));
}

/* ------------------------------------------------------------------ case page */
async function casePage(id, opts = {}) {
  let w;
  try { w = await api(`/api/crm/cases/${encodeURIComponent(id)}`); }
  catch (e) { return frame(id, errorBox('This case couldn’t be loaded.', e)); }
  C.ws = w;
  if (!opts.keepScroll) window.scrollTo({ top: 0 });
  const y = window.scrollY;
  frame(id, ...caseView(w));
  if (opts.keepScroll) window.scrollTo({ top: y });
  // A live call or a waiting customer keeps the page current; edits in progress are never overwritten.
  if (w.case.live || ['requested', 'queued', 'connected'].includes(w.handoff?.status)) {
    C.timer = setInterval(async () => {
      if (C.dirty || document.activeElement?.closest?.('form, .crm-rec, .crm-tickets')) return;
      try {
        const n = await api(`/api/crm/cases/${encodeURIComponent(id)}`);
        if (n.case.updatedAt !== C.ws.case.updatedAt || n.case.live !== C.ws.case.live || n.handoff?.status !== C.ws.handoff?.status) casePage(id, { keepScroll: true });
      } catch { /* next tick */ }
    }, 4000);
  }
}

function caseView(w) {
  const cu = w.customer;
  const eff = w.tags.effective;
  const head = h('section.card.crm-head',
    h('div.who2', h('span.av3', initials(cu?.name)),
      h('div',
        h('div.nm', cu ? h('a', { href: `#/crm/customer/${encodeURIComponent(cu.id)}` }, cu.name) : h('span', 'Unidentified caller'),
          cu ? (cu.identityVerified ? badge('mint', 'Identity verified') : badge('amber', 'Not verified')) : null),
        h('div.meta2', cu ? [h('span.mono', cu.accountRef), h('span', cu.cards[0] ? `${cu.cards[0].masked} · ${cu.cards[0].network} · ${cu.cards[0].status}` : 'No card'), h('span', `Standing: ${cu.standing}`), h('span', cu.phone)] : h('span', 'The caller was not identified.')))),
    h('div.caseid',
      h('div.row2', badge(ST[eff.status] ?? 'lav', eff.statusLabel), badge(PRI[eff.priority][0], `${PRI[eff.priority][1]} priority`), w.case.live ? badge('mint', '● Call in progress') : null),
      h('div.meta2', h('span.mono', w.case.id), h('span', w.case.channel), h('span', `Opened ${fmtFull(w.case.createdAt)}`)),
      h('div.meta2', h('span', `${eff.category} · ${eff.issueType}`))));

  return [
    head,
    handoverBar(w),
    h('div.crm-grid2.lead', keyInfo(w), recommendation(w)),
    summaryCard(w),
    h('div.crm-grid2', factsCard(w), tagsCard(w)),
    actionsCard(w),
    ticketsCard(w),
    h('div.crm-grid2', timelineCard(w), h('div', conversationCard(w), previousCard(w))),
  ];
}

function handoverBar(w) {
  const hd = w.handoff;
  if (!hd || hd.status === 'cancelled') return null;
  const mine = hd.agent_id === C.me?.userId;
  if (hd.status === 'queued' || hd.status === 'requested') {
    return h('section.crm-hand.wait', { role: 'status' }, K.icon('headset'),
      h('div', h('b', 'The customer is waiting for an agent'), h('span', `${hd.reasonLabel}. Lily has told them a colleague will pick up with the full case, so they won’t repeat anything.`)),
      h('button.btn.dark', { type: 'button', onclick: (e) => act(e.currentTarget, () => api(`/api/handoffs/${hd.id}/accept`, { method: 'POST', body: {} }), 'Handover accepted. The customer has been told you joined.') }, 'Accept handover'));
  }
  if (hd.status === 'connected') {
    const input = h('input', { type: 'text', maxlength: '500', placeholder: mine ? 'Message the customer…' : 'Accepted by another agent', 'aria-label': 'Message to the customer', disabled: !mine });
    const outcome = h('select', { 'aria-label': 'Outcome', disabled: !mine }, h('option', { value: 'resolved' }, 'Resolved'), h('option', { value: 'follow_up_required' }, 'Follow-up needed'), h('option', { value: 'unresolved' }, 'Not resolved'));
    return h('section.crm-hand.on', K.icon('headset'),
      h('div', h('b', `You’re with the customer${hd.agentName && !mine ? ` (${hd.agentName})` : ''}`), h('span', 'Messages you send appear in the customer’s conversation.'),
        h('form.row3', { onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (!v) return; act(e.submitter, () => api(`/api/handoffs/${hd.id}/message`, { method: 'POST', body: { text: v } }), 'Message sent.'); } }, input, h('button.btn', { type: 'submit', disabled: !mine }, 'Send'))),
      h('div.row3', outcome, h('button.btn.dark', { type: 'button', disabled: !mine, onclick: async (e) => { const b = e.currentTarget; if (await confirmBox({ title: 'Finish this handover?', body: 'The outcome you chose is recorded on the case.', confirmLabel: 'Finish' })) act(b, () => api(`/api/handoffs/${hd.id}/complete`, { method: 'POST', body: { outcome: outcome.value, notes: '', customerRepeatedIssue: false } }), 'Handover completed.'); } }, 'Finish')));
  }
  return h('section.crm-hand', K.icon('headset'), h('div', h('b', hd.status === 'completed' ? `Handled by ${hd.agentName ?? 'an agent'}` : 'No agent was available'), h('span', hd.status === 'completed' ? `Outcome: ${String(hd.outcome ?? '').replace(/_/g, ' ')}` : 'A callback was requested.')));
}

/** Run a change, then reload the case. Buttons are disabled while it runs, so a double click can’t send it twice. */
async function act(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try { await fn(); if (okMsg) K.toast(okMsg); C.dirty = false; await casePage(C.ws.case.id, { keepScroll: true }); }
  catch (e) { K.toast(e.status === 409 ? e.message : `That didn’t go through: ${e.message}`); if (btn) btn.disabled = false; }
}

function keyInfo(w) {
  const ic = { ok: 'check', warn: 'alert', bad: 'x', unknown: 'info' };
  return h('section.card.crm-sec', h('h2', 'Key information'),
    h('ul.keys', w.keyInfo.map((k) => h(`li.${k.state}`, h('span.k', K.icon(ic[k.state])), h('div', h('b', k.label), h('span', k.detail))))));
}

function recommendation(w) {
  const recs = w.recommendations;
  const top = recs.find((r) => r.status !== 'rejected') ?? recs[0];
  const rest = recs.filter((r) => r !== top);
  const stLabel = { suggested: null, accepted: ['mint', 'Accepted'], rejected: ['lav', 'Rejected'], edited: ['violet', 'Edited'] };
  const one = (r, big) => {
    const editing = C.openRec === r.kind;
    const ta = h('textarea', { rows: '2', maxlength: '500', 'aria-label': 'Your version of the next step' }, r.editedText ?? r.title);
    return h(`div.crm-rec${big ? '.big' : ''}`,
      h('div.rt', h('b', r.editedText ?? r.title), stLabel[r.status] ? badge(...stLabel[r.status]) : null),
      h('p', h('span.why', 'Why: '), r.reason),
      r.decidedBy ? h('p.small.muted', `${stLabel[r.status]?.[1] ?? ''} by ${r.decidedBy} · ${fmtFull(r.decidedAt)}`) : null,
      editing
        ? h('form.row3', { onsubmit: (e) => { e.preventDefault(); C.openRec = null; act(e.submitter, () => api(`/api/crm/cases/${w.case.id}/recommendations/${r.kind}`, { method: 'POST', body: { decision: 'edit', text: ta.value.trim() } }), 'Your version is saved.'); } }, ta, h('button.btn.dark', { type: 'submit' }, 'Save'), h('button.btn', { type: 'button', onclick: () => { C.openRec = null; casePage(w.case.id, { keepScroll: true }); } }, 'Cancel'))
        : h('div.row3',
          h('button.btn.mint', { type: 'button', disabled: r.status === 'accepted', onclick: (e) => act(e.currentTarget, () => api(`/api/crm/cases/${w.case.id}/recommendations/${r.kind}`, { method: 'POST', body: { decision: 'accept' } }), 'Accepted. Nothing on the account changes until you or the customer act.') }, K.icon('check'), 'Accept'),
          h('button.btn', { type: 'button', onclick: () => { C.openRec = r.kind; casePage(w.case.id, { keepScroll: true }); } }, 'Edit'),
          h('button.btn.ghost', { type: 'button', disabled: r.status === 'rejected', onclick: (e) => act(e.currentTarget, () => api(`/api/crm/cases/${w.case.id}/recommendations/${r.kind}`, { method: 'POST', body: { decision: 'reject' } }), 'Suggestion rejected.') }, 'Reject')));
  };
  return h('section.card.crm-sec.crm-recs', h('h2', 'Suggested next step', badge('amber', 'Not done yet')),
    top ? one(top, true) : h('p.muted', 'No suggestion for this case.'),
    rest.length ? h('details', h('summary', `${rest.length} more suggestion${rest.length > 1 ? 's' : ''}`), rest.map((r) => one(r, false))) : null);
}

function summaryCard(w) {
  const s = w.summary;
  const li = (items, cls, iconName, empty) => items.length ? h(`ul.list.${cls}`, items.map((x) => h('li', K.icon(iconName), h('span', x)))) : h('p.small.muted', empty);
  return h('section.card.crm-sec', h('h2', 'Case summary'),
    h('p.prose', w.summaryText),
    h('div.crm-sum',
      h('div', h('span.cap', 'What the customer reported'), h('p', s.reported ? `“${s.reported}”` : h('span.muted', 'Not captured'))),
      h('div', h('span.cap', 'What they want (likely)'), h('p', s.intendedOutcome ?? h('span.muted', 'Unknown'))),
      h('div', h('span.cap', 'Transaction'), h('p', s.transaction ?? h('span.muted', 'Not identified yet'))),
      h('div', h('span.cap', 'Verification'), h('p', s.verification)),
      h('div', h('span.cap', 'Outcome so far'), h('p', s.outcome)),
      h('div', h('span.cap', 'Systems checked'), s.checks.length ? h('div.chips', s.checks.map((c) => h(`span.chip.${c.status === 'ok' ? 'ok' : 'warn'}`, `${c.label}${c.status === 'ok' ? '' : ` · ${c.status}`}${c.stale ? ' · stale' : ''}`))) : h('p.muted', 'None yet'))),
    h('div.crm-grid3',
      h('div', h('h3', 'Confirmed findings'), li(s.confirmed, 'ok', 'check', 'Nothing confirmed by bank systems yet.')),
      h('div', h('h3', 'Still open or unclear'), li(s.unresolved, 'bad', 'alert', 'Nothing outstanding.')),
      h('div', h('h3', 'Recommended next steps'), li(s.nextSteps, 'next', 'arrow', 'None.'))));
}

function factsCard(w) {
  return h('section.card.crm-sec', h('h2', 'What we know'),
    h('p.small.muted', '“Customer said” means no bank system has checked it yet.'),
    h('table.crm-facts', h('thead', h('tr', h('th', 'Detail'), h('th', 'Value'), h('th', 'Status'))),
      h('tbody', w.facts.map((f) => h('tr',
        h('th', { scope: 'row' }, f.label),
        h('td', f.value ?? h('span.muted', 'Unknown'), f.customerValue ? h('div.small', `Customer said: ${f.customerValue}`) : null, f.history.filter((x) => x.value !== f.customerValue && x.value !== f.value).length ? h('div.small.muted', `Earlier: ${f.history.filter((x) => x.value !== f.customerValue && x.value !== f.value).map((x) => `${x.value} (${x.why})`).join('; ')}`) : null),
        h('td', badge(...(FACT[f.status] ?? ['lav', f.status]))))))));
}

function tagsCard(w) {
  const tx = w.taxonomy; const ai = w.tags.ai; const ov = w.tags.overrides;
  const field = (key, label, options, aiVal, fmt = (x) => x) => {
    const sel = h('select', { name: key, 'aria-label': label, onchange: () => { C.dirty = true; } },
      h('option', { value: '' }, `${aiVal ? fmt(aiVal) : 'None'} (auto)`),
      options.map((o) => { const v = typeof o === 'string' ? o : o.id; return h('option', { value: v, ...(ov[key] === v ? { selected: '' } : {}) }, typeof o === 'string' ? fmt(o) : o.label); }));
    return h('label.fld', h('span', label, ov[key] ? h('em', ' · changed') : null), sel);
  };
  const notes = h('textarea', { rows: '3', maxlength: '3000', 'aria-label': 'Case notes', placeholder: 'Notes for the next person who opens this case', oninput: () => { C.dirty = true; } }, w.notes);
  const form = h('form.crm-tags', { onsubmit: async (e) => {
    e.preventDefault();
    const submitter = e.submitter;
    const fd = new FormData(e.target); const overrides = {};
    for (const k of ['category', 'issueType', 'priority', 'status', 'resolutionType', 'escalationReason']) { const v = fd.get(k); overrides[k] = v ? v : null; }
    if (overrides.status === 'resolved' && ai.status !== 'resolved' && !(await confirmBox({ title: 'Mark this case resolved?', body: 'The customer’s case record will show it as resolved too.', confirmLabel: 'Mark resolved' }))) return;
    act(submitter, () => api(`/api/crm/cases/${w.case.id}`, { method: 'PATCH', body: { version: w.case.version, overrides, notes: notes.value } }), 'Case saved.');
  } },
    h('div.fields',
      field('category', 'Category', tx.categories, ai.category),
      field('issueType', 'Issue type', tx.issueTypes, ai.issueType),
      field('priority', 'Priority', tx.priorities, ai.priority, (x) => x[0].toUpperCase() + x.slice(1)),
      field('status', 'Status', tx.statuses, tx.statuses.find((s) => s.id === ai.status)?.label),
      field('resolutionType', 'Resolution', tx.resolutionTypes, ai.resolutionType),
      field('escalationReason', 'Escalation reason', tx.escalationReasons, ai.escalationReason)),
    h('p.small.muted', `Priority rule: ${ai.priorityReason}${ai.sentiment ? ` · Customer mood: ${ai.sentiment} (indicative only, never used to act)` : ''}`),
    h('label.fld.wide', h('span', 'Notes'), notes),
    h('div.row3', h('button.btn.dark', { type: 'submit' }, 'Save changes'), w.tags.editedBy ? h('span.small.muted', `Last changed by ${w.tags.editedBy} · ${fmtFull(w.tags.editedAt)}`) : null));
  return h('section.card.crm-sec', h('h2', 'Tags and status'), form);
}

function actionsCard(w) {
  if (!w.actions.length) return null;
  return h('section.card.crm-sec', h('h2', 'Account actions'),
    h('ul.crm-acts', w.actions.map((a) => h('li',
      h('div', h('b', a.label), h('span', a.reference ? `Ref ${a.reference}` : a.error ?? '')),
      badge(ACT[a.state] ?? 'lav', a.stateLabel),
      a.canApprove ? h('div.row3',
        h('button.btn.mint', { type: 'button', onclick: async (e) => { const b = e.currentTarget; if (await confirmBox({ title: `Approve “${a.label}”?`, body: 'This sends the request to the bank. It cannot be undone from here.', confirmLabel: 'Approve and send', tone: 'mint' })) act(b, () => api(`/api/actions/${a.id}/approve`, { method: 'POST', body: {} }), 'Approved and sent.'); } }, 'Approve'),
        h('button.btn.ghost', { type: 'button', onclick: async (e) => { const b = e.currentTarget; const reason = await confirmBox({ title: `Reject “${a.label}”?`, body: 'Nothing will be changed on the account.', ask: 'Why are you rejecting it?', confirmLabel: 'Reject' }); if (reason) act(b, () => api(`/api/actions/${a.id}/reject`, { method: 'POST', body: { reason } }), 'Rejected. Nothing was changed.'); } }, 'Reject')) : null,
      a.canCheck ? h('button.btn', { type: 'button', onclick: (e) => act(e.currentTarget, () => api(`/api/actions/${a.id}/reconcile`, { method: 'POST', body: {} }), 'Status checked with the bank system.') }, K.icon('retry'), 'Check status') : null))));
}

function ticketsCard(w) {
  const open = C.openTicketForm;
  const form = () => {
    const key = open.key;
    const reason = h('textarea', { rows: '2', maxlength: '300', required: true, 'aria-label': 'Reason', placeholder: open.type === 'complaint' ? 'What is the customer unhappy about?' : 'Why does this need another team?' });
    const team = h('select', { 'aria-label': 'Team' }, w.taxonomy.teams.map((t) => h('option', { value: t, ...(t === (open.type === 'complaint' ? 'Complaints' : '') ? { selected: '' } : {}) }, t)));
    const pri = h('select', { 'aria-label': 'Priority' }, h('option', { value: '' }, `Automatic (${w.tags.effective.priority})`), w.taxonomy.priorities.map((p) => h('option', { value: p }, p)));
    return h('form.crm-tform', { onsubmit: (e) => {
      e.preventDefault();
      if (reason.value.trim().length < 3) return K.toast('Add a short reason.');
      act(e.submitter, async () => { const r = await api(`/api/crm/cases/${w.case.id}/tickets`, { method: 'POST', body: { type: open.type, reason: reason.value.trim(), team: team.value, ...(pri.value ? { priority: pri.value } : {}), requestKey: key } }); C.openTicketForm = null; if (r.duplicate) K.toast(`Ticket ${r.ticket.id} already exists for this case, so no new one was made.`); return r; }, null);
    } },
      h('h3', open.type === 'complaint' ? 'New complaint ticket' : 'Escalate to another team'),
      h('p.small.muted', 'The ticket is filled in from the case: the customer’s words, the summary, confirmed details, steps taken and evidence.'),
      h('label.fld.wide', h('span', 'Reason'), reason), h('div.fields', h('label.fld', h('span', 'Team'), team), h('label.fld', h('span', 'Priority'), pri)),
      h('div.row3', h('button.btn.dark', { type: 'submit' }, 'Create ticket'), h('button.btn', { type: 'button', onclick: () => { C.openTicketForm = null; casePage(w.case.id, { keepScroll: true }); } }, 'Cancel')));
  };
  const next = { open: [['in_progress', 'Start work']], in_progress: [['resolved', 'Mark resolved']], resolved: [['closed', 'Close']], closed: [] };
  return h('section.card.crm-sec.crm-tickets', h('h2', `Tickets (${w.tickets.length})`),
    w.tickets.length ? h('ul.crm-tk', w.tickets.map((t) => h('li',
      h('div.rt', h('b', `${t.typeLabel} · ${t.id}`), badge(t.status === 'closed' || t.status === 'resolved' ? 'mint' : t.status === 'in_progress' ? 'violet' : 'amber', t.status.replace('_', ' ')), badge(PRI[t.priority][0], t.priority), h('span.small.muted', `${t.team ?? ''} · ${t.owner ? `owner ${t.owner}` : 'unassigned'} · created ${fmtFull(t.createdAt)} by ${t.createdBy}`)),
      h('p', t.reason),
      h('details', h('summary', 'Ticket details'),
        h('dl.kv2', h('dt', 'Customer’s concern'), h('dd', t.originalConcern ?? '—'), h('dt', 'Summary'), h('dd', t.summary), h('dt', 'Confirmed details'), h('dd', t.confirmedDetails.join(' · ') || '—'), h('dt', 'Steps taken'), h('dd', t.stepsTaken.join(' · ') || '—'), h('dt', 'Evidence'), h('dd', t.evidence.join(' · ') || '—'), h('dt', 'Outstanding'), h('dd', t.outstandingAction ?? '—')),
        h('ol.did', t.events.map((e) => h('li', h('span.small', `${fmtFull(e.at)} · ${e.event.replace('status_', 'moved to ').replace(/_/g, ' ')} · ${e.by}${e.detail ? ` — ${e.detail}` : ''}`))))),
      next[t.status]?.length ? h('div.row3', next[t.status].map(([s, label]) => h('button.btn', { type: 'button', onclick: (e) => act(e.currentTarget, () => api(`/api/crm/tickets/${t.id}`, { method: 'PATCH', body: { status: s } }), `Ticket ${t.id}: ${label.toLowerCase()}.`) }, label))) : null))) : h('p.small.muted', 'No tickets. Create one if the customer wants to complain or another team must act.'),
    open ? form() : h('div.row3',
      h('button.btn', { type: 'button', onclick: () => { C.openTicketForm = { type: 'complaint', key: `ui-${uid()}` }; casePage(w.case.id, { keepScroll: true }); } }, 'Create complaint ticket'),
      h('button.btn', { type: 'button', onclick: () => { C.openTicketForm = { type: 'escalation', key: `ui-${uid()}` }; casePage(w.case.id, { keepScroll: true }); } }, 'Escalate')));
}

function timelineCard(w) {
  const tone = { ok: 'ok', failed: 'failed', blocked: 'blocked', warn: 'warn', pending: 'pending', running: 'pending', info: 'info' };
  return h('section.card.crm-sec', h('h2', `Timeline (${w.timeline.length})`),
    h('ol.crm-tl', w.timeline.map((e) => h('li', h(`span.n.${tone[e.status] ?? 'info'}`), h('div', h('b', e.title), h('span.small.muted', fmtFull(e.at)), e.detail ? h('p.small', e.detail) : null)))));
}

function conversationCard(w) {
  const turns = w.transcript;
  let agentNow = 'Lily';
  return h('section.card.crm-sec', h('details', h('summary', h('h2', `Conversation (${turns.length})`), h('span.small.muted', 'Supporting detail, the summary above is enough to act on')),
    h('div.convo', turns.map((tr) => {
      if (tr.kind?.startsWith('agent_switch:')) agentNow = tr.kind.slice(13);
      if (tr.speaker === 'system') return h('div.note', tr.text.replace(/\s*\[[^\]]*\]\s*/g, ' ').trim());
      const cls = tr.speaker === 'customer' ? 'cust' : tr.speaker === 'assistant' ? 'lily' : 'agent';
      return h(`div.b.${cls}`, h('div.wl', h('b', cls === 'cust' ? 'Customer' : cls === 'lily' ? `${agentNow} (AI)` : 'Agent'), h('span', fmtFull(tr.at))), h('div.txt', tr.hidden ? 'Security answer given (not stored)' : tr.text));
    }))));
}

function previousCard(w) {
  return h('section.card.crm-sec', h('h2', 'Other cases for this customer'),
    w.previousCases.length ? h('div.crm-list.flat', w.previousCases.map(caseItem(null))) : h('p.small.muted', 'No other cases for this customer.'));
}

/* ------------------------------------------------------------------ customer page */
async function customerPage(id) {
  let p;
  try { p = await api(`/api/crm/customers/${encodeURIComponent(id)}`); }
  catch (e) { return frame(id, errorBox('This customer couldn’t be loaded.', e)); }
  const cu = p.customer;
  window.scrollTo({ top: 0 });
  frame(id,
    h('section.card.crm-head',
      h('div.who2', h('span.av3', initials(cu.name)), h('div', h('div.nm', h('span', cu.name), cu.standing === 'good' ? badge('mint', 'Good standing') : badge('coral', cu.standing)),
        h('div.meta2', h('span.mono', cu.accountRef), h('span', cu.phone), h('span', cu.email ?? ''), h('span', `${cu.segment} customer`)))),
      h('div.caseid', h('div.row2', cu.openFraudAlerts ? badge('coral', `${cu.openFraudAlerts} open fraud alert${cu.openFraudAlerts > 1 ? 's' : ''}`) : badge('mint', 'No open fraud alerts')))),
    h('div.crm-grid2',
      h('section.card.crm-sec', h('h2', 'Cards'), h('ul.crm-acts', cu.cards.map((k) => h('li', h('div', h('b', `${k.network} ${k.product}`), h('span', `${k.masked} · ${k.holder}`)), badge(k.status === 'active' ? 'mint' : 'coral', k.status + (k.statusReason ? ` · ${k.statusReason}` : '')))))),
      h('section.card.crm-sec', h('h2', `Cases (${p.cases.length})`), p.cases.length ? h('div.crm-list.flat', p.cases.map(caseItem(null))) : h('p.small.muted', 'No cases yet.'))),
    h('section.card.crm-sec', h('h2', 'Recent transactions'),
      h('table.crm-facts', h('thead', h('tr', h('th', 'Date'), h('th', 'Merchant'), h('th', 'Amount'), h('th', 'Status'))),
        h('tbody', p.transactions.map((t) => h('tr', h('td', fmtWhen(t.at)), h('td', t.merchant, t.disputed ? badge('amber', 'Disputed') : null, h('div.small.muted', `${t.kind}${t.card ? ` · ${t.card}` : ''}`)), h('td.mono', t.amount), h('td', t.status)))))),
    p.tickets.length ? h('section.card.crm-sec', h('h2', 'Tickets'), h('ul.crm-tk', p.tickets.map((t) => h('li', h('div.rt', h('b', `${t.typeLabel} · ${t.id}`), badge(t.status === 'closed' || t.status === 'resolved' ? 'mint' : 'amber', t.status.replace('_', ' ')), h('span.small.muted', fmtFull(t.createdAt))), h('p', t.reason), h('a', { href: `#/crm/case/${encodeURIComponent(t.caseId)}` }, 'Open the case'))))) : null);
}
