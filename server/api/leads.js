// Leads / Customer-360 API (spec §3, §6–§13, §22–§24, §27–§31, §44–§46)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, get, run, insert, update, setting, UPLOAD_DIR } from '../db.js';
import { bad, forbidden, notFound, readBody, parseMultipart, sendJson } from '../lib/http.js';
import { requireUser, requirePerm, can, leadScopeSql, assertLeadAccess } from '../lib/auth.js';
import {
  nowIso, addEvent, audit, notify, normalizePhone, prettyPhone, parseJson, recomputeScore,
  nextBestAction, summarizeCall, token, minutesBetween, renderTemplate, leadVars,
} from '../lib/util.js';
import {
  changeStatus, assignLead, sendWhatsapp, sendEmail, receiveMessage, intakeLead,
  resolveTreatments, leadName, createTask, runAutomations,
} from '../lib/services.js';
import { MESSAGE_KINDS, CHANNEL_LABEL, clinicConfig } from '../lib/clinic.js';

const SORTS = {
  created_desc: 'l.created_at DESC',
  created_asc: 'l.created_at ASC',
  updated_desc: 'l.updated_at DESC',
  score_desc: 'l.score DESC',
  next_action: 'l.next_action_at IS NULL, l.next_action_at ASC',
  name: 'l.first_name, l.last_name',
};

