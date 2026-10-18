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

const C = {
  me: null, timer: null, ws: null, dirty: false, openTicketForm: null, openRec: null,
  // The unified workspace: which section is open, whether the copilot is showing, and the state
  // each section keeps (transaction filters and selection, knowledge search, unsaved notes).
  // It lives here and not in the DOM so a 4-second refresh, or switching section, keeps it.
  tab: 'overview', cop: true,
  tx: { q: '', status: 'all', days: '90', disputed: false, sel: null, forCust: null, rows: [], total: 0, matching: 0, hasMore: false, cursor: null, oldestAt: null, statuses: [], loading: false, error: null, seq: 0 },
  kb: { forCase: null, data: null, error: null, loading: false, q: '', sel: null },
  notes: null, notesFor: null,
  side: 'ai', cust: 'account', ai: {}, joined: null, joinedFor: null, lastCall: null,
};
const fmtWhen = (iso) => { try { const d = new Date(iso); const today = new Date().toDateString() === d.toDateString(); return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }); } catch { return ''; } };
const fmtFull = (iso) => { try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const initials = (n) => String(n ?? '?').split(' ').map((x) => x[0]).join('').slice(0, 2).toUpperCase();
const PRI = { urgent: ['coral', 'Urgent'], high: ['amber', 'High'], normal: ['lav', 'Normal'] };
const ST = { new: 'lav', in_progress: 'violet', awaiting_customer: 'amber', awaiting_bank: 'amber', escalated: 'coral', resolved: 'mint' };
const ACT = { completed: 'mint', awaiting_customer: 'lav', awaiting_approval: 'amber', in_progress: 'amber', failed: 'coral', unknown: 'coral', declined: 'lav' };
const badge = (tone, text) => h(`span.badge.${tone}`, text);
/**
 * Other customers who reported the same merchant in the last 30 days. One unfamiliar charge is a
 * question; several people reporting the same merchant is a pattern worth seeing beside the charge.
 */
const patternBadge = (t) => (t.reportedByOthers > 0
  ? h('span.badge.coral.pat', { title: `${t.reportedByOthers} other customer${t.reportedByOthers > 1 ? 's' : ''} raised a fraud alert or dispute for ${t.merchant} in the last 30 days` },
      `Reported by ${t.reportedByOthers} other${t.reportedByOthers > 1 ? 's' : ''}`)
  : null);
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
  const input = h('input', { type: 'search', placeholder: 'Name, phone number, account number or case', 'aria-label': 'Search customers by name, full phone number, bank account number or case reference', maxlength: '120', autocomplete: 'off' });
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
          h('span.av2', initials(c.name)),
          h('div', h('b', c.name),
            h('span', `${c.accountRef} · ${c.phone} · ${c.totalCases ? `${c.totalCases} case${c.totalCases > 1 ? 's' : ''}` : 'no cases'}`)),
          // Say which field matched, so an exact hit on a phone or account number is visible as one.
          c.matchedOn ? h('span.cx-match', `matched on ${c.matchedOn}`) : null)),
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
  const sel = ['.ag-work', '.ag-cop .cx-ai', '.ag-talk', '.cx-cust', '.cx-case', '.cx-side .cx-pane'];
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
  keepScroll(() => shell(caseHead(w), joinedNote(w), handoverBar(w), workspace(w, id)));
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

/**
 * The one header the agent keeps across every section: who is on the line, how far their
 * verification has got, what the call is doing right now, and how the case is classified. It is
 * deliberately one row of chips rather than a panel, because it is on screen the whole call.
 */
function caseHead(w) {
  const cu = w.customer; const eff = w.tags.effective; const call = callState(w);
  const esc = eff.escalationReason;
  return h('div.cx-who',
    h('span.av3', initials(cu?.name)),
    h('div',
      h('div.nm', cu ? h('a', { href: `#/crm/customer/${encodeURIComponent(cu.id)}` }, cu.name) : h('span', 'Unidentified caller'),
        badge(call.tone, call.label)),
      h('div.meta2',
        h('span.mono', w.case.id),
        ...w.tickets.slice(0, 1).map((t) => h('span.mono', `Ref ${t.id}`)),
        h('span', `${eff.category} · ${eff.issueType}`),
        verifyChip(w),
        badge(ST[eff.status] ?? 'lav', eff.statusLabel),
        badge(PRI[eff.priority][0], `${PRI[eff.priority][1]} priority`),
        esc ? badge('coral', `Escalated · ${cap(esc)}`) : null)));
}

/**
 * What the call is actually doing. Taken from the handover record and whether the caller's line is
 * still open, never from what the agent last clicked, so the header cannot claim a live call after
 * the customer has gone.
 */
function callState(w) {
  const hd = w.handoff; const live = !!w.case.live;
  if (hd && ['requested', 'queued'].includes(hd.status)) return { tone: 'amber', label: live ? 'Waiting for handover' : 'Handover requested, line ended' };
  if (hd?.status === 'connected') return live ? { tone: 'mint', label: '● Live with an agent' } : { tone: 'coral', label: 'Customer disconnected' };
  if (hd?.status === 'completed') return { tone: 'lav', label: 'Ended' };
  if (hd && ['no_agent', 'failed'].includes(hd.status)) return { tone: 'coral', label: 'Transfer did not connect' };
  if (live) return { tone: 'mint', label: '● On the line with Lily' };
  return { tone: 'lav', label: 'Ended' };
}

/**
 * One verification wording for the whole screen: Verified, Pending, Failed or Not verified. It
 * reads the recorded verification outcome and the agent's own passcode check — never an assumption
 * from what the caller said or from anything the assistant inferred.
 */
function verifyChip(w) {
  const v = verifyState(w);
  return badge(v.tone, v.label);
}

