// Tasks, appointments, calendar, unified inbox, notification center.
// Spec §10, §16–§20, §21, §32, §39.
import { all, get, run, insert, update } from '../db.js';
import { bad, forbidden, notFound } from '../lib/http.js';
import { requireUser, requirePerm, can, leadScopeSql, assertLeadAccess } from '../lib/auth.js';
import { nowIso, plusMinutes, addEvent, audit, parseJson, notify } from '../lib/util.js';
import { createTask, completeTask, createAppointment, setAppointmentStatus, leadName } from '../lib/services.js';
import { fullLead } from './leads.js';

export default function register(router) {
  // -------------------------------------------------------------------------
  // Tasks (§32)
  // -------------------------------------------------------------------------
  router.get('/api/tasks', ({ req, query }) => {
    const user = requireUser(req);
    const where = [];
    const params = [];
    const mine = query.user === 'me' || (!can(user, 'tasks.all') && query.user !== 'all');
    if (mine) { where.push('t.user_id = ?'); params.push(user.id); }
    else if (query.user && query.user !== 'all') { where.push('t.user_id = ?'); params.push(Number(query.user)); }

    if (query.done === '1') where.push('t.done_at IS NOT NULL');
    else if (query.done !== 'all') where.push('t.done_at IS NULL');

    if (query.bucket === 'overdue') { where.push('t.due_at < ?'); params.push(nowIso()); }
    if (query.bucket === 'today') {
      where.push("date(t.due_at) = date('now','localtime')");
    }
    if (query.bucket === 'tomorrow') {
      where.push("date(t.due_at) = date('now','+1 day','localtime')");
    }
    if (query.bucket === 'week') { where.push('t.due_at <= ?'); params.push(plusMinutes(7 * 1440)); }
    if (query.lead) { where.push('t.lead_id = ?'); params.push(Number(query.lead)); }

    const sql = `
      SELECT t.*, l.first_name, l.last_name, l.phone_norm, l.status_key, l.temperature,
             u.name AS user_name, u.color AS user_color,
             s.name_he AS status_he, s.color AS status_color
      FROM tasks t
      LEFT JOIN leads l ON l.id = t.lead_id
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN statuses s ON s.key = l.status_key
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.done_at IS NOT NULL, t.due_at ASC LIMIT ?`;
    const rows = all(sql, ...params, Math.min(Number(query.limit || 200), 500));
    return rows.map(shapeTask);
  });

  router.get('/api/tasks/summary', ({ req, query }) => {
    const user = requireUser(req);
    // Mirrors the scoping of GET /api/tasks so the counters match the list.
    let targetId = null;
    if (query.user === 'me' || !can(user, 'tasks.all')) targetId = user.id;
    else if (query.user && query.user !== 'all') targetId = Number(query.user);
    const scope = targetId ? 'AND user_id = ?' : '';
    const p = targetId ? [targetId] : [];
    return get(
      `SELECT
        (SELECT COUNT(*) FROM tasks WHERE done_at IS NULL AND due_at < ? ${scope}) AS overdue,
        (SELECT COUNT(*) FROM tasks WHERE done_at IS NULL AND date(due_at)=date('now','localtime') ${scope}) AS today,
        (SELECT COUNT(*) FROM tasks WHERE done_at IS NULL AND date(due_at)=date('now','+1 day','localtime') ${scope}) AS tomorrow,
        (SELECT COUNT(*) FROM tasks WHERE done_at IS NULL AND priority='urgent' ${scope}) AS urgent`,
      nowIso(), ...p, ...p, ...p, ...p,
    );
  });

  router.post('/api/tasks', ({ req, body }) => {
    const user = requireUser(req);
    if (!body.title) throw bad('נדרשת כותרת למשימה');
    if (!body.due_at) throw bad('נדרש מועד');
    if (body.lead_id) assertLeadAccess(user, get('SELECT * FROM leads WHERE id=?', body.lead_id));
    const t = createTask(body.lead_id ? Number(body.lead_id) : null, {
      title: body.title,
      dueAt: new Date(body.due_at).toISOString(),
      userId: body.user_id ? Number(body.user_id) : user.id,
      kind: body.kind || 'callback',
      priority: body.priority || 'normal',
      note: body.note || null,
      createdBy: user.id,
    });
    return shapeTask(t);
  });

  router.patch('/api/tasks/:id', ({ req, params, body }) => {
    const user = requireUser(req);
    const t = get('SELECT * FROM tasks WHERE id=?', params.id);
    if (!t) throw notFound('task');
    if (t.user_id !== user.id && !can(user, 'tasks.all')) throw forbidden();

    if (body.done === true) return shapeTask(completeTask(t.id, user.id));
    if (body.done === false) { update('tasks', t.id, { done_at: null }); return shapeTask(get('SELECT * FROM tasks WHERE id=?', t.id)); }
    if (body.snooze_min) {
      const due = plusMinutes(Number(body.snooze_min));
      update('tasks', t.id, { due_at: due, notified_at: null, escalated_at: null });
      if (t.lead_id) addEvent(t.lead_id, 'task', `המשימה נדחתה ל-${new Date(due).toLocaleString('he-IL')}`, { actorId: user.id });
      return shapeTask(get('SELECT * FROM tasks WHERE id=?', t.id));
    }
    const patch = {};
    for (const k of ['title', 'note', 'kind', 'priority']) if (body[k] !== undefined) patch[k] = body[k];
    if (body.due_at) { patch.due_at = new Date(body.due_at).toISOString(); patch.notified_at = null; patch.escalated_at = null; }
    if (body.user_id !== undefined) patch.user_id = Number(body.user_id);
    update('tasks', t.id, patch);
    return shapeTask(get('SELECT * FROM tasks WHERE id=?', t.id));
  });

  router.delete('/api/tasks/:id', ({ req, params }) => {
    const user = requireUser(req);
    const t = get('SELECT * FROM tasks WHERE id=?', params.id);
    if (!t) throw notFound();
    if (t.user_id !== user.id && !can(user, 'tasks.all')) throw forbidden();
    run('DELETE FROM tasks WHERE id=?', t.id);
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Appointments (§20–§22)
  // -------------------------------------------------------------------------
  router.get('/api/appointments', ({ req, query }) => {
    const user = requireUser(req);
    const where = [];
    const params = [];
    if (query.from) { where.push('a.start_at >= ?'); params.push(query.from); }
    if (query.to) { where.push('a.start_at <= ?'); params.push(query.to); }
    if (query.status) {
      const list = String(query.status).split(',');
      where.push(`a.status IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
    if (query.doctor) { where.push('a.doctor_id = ?'); params.push(Number(query.doctor)); }
    if (query.lead) { where.push('a.lead_id = ?'); params.push(Number(query.lead)); }
    if (user.role === 'doctor') { where.push('a.doctor_id = ?'); params.push(user.id); }
    else if (!can(user, 'leads.read.all')) {
      const scope = leadScopeSql(user, 'l');
      where.push(`(${scope.sql})`);
      params.push(...scope.params);
    }
    return all(
      `SELECT a.*, l.first_name, l.last_name, l.phone_norm, l.language, l.temperature,
              t.name_he AS treatment_he, t.color AS treatment_color,
              d.name AS doctor_name, d.color AS doctor_color
       FROM appointments a
       JOIN leads l ON l.id = a.lead_id
       LEFT JOIN treatments t ON t.id = a.treatment_id
       LEFT JOIN users d ON d.id = a.doctor_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY a.start_at LIMIT ?`, ...params, Math.min(Number(query.limit || 300), 1000),
    );
  });

  router.post('/api/appointments', ({ req, body }) => {
    const user = requireUser(req);
    requirePerm(user, 'appointments.write');
    if (!body.lead_id) throw bad('lead_id required');
    assertLeadAccess(user, get('SELECT * FROM leads WHERE id=?', body.lead_id));
    const appt = createAppointment(Number(body.lead_id), body, user.id);
    audit(user.id, 'appointment', appt.id, 'create', body.start_at);
    return appt;
  });

  router.patch('/api/appointments/:id', ({ req, params, body }) => {
    const user = requireUser(req);
    requirePerm(user, 'appointments.write');
    const a = get('SELECT * FROM appointments WHERE id=?', params.id);
    if (!a) throw notFound('appointment');
    if (body.status && body.status !== a.status) {
      const valid = ['scheduled', 'confirmed', 'arrived', 'no_show', 'cancelled', 'done'];
      if (!valid.includes(body.status)) throw bad('invalid appointment status');
      setAppointmentStatus(a.id, body.status, user.id);
    }
    const patch = {};
    for (const k of ['branch', 'notes', 'treatment_id', 'doctor_id']) if (body[k] !== undefined) patch[k] = body[k];
    if (body.start_at) {
      const start = new Date(body.start_at);
      patch.start_at = start.toISOString();
      patch.end_at = body.end_at
        ? new Date(body.end_at).toISOString()
        : new Date(start.getTime() + (body.duration_min || 45) * 60000).toISOString();
      patch.reminded_at = null;
      addEvent(a.lead_id, 'appointment', `התור הועבר ל-${start.toLocaleString('he-IL')}`, { actorId: user.id });
    }
    update('appointments', a.id, patch);
    audit(user.id, 'appointment', a.id, 'update', body.status || Object.keys(patch).join(','));
    return get('SELECT * FROM appointments WHERE id=?', a.id);
  });

  router.delete('/api/appointments/:id', ({ req, params }) => {
    const user = requireUser(req);
    requirePerm(user, 'appointments.write');
    const a = get('SELECT * FROM appointments WHERE id=?', params.id);
    if (!a) throw notFound();
    setAppointmentStatus(a.id, 'cancelled', user.id);
    return { ok: true };
  });

  // Calendar feed: appointments + tasks in one list (§19)
  router.get('/api/calendar', ({ req, query }) => {
    const user = requireUser(req);
    const from = query.from || plusMinutes(-7 * 1440);
    const to = query.to || plusMinutes(30 * 1440);
    const appts = all(
      `SELECT a.id, a.start_at, a.end_at, a.status, a.branch, a.lead_id,
              l.first_name, l.last_name, t.name_he AS treatment_he, t.color AS treatment_color,
              d.name AS doctor_name
       FROM appointments a JOIN leads l ON l.id=a.lead_id
       LEFT JOIN treatments t ON t.id=a.treatment_id
       LEFT JOIN users d ON d.id=a.doctor_id
       WHERE a.start_at BETWEEN ? AND ? AND a.status != 'cancelled'`, from, to,
    ).map((a) => ({
      kind: 'appointment',
      id: a.id,
      lead_id: a.lead_id,
      title: `${a.treatment_he || 'תור'} — ${a.first_name} ${a.last_name}`,
      start_at: a.start_at,
      end_at: a.end_at,
      color: a.treatment_color || '#0ea5e9',
      status: a.status,
      doctor: a.doctor_name,
      branch: a.branch,
    }));
    const taskWhere = can(user, 'tasks.all') ? '' : 'AND t.user_id = ?';
    const tp = can(user, 'tasks.all') ? [] : [user.id];
    const tasks = all(
      `SELECT t.id, t.title, t.due_at, t.priority, t.done_at, t.lead_id, l.first_name, l.last_name
       FROM tasks t LEFT JOIN leads l ON l.id=t.lead_id
       WHERE t.due_at BETWEEN ? AND ? ${taskWhere}`, from, to, ...tp,
    ).map((t) => ({
      kind: 'task',
      id: t.id,
      lead_id: t.lead_id,
      title: `${t.title}${t.first_name ? ` — ${t.first_name} ${t.last_name}` : ''}`,
      start_at: t.due_at,
      end_at: t.due_at,
      color: t.priority === 'urgent' ? '#ef4444' : '#a855f7',
      done: !!t.done_at,
    }));
    return [...appts, ...tasks].sort((a, b) => a.start_at.localeCompare(b.start_at));
  });

  // -------------------------------------------------------------------------
  // Unified inbox (§10)
  // -------------------------------------------------------------------------
  router.get('/api/inbox', ({ req, query }) => {
    const user = requireUser(req);
    const where = [];
    const params = [];
    if (query.channel && query.channel !== 'all') { where.push('m.channel = ?'); params.push(query.channel); }
    if (query.unread === '1') where.push("m.direction='in' AND m.read_at IS NULL");
    if (!can(user, 'inbox.all')) { where.push('l.owner_id = ?'); params.push(user.id); }

    // one row per lead+channel — the latest message in that thread
    const rows = all(
      `SELECT m.*, l.first_name, l.last_name, l.phone_norm, l.temperature, l.status_key, l.owner_id,
              u.name AS owner_name, s.color AS status_color, s.name_he AS status_he,
              (SELECT COUNT(*) FROM messages x WHERE x.lead_id=m.lead_id AND x.channel=m.channel
                 AND x.direction='in' AND x.read_at IS NULL) AS unread
       FROM messages m
       JOIN leads l ON l.id = m.lead_id
       LEFT JOIN users u ON u.id = l.owner_id
       LEFT JOIN statuses s ON s.key = l.status_key
       WHERE m.id IN (SELECT MAX(id) FROM messages GROUP BY lead_id, channel)
         ${where.length ? 'AND ' + where.join(' AND ') : ''}
       ORDER BY m.created_at DESC LIMIT ?`, ...params, Math.min(Number(query.limit || 100), 300),
    );
    return rows.map((r) => ({
      ...r,
      media: parseJson(r.media, null),
      full_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      preview: (r.body || '').slice(0, 140),
    }));
  });

  router.get('/api/inbox/counts', ({ req }) => {
    const user = requireUser(req);
    const scope = can(user, 'inbox.all') ? '' : 'AND l.owner_id = ' + Number(user.id);
    return get(
      `SELECT
        (SELECT COUNT(*) FROM messages m JOIN leads l ON l.id=m.lead_id
          WHERE m.direction='in' AND m.read_at IS NULL ${scope}) AS unread,
        (SELECT COUNT(*) FROM messages m JOIN leads l ON l.id=m.lead_id
          WHERE m.direction='in' AND m.read_at IS NULL AND m.channel='whatsapp' ${scope}) AS whatsapp,
        (SELECT COUNT(*) FROM messages m JOIN leads l ON l.id=m.lead_id
          WHERE m.direction='in' AND m.read_at IS NULL AND m.channel='email' ${scope}) AS email,
        (SELECT COUNT(*) FROM messages m JOIN leads l ON l.id=m.lead_id
          WHERE m.direction='in' AND m.read_at IS NULL AND m.channel IN ('facebook','instagram') ${scope}) AS social`,
    );
  });

  router.post('/api/messages/:id/read', ({ req, params }) => {
    requireUser(req);
    run('UPDATE messages SET read_at=? WHERE id=? AND read_at IS NULL', nowIso(), params.id);
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Notifications (§39)
  // -------------------------------------------------------------------------
  router.get('/api/notifications', ({ req, query }) => {
    const user = requireUser(req);
    const unreadOnly = query.unread === '1' ? 'AND n.read_at IS NULL' : '';
    const rows = all(
      `SELECT n.*, l.first_name, l.last_name FROM notifications n
       LEFT JOIN leads l ON l.id = n.lead_id
       WHERE n.user_id = ? ${unreadOnly}
       ORDER BY n.id DESC LIMIT ?`, user.id, Math.min(Number(query.limit || 50), 200),
    );
    const unread = get('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL', user.id).n;
    return { rows, unread };
  });

  router.post('/api/notifications/read', ({ req, body }) => {
    const user = requireUser(req);
    if (body.id) run('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?', nowIso(), body.id, user.id);
    else run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', nowIso(), user.id);
    return { ok: true };
  });
}

function shapeTask(t) {
  if (!t) return null;
  return {
    ...t,
    done: !!t.done_at,
    overdue: !t.done_at && t.due_at < nowIso(),
    full_name: `${t.first_name || ''} ${t.last_name || ''}`.trim(),
  };
}