function buildFilters(user, q) {
  const where = [];
  const params = [];
  const scope = leadScopeSql(user, 'l');
  where.push(`(${scope.sql})`);
  params.push(...scope.params);
  where.push('l.archived = ?');
  params.push(q.archived === '1' ? 1 : 0);

  if (q.q) {
    const raw = String(q.q).trim();
    const term = `%${raw}%`;
    // Phone search must survive formatting differences: 050-123, 0501234567, +97250...
    const digits = raw.replace(/\D/g, '');
    const local = digits.replace(/^972/, '').replace(/^0/, '');
    const phoneClause = digits.length >= 5 ? ' OR l.phone_norm LIKE ?' : '';
    where.push(`(l.first_name LIKE ? OR l.last_name LIKE ? OR (l.first_name || ' ' || l.last_name) LIKE ?
      OR l.phone LIKE ? OR l.phone_norm LIKE ? OR l.email LIKE ? OR l.city LIKE ?
      OR CAST(l.id AS TEXT) = ?${phoneClause}
      OR EXISTS (SELECT 1 FROM lead_treatments lt JOIN treatments t ON t.id=lt.treatment_id
                 WHERE lt.lead_id=l.id AND (t.name_he LIKE ? OR t.name_ar LIKE ? OR t.name_en LIKE ?)))`);
    params.push(term, term, term, term, term, term, term, raw);
    if (phoneClause) params.push(`%${local}`);
    params.push(term, term, term);
  }
  if (q.status) {
    const list = String(q.status).split(',').filter(Boolean);
    where.push(`l.status_key IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (q.stage) {
    const list = String(q.stage).split(',').filter(Boolean);
    where.push(`EXISTS (SELECT 1 FROM statuses s WHERE s.key=l.status_key AND s.stage IN (${list.map(() => '?').join(',')}))`);
    params.push(...list);
  }
  if (q.owner) {
    if (q.owner === 'none') where.push('l.owner_id IS NULL');
    else {
      const list = String(q.owner).split(',').filter(Boolean);
      where.push(`l.owner_id IN (${list.map(() => '?').join(',')})`);
      params.push(...list.map(Number));
    }
  }
  if (q.source) {
    const list = String(q.source).split(',').filter(Boolean);
    where.push(`l.source IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (q.campaign) {
    where.push('l.campaign_name = ?');
    params.push(q.campaign);
  }
  if (q.temperature) {
    const list = String(q.temperature).split(',').filter(Boolean);
    where.push(`l.temperature IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (q.treatment) {
    const list = String(q.treatment).split(',').map(Number).filter(Boolean);
    if (list.length) {
      where.push(`EXISTS (SELECT 1 FROM lead_treatments lt WHERE lt.lead_id=l.id
                  AND lt.treatment_id IN (${list.map(() => '?').join(',')}))`);
      params.push(...list);
    }
  }
  if (q.created_from) { where.push('l.created_at >= ?'); params.push(q.created_from); }
  if (q.created_to) { where.push('l.created_at <= ?'); params.push(q.created_to); }
  if (q.due_from) { where.push('l.next_action_at >= ?'); params.push(q.due_from); }
  if (q.due_to) { where.push('l.next_action_at <= ?'); params.push(q.due_to); }
  if (q.arrived === '1') where.push('l.arrived_at IS NOT NULL');
  if (q.arrived === '0') where.push('l.arrived_at IS NULL');
  if (q.untouched === '1') where.push('l.first_response_at IS NULL');
  if (q.overdue === '1') { where.push('l.next_action_at IS NOT NULL AND l.next_action_at < ?'); params.push(nowIso()); }
  if (q.stale_hours) {
    where.push("COALESCE(l.last_contact_at, l.created_at) <= datetime('now', ?)");
    params.push(`-${Number(q.stale_hours)} hours`);
  }
  return { where: where.join(' AND '), params };
}

const LIST_SELECT = `
  SELECT l.*, u.name AS owner_name, u.color AS owner_color,
         s.name_he AS status_he, s.name_ar AS status_ar, s.name_en AS status_en,
         s.color AS status_color, s.stage AS status_stage,
         (SELECT GROUP_CONCAT(t.id) FROM lead_treatments lt JOIN treatments t ON t.id=lt.treatment_id
           WHERE lt.lead_id=l.id) AS treatment_ids,
         (SELECT GROUP_CONCAT(t.name_he, ' + ') FROM lead_treatments lt JOIN treatments t ON t.id=lt.treatment_id
           WHERE lt.lead_id=l.id) AS treatments_he,
         (SELECT COUNT(*) FROM messages m WHERE m.lead_id=l.id AND m.direction='in' AND m.read_at IS NULL) AS unread,
         (SELECT MIN(a.start_at) FROM appointments a WHERE a.lead_id=l.id AND a.status IN ('scheduled','confirmed')
            AND a.start_at > datetime('now')) AS next_appointment
  FROM leads l
  LEFT JOIN users u ON u.id = l.owner_id
  LEFT JOIN statuses s ON s.key = l.status_key
`;

export default function register(router) {
  // -------------------------------------------------------------------------
  // List / search / filters (§3, §28, §29)
  // -------------------------------------------------------------------------
  router.get('/api/leads', ({ req, query }) => {
    const user = requireUser(req);
    const { where, params } = buildFilters(user, query);
    const limit = Math.min(Number(query.limit || 50), 200);
    const offset = Number(query.offset || 0);
    const order = SORTS[query.sort] || SORTS.created_desc;
    const rows = all(`${LIST_SELECT} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset);
    const total = get(`SELECT COUNT(*) AS n FROM leads l WHERE ${where}`, ...params).n;
    return { rows: rows.map(shapeLead), total, limit, offset };
  });

  // Kanban board grouped by status (§3)
  router.get('/api/leads/kanban', ({ req, query }) => {
    const user = requireUser(req);
    const { where, params } = buildFilters(user, query);
    const statuses = all('SELECT * FROM statuses WHERE active=1 AND in_kanban=1 ORDER BY sort, id');
    const perColumn = Math.min(Number(query.per_column || 40), 100);
    const columns = statuses.map((s) => {
      const rows = all(
        `${LIST_SELECT} WHERE ${where} AND l.status_key = ? ORDER BY l.updated_at DESC LIMIT ?`,
        ...params, s.key, perColumn,
      );
      const total = get(`SELECT COUNT(*) AS n FROM leads l WHERE ${where} AND l.status_key = ?`, ...params, s.key).n;
      return { status: s, total, rows: rows.map(shapeLead) };
    });
    // statuses not shown as a column but still holding leads land in "other"
    return { columns };
  });

  // -------------------------------------------------------------------------
  // Create (§6) — goes through the same intake path as the webhooks (dedupe)
  // -------------------------------------------------------------------------
  router.post('/api/leads', ({ req, body, ip }) => {
    const user = requireUser(req);
    requirePerm(user, 'leads.write');
    if (!body.phone && !body.email) throw bad('נדרש טלפון או אימייל');
    const result = intakeLead(
      { ...body, owner_id: body.owner_id ?? (can(user, 'leads.assign') ? body.owner_id : user.id) },
      { source: body.source || 'manual', actorId: user.id },
    );
    audit(user.id, 'lead', result.lead.id, result.duplicate ? 'duplicate_merged' : 'create', body.phone, ip);
    return { ...result, lead: fullLead(result.lead.id, user) };
  });

  // Duplicate pre-check for the "new lead" form (§27)
  router.get('/api/leads/check', ({ req, query }) => {
    requireUser(req);
    const phone = normalizePhone(query.phone, setting('clinic', {})?.country_code || '972');
    if (!phone) return { exists: false };
    const lead = get('SELECT * FROM leads WHERE phone_norm=?', phone);
    if (!lead) return { exists: false };
    const days = Math.floor((Date.now() - new Date(lead.created_at).getTime()) / 86400000);
    return {
      exists: true,
      lead: shapeLead(get(`${LIST_SELECT} WHERE l.id=?`, lead.id)),
      days_ago: days,
      message: `הלקוח נמצא במערכת מלפני ${days} ימים.`,
    };
  });

  // -------------------------------------------------------------------------
  // Customer 360 (§6)
  // -------------------------------------------------------------------------
  router.get('/api/leads/:id', ({ req, params }) => {
    const user = requireUser(req);
    return fullLead(Number(params.id), user);
  });

  router.patch('/api/leads/:id', ({ req, params, body, ip }) => {
    const user = requireUser(req);
    requirePerm(user, 'leads.write');
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    if (!lead) throw notFound('lead');
    assertLeadAccess(user, lead);

    const patch = { updated_at: nowIso() };
    for (const k of ['first_name', 'last_name', 'email', 'language', 'city', 'gender', 'birth_date',
      'campaign_name', 'ad_name', 'ad_set', 'utm_source', 'utm_campaign', 'utm_medium', 'utm_content',
      'landing_page', 'source', 'temperature']) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    if (body.phone !== undefined) {
      patch.phone = body.phone;
      patch.phone_norm = normalizePhone(body.phone, setting('clinic', {})?.country_code || '972');
    }
    if (body.whatsapp !== undefined) patch.whatsapp = normalizePhone(body.whatsapp);
    if (body.do_not_contact !== undefined) patch.do_not_contact = body.do_not_contact ? 1 : 0;
    if (body.archived !== undefined) patch.archived = body.archived ? 1 : 0;
    update('leads', lead.id, patch);

    if (Array.isArray(body.treatment_ids)) {
      run('DELETE FROM lead_treatments WHERE lead_id=?', lead.id);
      for (const tid of body.treatment_ids) {
        run('INSERT OR IGNORE INTO lead_treatments(lead_id,treatment_id) VALUES(?,?)', lead.id, Number(tid));
      }
    }
    if (body.status_key && body.status_key !== lead.status_key) changeStatus(lead.id, body.status_key, user.id);
    if (body.owner_id !== undefined && Number(body.owner_id) !== lead.owner_id) {
      requirePerm(user, can(user, 'leads.assign') ? 'leads.assign' : 'leads.write');
      assignLead(lead.id, body.owner_id ? Number(body.owner_id) : null, user.id);
    }
    audit(user.id, 'lead', lead.id, 'update', Object.keys(patch).join(','), ip);
    recomputeScore(lead.id);
    return fullLead(lead.id, user);
  });

  router.delete('/api/leads/:id', ({ req, params, ip }) => {
    const user = requireUser(req);
    requirePerm(user, 'leads.delete');
    run('UPDATE leads SET archived=1, updated_at=? WHERE id=?', nowIso(), params.id);
    audit(user.id, 'lead', Number(params.id), 'archive', null, ip);
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Timeline (§8)
  // -------------------------------------------------------------------------
  router.get('/api/leads/:id/timeline', ({ req, params, query }) => {
    const user = requireUser(req);
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    if (!lead) throw notFound('lead');
    assertLeadAccess(user, lead);
    const limit = Math.min(Number(query.limit || 200), 500);
    return all(
      `SELECT e.*, u.name AS actor_name, u.color AS actor_color FROM events e
       LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.lead_id=? ORDER BY e.id DESC LIMIT ?`, lead.id, limit,
    ).map((e) => ({ ...e, meta: parseJson(e.meta, null) }));
  });

  // -------------------------------------------------------------------------
  // Status / assignment / temperature
  // -------------------------------------------------------------------------
  router.post('/api/leads/:id/status', ({ req, params, body, ip }) => {
    const user = requireUser(req);
    requirePerm(user, 'leads.write');
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    assertLeadAccess(user, lead);
    const updated = changeStatus(lead.id, body.status_key, user.id);
    audit(user.id, 'lead', lead.id, 'status', `${lead.status_key} → ${body.status_key}`, ip);
    return fullLead(updated.id, user);
  });

  router.post('/api/leads/:id/assign', ({ req, params, body, ip }) => {
    const user = requireUser(req);
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    if (!lead) throw notFound('lead');
    if (!can(user, 'leads.assign') && lead.owner_id !== user.id) throw forbidden();
    assignLead(lead.id, body.user_id ? Number(body.user_id) : null, user.id);
    audit(user.id, 'lead', lead.id, 'assign', String(body.user_id ?? 'none'), ip);
    return fullLead(lead.id, user);
  });

  router.post('/api/leads/:id/temperature', ({ req, params, body }) => {
    const user = requireUser(req);
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    assertLeadAccess(user, lead);
    if (!['hot', 'warm', 'cold'].includes(body.temperature)) throw bad('invalid temperature');
    update('leads', lead.id, { temperature: body.temperature, updated_at: nowIso() });
    addEvent(lead.id, 'note', `דירוג הליד שונה ל-${body.temperature}`, { actorId: user.id });
    return { ok: true, temperature: body.temperature };
  });

  // -------------------------------------------------------------------------
  // Internal notes + @mentions (§44, §45)
  // -------------------------------------------------------------------------
  router.post('/api/leads/:id/notes', ({ req, params, body }) => {
    const user = requireUser(req);
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    if (!lead) throw notFound('lead');
    assertLeadAccess(user, lead);
    const text = String(body.body || '').trim();
    if (!text) throw bad('הערה ריקה');
    const eventId = addEvent(lead.id, 'note', 'הערה פנימית', { actorId: user.id, body: text });

    // @mentions — match by user name or the local part of the email
    const users = all('SELECT id, name, email FROM users WHERE active=1');
    const mentioned = new Set();
    for (const m of text.matchAll(/@([\p{L}\w.'-]+)/gu)) {
      const needle = m[1].toLowerCase();
      const hit = users.find(
        (u) => u.name.toLowerCase().startsWith(needle) || u.email.split('@')[0].toLowerCase() === needle,
      );
      if (hit && !mentioned.has(hit.id)) {
        mentioned.add(hit.id);
        insert('mentions', { event_id: eventId, user_id: hit.id, lead_id: lead.id });
        notify(hit.id, {
          type: 'mention',
          title: `${user.name} תייג/ה אותך`,
          body: text.slice(0, 140),
          leadId: lead.id,
          level: 'warn',
        });
      }
    }
    return { ok: true, event_id: eventId, mentioned: [...mentioned] };
  });

  // -------------------------------------------------------------------------
  // Calls (§13–§15)
  // -------------------------------------------------------------------------
  router.get('/api/leads/:id/calls', ({ req, params }) => {
    const user = requireUser(req);
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    assertLeadAccess(user, lead);
    return all(
      `SELECT c.*, u.name AS user_name FROM calls c LEFT JOIN users u ON u.id=c.user_id
       WHERE c.lead_id=? ORDER BY c.id DESC`, lead.id,
    );
  });

  router.post('/api/leads/:id/calls', ({ req, params, body }) => {
    const user = requireUser(req);
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    if (!lead) throw notFound('lead');
    assertLeadAccess(user, lead);
    const outcomes = ['answered', 'no_answer', 'busy', 'wrong_number', 'call_back', 'appointment', 'not_interested'];
    if (!outcomes.includes(body.outcome)) throw bad('invalid outcome');

    const ai = body.summary ? summarizeCall(body.summary, lead) : null;
    const id = insert('calls', {
      lead_id: lead.id,
      user_id: user.id,
      direction: body.direction === 'in' ? 'in' : 'out',
      outcome: body.outcome,
      duration_sec: Number(body.duration_sec || 0),
      summary: body.summary || null,
      ai_summary: ai ? JSON.stringify(ai) : null,
      recording_url: body.recording_url || null,
    });
    addEvent(lead.id, 'call', `בוצעה שיחה — ${labelOutcome(body.outcome)}${
      body.duration_sec ? ` (${fmtDuration(body.duration_sec)})` : ''}`, {
      actorId: user.id, body: body.summary || null, meta: { call_id: id, outcome: body.outcome },
    });

    const patch = { last_contact_at: nowIso(), updated_at: nowIso() };
    if (!lead.first_response_at) patch.first_response_at = nowIso();
    update('leads', lead.id, patch);

    // Map the call outcome onto the pipeline status
    const statusMap = {
      no_answer: nextAttemptStatus(lead),
      busy: nextAttemptStatus(lead),
      wrong_number: 'wrong_number',
      call_back: 'call_back',
      not_interested: 'not_interested',
      answered: ['new', 'no_answer', 'attempt_1', 'attempt_2', 'attempt_3'].includes(lead.status_key)
        ? 'contacted' : null,
    };
    const nextStatus = body.status_key || statusMap[body.outcome];
    if (nextStatus) changeStatus(lead.id, nextStatus, user.id);
    if (body.outcome === 'no_answer') runAutomations('no_answer', lead.id, {});

    if (body.follow_up_at) {
      createTask(lead.id, {
        title: body.follow_up_title || 'חזרה ללקוח',
        dueAt: new Date(body.follow_up_at).toISOString(),
        userId: user.id,
        createdBy: user.id,
        note: body.summary || null,
      });
    }
    recomputeScore(lead.id);
    return { call: get('SELECT * FROM calls WHERE id=?', id), ai, lead: fullLead(lead.id, user) };
  });

  // Local "AI" summary of free text (§15)
  router.post('/api/leads/:id/ai-summary', ({ req, params, body }) => {
    const user = requireUser(req);
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    assertLeadAccess(user, lead);
    return summarizeCall(body.text || '', lead);
  });

  router.get('/api/leads/:id/next-action', ({ req, params }) => {
    const user = requireUser(req);
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    assertLeadAccess(user, lead);
    return nextBestAction(lead.id);
  });

  // -------------------------------------------------------------------------
  // Messages: WhatsApp + Email (§9–§12)
  // -------------------------------------------------------------------------
  router.get('/api/leads/:id/messages', ({ req, params, query }) => {
    const user = requireUser(req);
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    if (!lead) throw notFound('lead');
    assertLeadAccess(user, lead);
    const where = query.channel ? 'AND m.channel=?' : '';
    const params2 = query.channel ? [query.channel] : [];
    const rows = all(
      `SELECT m.*, u.name AS user_name FROM messages m LEFT JOIN users u ON u.id=m.user_id
       WHERE m.lead_id=? ${where} ORDER BY m.id ASC`, lead.id, ...params2,
    );
    run("UPDATE messages SET read_at=? WHERE lead_id=? AND direction='in' AND read_at IS NULL", nowIso(), lead.id);
    return rows.map((m) => ({ ...m, media: parseJson(m.media, null) }));
  });

  router.post('/api/leads/:id/whatsapp', async ({ req, params, body }) => {
    const user = requireUser(req);
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    if (!lead) throw notFound('lead');
    assertLeadAccess(user, lead);
    const msg = await sendWhatsapp(lead.id, {
      body: body.body,
      templateKey: body.template_key,
      media: body.media || null,
      userId: user.id,
    });
    return { message: msg };
  });

  router.post('/api/leads/:id/email', async ({ req, params, body }) => {
    const user = requireUser(req);
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    if (!lead) throw notFound('lead');
    assertLeadAccess(user, lead);
    const msg = await sendEmail(lead.id, {
      subject: body.subject,
      body: body.body,
      templateKey: body.template_key,
      media: body.media || null,
      userId: user.id,
    });
    return { message: msg };
  });

  // Preview a template with this lead's variables filled in
  router.get('/api/leads/:id/template/:tplId', ({ req, params }) => {
    const user = requireUser(req);
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    assertLeadAccess(user, lead);
    const tpl = get('SELECT * FROM templates WHERE id=?', params.tplId);
    if (!tpl) throw notFound('template');
    const vars = leadVars(lead);
    return {
      subject: tpl.subject ? renderTemplate(tpl.subject, vars) : null,
      body: renderTemplate(tpl.body, vars),
    };
  });

  // -------------------------------------------------------------------------
  // Clinic info: location / digital card / full details / appointment details
  // Spec §2–§9, §13 — every send is logged to the timeline with actor + channel.
  // -------------------------------------------------------------------------
  router.get('/api/leads/:id/clinic-message', ({ req, params, query }) => {
    const user = requireUser(req);
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    if (!lead) throw notFound('lead');
    assertLeadAccess(user, lead);
    const kind = MESSAGE_KINDS[query.kind];
    if (!kind) throw bad('unknown message kind');
    const appt = query.appointment_id
      ? get('SELECT * FROM appointments WHERE id=? AND lead_id=?', query.appointment_id, lead.id)
      : get(`SELECT * FROM appointments WHERE lead_id=? AND status IN ('scheduled','confirmed')
             AND start_at > ? ORDER BY start_at LIMIT 1`, lead.id, nowIso());
    // A reminder without an appointment would be an empty shell — say so instead.
    if (query.kind === 'appointment' && !appt) throw bad('אין פגישה עתידית לשליחת תזכורת');
    return {
      kind: query.kind,
      subject: kind.subject,
      body: kind.build(lead, appt),
      clinic: clinicConfig(),
      appointment: appt || null,
    };
  });

  router.post('/api/leads/:id/clinic-send', async ({ req, params, body }) => {
    const user = requireUser(req);
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    if (!lead) throw notFound('lead');
    assertLeadAccess(user, lead);

    const kind = MESSAGE_KINDS[body.kind];
    if (!kind) throw bad('unknown message kind');
    const channel = body.channel || 'whatsapp';
    if (!CHANNEL_LABEL[channel]) throw bad('unknown channel');

    const appt = body.appointment_id
      ? get('SELECT * FROM appointments WHERE id=? AND lead_id=?', body.appointment_id, lead.id)
      : get(`SELECT * FROM appointments WHERE lead_id=? AND status IN ('scheduled','confirmed')
             AND start_at > ? ORDER BY start_at LIMIT 1`, lead.id, nowIso());
    if (body.kind === 'appointment' && !appt) throw bad('אין פגישה עתידית לשליחת תזכורת');
    // The agent may edit the text before sending (spec §6).
    const text = (body.body && String(body.body).trim()) || kind.build(lead, appt);
    const subject = body.subject || kind.subject;

    let message = null;
    if (channel === 'whatsapp') {
      message = await sendWhatsapp(lead.id, { body: text, userId: user.id });
    } else if (channel === 'email') {
      message = await sendEmail(lead.id, { subject, body: text, userId: user.id });
    } else if (channel === 'sms') {
      // No SMS gateway is configured; the message is recorded so the history stays complete.
      const id = insert('messages', {
        lead_id: lead.id, channel: 'sms', direction: 'out', user_id: user.id,
        body: text, status: 'sent',
      });
      message = get('SELECT * FROM messages WHERE id=?', id);
      run('UPDATE leads SET last_contact_at=?, updated_at=? WHERE id=?', nowIso(), nowIso(), lead.id);
    }

    // §4 + §13 — one clear timeline entry: what was sent, through which channel, by whom
    addEvent(lead.id, kind.event,
      `${kind.icon} ${kind.label} ${channel === 'copy' ? 'הועתק ללוח' : `נשלח ללקוח באמצעות ${CHANNEL_LABEL[channel]}`}`, {
        actorId: user.id,
        body: channel === 'copy' ? null : text,
        meta: { kind: body.kind, channel, appointment_id: appt?.id || null, message_id: message?.id || null },
      });
    audit(user.id, 'lead', lead.id, `send_${body.kind}`, channel);
    recomputeScore(lead.id);
    return { ok: true, message, channel, kind: body.kind };
  });

  // Simulate an inbound customer reply — lets the whole flow be demoed offline
  router.post('/api/leads/:id/simulate-reply', ({ req, params, body }) => {
    const user = requireUser(req);
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    if (!lead) throw notFound('lead');
    assertLeadAccess(user, lead);
    return receiveMessage(lead.id, {
      channel: body.channel || 'whatsapp',
      body: body.body || 'תודה, אשמח לפרטים',
    });
  });

  // -------------------------------------------------------------------------
  // Documents (§46)
  // -------------------------------------------------------------------------
  router.get('/api/leads/:id/documents', ({ req, params }) => {
    const user = requireUser(req);
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    assertLeadAccess(user, lead);
    return all(
      `SELECT d.*, u.name AS uploaded_by_name FROM documents d LEFT JOIN users u ON u.id=d.uploaded_by
       WHERE d.lead_id=? ORDER BY d.id DESC`, lead.id,
    ).map((d) => ({ ...d, url: `/files/${d.stored_name}` }));
  });

  router.post('/api/leads/:id/documents', async ({ req, res, params }) => {
    const user = requireUser(req);
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    if (!lead) throw notFound('lead');
    assertLeadAccess(user, lead);
    const buf = await readBody(req);
    const { fields, files } = parseMultipart(buf, req.headers['content-type']);
    const saved = [];
    for (const f of files) {
      const ext = (f.filename.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
      const stored = `${lead.id}_${token(8)}${ext}`;
      writeFileSync(join(UPLOAD_DIR, stored), f.data);
      const id = insert('documents', {
        lead_id: lead.id,
        name: f.filename,
        stored_name: stored,
        mime: f.mime,
        size: f.data.length,
        kind: fields.kind || 'other',
        uploaded_by: user.id,
      });
      addEvent(lead.id, 'document', `הועלה מסמך: ${f.filename}`, { actorId: user.id, meta: { document_id: id } });
      saved.push({ id, name: f.filename, url: `/files/${stored}`, size: f.data.length, mime: f.mime });
    }
    sendJson(res, 200, { files: saved });
  });

  router.delete('/api/documents/:id', ({ req, params }) => {
    const user = requireUser(req);
    const doc = get('SELECT * FROM documents WHERE id=?', params.id);
    if (!doc) throw notFound();
    const lead = get('SELECT * FROM leads WHERE id=?', doc.lead_id);
    assertLeadAccess(user, lead);
    run('DELETE FROM documents WHERE id=?', doc.id);
    addEvent(doc.lead_id, 'document', `נמחק מסמך: ${doc.name}`, { actorId: user.id });
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Deals / revenue (§24)
  // -------------------------------------------------------------------------
  router.get('/api/leads/:id/deals', ({ req, params }) => {
    const user = requireUser(req);
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    assertLeadAccess(user, lead);
    return dealsFor(lead.id);
  });

  router.post('/api/leads/:id/deals', ({ req, params, body }) => {
    const user = requireUser(req);
    requirePerm(user, 'deals.write');
    const lead = get('SELECT * FROM leads WHERE id=?', params.id);
    if (!lead) throw notFound('lead');
    assertLeadAccess(user, lead);
    const id = insert('deals', {
      lead_id: lead.id,
      treatment_id: body.treatment_id ?? null,
      title: body.title || null,
      amount: Number(body.amount || 0),
      paid: Number(body.paid || 0),
      currency: body.currency || 'ILS',
      stage: body.stage || 'quoted',
      due_date: body.due_date || null,
      created_by: user.id,
    });
    if (Number(body.paid || 0) > 0) {
      insert('payments', { deal_id: id, amount: Number(body.paid), method: body.method || null, created_by: user.id });
    }
    addEvent(lead.id, 'payment', `נוצרה עסקה: ₪${Number(body.amount || 0).toLocaleString('he-IL')}`, {
      actorId: user.id, meta: { deal_id: id },
    });
    return dealsFor(lead.id);
  });

  router.patch('/api/deals/:id', ({ req, params, body }) => {
    const user = requireUser(req);
    requirePerm(user, 'deals.write');
    const deal = get('SELECT * FROM deals WHERE id=?', params.id);
    if (!deal) throw notFound();
    const patch = {};
    for (const k of ['title', 'amount', 'stage', 'due_date', 'treatment_id']) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    if (body.add_payment) {
      const amt = Number(body.add_payment);
      insert('payments', { deal_id: deal.id, amount: amt, method: body.method || null, created_by: user.id });
      patch.paid = (deal.paid || 0) + amt;
      addEvent(deal.lead_id, 'payment', `התקבל תשלום: ₪${amt.toLocaleString('he-IL')}`, { actorId: user.id });
    } else if (body.paid !== undefined) {
      patch.paid = Number(body.paid);
    }
    update('deals', deal.id, patch);
    return dealsFor(deal.lead_id);
  });

  router.delete('/api/deals/:id', ({ req, params }) => {
    const user = requireUser(req);
    requirePerm(user, 'deals.write');
    const deal = get('SELECT * FROM deals WHERE id=?', params.id);
    if (!deal) throw notFound();
    run('DELETE FROM deals WHERE id=?', deal.id);
    return dealsFor(deal.lead_id);
  });
}

// ---------------------------------------------------------------------------
// Shaping helpers
// ---------------------------------------------------------------------------
function shapeLead(r) {
  if (!r) return null;
  return {
    ...r,
    phone_pretty: prettyPhone(r.phone_norm || r.phone),
    full_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
    treatment_ids: r.treatment_ids ? String(r.treatment_ids).split(',').map(Number) : [],
    do_not_contact: !!r.do_not_contact,
    archived: !!r.archived,
  };
}

export function fullLead(id, user) {
  const row = get(`${LIST_SELECT} WHERE l.id=?`, id);
  if (!row) throw notFound('lead');
  assertLeadAccess(user, row);
  const lead = shapeLead(row);
  const respMin = lead.first_response_at ? minutesBetween(lead.created_at, lead.first_response_at) : null;
  return {
    ...lead,
    response_time_min: respMin == null ? null : Math.round(respMin),
    submissions: all('SELECT * FROM lead_submissions WHERE lead_id=? ORDER BY id DESC', id)
      .map((s) => ({ ...s, utm: parseJson(s.utm, {}), payload: parseJson(s.payload, {}) })),
    appointments: all(
      `SELECT a.*, t.name_he AS treatment_he, d.name AS doctor_name FROM appointments a
       LEFT JOIN treatments t ON t.id=a.treatment_id
       LEFT JOIN users d ON d.id=a.doctor_id
       WHERE a.lead_id=? ORDER BY a.start_at DESC`, id,
    ),
    tasks: all(
      `SELECT t.*, u.name AS user_name FROM tasks t LEFT JOIN users u ON u.id=t.user_id
       WHERE t.lead_id=? ORDER BY t.done_at IS NOT NULL, t.due_at`, id,
    ),
    deals: dealsFor(id),
    documents: all('SELECT * FROM documents WHERE lead_id=? ORDER BY id DESC', id)
      .map((d) => ({ ...d, url: `/files/${d.stored_name}` })),
    counts: get(
      `SELECT
        (SELECT COUNT(*) FROM calls WHERE lead_id=?) AS calls,
        (SELECT COUNT(*) FROM messages WHERE lead_id=? AND channel='whatsapp') AS whatsapp,
        (SELECT COUNT(*) FROM messages WHERE lead_id=? AND channel='email') AS emails,
        (SELECT COUNT(*) FROM messages WHERE lead_id=? AND direction='in' AND read_at IS NULL) AS unread`,
      id, id, id, id,
    ),
    next_best_action: nextBestAction(id),
  };
}

function dealsFor(leadId) {
  const rows = all(
    `SELECT d.*, t.name_he AS treatment_he FROM deals d LEFT JOIN treatments t ON t.id=d.treatment_id
     WHERE d.lead_id=? ORDER BY d.id DESC`, leadId,
  );
  return rows.map((d) => ({
    ...d,
    balance: (d.amount || 0) - (d.paid || 0),
    payments: all('SELECT * FROM payments WHERE deal_id=? ORDER BY id', d.id),
  }));
}

function nextAttemptStatus(lead) {
  const order = ['no_answer', 'attempt_1', 'attempt_2', 'attempt_3'];
  const i = order.indexOf(lead.status_key);
  if (i < 0) return 'no_answer';
  return order[Math.min(i + 1, order.length - 1)];
}

const OUTCOME_HE = {
  answered: 'ענה', no_answer: 'לא ענה', busy: 'תפוס', wrong_number: 'מספר שגוי',
  call_back: 'לחזור מאוחר יותר', appointment: 'נקבע תור', not_interested: 'לא מעוניין',
};
const labelOutcome = (o) => OUTCOME_HE[o] || o;
const fmtDuration = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
