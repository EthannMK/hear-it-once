/**
 * Role-based access control (FR-18). Enforced server-side on every route.
 * Demo authentication: a staff user picks a synthetic demo identity; the server issues a
 * signed, HttpOnly, SameSite=Strict cookie. This is NOT production authentication.
 */
import { all, get, run } from '../db/db.ts';
import { hmac, safeEqual, sha256, newId } from '../lib/ids.ts';
import { env } from '../config/env.ts';
import { nowMs, nowIso } from '../lib/clock.ts';
import { AppError } from '../lib/errors.ts';
import type { Actor } from '../audit/audit.ts';

export type StaffRole = 'agent' | 'qa' | 'admin';

export type Permission =
  | 'call.read'
  | 'case.read'
  | 'case.update'
  | 'handoff.read'
  | 'handoff.accept'
  | 'handoff.complete'
  | 'handoff.message'
  | 'action.request'
  | 'action.approve'
  | 'action.reconcile'
  | 'kpi.read'
  | 'audit.read'
  | 'qa.review'
  | 'policy.read'
  | 'safety.control'
  | 'demo.reset'
  | 'demo.faults';

/** Least privilege. Note admin cannot request/approve banking actions. */
export const ROLE_PERMISSIONS: Record<StaffRole, { description: string; permissions: Permission[] }> = {
  agent: {
    description: 'Card services agent: handoff briefs, case context, continue conversation, record outcome, approve held actions',
    permissions: ['call.read', 'case.read', 'case.update', 'handoff.read', 'handoff.accept', 'handoff.complete', 'handoff.message', 'action.request', 'action.approve', 'action.reconcile'],
  },
  qa: {
    description: 'Operations / QA reviewer: KPI dashboard, cases, audit events, QA review, and the assistant’s off switch',
    permissions: ['call.read', 'case.read', 'kpi.read', 'audit.read', 'qa.review', 'policy.read', 'safety.control'],
  },
  admin: {
    description: 'Administrator / developer: reset synthetic data, configure mock faults, throw the assistant’s off switch; cannot execute banking actions',
    permissions: ['kpi.read', 'audit.read', 'policy.read', 'safety.control', 'demo.reset', 'demo.faults', 'case.read', 'call.read'],
  },
};

export function seedRoles(): void {
  for (const [role, def] of Object.entries(ROLE_PERMISSIONS)) {
    run('INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?)', [role, def.description]);
    for (const p of def.permissions) run('INSERT OR IGNORE INTO role_permissions (role, permission) VALUES (?, ?)', [role, p]);
  }
}

/** Permissions are read from the database so the persisted role model is authoritative. */
export function permissionsFor(role: string): Set<string> {
  return new Set(all<{ permission: string }>('SELECT permission FROM role_permissions WHERE role = ?', [role]).map((r) => r.permission));
}

export interface StaffPrincipal {
  kind: 'staff';
  userId: string;
  role: StaffRole;
  displayName: string;
  permissions: Set<string>;
}

const STAFF_TTL_MS = 8 * 60 * 60 * 1000;

export function issueStaffToken(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: nowMs() + STAFF_TTL_MS, n: newId('N', 6) })).toString('base64url');
  return `${payload}.${hmac(env().SESSION_SECRET, payload)}`;
}

export function verifyStaffToken(token: string | undefined): StaffPrincipal | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEqual(sig, hmac(env().SESSION_SECRET, payload))) return null;
  let data: { uid: string; exp: number };
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof data.exp !== 'number' || data.exp < nowMs()) return null;
  const user = get<{ id: string; role: StaffRole; display_name: string }>('SELECT id, role, display_name FROM staff_users WHERE id = ?', [data.uid]);
  if (!user) return null;
  return { kind: 'staff', userId: user.id, role: user.role, displayName: user.display_name, permissions: permissionsFor(user.role) };
}

export function requirePermission(p: StaffPrincipal | null, perm: Permission): StaffPrincipal {
  if (!p) throw new AppError('UNAUTHENTICATED', 'Sign in with a demo staff role first.');
  if (!p.permissions.has(perm)) throw new AppError('FORBIDDEN', `Your role (${p.role}) does not have permission for this operation.`, { permission: perm });
  return p;
}

export function staffActor(p: StaffPrincipal): Actor {
  return { type: p.role === 'agent' ? 'agent' : p.role === 'qa' ? 'qa' : 'admin', id: p.userId };
}

/* Caller (customer) tokens: bind a browser/telephony leg to exactly one call session. */
export function hashCallToken(token: string): string {
  return sha256(`call:${token}`);
}

export function listStaffUsers() {
  return all<{ id: string; display_name: string; role: string }>('SELECT id, display_name, role FROM staff_users ORDER BY role, display_name');
}

export function createStaffUser(id: string, displayName: string, role: StaffRole): void {
  run('INSERT OR IGNORE INTO staff_users (id, display_name, role, created_at) VALUES (?,?,?,?)', [id, displayName, role, nowIso()]);
}