function verifyState(w) {
  const ck = w.agentCheck;
  const id = w.keyInfo?.find((k) => k.key === 'identity');
  if (ck?.status === 'passed' || w.customer?.identityVerified) return { tone: 'mint', label: 'Verified', next: null };
  if (ck?.status === 'awaiting') return { tone: 'amber', label: 'Verification pending', next: `Passcode sent to ${ck.deliveredTo ?? 'the registered phone'}. Ask the customer to read it back.` };
  if (ck?.status === 'failed' || id?.state === 'bad') return { tone: 'coral', label: 'Verification failed', next: 'The security check did not pass. Do not discuss the account; a branch visit with ID is the approved route.' };
  return { tone: 'amber', label: 'Not verified', next: 'Accept the handover, then send a passcode with “Verify by passcode” before discussing the account.' };
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

/**
 * The handover banner, directly under the header and present for the whole call. Before the agent
 * accepts it says who is waiting and why, and carries the one action that exists. Once accepted it
 * becomes a single compact row of real call controls: it never keeps offering "Accept handover" for
 * a handover that has already been taken, and if the caller's line has ended it says so rather than
 * leaving a live-looking message box.
 */
function handoverBar(w) {
  const hd = w.handoff;
  if (!hd || hd.status === 'cancelled') return null;
  const mine = hd.agent_id === C.me?.userId;
  if (hd.status === 'queued' || hd.status === 'requested') {
    const gone = !w.case.live;
    return h(`section.cx-hand.wait${gone ? '.cold' : ''}`, { role: 'status' }, K.icon('headset'),
      h('div.grow',
        h('b', gone ? 'The customer hung up before anyone picked up' : 'The customer is waiting for you'),
        h('span', `${hd.reasonLabel}. ${gone ? 'Their case is below, with everything Lily recorded. A callback is the next step.' : 'Lily told them a colleague will pick up with the full case, so they won’t repeat anything.'}`)),
      h('div.row3',
        h('button.btn.sm.ghost', { type: 'button', onclick: () => setTab('overview') }, 'Read the AI summary'),
        gone ? null : h('button.btn.dark.cta', { type: 'button', onclick: (e) => act(e.currentTarget, () => api(`/api/handoffs/${hd.id}/accept`, { method: 'POST', body: {} }), 'Handover accepted. The customer has been told you joined.') }, 'Accept handover')));
  }
  if (hd.status === 'connected') {
    const gone = !w.case.live;
    const input = h('input', { type: 'text', maxlength: '500', placeholder: gone ? 'The customer’s line has ended' : mine ? 'Message the customer…' : 'Accepted by another agent', 'aria-label': 'Message to the customer', disabled: !mine || gone });
    const ck = w.agentCheck ?? null;
    // Anything the agent needs to know about a draft before sending it stays on screen until the
    // next draft replaces it. A warning that disappears after four seconds is not a warning.
    const notice = h('div.cx-warn', { role: 'alert', hidden: true });
    const v = verifyState(w);
    return h(`section.cx-hand.on.slim${gone ? '.cold' : ''}`, K.icon('headset'),
      h('b.ha-ttl', gone ? 'Customer disconnected' : mine ? 'Live with the customer' : `Live with ${hd.agentName ?? 'another agent'}`),
      badge(v.tone, v.label),
      h('form.ha-form', { onsubmit: (e) => { e.preventDefault(); const t = input.value.trim(); if (!t) return; act(e.submitter, () => api(`/api/handoffs/${hd.id}/message`, { method: 'POST', body: { text: t } }), 'Message sent.'); } },
        input,
        h('button.btn.sm', { type: 'button', disabled: !mine || gone, title: 'Write a first version from the case. Nothing is sent until you press Send.', onclick: (e) => draftInto(e.currentTarget, input, w.case.id, notice) }, K.icon('activity'), 'Draft'),
        h('button.btn.sm.dark', { type: 'submit', disabled: !mine || gone }, 'Send')),
      h('div.row3',
        h('button.btn.sm', { type: 'button', disabled: !mine || gone || ck?.status === 'awaiting' || ck?.status === 'passed', title: 'A passcode goes to the registered phone; the customer types it in.', onclick: (e) => act(e.currentTarget, () => api(`/api/handoffs/${hd.id}/identity-check`, { method: 'POST', body: {} }), 'Passcode sent. Ask the customer to type it in.') },
          K.icon('lock'), ck?.status === 'awaiting' ? 'Passcode sent' : ck?.status === 'passed' ? 'Verified' : ck?.status === 'failed' ? 'Passcode failed' : 'Verify by passcode'),
        h('button.btn.sm.dark', { type: 'button', disabled: !mine, onclick: (e) => finishHandover(e.currentTarget, hd, w.case.id) }, 'Finish call')),
      notice);
  }
  const failed = ['no_agent', 'failed'].includes(hd.status);
  return h(`section.cx-hand.slim${failed ? '.cold' : ''}`, K.icon('headset'),
    h('b.ha-ttl', hd.status === 'completed' ? `Handled by ${hd.agentName ?? 'an agent'}` : hd.status === 'no_agent' ? 'No agent was available' : 'The transfer did not connect'),
    h('span', hd.status === 'completed' ? `Outcome: ${cap(hd.outcome)}` : 'A callback was requested. Nothing was changed on the account.'));
}

/**
 * A first version of what to say next, written from the case and put in the message box. The agent
 * reads it, changes what they want and presses Send: nothing reaches the customer on its own.
 */
async function draftInto(btn, input, caseId, notice) {
  const was = btn.textContent;
  btn.disabled = true; btn.replaceChildren('Writing…');
  try {
    const r = await api('/api/backoffice/draft', { method: 'POST', body: { caseId, kind: 'reply' } });
    input.value = r.text ?? '';
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    // A warning here is about the draft, not about the customer: a record that reads like an
    // instruction, or wording that had to be replaced because it promised something the records do
    // not show. It stays on screen, because the agent decides what to send.
    if (notice) {
      notice.hidden = !r.warnings?.length;
      notice.replaceChildren(...(r.warnings ?? []).map((w) => h('p', K.icon('alert'), w)));
    }
    K.toast(r.warnings?.length ? 'Draft ready, with something to check first.' : `Draft ready${r.mode === 'adk' ? ' (ADK agent)' : ''}. Edit it, then press Send.`);
  } catch (e) { K.toast(`Couldn’t write a draft: ${e.message}`); }
  finally { btn.disabled = false; btn.replaceChildren(K.icon('activity'), was || 'Draft'); }
}

async function finishHandover(btn, hd, caseId) {
  const outcome = h('select', { 'aria-label': 'Outcome' }, h('option', { value: 'resolved' }, 'Resolved'), h('option', { value: 'follow_up_required' }, 'Follow-up needed'), h('option', { value: 'unresolved' }, 'Not resolved'));
  // Tagging belongs to the wrap-up: the agent picks the labels while the call is fresh. Each tag
  // is saved on the case the moment it is chosen, not when the dialog is submitted, so closing the
  // box without finishing does not lose them.
  const w = C.ws;
  const chosen = new Set((w?.callTags ?? []).map((t) => t.tag));
  const chips = h('div.ag-taglist');
  const tagPick = h('select', { 'aria-label': 'Call tag' });
  const drawTags = () => {
    const left = (w?.taxonomy?.callTags ?? []).filter((t) => !chosen.has(t));
    tagPick.replaceChildren(h('option', { value: '' }, left.length ? 'Tag this call…' : 'All standard tags added'), ...left.map((t) => h('option', { value: t }, t)));
    chips.replaceChildren(...(chosen.size ? [...chosen].map((t) => h('span.ag-tag', h('span', t))) : [h('span.small.muted', 'No tags yet.')]));
  };
  drawTags();
  tagPick.addEventListener('change', async () => {
    const t = tagPick.value;
    if (!t) return;
    tagPick.disabled = true;
    try { await api(`/api/crm/cases/${caseId}/tags`, { method: 'POST', body: { tag: t } }); chosen.add(t); }
    catch (e) { K.toast(`Couldn’t add that tag: ${e.message}`); }
    finally { tagPick.disabled = false; drawTags(); }
  });
  const notes = h('textarea', { rows: '4', maxlength: '1000', 'aria-label': 'Notes for the case', placeholder: 'Writing the wrap-up from the case…' });
  const follow = h('p.small.muted', 'Reading the case…');
  // The wrap-up is filled in from the case while the box is open; the agent confirms or changes it.
  api('/api/backoffice/draft', { method: 'POST', body: { caseId, kind: 'wrapup' } })
    .then((r) => {
      if (!notes.value.trim()) notes.value = r.notes ?? '';
      if (r.outcome) outcome.value = r.outcome;
      notes.placeholder = 'Notes for the case';
      follow.replaceChildren(r.followUp ? `Suggested follow-up: ${r.followUp}` : 'Written from the case record. Change anything that is not right.');
    })
    .catch(() => { notes.placeholder = 'Notes for the case'; follow.replaceChildren('Write the outcome and any notes for the case.'); });
  const ok = await new Promise((resolve) => {
    const dlg = h('dialog.crm-dlg', { 'aria-labelledby': 'fin-t' });
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(h('form', { onsubmit: (e) => { e.preventDefault(); done(true); } },
      h('h2#fin-t', 'Finish this call'), h('p', 'The outcome and your notes are saved on the case.'),
      h('label.fld', h('span', 'Outcome'), outcome),
      h('label.fld', h('span', 'Call tags'), tagPick), chips,
      h('label.fld', h('span', 'Notes'), notes), follow,
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

/* ------------------------------------------------------------------ customer and account */

/** Shown in place of the account when the caller has not passed the security check. */
function unverifiedNotice(w) {
  const cu = w.customer;
  const v = verifyState(w);
  return h('section.ag-sec.cx-unver',
    h('h2', K.icon('lock'), 'Account hidden'),
    h('p', cu ? `Lily matched the caller to ${cu.name}, but they have not passed the security check, so the account stays hidden.` : 'Lily could not match the caller to a customer, so no account is shown.'),
    v.next ? h('p.small.muted', v.next) : null,
    w.summary.reported ? h('p.cx-said', `“${w.summary.reported}”`) : null);
}

/**
 * The transaction ledger across the full width: one row per entry with the columns a card agent
 * works from, and the rest of the record on the row itself when it is opened.
 */
function txTable(txns, cu) {
  const head = ['Date and time', 'Merchant', 'Type', 'Entry', 'Location', 'Category', 'Status', 'Amount'];
  const rows = (txns ?? []).map((t) => {
    const when = new Date(t.at);
    const time = isNaN(when) ? '' : when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const more = [
      ['Settled', t.postedAt ? fmtFull(t.postedAt) : 'Not yet settled'],
      t.card ? ['Card', t.card] : null,
      t.authCode ? ['Authorisation code', t.authCode] : null,
      t.networkRef ? ['Acquirer reference', t.networkRef] : null,
      t.acquirer ? ['Acquirer', t.acquirer] : null,
      t.mcc ? ['Merchant category code', `${t.mcc}${t.mccLabel ? ` · ${t.mccLabel}` : ''}`] : null,
      ['Transaction id', t.id],
    ].filter(Boolean);
    const open = (e) => e.currentTarget.closest('tbody').classList.toggle('open');
    return h(`tbody${t.focus ? '.focus' : ''}`,
      h('tr.txr', { onclick: open, tabindex: '0', onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } } },
        h('td', h('b', fmtWhen(t.at)), time ? h('span', time) : null),
        h('td', h('b', t.merchant), t.disputed ? badge('lav', 'Disputed') : t.focus ? badge('amber', 'This call') : null, patternBadge(t)),
        h('td', t.typeLabel ?? t.kind),
        h('td', t.entryLabel ?? '—'),
        h('td', t.where ?? '—'),
        h('td', t.category ? String(t.category).replace(/_/g, ' ') : '—'),
        h('td', h(`span.st.${t.status}`, t.statusLabel ?? t.status)),
        h('td.amt', h('b.mono', t.amount))),
      h('tr.txmore', h('td', { colspan: String(head.length) },
        h('dl.txd2', more.map(([k, v]) => h('div', h('dt', k), h('dd.mono', v)))))));
  });
  return h('section.cx-sec.cx-txtable',
    h('div.cx-h', h('h2', `Transactions${txns?.length ? ` (${txns.length})` : ''}`),
      h('span.small.muted', 'Click a row for the rest of the record'),
      location.hash.includes('/customer/') || !cu ? null : h('a.small', { href: `#/crm/customer/${encodeURIComponent(cu.id)}` }, 'See all')),
    rows.length
      ? h('div.tablewrap', h('table.txt', h('thead', h('tr', head.map((x) => h('th', { scope: 'col' }, x)))), ...rows))
      : h('p.small.muted', 'No transactions.'));
}

function focusPanel(which) {
  const grid = document.querySelector('.cx-grid');
  if (!grid) return;
  grid.classList.toggle('focus-cust', which === 'cust');
  grid.classList.toggle('focus-side', which === 'side');
}

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
    const wide = C.cust !== 'account';
    pane.replaceChildren(
      C.cust === 'tx' ? h('div.cx-stack', txTable(w.transactions, cu))
        : C.cust === 'history' ? h('div.cx-stack', interactionsCard(w.previousCases ?? [], w.case?.id))
          : h('div.cx-stack', accountCard(cu, w.focus?.cardRef), balanceCard(w.account), usageCard(w.account, w.history)),
    );
    focusPanel(wide ? 'cust' : null);
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
  return h('section.card.cx-sec', h('h2', 'Transaction usage', history ? badge('lav', 'BigQuery') : null), usageBody(a, history));
}

function usageBody(a, history) {
  const max = Math.max(1, ...a.usage.months.map((m) => m.minor));
  const cmax = Math.max(1, ...a.usage.categories.map((c) => c.minor));
  const bars = (items, top, label, value) => h('ul.cx-bars', items.map((x) => { const f = h('i'); f.style.width = `${Math.max(2, Math.round((x.minor / top) * 100))}%`; return h('li', h('span', label(x)), h('span.track', f), h('b', value(x))); }));
  return h('div.ag-usage',
    h('p.small', h('b', a.usage.last30), ` spent in the last 30 days · ${a.usage.purchases30} purchase${a.usage.purchases30 === 1 ? '' : 's'}`),
    bars(a.usage.months, max, (m) => m.label, (m) => m.amount),
    a.usage.categories.length ? [h('p.cap', 'Top categories · 90 days'), bars(a.usage.categories, cmax, (c) => cap(c.category), (c) => c.amount)] : null,
    history ? h('p.small.muted', `${history.transactions.toLocaleString()} transactions on file${history.firstAt ? ` since ${fmtWhen(history.firstAt)}` : ''} · live from ${history.source}`) : null);
}

/* ------------------------------------------------------------------ the case: summary, suggestions, actions, requests */

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
      h('div.amt', h('b.mono', t.amount), t.focus ? badge('amber', 'This call') : t.disputed ? badge('lav', 'Disputed') : null, patternBadge(t))),
    h('dl.txd', detail.map(([k, v]) => h('div', h('dt', k), h('dd.mono', v)))));
}

