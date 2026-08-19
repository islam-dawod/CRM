// Auth, bootstrap, admin-editable reference data, templates, automations, audit.
import { all, get, run, insert, update, setting, setSetting } from '../db.js';
import { bad, forbidden, notFound, unauthorized } from '../lib/http.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, requireUser, requirePerm, can, ROLES,
} from '../lib/auth.js';
import { audit, nowIso, slug, parseJson, token } from '../lib/util.js';
import { clinicConfig } from '../lib/clinic.js';

const publicUser = (u) =>
  u && {
    id: u.id, name: u.name, email: u.email, role: u.role, lang: u.lang, color: u.color,
    phone: u.phone, active: !!u.active, receives_leads: !!u.receives_leads,
    specialties: parseJson(u.specialties, []),
  };

export default function register(router) {
  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------
  router.post('/api/auth/login', ({ body, res, ip }) => {
    const email = String(body.email || '').trim().toLowerCase();
    const user = get('SELECT * FROM users WHERE lower(email)=? AND active=1', email);
    if (!user || !verifyPassword(body.password || '', user.password_hash)) {
      audit(null, 'auth', null, 'login_failed', email, ip);
      throw unauthorized('אימייל או סיסמה שגויים');
    }
    createSession(res, user.id);
    audit(user.id, 'auth', user.id, 'login', null, ip);
    return { user: publicUser(user) };
  });

  router.post('/api/auth/logout', ({ req, res }) => {
    destroySession(req, res);
    return { ok: true };
  });

  router.get('/api/auth/me', ({ user }) => ({ user: publicUser(user) }));

  router.post('/api/auth/password', ({ req, body }) => {
    const me = requireUser(req);
    const fresh = get('SELECT * FROM users WHERE id=?', me.id);
    if (!verifyPassword(body.current || '', fresh.password_hash)) throw bad('הסיסמה הנוכחית שגויה');
    if (String(body.next || '').length < 4) throw bad('סיסמה קצרה מדי');
    update('users', me.id, { password_hash: hashPassword(body.next) });
    audit(me.id, 'user', me.id, 'password_change');
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Bootstrap — everything the SPA needs on load
  // -------------------------------------------------------------------------
  router.get('/api/bootstrap', ({ req }) => {
    const user = requireUser(req);
    return {
      user: publicUser(user),
      statuses: all('SELECT * FROM statuses WHERE active=1 ORDER BY sort, id'),
      treatments: all('SELECT * FROM treatments WHERE active=1 ORDER BY sort, id'),
      users: all('SELECT * FROM users WHERE active=1 ORDER BY id').map(publicUser),
      settings: {
        // clinicConfig() adds the derived Maps/Waze/WhatsApp links so the UI never
        // builds them itself (spec §15).
        clinic: clinicConfig(),
        sla: setting('sla', {}),
        assignment: setting('assignment', {}),
        integrations: can(user, 'automations.write') || user.role === 'admin'
          ? setting('integrations', {})
          : undefined,
      },
      permissions: {
        readAll: can(user, 'leads.read.all'),
        write: can(user, 'leads.write'),
        reports: can(user, 'reports.read'),
        team: can(user, 'team.read'),
        admin: user.role === 'admin',
        automations: can(user, 'automations.write'),
        audit: can(user, 'audit.read'),
      },
      sources: [
        'facebook_lead_ads', 'facebook_campaign', 'instagram', 'landing_page',
        'website', 'whatsapp', 'google_ads', 'phone', 'manual', 'referral',
      ],
    };
  });

  // -------------------------------------------------------------------------
  // Statuses (§4 — editable by the admin)
  // -------------------------------------------------------------------------
  router.get('/api/statuses', ({ req }) => {
    requireUser(req);
    return all('SELECT * FROM statuses ORDER BY sort, id');
  });

  router.post('/api/statuses', ({ req, body }) => {
    const u = requireUser(req);
    if (u.role !== 'admin') throw forbidden();
    const key = body.key ? slug(body.key) : slug(body.name_en || body.name_he);
    if (get('SELECT 1 AS x FROM statuses WHERE key=?', key)) throw bad('status key already exists');
    const id = insert('statuses', {
      key,
      name_he: body.name_he || key,
      name_ar: body.name_ar || body.name_he || key,
      name_en: body.name_en || key,
      color: body.color || '#64748b',
      stage: body.stage || 'working',
      in_kanban: body.in_kanban ? 1 : 0,
      sort: body.sort ?? (get('SELECT MAX(sort) AS m FROM statuses').m ?? 0) + 1,
      active: 1,
    });
    audit(u.id, 'status', id, 'create', body);
    return get('SELECT * FROM statuses WHERE id=?', id);
  });

  router.patch('/api/statuses/:id', ({ req, params, body }) => {
    const u = requireUser(req);
    if (u.role !== 'admin') throw forbidden();
    const allowed = ['name_he', 'name_ar', 'name_en', 'color', 'stage', 'in_kanban', 'sort', 'active'];
    const patch = {};
    for (const k of allowed) if (body[k] !== undefined) patch[k] = typeof body[k] === 'boolean' ? (body[k] ? 1 : 0) : body[k];
    update('statuses', params.id, patch);
    audit(u.id, 'status', Number(params.id), 'update', patch);
    return get('SELECT * FROM statuses WHERE id=?', params.id);
  });

  router.delete('/api/statuses/:id', ({ req, params }) => {
    const u = requireUser(req);
    if (u.role !== 'admin') throw forbidden();
    const st = get('SELECT * FROM statuses WHERE id=?', params.id);
    if (!st) throw notFound();
    const used = get('SELECT COUNT(*) AS n FROM leads WHERE status_key=?', st.key).n;
    if (used) {
      update('statuses', params.id, { active: 0 });
      return { ok: true, deactivated: true, leads: used };
    }
    run('DELETE FROM statuses WHERE id=?', params.id);
    audit(u.id, 'status', Number(params.id), 'delete', st.key);
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Treatments (§5)
  // -------------------------------------------------------------------------
  router.get('/api/treatments', ({ req }) => {
    requireUser(req);
    return all('SELECT * FROM treatments ORDER BY sort, id');
  });

  router.post('/api/treatments', ({ req, body }) => {
    const u = requireUser(req);
    if (!['admin', 'manager'].includes(u.role)) throw forbidden();
    const id = insert('treatments', {
      name_he: body.name_he, name_ar: body.name_ar || body.name_he, name_en: body.name_en || body.name_he,
      color: body.color || '#0ea5e9', price: Number(body.price || 0),
      sort: body.sort ?? (get('SELECT MAX(sort) AS m FROM treatments').m ?? 0) + 1, active: 1,
    });
    audit(u.id, 'treatment', id, 'create', body);
    return get('SELECT * FROM treatments WHERE id=?', id);
  });

  router.patch('/api/treatments/:id', ({ req, params, body }) => {
    const u = requireUser(req);
    if (!['admin', 'manager'].includes(u.role)) throw forbidden();
    const patch = {};
    for (const k of ['name_he', 'name_ar', 'name_en', 'color', 'price', 'sort', 'active']) {
      if (body[k] !== undefined) patch[k] = typeof body[k] === 'boolean' ? (body[k] ? 1 : 0) : body[k];
    }
    update('treatments', params.id, patch);
    return get('SELECT * FROM treatments WHERE id=?', params.id);
  });

  router.delete('/api/treatments/:id', ({ req, params }) => {
    const u = requireUser(req);
    if (!['admin', 'manager'].includes(u.role)) throw forbidden();
    update('treatments', params.id, { active: 0 });
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Team (§33, §47)
  // -------------------------------------------------------------------------
  router.get('/api/users', ({ req }) => {
    requireUser(req);
    return all('SELECT * FROM users ORDER BY active DESC, id').map(publicUser);
  });

  router.post('/api/users', ({ req, body }) => {
    const u = requireUser(req);
    if (u.role !== 'admin') throw forbidden();
    if (!body.email || !body.name) throw bad('name and email are required');
    if (!ROLES.includes(body.role)) throw bad('invalid role');
    if (get('SELECT 1 AS x FROM users WHERE lower(email)=?', String(body.email).toLowerCase())) {
      throw bad('email already exists');
    }
    const id = insert('users', {
      name: body.name,
      email: String(body.email).toLowerCase(),
      phone: body.phone || null,
      password_hash: hashPassword(body.password || '123456'),
      role: body.role,
      lang: body.lang || 'he',
      color: body.color || '#0ea5e9',
      specialties: JSON.stringify(body.specialties || []),
      receives_leads: body.receives_leads ? 1 : 0,
      active: 1,
    });
    audit(u.id, 'user', id, 'create', { name: body.name, role: body.role });
    return publicUser(get('SELECT * FROM users WHERE id=?', id));
  });

  router.patch('/api/users/:id', ({ req, params, body }) => {
    const u = requireUser(req);
    const targetId = Number(params.id);
    if (u.role !== 'admin' && u.id !== targetId) throw forbidden();
    const patch = {};
    for (const k of ['name', 'phone', 'lang', 'color']) if (body[k] !== undefined) patch[k] = body[k];
    if (u.role === 'admin') {
      if (body.role !== undefined) {
        if (!ROLES.includes(body.role)) throw bad('invalid role');
        patch.role = body.role;
      }
      if (body.active !== undefined) patch.active = body.active ? 1 : 0;
      if (body.receives_leads !== undefined) patch.receives_leads = body.receives_leads ? 1 : 0;
      if (body.specialties !== undefined) patch.specialties = JSON.stringify(body.specialties);
      if (body.password) patch.password_hash = hashPassword(body.password);
    }
    update('users', targetId, patch);
    audit(u.id, 'user', targetId, 'update', Object.keys(patch).join(','));
    return publicUser(get('SELECT * FROM users WHERE id=?', targetId));
  });

  // -------------------------------------------------------------------------
  // Templates (§42, §43)
  // -------------------------------------------------------------------------
  router.get('/api/templates', ({ req, query }) => {
    requireUser(req);
    if (query.channel) {
      return all('SELECT * FROM templates WHERE channel=? ORDER BY lang, id', query.channel);
    }
    return all('SELECT * FROM templates ORDER BY channel, lang, id');
  });

  router.post('/api/templates', ({ req, body }) => {
    const u = requireUser(req);
    requirePerm(u, 'templates.write');
    const id = insert('templates', {
      channel: body.channel === 'email' ? 'email' : 'whatsapp',
      key: body.key ? slug(body.key) : slug(body.name),
      name: body.name || 'תבנית',
      lang: body.lang || 'he',
      subject: body.subject || null,
      body: body.body || '',
      active: 1,
    });
    audit(u.id, 'template', id, 'create', body.name);
    return get('SELECT * FROM templates WHERE id=?', id);
  });

  router.patch('/api/templates/:id', ({ req, params, body }) => {
    const u = requireUser(req);
    requirePerm(u, 'templates.write');
    const patch = {};
    for (const k of ['name', 'lang', 'subject', 'body', 'active']) {
      if (body[k] !== undefined) patch[k] = typeof body[k] === 'boolean' ? (body[k] ? 1 : 0) : body[k];
    }
    update('templates', params.id, patch);
    return get('SELECT * FROM templates WHERE id=?', params.id);
  });

  router.delete('/api/templates/:id', ({ req, params }) => {
    const u = requireUser(req);
    requirePerm(u, 'templates.write');
    run('DELETE FROM templates WHERE id=?', params.id);
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Automations (§40, §41)
  // -------------------------------------------------------------------------
  router.get('/api/automations', ({ req }) => {
    const u = requireUser(req);
    requirePerm(u, 'automations.write');
    return all('SELECT * FROM automations ORDER BY id').map((a) => ({
      ...a,
      conditions: parseJson(a.conditions, {}),
      actions: parseJson(a.actions, []),
      active: !!a.active,
    }));
  });

  router.post('/api/automations', ({ req, body }) => {
    const u = requireUser(req);
    requirePerm(u, 'automations.write');
    const id = insert('automations', {
      name: body.name || 'אוטומציה',
      trigger: body.trigger || 'lead_created',
      conditions: JSON.stringify(body.conditions || {}),
      actions: JSON.stringify(body.actions || []),
      delay_min: Number(body.delay_min || 0),
      active: body.active === false ? 0 : 1,
    });
    audit(u.id, 'automation', id, 'create', body.name);
    return get('SELECT * FROM automations WHERE id=?', id);
  });

  router.patch('/api/automations/:id', ({ req, params, body }) => {
    const u = requireUser(req);
    requirePerm(u, 'automations.write');
    const patch = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.trigger !== undefined) patch.trigger = body.trigger;
    if (body.conditions !== undefined) patch.conditions = JSON.stringify(body.conditions);
    if (body.actions !== undefined) patch.actions = JSON.stringify(body.actions);
    if (body.delay_min !== undefined) patch.delay_min = Number(body.delay_min);
    if (body.active !== undefined) patch.active = body.active ? 1 : 0;
    update('automations', params.id, patch);
    audit(u.id, 'automation', Number(params.id), 'update', patch.name);
    return get('SELECT * FROM automations WHERE id=?', params.id);
  });

  router.delete('/api/automations/:id', ({ req, params }) => {
    const u = requireUser(req);
    requirePerm(u, 'automations.write');
    run('DELETE FROM automations WHERE id=?', params.id);
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------
  router.get('/api/settings', ({ req }) => {
    const u = requireUser(req);
    if (u.role !== 'admin') throw forbidden();
    return {
      clinic: clinicConfig(),
      sla: setting('sla', {}),
      assignment: setting('assignment', {}),
      integrations: setting('integrations', {}),
    };
  });

  router.put('/api/settings/:key', ({ req, params, body }) => {
    const u = requireUser(req);
    if (u.role !== 'admin') throw forbidden();
    if (!['clinic', 'sla', 'assignment', 'integrations'].includes(params.key)) throw bad('unknown setting');
    setSetting(params.key, body);
    audit(u.id, 'settings', null, 'update', params.key);
    return setting(params.key);
  });

  router.post('/api/settings/webhook-key', ({ req }) => {
    const u = requireUser(req);
    if (u.role !== 'admin') throw forbidden();
    const cfg = setting('integrations', {});
    cfg.webhook_key = token(12);
    setSetting('integrations', cfg);
    return { webhook_key: cfg.webhook_key };
  });

  // -------------------------------------------------------------------------
  // Audit log (§48)
  // -------------------------------------------------------------------------
  router.get('/api/audit', ({ req, query }) => {
    const u = requireUser(req);
    requirePerm(u, 'audit.read');
    const limit = Math.min(Number(query.limit || 100), 500);
    return all(
      `SELECT a.*, u.name AS user_name FROM audit_log a
       LEFT JOIN users u ON u.id=a.user_id
       ORDER BY a.id DESC LIMIT ?`, limit,
    );
  });
}
