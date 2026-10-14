// One consistent icon set: 24px grid, 1.6 stroke, round caps. Built as SVG nodes (no innerHTML).
const PATHS = {
  mic: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M19 11a7 7 0 0 1-14 0', 'M12 18v3'],
  stop: ['M7 7h10v10H7z'],
  retry: ['M4 12a8 8 0 1 0 2.4-5.7', 'M4 4v4h4'],
  end: ['M5 15c4-4 10-4 14 0l-2 3-3-1v-2a10 10 0 0 0-4 0v2l-3 1z'],
  send: ['M4 12l16-8-6 16-2-7z'],
  shield: ['M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z', 'M9 12l2 2 4-4'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
  bolt: ['M13 3L5 14h6l-1 7 8-11h-6z'],
  check: ['M5 12l5 5 9-10'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21a8 8 0 0 1 16 0'],
  doc: ['M7 3h7l5 5v13H7z', 'M14 3v5h5', 'M10 13h6', 'M10 17h6'],
  copy: ['M9 9h11v11H9z', 'M5 15V4h11'],
  card: ['M3 6h18v12H3z', 'M3 10h18', 'M7 15h4'],
  lock: ['M6 11h12v9H6z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  receipt: ['M6 3h12v18l-3-2-3 2-3-2-3 2z', 'M9 8h6', 'M9 12h6'],
  repeat: ['M17 2l3 3-3 3', 'M4 11V9a4 4 0 0 1 4-4h12', 'M7 22l-3-3 3-3', 'M20 13v2a4 4 0 0 1-4 4H4'],
  alert: ['M12 3l10 18H2z', 'M12 10v4', 'M12 17v.5'],
  headset: ['M4 14v-2a8 8 0 0 1 16 0v2', 'M4 14h3v6H4z', 'M17 14h3v6h-3z'],
  book: ['M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z', 'M4 19V5'],
  layers: ['M12 3l9 5-9 5-9-5z', 'M3 13l9 5 9-5'],
  volume: ['M4 9h4l5-4v14l-5-4H4z', 'M17 9a4 4 0 0 1 0 6'],
  mute: ['M4 9h4l5-4v14l-5-4H4z', 'M17 9l4 6', 'M21 9l-4 6'],
  keyboard: ['M3 6h18v12H3z', 'M7 10h.01', 'M11 10h.01', 'M15 10h.01', 'M7 14h10'],
};

export function icon(name, label) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'icon');
  if (label) {
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', label);
  } else s.setAttribute('aria-hidden', 'true');
  for (const d of PATHS[name] ?? []) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}

/** Brand mark: three sound rings converging on a point (one conversation). */
export function brandMark() {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 32 32');
  s.setAttribute('class', 'mark');
  s.setAttribute('aria-hidden', 'true');
  [[16, 13, 0.35], [16, 9, 0.6], [16, 5, 1]].forEach(([c, r, o]) => {
    const e = document.createElementNS(ns, 'circle');
    e.setAttribute('cx', c);
    e.setAttribute('cy', 16);
    e.setAttribute('r', r);
    e.setAttribute('fill', 'none');
    e.setAttribute('stroke', '#7fe1ff');
    e.setAttribute('stroke-opacity', o);
    e.setAttribute('stroke-width', '1.6');
    s.append(e);
  });
  const d = document.createElementNS(ns, 'circle');
  d.setAttribute('cx', 16);
  d.setAttribute('cy', 16);
  d.setAttribute('r', 2);
  d.setAttribute('fill', '#7fe1ff');
  s.append(d);
  return s;
}
