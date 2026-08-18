import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { get, run, insert } from '../db.js';
import { token, nowIso, plusDays } from './util.js';
import { parseCookies, setCookie, unauthorized, forbidden } from './http.js';

export const COOKIE = 'crm_session';

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored?.startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  const candidate = scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function createSession(res, userId, days = 30) {
  const t = token(32);
  insert('sessions', { token: t, user_id: userId, expires_at: plusDays(days) });
  setCookie(res, COOKIE, t, { maxAge: days * 86400 });
  return t;
}

export function destroySession(req, res) {
  const t = parseCookies(req)[COOKIE];
  if (t) run('DELETE FROM sessions WHERE token=?', t);
  setCookie(res, COOKIE, '', { maxAge: 0 });
}

export function currentUser(req) {
  const t = parseCookies(req)[COOKIE];
  if (!t) return null;
  const row = get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`,
    t,
    nowIso(),
  );
  return row || null;
}

export function requireUser(req) {
  const u = currentUser(req);
  if (!u) throw unauthorized();
  return u;
}

// ---------------------------------------------------------------------------
// Role matrix (spec §47)
// ---------------------------------------------------------------------------
export const ROLES = ['admin', 'manager', 'agent', 'reception', 'doctor'];

const PERMS = {
  admin: ['*'],
  manager: [
    'leads.read.all', 'leads.write', 'leads.assign', 'leads.delete',
    'inbox.all', 'appointments.write', 'tasks.all', 'reports.read',
    'team.read', 'templates.write', 'automations.write', 'audit.read', 'deals.write',
  ],
  agent: ['leads.read.own', 'leads.write', 'inbox.own', 'appointments.write', 'tasks.own', 'deals.write'],
  reception: [
    'leads.read.all', 'leads.write', 'inbox.all', 'appointments.write', 'tasks.all', 'deals.write',
  ],
  doctor: ['leads.read.clinical', 'appointments.read', 'tasks.own'],
};

export function can(user, perm) {
  if (!user) return false;
  const list = PERMS[user.role] || [];
  return list.includes('*') || list.includes(perm);
}

export function requirePerm(user, perm) {
  if (!can(user, perm)) throw forbidden(`missing permission: ${perm}`);
  return true;
}

/** Agents only see their own leads; doctors only leads with an appointment of theirs. */
export function leadScopeSql(user, alias = 'l') {
  if (can(user, 'leads.read.all')) return { sql: '1=1', params: [] };
  if (user.role === 'doctor') {
    return {
      sql: `EXISTS (SELECT 1 FROM appointments a WHERE a.lead_id = ${alias}.id AND a.doctor_id = ?)`,
      params: [user.id],
    };
  }
  return { sql: `${alias}.owner_id = ?`, params: [user.id] };
}

export function assertLeadAccess(user, lead) {
  if (!lead) throw forbidden('lead not found');
  if (can(user, 'leads.read.all')) return true;
  if (user.role === 'doctor') {
    const ok = get('SELECT 1 AS x FROM appointments WHERE lead_id=? AND doctor_id=?', lead.id, user.id);
    if (!ok) throw forbidden('lead not in your scope');
    return true;
  }
  if (lead.owner_id !== user.id) throw forbidden('lead not in your scope');
  return true;
}
