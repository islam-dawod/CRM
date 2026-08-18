// Shared business logic — used by the REST API, the webhooks and the automation engine.
import { all, get, run, insert, update, setting, setSetting } from '../db.js';
import {
  nowIso, plusMinutes, normalizePhone, addEvent, notify, notifyManagers,
  renderTemplate, leadVars, recomputeScore, token, parseJson, prettyPhone,
} from './util.js';
import { bad, notFound } from './http.js';

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------
export const statusByKey = (key) => get('SELECT * FROM statuses WHERE key=?', key);
export const leadById = (id) => get('SELECT * FROM leads WHERE id=?', id);

export function leadName(lead) {
  return `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || prettyPhone(lead.phone_norm) || `ליד #${lead.id}`;
}

// ---------------------------------------------------------------------------
// Assignment (spec §33, §34)
// ---------------------------------------------------------------------------
export function pickOwner({ treatmentIds = [] } = {}) {
  const cfg = setting('assignment', { mode: 'round_robin', last_user_id: null, by_specialty: false });
  let pool = all("SELECT * FROM users WHERE active=1 AND receives_leads=1 AND role IN ('agent','reception')");
  if (!pool.length) return null;

  if (cfg.by_specialty && treatmentIds.length) {
    const specialists = pool.filter((u) => {
      const s = parseJson(u.specialties, []);
      return Array.isArray(s) && s.some((id) => treatmentIds.includes(Number(id)));
    });
    if (specialists.length) pool = specialists;
  }

  if (cfg.mode === 'least_load') {
    const loads = pool.map((u) => ({
      u,
      n: get(
        `SELECT COUNT(*) AS n FROM leads l JOIN statuses s ON s.key=l.status_key
         WHERE l.owner_id=? AND s.stage IN ('new','working')`, u.id,
      ).n,
    }));
    loads.sort((a, b) => a.n - b.n);
    return loads[0].u;
  }

  // round robin
  const idx = pool.findIndex((u) => u.id === cfg.last_user_id);
  const next = pool[(idx + 1) % pool.length];
  setSetting('assignment', { ...cfg, last_user_id: next.id });
  return next;
}

export function assignLead(leadId, userId, actorId = null) {
  const lead = leadById(leadId);
  if (!lead) throw notFound('lead');
  const user = userId ? get('SELECT * FROM users WHERE id=?', userId) : null;
  run('UPDATE leads SET owner_id=?, updated_at=? WHERE id=?', user?.id ?? null, nowIso(), leadId);
  addEvent(leadId, 'assign', user ? `הליד הועבר ל-${user.name}` : 'הליד הוסר מבעלות', { actorId });
  if (user) {
    notify(user.id, {
      type: 'lead_assigned',
      title: 'הוקצה לך ליד חדש',
      body: leadName(lead),
      leadId,
      level: 'info',
    });
  }
  return user;
}

// ---------------------------------------------------------------------------
// Status (spec §4, §22, §23)
// ---------------------------------------------------------------------------
export function changeStatus(leadId, statusKey, actorId = null, opts = {}) {
  const lead = leadById(leadId);
  if (!lead) throw notFound('lead');
  const st = statusByKey(statusKey);
  if (!st) throw bad(`unknown status: ${statusKey}`);
  if (lead.status_key === statusKey && !opts.force) return lead;

  const from = statusByKey(lead.status_key);
  const patch = { status_key: statusKey, updated_at: nowIso() };
  if (st.stage === 'arrived' && !lead.arrived_at) patch.arrived_at = nowIso();
  if (st.stage === 'won' || st.stage === 'lost') patch.closed_at = nowIso();
  update('leads', leadId, patch);

  addEvent(leadId, 'status', `סטטוס שונה: ${from?.name_he || lead.status_key} → ${st.name_he}`, {
    actorId,
    meta: { from: lead.status_key, to: statusKey },
  });

  // §22 — arriving at the clinic is the important conversion moment
  if (st.stage === 'arrived') {
    const appt = get(
      `SELECT * FROM appointments WHERE lead_id=? AND status IN ('scheduled','confirmed')
       ORDER BY start_at LIMIT 1`, leadId,
    );
    if (appt) update('appointments', appt.id, { status: 'arrived', arrived_at: nowIso() });
  }
  recomputeScore(leadId);
  runAutomations('status_changed', leadId, { from: lead.status_key, to: statusKey, actorId });
  return leadById(leadId);
}

export function touchLead(leadId, { channel } = {}) {
  const lead = leadById(leadId);
  if (!lead) return;
  const patch = { last_contact_at: nowIso(), updated_at: nowIso() };
  if (!lead.first_response_at) patch.first_response_at = nowIso();
  update('leads', leadId, patch);
}

