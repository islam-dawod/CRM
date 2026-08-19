import { randomBytes, createHash } from 'node:crypto';
import { insert, get, all, run } from '../db.js';
import { clinicVars } from './clinic.js';

// ---------------------------------------------------------------------------
// Time — everything is stored as ISO-8601 UTC so plain string compares work
// ---------------------------------------------------------------------------
export const nowIso = () => new Date().toISOString();
export const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
export const plusMinutes = (min, from = new Date()) =>
  new Date(new Date(from).getTime() + min * 60000).toISOString();
export const plusHours = (h, from = new Date()) => plusMinutes(h * 60, from);
export const plusDays = (d, from = new Date()) => plusMinutes(d * 1440, from);
export const minutesBetween = (a, b) => (new Date(b) - new Date(a)) / 60000;

/** Start of "today" in the clinic timezone, returned as a UTC ISO string. */
export function dayRange(dayOffset = 0, tzOffsetMin = 0) {
  const now = new Date(Date.now() - tzOffsetMin * 60000);
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset));
  const start = new Date(d.getTime() + tzOffsetMin * 60000);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86400000).toISOString() };
}

export const token = (bytes = 24) => randomBytes(bytes).toString('base64url');
export const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

// ---------------------------------------------------------------------------
// Phone normalization — Israeli / Palestinian numbers, used for dedupe (§27)
// ---------------------------------------------------------------------------
export function normalizePhone(raw, defaultCc = '972') {
  if (!raw) return null;
  let s = String(raw).replace(/[^\d+]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (s.startsWith('+')) return s;
  if (s.startsWith('0')) return '+' + defaultCc + s.slice(1);
  if (s.startsWith(defaultCc)) return '+' + s;
  if (s.length >= 9 && s.length <= 10) return '+' + defaultCc + s.replace(/^0/, '');
  return '+' + s;
}

export function prettyPhone(norm) {
  if (!norm) return '';
  if (norm.startsWith('+972')) return '0' + norm.slice(4);
  return norm;
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------
export function parseJson(v, fallback = null) {
  if (v == null) return fallback;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export function slug(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'item';
}

// ---------------------------------------------------------------------------
// Timeline + audit + notifications
// ---------------------------------------------------------------------------
export function addEvent(leadId, type, title, opts = {}) {
  return insert('events', {
    lead_id: leadId,
    type,
    title,
    actor_id: opts.actorId ?? null,
    body: opts.body ?? null,
    meta: opts.meta ? JSON.stringify(opts.meta) : null,
  });
}

export function audit(userId, entity, entityId, action, detail, ip) {
  return insert('audit_log', {
    user_id: userId ?? null,
    entity,
    entity_id: entityId ?? null,
    action,
    detail: typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : null,
    ip: ip ?? null,
  });
}

export function notify(userId, { type, title, body, level = 'info', leadId = null }) {
  if (!userId) return null;
  return insert('notifications', {
    user_id: userId,
    lead_id: leadId,
    type,
    title,
    body: body ?? null,
    level,
  });
}

export function notifyManagers({ type, title, body, level = 'warn', leadId = null }) {
  const managers = all("SELECT id FROM users WHERE active=1 AND role IN ('admin','manager')");
  for (const m of managers) notify(m.id, { type, title, body, level, leadId });
}

// ---------------------------------------------------------------------------
// Template rendering  {{first_name}} etc.
// ---------------------------------------------------------------------------
export function renderTemplate(text, vars) {
  return String(text || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => {
    const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), vars);
    return v == null ? '' : String(v);
  });
}

export function leadVars(lead) {
  const treatments = all(
    `SELECT t.name_he, t.name_ar, t.name_en FROM lead_treatments lt
     JOIN treatments t ON t.id = lt.treatment_id WHERE lt.lead_id = ?`,
    lead.id,
  );
  const lang = lead.language === 'ar' ? 'ar' : 'he';
  const tName = (t) => (lang === 'ar' ? t.name_ar : t.name_he);
  const appt = get(
    `SELECT * FROM appointments WHERE lead_id=? AND status IN ('scheduled','confirmed')
     ORDER BY start_at LIMIT 1`,
    lead.id,
  );
  const owner = lead.owner_id ? get('SELECT name FROM users WHERE id=?', lead.owner_id) : null;
  const fmt = (d, opts) =>
    d ? new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', ...opts }).format(new Date(d)) : '';
  return {
    // Clinic name, address and every official link come from the central config.
    ...clinicVars(),
    first_name: lead.first_name || '',
    last_name: lead.last_name || '',
    full_name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
    phone: prettyPhone(lead.phone_norm || lead.phone),
    email: lead.email || '',
    city: lead.city || '',
    treatment: treatments.map(tName).join(' + '),
    owner: owner?.name || '',
    appointment_date: fmt(appt?.start_at, { day: '2-digit', month: '2-digit', year: 'numeric' }),
    appointment_time: fmt(appt?.start_at, { hour: '2-digit', minute: '2-digit', hour12: false }),
  };
}

// ---------------------------------------------------------------------------
// Lead scoring & temperature (spec §30, §31)
// ---------------------------------------------------------------------------
export function recomputeScore(leadId) {
  const lead = get('SELECT * FROM leads WHERE id=?', leadId);
  if (!lead) return null;

  const m = get(
    `SELECT
       SUM(CASE WHEN channel='email' AND direction='out' AND opens>0 THEN 1 ELSE 0 END) AS mail_opens,
       SUM(CASE WHEN channel='email' AND direction='out' AND clicks>0 THEN 1 ELSE 0 END) AS mail_clicks,
       SUM(CASE WHEN channel='whatsapp' AND direction='in' THEN 1 ELSE 0 END) AS wa_in
     FROM messages WHERE lead_id=?`,
    leadId,
  ) || {};
  const c = get(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN outcome='answered' THEN 1 ELSE 0 END) AS answered
     FROM calls WHERE lead_id=?`,
    leadId,
  ) || {};
  const appt = get('SELECT COUNT(*) AS n FROM appointments WHERE lead_id=?', leadId)?.n || 0;
  const deal = get('SELECT COUNT(*) AS n FROM deals WHERE lead_id=?', leadId)?.n || 0;

  let score = 10;
  if (lead.email) score += 3;
  if (lead.phone_norm) score += 3;
  score += Math.min(3, m.mail_opens || 0) * 6;
  score += Math.min(2, m.mail_clicks || 0) * 8;
  score += Math.min(4, m.wa_in || 0) * 7;
  score += Math.min(3, c.answered || 0) * 8;
  if (appt) score += 18;
  if (deal) score += 10;
  if (lead.arrived_at) score += 12;

  // Decay for silence
  const lastTouch = lead.last_contact_at || lead.created_at;
  const daysQuiet = Math.floor((Date.now() - new Date(lastTouch).getTime()) / 86400000);
  score -= clamp(daysQuiet * 2, 0, 25);

  if (['not_interested', 'irrelevant', 'wrong_number'].includes(lead.status_key)) score = Math.min(score, 15);

  score = clamp(Math.round(score), 0, 100);
  const temperature = score >= 65 ? 'hot' : score >= 35 ? 'warm' : 'cold';
  run('UPDATE leads SET score=?, temperature=?, updated_at=? WHERE id=?', score, temperature, nowIso(), leadId);
  return { score, temperature };
}

// ---------------------------------------------------------------------------
// AI-ish helpers, fully local (no external API key required) — spec §15, §55
// ---------------------------------------------------------------------------
const KEYWORDS = {
  price: ['מחיר', 'עלות', 'כמה עולה', 'הצעת מחיר', 'תשלומים', 'מימון', 'سعر', 'تكلفة', 'أقساط'],
  schedule: ['תור', 'לקבוע', 'מתי', 'להגיע', 'موعد', 'احجز'],
  spouse: ['אשתי', 'אשתו', 'בעלי', 'בעלה', 'לחשוב', 'להתייעץ', 'زوجتي', 'زوجي', 'أفكر'],
  callback: ['לחזור', 'יחזור', 'תחזרו', 'מחר', 'ביום', 'اتصلوا', 'غدا'],
  urgent: ['כאב', 'דחוף', 'ألم', 'عاجل'],
};
export function summarizeCall(text, lead) {
  const t = String(text || '');
  const hits = [];
  for (const [k, words] of Object.entries(KEYWORDS)) if (words.some((w) => t.includes(w))) hits.push(k);
  const bits = [];
  const name = lead?.first_name || 'הלקוח';
  if (hits.includes('price')) bits.push('שאל/ה על מחיר ותנאי תשלום');
  if (hits.includes('schedule')) bits.push('מעוניין/ת לקבוע תור');
  if (hits.includes('spouse')) bits.push('רוצה להתייעץ לפני החלטה');
  if (hits.includes('callback')) bits.push('ביקש/ה שנחזור אליו/ה');
  if (hits.includes('urgent')) bits.push('מדווח/ת על כאב — לטפל בעדיפות');
  if (!bits.length) bits.push('שיחה כללית ללא סימני החלטה ברורים');
  const next = hits.includes('schedule')
    ? 'הצע תור בשלושת הימים הקרובים'
    : hits.includes('price')
      ? 'שלח הצעת מחיר בוואטסאפ ותאם חזרה מחר'
      : 'קבע שיחת חזרה תוך 24 שעות';
  return { summary: `${name}: ${bits.join('; ')}.`, next_action: next, tags: hits };
}

export function nextBestAction(leadId) {
  const lead = get('SELECT * FROM leads WHERE id=?', leadId);
  if (!lead) return null;
  const reasons = [];
  const stats = get(
    `SELECT
      (SELECT COUNT(*) FROM messages WHERE lead_id=l.id AND channel='email' AND opens>0) AS opens,
      (SELECT COUNT(*) FROM messages WHERE lead_id=l.id AND direction='in') AS replies,
      (SELECT COUNT(*) FROM calls WHERE lead_id=l.id AND outcome='answered') AS answered,
      (SELECT COUNT(*) FROM calls WHERE lead_id=l.id AND outcome='no_answer') AS no_answer,
      (SELECT COUNT(*) FROM appointments WHERE lead_id=l.id AND status NOT IN ('cancelled','no_show')) AS appts
     FROM leads l WHERE l.id=?`,
    leadId,
  );
  if (stats.opens) reasons.push(`פתח/ה מייל ${stats.opens} פעמים`);
  if (stats.replies) reasons.push(`השיב/ה ${stats.replies} הודעות`);
  if (stats.answered) reasons.push('ענה/תה לשיחה');
  if (stats.no_answer) reasons.push(`${stats.no_answer} ניסיונות ללא מענה`);
  if (!stats.appts) reasons.push('עדיין לא נקבע תור');

  let action = 'call';
  let label = 'התקשר עכשיו';
  if (stats.appts) {
    action = 'confirm';
    label = 'שלח אישור תור בוואטסאפ';
  } else if (stats.no_answer >= 2 && !stats.replies) {
    action = 'whatsapp';
    label = 'שלח וואטסאפ — לא עונה לשיחות';
  } else if (stats.opens >= 2 && !stats.answered) {
    action = 'call';
    label = 'התקשר עכשיו — מתעניין ולא נוצר קשר';
  }
  const probability = clamp(lead.score, 0, 100);
  return { action, label, probability, reasons };
}