function summaryBody(w) {
  const s = w.summary;
  const li = (items, cls, iconName) => h(`ul.list.${cls}`, items.slice(0, 4).map((x) => h('li', K.icon(iconName), h('span', x))));
  return h('div.ag-sum',
    h('p.prose.clamp', { title: 'Click to show all', onclick: (e) => e.currentTarget.classList.toggle('open') }, w.summaryText),
    s.confirmed.length || s.unresolved.length ? h('div.cx-two',
      s.confirmed.length ? h('div', h('h3', 'Confirmed'), li(s.confirmed, 'ok', 'check')) : null,
      s.unresolved.length ? h('div', h('h3', 'Still open'), li(s.unresolved, 'bad', 'alert')) : null) : null);
}

/** The top suggestion, plus the rest behind a disclosure. The heading comes from the section. */
function recommendationBody(w) {
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
  return h('div.cx-recs.ag-recs',
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
  const list = (items ?? []).filter((x) => x.id !== currentId);
  if (!list.length) return h('section.cx-sec', h('h2', 'Earlier interactions'), h('p.small.muted', 'First contact: no earlier calls or cases.'));
  return h('section.cx-sec.cx-hist',
    h('div.cx-h', h('h2', `Earlier interactions (${list.length})`), h('span.small.muted', 'Newest first · open one to work it')),
    h('ul.cx-histl', list.map((c) => h('li',
      h('div.hh',
        h('div',
          h('b', c.headline ?? c.issueType ?? 'Customer call'),
          h('span', [fmtFull(c.createdAt), c.channel, c.durationLabel, c.identity === 'verified' ? 'identity verified' : 'identity not verified'].filter(Boolean).join(' · '))),
        h('div.hb',
          badge(ST[c.status] ?? 'lav', c.statusLabel ?? c.status),
          c.csat ? badge('mint', `Rated ${c.csat}/5`) : null,
          h('a.btn.sm', { href: `#/crm/case/${encodeURIComponent(c.id)}` }, 'Open'))),
      c.said?.length ? h('p.hsaid', `“${c.said[0]}”`) : null,
      h('dl.txd2',
        h('div', h('dt', 'Outcome'), h('dd', (c.outcome ?? 'not recorded').replace(/_/g, ' '))),
        h('div', h('dt', 'Actions'), h('dd', c.actions?.length ? c.actions.map((a) => `${a.label} — ${a.status}`).join('; ') : 'none')),
        h('div', h('dt', 'Handover'), h('dd', c.handover ? `${c.handover.reason} — ${c.handover.status}${c.handover.agent ? ` (${c.handover.agent})` : ''}` : 'handled without a person')),
        h('div', h('dt', 'Case'), h('dd.mono', c.id)))))));
}

/* ------------------------------------------------------------------ AI copilot, timeline, conversation */

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
    focusPanel(C.side === 'ai' ? null : 'side');
  }
  draw();
  return h('aside.card.cx-side', { 'aria-label': 'Back office, timeline and conversation' }, h('div.cx-tabs', { role: 'tablist' }, btns), pane);
}