// ---------------------------------------------------------------------------
// Messaging (spec §9–§12)
// Provider is pluggable; the default "simulator" records the message locally so
// the whole flow works with no external accounts. Real providers plug in here.
// ---------------------------------------------------------------------------
async function deliver(channel, lead, payload) {
  const cfg = setting('integrations', {});
  const provider = cfg?.[channel]?.provider || 'simulator';
  if (provider === 'simulator') {
    return { status: channel === 'email' ? 'delivered' : 'delivered', external_id: 'sim_' + token(8) };
  }
  if (channel === 'whatsapp' && provider === 'cloud_api') {
    // Meta WhatsApp Cloud API — enable by filling settings.integrations.whatsapp
    const { phone_number_id, token: apiToken } = cfg.whatsapp;
    const res = await fetch(`https://graph.facebook.com/v20.0/${phone_number_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: (lead.whatsapp || lead.phone_norm || '').replace('+', ''),
        type: 'text',
        text: { body: payload.body },
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { status: 'failed', error: json?.error?.message || res.statusText };
    return { status: 'sent', external_id: json?.messages?.[0]?.id };
  }
  return { status: 'failed', error: `provider ${provider} not configured` };
}

export async function sendWhatsapp(leadId, { body, userId = null, media = null, templateKey = null }) {
  const lead = leadById(leadId);
  if (!lead) throw notFound('lead');
  if (lead.do_not_contact) throw bad('lead is marked do-not-contact');
  let text = body;
  if (templateKey) {
    const tpl = get('SELECT * FROM templates WHERE channel=? AND key=? AND active=1', 'whatsapp', templateKey);
    if (tpl) text = renderTemplate(tpl.body, leadVars(lead));
  }
  if (!text) throw bad('empty message');
  const result = await deliver('whatsapp', lead, { body: text });
  const id = insert('messages', {
    lead_id: leadId,
    channel: 'whatsapp',
    direction: 'out',
    user_id: userId,
    body: text,
    media: media ? JSON.stringify(media) : null,
    status: result.status,
    external_id: result.external_id || null,
  });
  addEvent(leadId, 'whatsapp', 'נשלחה הודעת WhatsApp', { actorId: userId, body: text, meta: { message_id: id } });
  touchLead(leadId, { channel: 'whatsapp' });
  recomputeScore(leadId);
  return get('SELECT * FROM messages WHERE id=?', id);
}

export async function sendEmail(leadId, { subject, body, userId = null, media = null, templateKey = null }) {
  const lead = leadById(leadId);
  if (!lead) throw notFound('lead');
  if (!lead.email) throw bad('lead has no email address');
  if (lead.do_not_contact) throw bad('lead is marked do-not-contact');
  let subj = subject;
  let text = body;
  if (templateKey) {
    const tpl = get('SELECT * FROM templates WHERE channel=? AND key=? AND active=1', 'email', templateKey);
    if (tpl) {
      const vars = leadVars(lead);
      subj = renderTemplate(tpl.subject, vars);
      text = renderTemplate(tpl.body, vars);
    }
  }
  const trackingId = token(12);
  const result = await deliver('email', lead, { subject: subj, body: text, trackingId });
  const id = insert('messages', {
    lead_id: leadId,
    channel: 'email',
    direction: 'out',
    user_id: userId,
    subject: subj || '(ללא נושא)',
    body: text || '',
    media: media ? JSON.stringify(media) : null,
    status: result.status,
    tracking_id: trackingId,
    external_id: result.external_id || null,
  });
  addEvent(leadId, 'email', `נשלח מייל: "${subj || ''}"`, { actorId: userId, body: text, meta: { message_id: id } });
  touchLead(leadId, { channel: 'email' });
  recomputeScore(leadId);
  return get('SELECT * FROM messages WHERE id=?', id);
}

/** Inbound message from a provider webhook or the simulator. */
export function receiveMessage(leadId, { channel, body, media = null, externalId = null, createdAt = null }) {
  const id = insert('messages', {
    lead_id: leadId,
    channel,
    direction: 'in',
    body: body || '',
    media: media ? JSON.stringify(media) : null,
    status: 'delivered',
    external_id: externalId,
    created_at: createdAt || nowIso(),
  });
  const lead = leadById(leadId);
  addEvent(leadId, channel, `הלקוח השיב ב-${channel}`, { body, meta: { message_id: id } });
  run('UPDATE leads SET last_contact_at=?, updated_at=? WHERE id=?', nowIso(), nowIso(), leadId);
  recomputeScore(leadId);
  if (lead?.owner_id) {
    notify(lead.owner_id, {
      type: 'message_in',
      title: `הודעה חדשה מ-${leadName(lead)}`,
      body: (body || '').slice(0, 120),
      leadId,
      level: 'info',
    });
  }
  runAutomations('message_in', leadId, { channel, body });
  return get('SELECT * FROM messages WHERE id=?', id);
}

// ---------------------------------------------------------------------------
// Tasks / reminders (spec §16–§18, §32)
// ---------------------------------------------------------------------------
export function createTask(leadId, { title, dueAt, userId, kind = 'callback', priority = 'normal', note = null, createdBy = null }) {
  const lead = leadId ? leadById(leadId) : null;
  const id = insert('tasks', {
    lead_id: leadId ?? null,
    user_id: userId ?? lead?.owner_id ?? null,
    created_by: createdBy,
    title,
    note,
    kind,
    priority,
    due_at: dueAt,
  });
  if (leadId) {
    run('UPDATE leads SET next_action_at=? WHERE id=? AND (next_action_at IS NULL OR next_action_at > ?)',
      dueAt, leadId, dueAt);
    addEvent(leadId, 'task', `נקבעה משימה: ${title}`, { actorId: createdBy, meta: { due_at: dueAt, task_id: id } });
  }
  return get('SELECT * FROM tasks WHERE id=?', id);
}

export function completeTask(taskId, userId) {
  const t = get('SELECT * FROM tasks WHERE id=?', taskId);
  if (!t) throw notFound('task');
  update('tasks', taskId, { done_at: nowIso() });
  if (t.lead_id) {
    addEvent(t.lead_id, 'task', `המשימה בוצעה: ${t.title}`, { actorId: userId });
    const next = get(
      'SELECT MIN(due_at) AS d FROM tasks WHERE lead_id=? AND done_at IS NULL', t.lead_id,
    );
    run('UPDATE leads SET next_action_at=? WHERE id=?', next?.d || null, t.lead_id);
  }
  return get('SELECT * FROM tasks WHERE id=?', taskId);
}

// ---------------------------------------------------------------------------
// Appointments (spec §20–§22)
// ---------------------------------------------------------------------------
export function createAppointment(leadId, data, actorId = null) {
  const lead = leadById(leadId);
  if (!lead) throw notFound('lead');
  if (!data.start_at) throw bad('start_at required');
  const start = new Date(data.start_at);
  const end = data.end_at ? new Date(data.end_at) : new Date(start.getTime() + (data.duration_min || 45) * 60000);
  const id = insert('appointments', {
    lead_id: leadId,
    treatment_id: data.treatment_id ?? null,
    doctor_id: data.doctor_id ?? null,
    created_by: actorId,
    branch: data.branch ?? null,
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    status: data.status || 'scheduled',
    notes: data.notes ?? null,
    confirm_token: token(10),
  });
  addEvent(leadId, 'appointment', 'נקבע תור', {
    actorId,
    meta: { appointment_id: id, start_at: start.toISOString() },
  });
  changeStatus(leadId, 'appointment_set', actorId);
  runAutomations('appointment_created', leadId, { appointment_id: id });
  return get('SELECT * FROM appointments WHERE id=?', id);
}

export function setAppointmentStatus(apptId, status, actorId = null) {
  const a = get('SELECT * FROM appointments WHERE id=?', apptId);
  if (!a) throw notFound('appointment');
  const patch = { status };
  if (status === 'confirmed') patch.confirmed_at = nowIso();
  if (status === 'arrived') patch.arrived_at = nowIso();
  update('appointments', apptId, patch);
  const map = {
    confirmed: 'appointment_confirmed',
    arrived: 'arrived',
    no_show: 'no_show',
    cancelled: 'appointment_cancelled',
    done: 'treatment_started',
  };
  addEvent(a.lead_id, 'appointment', `סטטוס תור: ${status}`, { actorId, meta: { appointment_id: apptId } });
  if (map[status]) changeStatus(a.lead_id, map[status], actorId);
  return get('SELECT * FROM appointments WHERE id=?', apptId);
}

// ---------------------------------------------------------------------------
// Lead intake + duplicate prevention (spec §25–§27)
// ---------------------------------------------------------------------------
export function intakeLead(payload, { source = 'manual', actorId = null, raw = null } = {}) {
  const clinic = setting('clinic', {});
  const phoneNorm = normalizePhone(payload.phone, clinic.country_code || '972');
  const email = payload.email ? String(payload.email).trim().toLowerCase() : null;

  let existing = null;
  if (phoneNorm) existing = get('SELECT * FROM leads WHERE phone_norm=? ORDER BY id LIMIT 1', phoneNorm);
  if (!existing && email) existing = get('SELECT * FROM leads WHERE lower(email)=? ORDER BY id LIMIT 1', email);

  const utm = {
    source: payload.utm_source, campaign: payload.utm_campaign, medium: payload.utm_medium,
    content: payload.utm_content, term: payload.utm_term,
  };
  const treatmentIds = resolveTreatments(payload.treatment ?? payload.treatments);

  if (existing) {
    // §27 — never blindly create a second card; attach to the customer's history
    const daysAgo = Math.floor((Date.now() - new Date(existing.created_at).getTime()) / 86400000);
    insert('lead_submissions', {
      lead_id: existing.id,
      source,
      campaign_name: payload.campaign_name ?? null,
      ad_name: payload.ad_name ?? null,
      ad_set: payload.ad_set ?? null,
      utm: JSON.stringify(utm),
      payload: JSON.stringify(raw || payload),
      is_duplicate: 1,
    });
    for (const tid of treatmentIds) {
      run('INSERT OR IGNORE INTO lead_treatments(lead_id,treatment_id) VALUES(?,?)', existing.id, tid);
    }
    addEvent(existing.id, 'lead_created', `פנייה חוזרת מ-${source}`, {
      body: `הלקוח נמצא במערכת מלפני ${daysAgo} ימים — הפנייה צורפה לכרטיס הקיים.`,
      meta: { duplicate: true, source, campaign: payload.campaign_name },
    });
    // Re-open a closed card so nobody misses a returning customer
    const st = statusByKey(existing.status_key);
    if (st && ['lost', 'won'].includes(st.stage)) changeStatus(existing.id, 'contacted', actorId, { force: true });
    if (existing.owner_id) {
      notify(existing.owner_id, {
        type: 'duplicate_lead',
        title: 'פנייה חוזרת מלקוח קיים',
        body: `${leadName(existing)} — ${source}`,
        leadId: existing.id,
        level: 'warn',
      });
    }
    recomputeScore(existing.id);
    return { lead: leadById(existing.id), duplicate: true, days_ago: daysAgo };
  }

  const fullName = String(payload.full_name || payload.name || '').trim();
  const parts = fullName.split(/\s+/);
  const first = payload.first_name || parts[0] || '';
  const last = payload.last_name || parts.slice(1).join(' ') || '';

  const owner = payload.owner_id ? get('SELECT * FROM users WHERE id=?', payload.owner_id)
    : pickOwner({ treatmentIds });

  const leadId = insert('leads', {
    first_name: first,
    last_name: last,
    phone: payload.phone ?? null,
    phone_norm: phoneNorm,
    whatsapp: payload.whatsapp ? normalizePhone(payload.whatsapp) : phoneNorm,
    email,
    language: payload.language || clinic.default_lang || 'he',
    city: payload.city ?? null,
    status_key: 'new',
    owner_id: owner?.id ?? null,
    source,
    campaign_name: payload.campaign_name ?? null,
    ad_name: payload.ad_name ?? null,
    ad_set: payload.ad_set ?? null,
    utm_source: payload.utm_source ?? null,
    utm_campaign: payload.utm_campaign ?? null,
    utm_medium: payload.utm_medium ?? null,
    utm_content: payload.utm_content ?? null,
    utm_term: payload.utm_term ?? null,
    landing_page: payload.landing_page ?? null,
    external_id: payload.external_id ?? null,
    updated_at: nowIso(),
  });
  for (const tid of treatmentIds) {
    run('INSERT OR IGNORE INTO lead_treatments(lead_id,treatment_id) VALUES(?,?)', leadId, tid);
  }
  insert('lead_submissions', {
    lead_id: leadId,
    source,
    campaign_name: payload.campaign_name ?? null,
    ad_name: payload.ad_name ?? null,
    ad_set: payload.ad_set ?? null,
    utm: JSON.stringify(utm),
    payload: JSON.stringify(raw || payload),
  });
  addEvent(leadId, 'lead_created', `הליד התקבל מ-${source}`, {
    actorId,
    meta: { source, campaign: payload.campaign_name, ad: payload.ad_name },
  });
  if (owner) {
    notify(owner.id, {
      type: 'new_lead',
      title: 'ליד חדש 🔥',
      body: `${first} ${last} — ${payload.campaign_name || source}`,
      leadId,
      level: 'urgent',
    });
  } else {
    notifyManagers({ type: 'new_lead', title: 'ליד חדש ללא נציג', body: `${first} ${last}`, leadId });
  }
  recomputeScore(leadId);
  runAutomations('lead_created', leadId, { source });
  return { lead: leadById(leadId), duplicate: false };
}

export function resolveTreatments(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : String(input).split(/[,+|]/);
  const ids = [];
  for (const item of list) {
    const s = String(item).trim();
    if (!s) continue;
    if (/^\d+$/.test(s)) {
      if (get('SELECT 1 AS x FROM treatments WHERE id=?', Number(s))) ids.push(Number(s));
      continue;
    }
    const row = get(
      `SELECT id FROM treatments
       WHERE name_he=? OR name_ar=? OR lower(name_en)=lower(?)
       ORDER BY id LIMIT 1`, s, s, s,
    );
    if (row) ids.push(row.id);
    else {
      const like = get(
        `SELECT id FROM treatments WHERE name_he LIKE ? OR name_ar LIKE ? OR name_en LIKE ? LIMIT 1`,
        `%${s}%`, `%${s}%`, `%${s}%`,
      );
      if (like) ids.push(like.id);
    }
  }
  return [...new Set(ids)];
}

// ---------------------------------------------------------------------------
// Automation engine (spec §40, §41)
// ---------------------------------------------------------------------------
export function runAutomations(trigger, leadId, ctx = {}) {
  const rules = all('SELECT * FROM automations WHERE active=1 AND trigger=?', trigger);
  for (const rule of rules) {
    const cond = parseJson(rule.conditions, {});
    if (!matchConditions(cond, leadId, ctx)) continue;
    if (rule.delay_min > 0) {
      insert('automation_jobs', {
        automation_id: rule.id,
        lead_id: leadId,
        run_at: plusMinutes(rule.delay_min),
        actions: rule.actions,
      });
    } else {
      executeActions(rule, leadId, parseJson(rule.actions, []));
    }
    run('UPDATE automations SET runs=runs+1, last_run_at=? WHERE id=?', nowIso(), rule.id);
  }
}

function matchConditions(cond, leadId, ctx) {
  const lead = leadById(leadId);
  if (!lead) return false;
  if (cond.to && !cond.to.includes(ctx.to)) return false;
  if (cond.from && !cond.from.includes(ctx.from)) return false;
  if (cond.source && !cond.source.includes(lead.source)) return false;
  if (cond.channel && ctx.channel && !cond.channel.includes(ctx.channel)) return false;
  if (cond.status_stage) {
    const st = statusByKey(lead.status_key);
    if (!st || !cond.status_stage.includes(st.stage)) return false;
  }
  if (cond.treatment_ids?.length) {
    const has = all('SELECT treatment_id FROM lead_treatments WHERE lead_id=?', leadId)
      .some((r) => cond.treatment_ids.includes(r.treatment_id));
    if (!has) return false;
  }
  return true;
}

export async function executeActions(rule, leadId, actions) {
  const lead = leadById(leadId);
  if (!lead) return;
  for (const action of actions) {
    try {
      switch (action.type) {
        case 'send_whatsapp':
          if (lead.do_not_contact) break;
          await sendWhatsapp(leadId, { templateKey: action.template, body: action.body, userId: null });
          break;
        case 'send_email':
          if (lead.do_not_contact || !lead.email) break;
          await sendEmail(leadId, { templateKey: action.template, subject: action.subject, body: action.body });
          break;
        case 'create_task':
          createTask(leadId, {
            title: action.title || 'משימה אוטומטית',
            dueAt: plusMinutes(action.in_minutes ?? 60),
            userId: lead.owner_id,
            priority: action.priority || 'normal',
            kind: action.kind || 'callback',
          });
          break;
        case 'set_status':
          if (action.status) changeStatus(leadId, action.status, null);
          break;
        case 'assign':
          assignLead(leadId, action.user_id ?? pickOwner()?.id ?? null);
          break;
        case 'notify_manager':
          notifyManagers({
            type: 'automation',
            title: action.title || 'התראת אוטומציה',
            body: leadName(lead),
            leadId,
            level: action.level || 'warn',
          });
          break;
        case 'notify_owner':
          notify(lead.owner_id, {
            type: 'automation', title: action.title || 'התראה', body: leadName(lead), leadId, level: 'warn',
          });
          break;
        case 'add_note':
          addEvent(leadId, 'note', 'הערה אוטומטית', { body: action.body });
          break;
        default:
          break;
      }
    } catch (err) {
      addEvent(leadId, 'automation', `אוטומציה נכשלה: ${action.type}`, { body: String(err.message || err) });
    }
  }
  if (rule?.name) addEvent(leadId, 'automation', `הופעלה אוטומציה: ${rule.name}`);
}
