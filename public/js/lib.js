
// Shared browser helpers. All rendering uses textContent / DOM nodes — never innerHTML with
// data — so server-provided text is always output-encoded.

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.error?.code;
    err.data = data;
    throw err;
  }
  return data;
}

/** h('div.class#id', {attrs}, ...children) */
export function h(tag, attrs, ...children) {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const el = document.createElement(name || 'div');
  for (const r of rest) {
    if (r.length < 2) continue;
    if (r.startsWith('.')) el.classList.add(r.slice(1));
    else if (r.startsWith('#')) el.id = r.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM: allowed under the strict CSP
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

const STATUS_TONE = {
  succeeded: 'ok', ok: 'ok', verified: 'ok', connected: 'ok', completed: 'ok', resolved: 'ok', submitted: 'warn',
  pending: 'warn', unknown: 'warn', queued: 'warn', awaiting_confirmation: 'info', awaiting_approval: 'warn', validated: 'info', requested: 'info',
  failed: 'bad', rejected: 'bad', unavailable: 'bad', timeout: 'bad', error: 'bad', circuit_open: 'bad', no_agent: 'bad', verification_failed: 'bad', fallback: 'bad',
  handed_off: 'info', in_progress: 'info', open: 'info', awaiting_agent: 'warn', informational: 'ok', partially_resolved: 'warn', unresolved: 'warn', ended_unresolved: 'warn', abandoned: 'neutral',
};
export function chip(status, label) {
  return h(`span.chip.${STATUS_TONE[status] ?? 'neutral'}`, label ?? humanise(status));
}
export const humanise = (s) => (s == null ? '—' : String(s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()));
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
export const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

/** Demo staff sign-in strip: one click per synthetic role (not real authentication). */
export async function staffSignin(container, { roles, onChange }) {
  const me = await api('/api/auth/me');
  const users = (await api('/api/auth/demo-users')).items.filter((u) => roles.includes(u.role));
  const login = async (id) => {
    await api('/api/auth/demo-login', { method: 'POST', body: { userId: id } });
    const n = await api('/api/auth/me');
    render(n);
    onChange(n);
  };
  const render = (m) => {
    if (m.authenticated) {
      mount(container, h('div.signin', h('span.small', `Signed in as ${m.displayName}`), h('button.ghost', { onclick: async () => { await api('/api/auth/logout', { method: 'POST', body: {} }); const n = await api('/api/auth/me'); render(n); onChange(n); } }, 'Sign out')));
    } else {
      mount(container, h('div.signin', h('span.small.muted', 'Demo sign-in (no password):'), users.map((u) => h('button', { onclick: () => login(u.id) }, `Continue as ${u.display_name.replace(/ \(demo (agent|QA|admin)\)/, '')} · ${u.role}`))));
    }
  };
  render(me);
  onChange(me);
}