function aiPane(target, key, suggest) {
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
  // The chips follow whichever section the agent is working in; the thread and the insights above
  // them do not, so changing section never re-asks the back office anything.
  const chips = h('div.cx-chips');
  const drawChips = () => chips.replaceChildren(...(suggest ? suggest() : target.caseId ? SUGGEST_CASE : SUGGEST_CUST).map((q) => h('button.chip', { type: 'button', onclick: () => send(q) }, q)));
  drawChips();
  const el = h('div.cx-ai', insightsEl,
    chips,
    thread,
    h('form.cx-ask', { onsubmit: (e) => { e.preventDefault(); send(input.value); } }, input, h('button.btn.sm.primary', { type: 'submit' }, 'Ask')),
    h('p.small.muted.cx-ro', 'Read-only: the back office looks things up; it never changes an account.'));
  el.redrawChips = drawChips;
  return el;
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


/* ================================================================== the unified agent workspace */

/**
 * One shell for the whole call. The header and the handover banner stay put; everything else the
 * agent needs is a section of this workspace, and the AI copilot sits beside it rather than
 * competing with it for a tab. Switching section replaces the contents of the work pane only: the
 * call, the transcript, the copilot thread, the transaction filters and any unsaved note all
 * belong to module state, so none of them is rebuilt or refetched by a change of section.
 */
const AG_TABS = [
  ['overview', 'Overview'],
  ['tx', 'Transactions'],
  ['talk', 'Conversation'],
  ['case', 'Case & Requests'],
  ['timeline', 'Timeline'],
  ['kb', 'Knowledge'],
];

/** Questions worth asking the back office, by the section the agent is working in. */
const SUGGEST = {
  overview: ['Summarise this customer', 'Has this customer disputed before?', 'Any fees we could reverse?'],
  tx: ['Is anyone else reporting this merchant?', 'How does the customer use the card?', 'Has this customer disputed before?'],
  talk: ['Summarise this customer', 'What has this customer contacted us about before?'],
  case: ['Any fees we could reverse?', 'Has this customer disputed before?'],
  timeline: ['What has this customer contacted us about before?', 'Summarise this customer'],
  kb: ['Any fees we could reverse?', 'How does the customer use the card?'],
};

function setTab(k) { C.tab = k; C.redraw?.(); }

function workspace(w, id) {
  if (!AG_TABS.some(([k]) => k === C.tab)) C.tab = 'overview';
  if (C.notesFor !== id) { C.notesFor = id; C.notes = null; }
  const n = { tx: (C.tx.forCust && C.tx.forCust === w.customer?.id ? C.tx.total : 0) || w.transactions?.length || 0, talk: w.transcript.length, case: (w.tickets?.length ?? 0) + (w.actions?.length ?? 0), timeline: w.timeline.length };
  const btns = AG_TABS.map(([k, label]) => h('button', { type: 'button', role: 'tab', 'data-k': k, onclick: () => setTab(k) },
    h('span', label), n[k] ? h('span.n', String(n[k])) : null));
  const work = h('section.ag-work', { role: 'tabpanel', tabindex: '-1', 'aria-label': 'Agent workspace' });

  const ctx = h('div.ag-ctx');
  const ai = aiPane({ caseId: id }, id, () => SUGGEST[C.tab] ?? SUGGEST.overview);
  const hide = h('button.ag-x', { type: 'button', title: 'Hide the AI copilot', 'aria-label': 'Hide the AI copilot' }, K.icon('x'));
  const cop = h('aside.ag-cop', { 'aria-label': 'AI copilot' },
    h('div.ag-coph', K.icon('activity'), h('b', 'AI copilot'), badge('lav', 'Read-only'), hide),
    ctx, ai);
  const show = h('button.ag-rail', { type: 'button', title: 'Show the AI copilot' }, K.icon('activity'), h('span', 'AI copilot'));
  const body = h('div.ag-body', work, cop, show);
  // Collapsing is a class on the body, not a re-render: the copilot keeps its thread, its answers
  // and its scroll position, and the work pane simply gets the width back.
  const setCop = (on) => { C.cop = on; body.classList.toggle('cop-off', !on); };
  hide.onclick = () => setCop(false);
  show.onclick = () => setCop(true);

  function draw() {
    for (const b of btns) b.setAttribute('aria-selected', String(b.dataset.k === C.tab));
    work.replaceChildren(view(w, id));
    work.scrollTop = 0;
    ctx.replaceChildren(...copilotContext(w));
    ai.redrawChips?.();
  }
  C.redraw = draw;
  // A section whose data arrives after the first paint (Knowledge) refreshes only the copilot's
  // context block, so the thread above it is left alone.
  C.refreshCtx = () => { if (ctx.isConnected) ctx.replaceChildren(...copilotContext(w)); };
  // A count a section only learns after loading (the full transaction history) corrects its tab.
  C.refreshCount = (k, total) => {
    const b = btns.find((x) => x.dataset.k === k);
    if (!b || !b.isConnected) return;
    b.replaceChildren(h('span', AG_TABS.find(([t]) => t === k)[1]), total ? h('span.n', String(total)) : null);
  };
  draw();
  setCop(C.cop);
  return h('div.ag-shell', h('nav.ag-nav', { role: 'tablist', 'aria-label': 'Agent workspace sections' }, btns), body);
}

function view(w, id) {
  if (C.tab === 'tx') return txView(w);
  if (C.tab === 'talk') return talkView(w);
  if (C.tab === 'case') return caseView(w);
  if (C.tab === 'timeline') return timelineView(w);
  if (C.tab === 'kb') return kbView(w, id);
  return overview(w);
}

const agH = (title, ...rest) => h('div.cx-h', h('h2', title), ...rest);
/** Let a reused card be a full-width section of the grid rather than sit inside one. */
const wide = (el) => { if (el) { el.classList.add('ag-sec', 'ag-span'); el.classList.remove('card', 'cx-sec'); } return el; };

/* ---------------------------------------------------------------- overview */

/**
 * Where the agent lands when they take a handover: who they are talking to, how far the security
 * check has got, what Lily recorded, and the one thing to do next. The suggestion and what has
 * actually happened on the account are kept in separate blocks on purpose — a suggestion the agent
 * has not accepted must never read like a completed action.
 */
function overview(w) {
  const cu = w.customer; const s = w.summary; const v = verifyState(w);
  const focusTx = (w.transactions ?? []).filter((t) => t.focus);
  const openTickets = [...(w.tickets ?? []), ...(w.customerTickets ?? []).filter((t) => t.status !== 'closed' && !(w.tickets ?? []).some((x) => x.id === t.id))];
  const done = (w.actions ?? []).filter((a) => a.state !== 'awaiting_approval');
  const waiting = (w.actions ?? []).filter((a) => a.state === 'awaiting_approval');
  return h('div.ag-grid',
    h('section.ag-sec.ag-span',
      agH('Why they called', badge('lav', w.tags.effective.issueType)),
      s.reported ? h('p.cx-said', `“${s.reported}”`) : h('p.small.muted', 'The caller’s own words were not captured on this call.'),
      h('div.cx-kv',
        h('span', 'What they want'), h('b', s.intendedOutcome ?? 'Not recorded'),
        s.transaction ? [h('span', 'Charge in question'), h('b', s.transaction)] : null,
        h('span', 'Where the call got to'), h('b', s.outcome)),
      (w.callTags ?? []).length
        ? h('div.ag-taglist', (w.callTags ?? []).map((t) => h('span.ag-tag', h('span', t.tag))), h('button.btn.sm.ghost', { type: 'button', onclick: () => setTab('case') }, 'Edit tags'))
        : h('p.small.muted', ['Not tagged yet. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); setTab('case'); } }, 'Tag this call')])),

    h('section.ag-sec',
      agH('Identity and verification', badge(v.tone, v.label)),
      h('ul.ag-checks', (w.keyInfo ?? []).map((k) => h(`li.${k.state}`, h('div', h('b', k.label), h('span', k.detail))))),
      v.next ? h('p.ag-next', K.icon('lock'), v.next) : h('p.small.muted', 'Verified: the account can be discussed.')),

    cu && w.account
      ? h('section.ag-sec',
        agH('Customer and account', h('a.small', { href: `#/crm/customer/${encodeURIComponent(cu.id)}` }, 'Full record')),
        accountBody(cu, w.focus?.cardRef),
        balanceBody(w.account))
      : unverifiedNotice(w),


    h('section.ag-sec.ag-span', agH('What Lily recorded'), summaryBody(w)),

    h('section.ag-sec.ag-sug', agH('Suggested next step', badge('amber', 'Not done yet')), recommendationBody(w) ?? h('p.small.muted', 'No suggestion for this case.')),

    h('section.ag-sec',
      agH('On the account', badge(done.length ? 'mint' : 'lav', done.length ? `${done.length} recorded` : 'Nothing changed')),
      waiting.length ? h('p.small.ag-warnline', K.icon('alert'), `${waiting.length} action${waiting.length > 1 ? 's' : ''} waiting for your approval — Case & Requests.`) : null,
      done.length
        ? h('ul.cx-acts', done.map((a) => h('li', h('div', h('b', a.label), h('span', a.reference ? `Ref ${a.reference}` : a.error ?? '')), badge(ACT[a.state] ?? 'lav', a.stateLabel))))
        : h('p.small.muted', 'No change has been made to this account on this call.')),

    // Full width, two columns of tickets. Half a card of white space next to four rows read as a
    // panel that had failed to load; an empty list now says what that means for this call rather
    // than leaving the agent to work it out.
    h('section.ag-sec.ag-span',
      agH('Open service requests', badge(openTickets.length ? 'violet' : 'lav', String(openTickets.length))),
      openTickets.length
        ? h('ul.ag-mini.ag-two', openTickets.slice(0, 6).map((t) => h('li', h('b', `${t.typeLabel} · ${t.id}`), badge(tkTone(t.status), cap(t.status)), h('span', t.reason))))
        : h('p.small.muted', 'Nothing is open for this customer, so anything agreed on this call starts a new request.'),
      openTickets.length > 6 ? h('p.small.muted', `${openTickets.length - 6} more open on this account.`) : null),

    s.unresolved.length
      ? h('section.ag-sec.ag-open', agH('Still to resolve', badge('coral', String(s.unresolved.length))),
        h('ul.list.bad', s.unresolved.map((x) => h('li', K.icon('alert'), h('span', x)))))
      : null,

    focusTx.length
      ? h('section.ag-sec.ag-span', agH('The charge this call is about', h('button.btn.sm', { type: 'button', onclick: () => setTab('tx') }, 'Open in Transactions')),
        h('ul.cx-txl', focusTx.map((t) => txRow(t))))
      : null,

    s.demoReset ? h('p.small.muted.ag-span', `${s.demoReset.note}${s.demoReset.at ? ` (${fmtFull(s.demoReset.at)})` : ''}`) : null);
}

/** The account-status rows, without their own card frame: the overview is already one surface. */
function accountBody(cu, focusRef) {
  const card = cu.cards.find((k) => k.ref === focusRef) ?? cu.cards[0];
  const others = cu.cards.filter((k) => k !== card);
  return h('div.cx-kv',
    h('span', 'Standing'), h('b', cu.standing === 'good' ? badge('mint', 'Good standing') : badge('coral', cap(cu.standing))),
    h('span', focusRef ? 'Card on this call' : 'Card'), h('b', card ? [`${card.network} ${card.masked} `, badge(card.status === 'active' ? 'mint' : 'coral', cap(card.status) + (card.statusReason ? ` · ${card.statusReason.replace(/_/g, ' ')}` : ''))] : '—'),
    others.length ? [h('span', 'Other cards'), h('b', others.map((k) => `${k.masked} ${k.status}`).join(', '))] : null,
    h('span', 'Fraud alerts'), h('b', cu.openFraudAlerts ? badge('coral', `${cu.openFraudAlerts} open`) : badge('mint', 'None open')),
    h('span', 'Contact'), h('b.small', `${cu.phone} · ${cu.accountRef}`));
}

function balanceBody(a) {
  const bar = h('span.fill');
  bar.style.width = `${a.utilisation}%`;
  return h('div.ag-bal',
    h('div.cx-money', h('div', h('span', 'Current balance'), h('b', a.balance)), h('div', h('span', 'Available credit'), h(`b${a.lowCredit || a.utilisation > 90 ? '.warn' : ''}`, a.available))),
    h(`div.cx-meter${a.utilisation > 90 ? '.hot' : ''}`, { role: 'img', 'aria-label': `${a.utilisation}% of the ${a.limit} limit used` }, bar),
    h('div.cx-kv',
      h('span', 'Credit limit'), h('b', a.limit),
      a.lastPayment ? [h('span', 'Last payment'), h('b', `${a.lastPayment.amount} · ${fmtWhen(a.lastPayment.at)}`)] : null,
      h('span', 'Limit used'), h('b', `${a.utilisation}%`)));
}

/* ------------------------------------------------------------ transactions */

const TX_RANGES = [['all', 'Whole history'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last 12 months']];

/**
 * The transaction workspace. The ledger is read from the customer's own transaction endpoint, not
 * from the handful the case carries, and it is paged: the counts beside the filters are counted in
 * the database, so the screen can say how many entries there really are instead of implying that
 * the first page is the whole history. Filters, the page already loaded and the selected row live
 * in module state, so leaving the section and coming back costs nothing and loses nothing.
 */
function txView(w) {
  const st = C.tx;
  const cust = w.customer?.id ?? null;
  if (!cust) return h('div.ag-tx', h('p.small.muted', 'No customer is identified on this case, so there is no account to read transactions from.'));
  if (st.forCust !== cust) { Object.assign(st, { forCust: cust, rows: [], total: 0, matching: 0, hasMore: false, cursor: null, sel: null, error: null, loading: false, statuses: [], seq: st.seq + 1 }); }

  const q = h('input', { type: 'search', value: st.q, maxlength: '60', placeholder: 'Merchant, amount or reference', 'aria-label': 'Search transactions' });
  const stSel = h('select', { 'aria-label': 'Status' });
  const dr = h('select', { 'aria-label': 'Date range' }, TX_RANGES.map(([k, l]) => h('option', { value: k, ...(st.days === k ? { selected: '' } : {}) }, l)));
  const disp = h('input', { type: 'checkbox', ...(st.disputed ? { checked: '' } : {}) });
  const count = h('span.small.muted.ag-count');
  const table = h('div.ag-txwrap');
  const detail = h('div.ag-txdet');
  const more = h('div.ag-more');

  const drawStatuses = () => stSel.replaceChildren(h('option', { value: 'all' }, 'Any status'), ...st.statuses.map((x) => h('option', { value: x, ...(st.status === x ? { selected: '' } : {}) }, cap(x))));

  // One request per change of filter, and one more for each further page. Nothing is refetched
  // when the agent only switches section.
  //
  // Each request carries a sequence number and only the newest one is allowed to write. Typing in
  // the search box puts several in flight at once, and without this a slow early reply can land
  // after a fast later one and leave the table showing rows the filters no longer select — with a
  // count that says those rows match. An agent reading a ledger has to be able to trust the count.
  async function load(append) {
    const mine = ++st.seq;
    st.loading = true; st.error = null;
    paint();
    const p = new URLSearchParams({ limit: '25' });
    if (st.q.trim()) p.set('q', st.q.trim());
    if (st.status !== 'all') p.set('status', st.status);
    if (st.days !== 'all') p.set('days', st.days);
    if (st.disputed) p.set('disputed', 'true');
    if (append && st.cursor) p.set('cursor', st.cursor);
    try {
      const r = await api(`/api/crm/customers/${encodeURIComponent(cust)}/transactions?${p}`);
      if (mine !== st.seq) return;
      st.rows = append ? [...st.rows, ...r.items] : r.items;
      st.total = r.total; st.matching = r.matching; st.hasMore = r.hasMore; st.cursor = r.nextCursor;
      st.oldestAt = r.oldestAt; st.statuses = r.statuses;
      C.refreshCount?.('tx', r.total);
      if (st.sel && !st.rows.some((t) => t.id === st.sel)) st.sel = null;
    } catch (e) {
      if (mine === st.seq) st.error = e.message;
    } finally {
      if (mine === st.seq) {
        st.loading = false;
        if (table.isConnected) { drawStatuses(); paint(); }
      }
    }
  }

  function paint() {
    const filtered = st.q.trim() || st.status !== 'all' || st.days !== 'all' || st.disputed;
    count.replaceChildren(st.error ? 'Could not be read'
      : st.loading && !st.rows.length ? 'Loading…'
      : filtered ? `${st.rows.length} shown · ${st.matching} match these filters · ${st.total} in the full history`
      : `${st.rows.length} shown · ${st.total} in the full history`);
    table.replaceChildren(
      st.error ? h('div.ag-state', { role: 'alert' }, K.icon('alert'), h('div', h('b', 'The transaction ledger could not be read.'), h('span', st.error)), h('button.btn.sm', { type: 'button', onclick: () => load(false) }, K.icon('retry'), 'Try again'))
        : st.loading && !st.rows.length ? h('ul.skel.ag-skel', [1, 2, 3, 4].map(() => h('li', h('span'))))
        : st.rows.length ? txGrid(st.rows, paint)
        : h('div.ag-state', K.icon('search'), h('div', h('b', filtered ? 'Nothing matches these filters.' : 'No transactions on file for this customer.'), h('span', filtered ? 'Widen the date range or clear the search.' : st.total ? '' : 'Nothing has been recorded against this account.'))));
    more.replaceChildren(...[
      st.hasMore ? h('button.btn.sm', { type: 'button', disabled: st.loading, onclick: () => load(true) }, st.loading ? 'Loading…' : `Load 25 more (${Math.max(0, st.matching - st.rows.length)} left)`) : null,
      !st.hasMore && st.rows.length ? h('span.small.muted', st.oldestAt ? `That is every entry${st.days === 'all' ? '' : ' in this range'}. The oldest on file is ${fmtWhen(st.oldestAt)}.` : 'That is every entry.') : null,
    ].filter(Boolean));
    const sel = st.rows.find((t) => t.id === st.sel) ?? null;
    detail.replaceChildren(sel ? txDetail(sel, w) : h('p.small.muted', 'Select a transaction to see its full record and what you can do with it.'));
    detail.classList.toggle('on', !!sel);
  }

  let t = 0;
  q.addEventListener('input', () => { st.q = q.value; clearTimeout(t); t = setTimeout(() => load(false), 280); });
  stSel.addEventListener('change', () => { st.status = stSel.value; load(false); });
  dr.addEventListener('change', () => { st.days = dr.value; load(false); });
  disp.addEventListener('change', () => { st.disputed = disp.checked; load(false); });
  drawStatuses();
  paint();
  if (!st.rows.length && !st.loading) load(false);
  return h('div.ag-tx',
    h('div.ag-txbar', h('div.cx-search.sm', K.icon('search'), q), stSel, dr, h('label.ag-chk', disp, h('span', 'Disputed only')), count),
    h('div.ag-txsplit', h('div.ag-txcol', table, more), detail));
}

/** The ledger itself: one row per entry, the selected one highlighted. */
function txGrid(rows, paint) {
  const head = ['Date and time', 'Merchant', 'Type', 'Card', 'Location', 'Status', 'Amount'];
  const body = rows.map((t) => {
    const when = new Date(t.at);
    const time = isNaN(when) ? '' : when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const pick = () => { C.tx.sel = C.tx.sel === t.id ? null : t.id; paint(); };
    return h(`tr.txr${t.focus ? '.focus' : ''}${C.tx.sel === t.id ? '.on' : ''}`,
      { onclick: pick, tabindex: '0', 'aria-selected': String(C.tx.sel === t.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } } },
      h('td', h('b', fmtWhen(t.at)), time ? h('span', time) : null),
      h('td', h('b', t.merchant), t.disputed ? badge('lav', 'Disputed') : t.focus ? badge('amber', 'This call') : null, patternBadge(t)),
      h('td', t.typeLabel ?? t.kind),
      h('td.mono', t.card ?? '—'),
      h('td', t.where ?? '—'),
      h('td', h(`span.st.${t.status}`, t.statusLabel ?? t.status)),
      h('td.amt', h('b.mono', t.amount)));
  });
  return h('table.txt.ag-txt', h('thead', h('tr', head.map((x) => h('th', { scope: 'col' }, x)))), h('tbody', ...body));
}

/**
 * One transaction's full record, and the only thing the screen can do with it: raise a service
 * request for the team that reviews suspicious charges. Nothing here blocks a card or opens a
 * dispute — those keep their own consent and approval route through the case.
 */
function txDetail(t, w) {
  const rows = [
    ['Merchant', t.merchant],
    ['Amount', t.amount],
    ['Authorised', fmtFull(t.at)],
    ['Settled', t.postedAt ? fmtFull(t.postedAt) : 'Not yet settled'],
    ['Status', t.statusLabel ?? t.status],
    ['Type', t.typeLabel ?? t.kind],
    t.entryLabel ? ['Entry', t.entryLabel] : null,
    t.where ? ['Merchant location', t.where] : null,
    t.mcc ? ['Merchant category', `${t.mcc}${t.mccLabel ? ` · ${t.mccLabel}` : ''}`] : null,
    t.card ? ['Card', t.card] : null,
    t.authCode ? ['Authorisation code', t.authCode] : null,
    t.networkRef ? ['Acquirer reference', t.networkRef] : null,
    t.acquirer ? ['Acquirer', t.acquirer] : null,
    ['Transaction id', t.id],
  ].filter(Boolean);
  const canRaise = !!w.case && !!w.customer;
  return h('div.ag-det',
    h('div.cx-h', h('h2', 'Transaction record'),
      t.disputed ? badge('lav', 'Disputed') : null, t.focus ? badge('amber', 'This call') : null, patternBadge(t)),
    h('dl.txd2', rows.map(([k, v]) => h('div', h('dt', k), h('dd.mono', v)))),
    t.reportedByOthers > 0 ? h('p.small.ag-warnline', K.icon('alert'), `${t.reportedByOthers} other customer${t.reportedByOthers > 1 ? 's have' : ' has'} raised a fraud alert or dispute for ${t.merchant} in the last 30 days.`) : null,
    canRaise
      ? h('div.row3', h('button.btn.sm', { type: 'button', onclick: (e) => raiseSuspicious(e.currentTarget, t, w) }, K.icon('alert'), 'Report as suspicious'))
      : h('p.small.muted', 'Verify the caller before raising anything on this transaction.'),
    h('p.small.muted', 'Synthetic demo records. Nothing here is a finding of fraud.'));
}

async function raiseSuspicious(btn, t, w) {
  const reason = await confirmBox({
    title: `Report ${t.merchant} ${t.amount} as suspicious?`,
    body: 'This opens a service request for the fraud and security team with this transaction attached. It does not block the card or open a dispute.',
    ask: 'What has the customer told you about this charge?',
    confirmLabel: 'Create the request',
  });
  if (!reason) return;
  const team = (w.taxonomy?.teams ?? []).find((x) => /fraud/i.test(x)) ?? w.taxonomy?.teams?.[0] ?? 'Card services';
  act(btn, () => api(`/api/crm/cases/${w.case.id}/tickets`, { method: 'POST', body: { type: 'escalation', team, reason: `Suspicious transaction ${t.id} — ${t.merchant} ${t.amount} on ${fmtFull(t.at)}. ${reason}`, requestKey: `tx-${t.id}` } }), 'Service request created for the fraud team.');
}

/* ------------------------------------------------------------ conversation */

function talkView(w) {
  return h('div.ag-talkwrap',
    h('div.cx-h', h('h2', `Conversation (${w.transcript.length})`),
      h('span.ag-legend', h('i.cust'), 'Customer', h('i.lily'), 'Lily (AI)', h('i.agent'), 'Agent'),
      h('span.small.muted', 'The whole call, oldest first')),
    w.transcript.length ? h('div.ag-talk', conversation(w)) : h('p.small.muted', 'Nothing was transcribed on this call.'),
    w.summary.unresolved.length
      ? h('div.ag-talkfoot', h('h3', 'Still unanswered'), h('ul.list.bad', w.summary.unresolved.map((x) => h('li', K.icon('alert'), h('span', x)))))
      : null);
}

/* --------------------------------------------------------- case & requests */

/**
 * The case record and everything waiting on someone: how it is classified, the actions that need
 * an approval, the service requests, and the agent's own notes. Every control writes through the
 * API and the page reloads from the record afterwards.
 */
function caseView(w) {
  const eff = w.tags.effective; const tx = w.taxonomy;
  const save = (key) => (e) => act(e.currentTarget, () => api(`/api/crm/cases/${w.case.id}`, { method: 'PATCH', body: { version: w.case.version, overrides: { [key]: e.currentTarget.value || null } } }), 'Case updated.');
  const notes = h('textarea', { rows: '5', maxlength: '3000', 'aria-label': 'Agent notes', placeholder: 'Notes for the case record' }, C.notes ?? w.notes ?? '');
  notes.addEventListener('input', () => { C.notes = notes.value; C.dirty = true; });
  const saveNotes = h('button.btn.sm.dark', { type: 'button', onclick: (e) => act(e.currentTarget, () => api(`/api/crm/cases/${w.case.id}`, { method: 'PATCH', body: { version: w.case.version, notes: notes.value } }).then((r) => { C.notes = null; return r; }), 'Notes saved on the case.') }, 'Save notes');
  return h('div.ag-grid',
    h('section.ag-sec.ag-span',
      agH('Case record', h('span.small.muted', `Opened ${fmtFull(w.case.createdAt)} · updated ${fmtFull(w.case.updatedAt)}`)),
      h('div.cx-kv',
        h('span', 'Case'), h('b.mono', w.case.id),
        h('span', 'Reference'), h('b.mono', w.tickets[0]?.id ?? '—'),
        h('span', 'Call reason'), h('b', w.summary.reported ?? w.tags.effective.issueType),
        h('span', 'Assigned agent'), h('b', w.handoff?.agentName ?? 'Not assigned'),
        h('span', 'Resolution'), h('b', eff.resolutionType ?? 'Not recorded')),
      h('div.cx-sel',
        h('select', { 'aria-label': 'Case status', onchange: save('status') }, tx.statuses.map((x) => h('option', { value: x.id, ...(eff.status === x.id ? { selected: '' } : {}) }, x.label))),
        h('select', { 'aria-label': 'Priority', onchange: save('priority') }, tx.priorities.map((pr) => h('option', { value: pr, ...(eff.priority === pr ? { selected: '' } : {}) }, `${cap(pr)} priority`))),
        h('select', { 'aria-label': 'Escalation reason', onchange: save('escalationReason') }, h('option', { value: '' }, 'No escalation reason'), tx.escalationReasons.map((r) => h('option', { value: r, ...(eff.escalationReason === r ? { selected: '' } : {}) }, r))),
        w.tags.overrides.status || w.tags.overrides.priority || w.tags.overrides.escalationReason ? h('span.small.muted', `set by ${w.tags.editedBy ?? 'an agent'}`) : null)),
    wide(ticketsCard(w)),
    w.actions?.length ? wide(actionsCard(w)) : null,
    h('section.ag-sec.ag-span', agH('Call tagging', badge('lav', `${(w.callTags ?? []).length} on this call`)), tagEditor(w)),
    h('section.ag-sec.ag-span', agH('Agent notes', C.notes !== null ? badge('amber', 'Unsaved') : null), notes, h('div.row3', saveNotes), h('p.small.muted', 'Saved on the case record and written to the audit trail.')),
    (w.previousCases ?? []).length > 1 ? wide(interactionsCard(w.previousCases ?? [], w.case?.id)) : null);
}

/**
 * Call tagging. The dropdown holds the bank's standard reporting labels; the box beside it takes
 * anything else the agent needs. Tags are the agent's own classification and are saved on the case
 * as soon as they are added, so a call that ends abruptly keeps whatever was already tagged.
 */
function tagEditor(w) {
  const on = (w.callTags ?? []).map((t) => t.tag);
  const left = (w.taxonomy?.callTags ?? []).filter((t) => !on.includes(t));
  const pick = h('select', { 'aria-label': 'Standard call tag' }, h('option', { value: '' }, left.length ? 'Choose a tag…' : 'All standard tags added'), left.map((t) => h('option', { value: t }, t)));
  const own = h('input', { type: 'text', maxlength: '40', placeholder: 'Or type your own', 'aria-label': 'Your own tag' });
  const add = (tag, btn) => {
    tag = String(tag ?? '').trim();
    if (tag.length < 2) return K.toast('A tag needs at least two characters.');
    act(btn, () => api(`/api/crm/cases/${w.case.id}/tags`, { method: 'POST', body: { tag } }), `Tagged “${tag}”.`);
  };
  return h('div.ag-tags',
    (w.callTags ?? []).length
      ? h('div.ag-taglist', (w.callTags ?? []).map((t) => h('span.ag-tag', h('span', t.tag),
        h('button', { type: 'button', 'aria-label': `Remove the tag ${t.tag}`, title: `Added by ${t.by ?? 'an agent'} · ${fmtFull(t.at)}`, onclick: (e) => act(e.currentTarget, () => api(`/api/crm/cases/${w.case.id}/tags`, { method: 'DELETE', body: { tag: t.tag } }), `Removed “${t.tag}”.`) }, K.icon('x')))))
      : h('p.small.muted', 'No tags on this call yet.'),
    h('form.ag-tagform', { onsubmit: (e) => { e.preventDefault(); add(own.value, e.submitter); } },
      pick,
      h('button.btn.sm', { type: 'button', disabled: !left.length, onclick: (e) => { if (!pick.value) return K.toast('Choose a tag first.'); add(pick.value, e.currentTarget); } }, 'Add'),
      own,
      h('button.btn.sm.dark', { type: 'submit' }, 'Add tag')));
}

/* ---------------------------------------------------------------- timeline */

function timelineView(w) {
  const bad = w.timeline.filter((e) => ['failed', 'blocked', 'warn'].includes(e.status)).length;
  const pending = w.timeline.filter((e) => ['pending', 'running'].includes(e.status)).length;
  return h('div.ag-tl',
    h('div.cx-h', h('h2', `Call and case history (${w.timeline.length})`),
      badge(bad ? 'coral' : 'lav', bad ? `${bad} failed or blocked` : 'None failed'),
      badge(pending ? 'amber' : 'lav', pending ? `${pending} still running` : 'None pending'),
      h('span.small.muted', 'Newest first · an attempt is not a result')),
    timeline(w));
}

/* --------------------------------------------------------------- knowledge */

/**
 * What the agent may read out. Three lists, kept apart because they mean different things: what
 * the assistant actually retrieved on this call, what the knowledge base returns for this case,
 * and the rest of the library to search. Nothing on this screen is generated, so nothing here can
 * state a policy the bank's own knowledge base does not hold.
 */
function kbView(w, id) {
  const st = C.kb;
  if (st.forCase !== id) { st.forCase = id; st.data = null; st.error = null; st.loading = false; st.sel = null; }
  const out = h('div.ag-kb');
  const q = h('input', { type: 'search', value: st.q, maxlength: '80', placeholder: 'Search the knowledge base', 'aria-label': 'Search the knowledge base' });
  const list = h('div.ag-kblist');
  const prev = h('div.ag-kbprev');
  const src = h('span.small.muted', 'Loading the knowledge base…');

  const card = (a, tag) => h(`button.ag-kbitem${st.sel === a.id ? '.on' : ''}`, { type: 'button', onclick: () => { st.sel = a.id; paint(); } },
    h('div.rt', h('b', a.title), tag ?? null),
    h('span.mono', a.id), a.excerpt ? h('p', a.excerpt.slice(0, 150) + (a.excerpt.length > 150 ? '…' : '')) : null);

  function paint() {
    if (st.error) { list.replaceChildren(h('p.small.bad', st.error)); return; }
    if (!st.data) { list.replaceChildren(h('ul.skel.ag-skel', [1, 2, 3].map(() => h('li', h('span'))))); prev.replaceChildren(); return; }
    const d = st.data;
    const needle = st.q.trim().toLowerCase();
    const hits = needle
      ? d.library.filter((a) => [a.title, a.excerpt, a.id, ...(a.keywords ?? [])].some((x) => String(x ?? '').toLowerCase().includes(needle)))
      : [];
    src.replaceChildren(st.data ? `${st.data.library.length} articles · source: ${st.data.source}` : st.error ? 'Could not be read' : 'Loading the knowledge base…');
    list.replaceChildren(...[
      needle
        ? h('div.ag-kbgrp', h('h3', `Search · ${hits.length} match${hits.length === 1 ? '' : 'es'}`), hits.length ? h('div.ag-kbcards', hits.map((a) => card(a))) : h('p.small.muted', `Nothing in the knowledge base matches “${st.q}”.`))
        : null,
      d.used.length ? h('div.ag-kbgrp', h('h3', 'Used by Lily on this call'), h('div.ag-kbcards', d.used.map((a) => card(a, badge('mint', 'Retrieved'))))) : null,
      d.suggested.length ? h('div.ag-kbgrp', h('h3', 'Suggested for this case'), h('div.ag-kbcards', d.suggested.map((a) => card(a, badge('lav', 'Suggested'))))) : null,
      needle ? null : h('div.ag-kbgrp', h('h3', `Everything in the knowledge base (${d.library.length})`), h('div.ag-kbcards', d.library.map((a) => card(a)))),
    ].filter(Boolean));
    const sel = st.sel ? [...d.library, ...d.used, ...d.suggested].find((a) => a.id === st.sel) : null;
    prev.replaceChildren(sel
      ? h('article.ag-art',
        h('div.cx-h', h('h2', sel.title), h('span.mono.small', `${sel.id} · ${sel.version ?? ''}`)),
        sel.reason ? h('p.small.muted', `Matched because it ${sel.reason}.`) : null,
        h('p.prose', sel.excerpt),
        (sel.steps ?? []).length ? h('div', h('h3', 'Procedure'), h('ol.ag-steps', sel.steps.map((x) => h('li', x)))) : null,
        (sel.ruleRefs ?? []).length ? h('p.small.muted', `Enforced by ${sel.ruleRefs.join(', ')}.`) : null,
        h('p.small.muted', d.notice))
      : h('p.small.muted', 'Choose an article to read it here.'));
    prev.classList.toggle('on', !!sel);
  }
  q.addEventListener('input', () => { st.q = q.value; paint(); });
  if (!st.data && !st.loading) {
    st.loading = true;
    api(`/api/crm/cases/${encodeURIComponent(id)}/knowledge`)
      .then((d) => { st.data = d; })
      .catch((e) => { st.error = `The knowledge base could not be read: ${e.message}`; })
      .finally(() => { st.loading = false; if (out.isConnected) { paint(); C.refreshCtx?.(); } });
  }
  paint();
  out.append(h('div.ag-kbbar', h('div.cx-search.sm', K.icon('search'), q), src),
    h('div.ag-kbsplit', list, prev));
  return out;
}

/* ----------------------------------------------------------- the copilot */

/**
 * The copilot's own reading of whichever section is open. It is assembled from the case record the
 * page already has — no second request, and no AI call — so switching section cannot make the
 * assistant say something new. Anything it suggests is labelled as a suggestion.
 */
function copilotContext(w) {
  const s = w.summary; const v = verifyState(w);
  const line = (t) => h('li', h('span', t));
  const block = (title, items, note) => h('div.ag-cblock', h('h3', title), items.length ? h('ul', items.map(line)) : h('p.small.muted', note ?? 'Nothing recorded.'));
  if (C.tab === 'tx') {
    const flagged = (w.transactions ?? []).filter((t) => t.disputed || t.reportedByOthers);
    const el = w.keyInfo?.find((k) => k.key === 'dispute');
    return [
      block('Reviewing transactions', [
        el ? `${el.label}: ${el.detail}` : null,
        flagged.length ? `${flagged.length} entr${flagged.length > 1 ? 'ies are' : 'y is'} disputed or reported by other customers.` : 'No entry is disputed or reported by others.',
        s.transaction ? `The call is about: ${s.transaction}` : null,
      ].filter(Boolean)),
      block('Worth asking', ['Was the card with you at the time?', 'Have you shopped with this merchant before?', 'Was anything else charged the same day?']),
    ];
  }
  if (C.tab === 'talk') return [block('Transcript summary', [s.reported ? `They said: “${s.reported}”` : null, `Identity: ${v.label.toLowerCase()}.`, `Where it got to: ${s.outcome}`].filter(Boolean)), block('Unresolved', s.unresolved, 'Nothing is left open.')];
  if (C.tab === 'case') {
    const waiting = (w.actions ?? []).filter((a) => a.state === 'awaiting_approval').map((a) => `${a.label} — waiting for your approval.`);
    const open = (w.tickets ?? []).filter((t) => t.status !== 'closed').map((t) => `${t.id}: ${cap(t.status)} with ${t.team ?? 'the team'}.`);
    return [block('Outstanding', [...waiting, ...open], 'Nothing is waiting on anyone.'), block('To close the case', [...s.nextSteps, 'Record the outcome and your notes before you finish the call.'])];
  }
  if (C.tab === 'timeline') {
    const bad = w.timeline.filter((e) => ['failed', 'blocked'].includes(e.status)).map((e) => `${e.title} — ${e.status}.`);
    return [block('What stands out', bad.length ? bad : [`${w.timeline.length} events recorded, none failed or blocked.`]), block('Reading it', ['An attempt and a confirmed result are separate events.', 'A blocked event means a safeguard stopped the assistant on purpose.'])];
  }
  if (C.tab === 'kb') {
    const used = (C.kb.data?.used ?? []).map((a) => `${a.title} (${a.id}) — used on this call.`);
    const sug = (C.kb.data?.suggested ?? []).map((a) => `${a.title} (${a.id}) — suggested for this issue.`);
    return [block('Relevant guidance', [...used, ...sug], 'Nothing retrieved for this case yet.'), block('Before you read it out', ['Everything here is synthetic demo guidance, not Northstar policy.'])];
  }
  return [
    block('Handover summary', [s.reported ? `They said: “${s.reported}”` : null, s.intendedOutcome ? `They want: ${s.intendedOutcome}` : null, `Identity: ${v.label.toLowerCase()}.`, s.confirmed.length ? `Confirmed: ${s.confirmed.slice(0, 2).join(' ')}` : 'Nothing confirmed by bank systems yet.'].filter(Boolean)),
    block('Suggested next steps', s.nextSteps, 'No suggestion for this case.'),
    s.unresolved.length ? block('Open questions', s.unresolved) : null,
  ].filter(Boolean);
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
