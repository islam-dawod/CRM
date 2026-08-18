// Dashboard KPIs, funnel, campaigns, team performance, response time, revenue,
// and the local AI assistant. Spec §2, §35–§38, §54, §55.
import { all, get } from '../db.js';
import { requireUser, requirePerm, can, leadScopeSql } from '../lib/auth.js';
import { nowIso, plusMinutes, parseJson, nextBestAction, prettyPhone } from '../lib/util.js';

const RANGE_SQL = (from, to) => ({ from: from || plusMinutes(-30 * 1440), to: to || nowIso() });

export default function register(router) {
  // -------------------------------------------------------------------------
  // Dashboard (§2)
  // -------------------------------------------------------------------------
  router.get('/api/reports/dashboard', ({ req }) => {
    const user = requireUser(req);
    const scope = leadScopeSql(user, 'l');
    const S = scope.sql;
    const P = scope.params;

    const kpi = get(
      `SELECT
        (SELECT COUNT(*) FROM leads l WHERE ${S} AND date(l.created_at)=date('now','localtime')) AS new_today,
        (SELECT COUNT(*) FROM leads l JOIN statuses s ON s.key=l.status_key
          WHERE ${S} AND s.stage='working' AND l.archived=0) AS waiting,
        (SELECT COUNT(*) FROM leads l WHERE ${S} AND l.status_key IN
          ('no_answer','attempt_1','attempt_2','attempt_3') AND l.archived=0) AS no_answer,
        (SELECT COUNT(*) FROM leads l JOIN statuses s ON s.key=l.status_key
          WHERE ${S} AND s.stage='scheduled' AND l.archived=0) AS scheduled,
        (SELECT COUNT(*) FROM leads l WHERE ${S} AND l.arrived_at IS NOT NULL) AS arrived,
        (SELECT COUNT(*) FROM leads l WHERE ${S} AND l.status_key='treatment_done') AS completed,
        (SELECT COUNT(*) FROM leads l WHERE ${S} AND l.archived=0 AND l.first_response_at IS NULL
          AND l.created_at <= datetime('now','-24 hours')) AS untouched_24h,
        (SELECT COUNT(*) FROM leads l WHERE ${S} AND l.arrived_at IS NOT NULL
          AND date(l.arrived_at)=date('now','localtime')) AS arrived_today`,
      ...P, ...P, ...P, ...P, ...P, ...P, ...P, ...P,
    );

    const todayAppointments = all(
      `SELECT a.id, a.start_at, a.status, a.lead_id, l.first_name, l.last_name, l.phone_norm,
              t.name_he AS treatment_he, d.name AS doctor_name
       FROM appointments a JOIN leads l ON l.id=a.lead_id
       LEFT JOIN treatments t ON t.id=a.treatment_id
       LEFT JOIN users d ON d.id=a.doctor_id
       WHERE date(a.start_at,'localtime')=date('now','localtime') AND a.status!='cancelled'
       ORDER BY a.start_at`,
    );

    const taskScope = can(user, 'tasks.all') ? '' : 'AND t.user_id=' + Number(user.id);
    const dueTasks = all(
      `SELECT t.*, l.first_name, l.last_name, l.phone_norm FROM tasks t
       LEFT JOIN leads l ON l.id=t.lead_id
       WHERE t.done_at IS NULL AND t.due_at <= ? ${taskScope}
       ORDER BY t.due_at LIMIT 20`, plusMinutes(180),
    );

    const inboxScope = can(user, 'inbox.all') ? '' : 'AND l.owner_id=' + Number(user.id);
    const newMessages = all(
      `SELECT m.id, m.channel, m.body, m.created_at, m.lead_id, l.first_name, l.last_name
       FROM messages m JOIN leads l ON l.id=m.lead_id
       WHERE m.direction='in' AND m.read_at IS NULL ${inboxScope}
       ORDER BY m.id DESC LIMIT 15`,
    );

    const newLeads = all(
      `SELECT l.id, l.first_name, l.last_name, l.source, l.campaign_name, l.created_at, l.temperature,
              l.phone_norm, u.name AS owner_name
       FROM leads l LEFT JOIN users u ON u.id=l.owner_id
       WHERE ${S} AND l.archived=0 AND l.created_at >= datetime('now','-2 days')
       ORDER BY l.id DESC LIMIT 15`, ...P,
    );

    const idleAgents = can(user, 'team.read')
      ? all(
          `SELECT u.id, u.name, u.color,
                  (SELECT COUNT(*) FROM tasks t WHERE t.user_id=u.id AND t.done_at IS NULL AND t.due_at < ?) AS overdue,
                  (SELECT COUNT(*) FROM leads l WHERE l.owner_id=u.id AND l.first_response_at IS NULL
                     AND l.archived=0) AS untouched
           FROM users u WHERE u.active=1 AND u.role IN ('agent','reception')
           ORDER BY overdue DESC, untouched DESC`, nowIso(),
        ).filter((r) => r.overdue || r.untouched)
      : [];

    const bySource = all(
      `SELECT l.source, COUNT(*) AS n FROM leads l
       WHERE ${S} AND l.created_at >= datetime('now','-30 days') GROUP BY l.source ORDER BY n DESC`, ...P,
    );

    const daily = all(
      `SELECT date(l.created_at,'localtime') AS day, COUNT(*) AS n FROM leads l
       WHERE ${S} AND l.created_at >= datetime('now','-14 days')
       GROUP BY day ORDER BY day`, ...P,
    );

    return { kpi, todayAppointments, dueTasks, newMessages, newLeads, idleAgents, bySource, daily };
  });

  // -------------------------------------------------------------------------
  // Funnel (§36)
  // -------------------------------------------------------------------------
  router.get('/api/reports/funnel', ({ req, query }) => {
    const user = requireUser(req);
    requirePerm(user, 'reports.read');
    const { from, to } = RANGE_SQL(query.from, query.to);
    const extra = [];
    const params = [from, to];
    if (query.campaign) { extra.push('AND l.campaign_name = ?'); params.push(query.campaign); }
    if (query.source) { extra.push('AND l.source = ?'); params.push(query.source); }
    if (query.owner) { extra.push('AND l.owner_id = ?'); params.push(Number(query.owner)); }
    const w = extra.join(' ');

    const row = get(
      `SELECT
        COUNT(*) AS leads,
        SUM(CASE WHEN l.first_response_at IS NOT NULL THEN 1 ELSE 0 END) AS contacted,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM statuses s WHERE s.key=l.status_key
              AND s.stage IN ('working','scheduled','arrived','treatment','won'))
              AND l.status_key NOT IN ('no_answer','attempt_1','attempt_2','attempt_3','wrong_number')
            THEN 1 ELSE 0 END) AS interested,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM appointments a WHERE a.lead_id=l.id
              AND a.status != 'cancelled') THEN 1 ELSE 0 END) AS scheduled,
        SUM(CASE WHEN l.arrived_at IS NOT NULL THEN 1 ELSE 0 END) AS arrived,
        SUM(CASE WHEN l.status_key IN ('treatment_started','treatment_done','treatment_approved')
            THEN 1 ELSE 0 END) AS started,
        SUM(CASE WHEN l.status_key='treatment_done' THEN 1 ELSE 0 END) AS completed
       FROM leads l WHERE l.created_at BETWEEN ? AND ? ${w}`, ...params,
    );

    const revenue = get(
      `SELECT COALESCE(SUM(d.amount),0) AS amount, COALESCE(SUM(d.paid),0) AS paid
       FROM deals d JOIN leads l ON l.id=d.lead_id
       WHERE l.created_at BETWEEN ? AND ? ${w}`, ...params,
    );

    const steps = [
      { key: 'leads', label: 'לידים', value: row.leads || 0 },
      { key: 'contacted', label: 'נוצר קשר', value: row.contacted || 0 },
      { key: 'interested', label: 'מתעניינים', value: row.interested || 0 },
      { key: 'scheduled', label: 'קבעו תור', value: row.scheduled || 0 },
      { key: 'arrived', label: 'הגיעו', value: row.arrived || 0 },
      { key: 'started', label: 'התחילו טיפול', value: row.started || 0 },
      { key: 'completed', label: 'סיימו טיפול', value: row.completed || 0 },
    ];
    const first = steps[0].value || 1;
    steps.forEach((s, i) => {
      s.pct_of_total = Math.round((s.value / first) * 1000) / 10;
      s.pct_of_prev = i === 0 ? 100 : Math.round((s.value / (steps[i - 1].value || 1)) * 1000) / 10;
    });
    return { steps, revenue, range: { from, to } };
  });

  // -------------------------------------------------------------------------
  // Campaign performance (§37) — money, not just lead count
  // -------------------------------------------------------------------------
  router.get('/api/reports/campaigns', ({ req, query }) => {
    const user = requireUser(req);
    requirePerm(user, 'reports.read');
    const { from, to } = RANGE_SQL(query.from, query.to);
    const groupBy = query.group === 'source' ? 'l.source'
      : query.group === 'ad' ? "COALESCE(l.ad_name,'—')"
      : "COALESCE(l.campaign_name, l.source)";
    return all(
      `SELECT ${groupBy} AS name,
              MIN(l.source) AS source,
              COUNT(*) AS leads,
              SUM(CASE WHEN l.first_response_at IS NOT NULL THEN 1 ELSE 0 END) AS contacted,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM appointments a WHERE a.lead_id=l.id AND a.status!='cancelled')
                  THEN 1 ELSE 0 END) AS scheduled,
              SUM(CASE WHEN l.arrived_at IS NOT NULL THEN 1 ELSE 0 END) AS arrived,
              SUM(CASE WHEN l.status_key IN ('treatment_started','treatment_done') THEN 1 ELSE 0 END) AS customers,
              COALESCE(SUM(dsum.amount),0) AS revenue,
              COALESCE(SUM(dsum.paid),0) AS paid
       FROM leads l
       LEFT JOIN (SELECT lead_id, SUM(amount) AS amount, SUM(paid) AS paid FROM deals GROUP BY lead_id) dsum
              ON dsum.lead_id = l.id
       WHERE l.created_at BETWEEN ? AND ?
       GROUP BY name ORDER BY revenue DESC, leads DESC`, from, to,
    ).map((r) => ({
      ...r,
      conv_scheduled: pct(r.scheduled, r.leads),
      conv_arrived: pct(r.arrived, r.leads),
      conv_customer: pct(r.customers, r.leads),
      revenue_per_lead: r.leads ? Math.round(r.revenue / r.leads) : 0,
    }));
  });

  // -------------------------------------------------------------------------
  // Team performance (§35) + response time (§38)
  // -------------------------------------------------------------------------
  router.get('/api/reports/team', ({ req, query }) => {
    const user = requireUser(req);
    requirePerm(user, 'reports.read');
    const { from, to } = RANGE_SQL(query.from, query.to);
    return all(
      `SELECT u.id, u.name, u.color, u.role,
        (SELECT COUNT(*) FROM leads l WHERE l.owner_id=u.id AND l.created_at BETWEEN ? AND ?) AS leads,
        (SELECT COUNT(*) FROM leads l WHERE l.owner_id=u.id AND l.created_at BETWEEN ? AND ?
           AND l.first_response_at IS NOT NULL) AS contacted,
        (SELECT COUNT(*) FROM calls c WHERE c.user_id=u.id AND c.created_at BETWEEN ? AND ?) AS calls,
        (SELECT COUNT(*) FROM calls c WHERE c.user_id=u.id AND c.created_at BETWEEN ? AND ?
           AND c.outcome='answered') AS answered,
        (SELECT COUNT(*) FROM appointments a JOIN leads l ON l.id=a.lead_id
           WHERE l.owner_id=u.id AND a.created_at BETWEEN ? AND ? AND a.status!='cancelled') AS scheduled,
        (SELECT COUNT(*) FROM leads l WHERE l.owner_id=u.id AND l.arrived_at BETWEEN ? AND ?) AS arrived,
        (SELECT COUNT(*) FROM leads l WHERE l.owner_id=u.id AND l.status_key IN
           ('treatment_started','treatment_done') AND l.created_at BETWEEN ? AND ?) AS treatments,
        (SELECT COALESCE(SUM(d.amount),0) FROM deals d JOIN leads l ON l.id=d.lead_id
           WHERE l.owner_id=u.id AND d.created_at BETWEEN ? AND ?) AS revenue,
        (SELECT COALESCE(AVG((julianday(l.first_response_at)-julianday(l.created_at))*1440),0)
           FROM leads l WHERE l.owner_id=u.id AND l.first_response_at IS NOT NULL
             AND l.created_at BETWEEN ? AND ?) AS avg_response_min,
        (SELECT COUNT(*) FROM tasks t WHERE t.user_id=u.id AND t.done_at IS NULL AND t.due_at < ?) AS overdue_tasks,
        (SELECT COUNT(*) FROM leads l JOIN statuses s ON s.key=l.status_key
           WHERE l.owner_id=u.id AND s.stage IN ('new','working') AND l.archived=0) AS open_leads
       FROM users u WHERE u.active=1 AND u.role IN ('agent','reception','manager')
       ORDER BY revenue DESC`,
      from, to, from, to, from, to, from, to, from, to, from, to, from, to, from, to, from, to, nowIso(),
    ).map((r) => ({
      ...r,
      avg_response_min: Math.round(r.avg_response_min || 0),
      conv_scheduled: pct(r.scheduled, r.leads),
      conv_arrived: pct(r.arrived, r.leads),
      answer_rate: pct(r.answered, r.calls),
    }));
  });

  router.get('/api/reports/response-time', ({ req, query }) => {
    const user = requireUser(req);
    requirePerm(user, 'reports.read');
    const { from, to } = RANGE_SQL(query.from, query.to);
    const buckets = get(
      `SELECT
        SUM(CASE WHEN m <= 5 THEN 1 ELSE 0 END) AS under_5,
        SUM(CASE WHEN m > 5 AND m <= 15 THEN 1 ELSE 0 END) AS m5_15,
        SUM(CASE WHEN m > 15 AND m <= 60 THEN 1 ELSE 0 END) AS m15_60,
        SUM(CASE WHEN m > 60 AND m <= 1440 THEN 1 ELSE 0 END) AS h1_24,
        SUM(CASE WHEN m > 1440 THEN 1 ELSE 0 END) AS over_24h,
        AVG(m) AS avg_min,
        COUNT(*) AS total
       FROM (SELECT (julianday(first_response_at)-julianday(created_at))*1440 AS m
             FROM leads WHERE first_response_at IS NOT NULL AND created_at BETWEEN ? AND ?)`,
      from, to,
    );
    const noResponse = get(
      `SELECT COUNT(*) AS n FROM leads WHERE first_response_at IS NULL AND created_at BETWEEN ? AND ?`,
      from, to,
    ).n;
    const bySource = all(
      `SELECT source, COUNT(*) AS n,
              AVG((julianday(first_response_at)-julianday(created_at))*1440) AS avg_min
       FROM leads WHERE first_response_at IS NOT NULL AND created_at BETWEEN ? AND ?
       GROUP BY source ORDER BY n DESC`, from, to,
    ).map((r) => ({ ...r, avg_min: Math.round(r.avg_min || 0) }));
    return { ...buckets, avg_min: Math.round(buckets.avg_min || 0), no_response: noResponse, bySource };
  });

  // -------------------------------------------------------------------------
  // Revenue (§24)
  // -------------------------------------------------------------------------
  router.get('/api/reports/revenue', ({ req, query }) => {
    const user = requireUser(req);
    requirePerm(user, 'reports.read');
    const { from, to } = RANGE_SQL(query.from, query.to);
    const totals = get(
      `SELECT COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(paid),0) AS paid, COUNT(*) AS deals
       FROM deals WHERE created_at BETWEEN ? AND ?`, from, to,
    );
    const byTreatment = all(
      `SELECT COALESCE(t.name_he,'ללא טיפול') AS name, t.color, COUNT(*) AS deals,
              COALESCE(SUM(d.amount),0) AS amount, COALESCE(SUM(d.paid),0) AS paid
       FROM deals d LEFT JOIN treatments t ON t.id=d.treatment_id
       WHERE d.created_at BETWEEN ? AND ? GROUP BY name ORDER BY amount DESC`, from, to,
    );
    const monthly = all(
      `SELECT strftime('%Y-%m', created_at) AS month, COALESCE(SUM(amount),0) AS amount,
              COALESCE(SUM(paid),0) AS paid, COUNT(*) AS deals
       FROM deals WHERE created_at >= datetime('now','-12 months') GROUP BY month ORDER BY month`,
    );
    return { totals: { ...totals, balance: totals.amount - totals.paid }, byTreatment, monthly };
  });

  router.get('/api/reports/sources', ({ req, query }) => {
    const user = requireUser(req);
    requirePerm(user, 'reports.read');
    const { from, to } = RANGE_SQL(query.from, query.to);
    return all(
      `SELECT l.source AS name, COUNT(*) AS leads,
              SUM(CASE WHEN l.arrived_at IS NOT NULL THEN 1 ELSE 0 END) AS arrived,
              COALESCE(SUM(dsum.amount),0) AS revenue
       FROM leads l
       LEFT JOIN (SELECT lead_id, SUM(amount) AS amount FROM deals GROUP BY lead_id) dsum
              ON dsum.lead_id = l.id
       WHERE l.created_at BETWEEN ? AND ?
       GROUP BY l.source ORDER BY leads DESC`, from, to,
    ).map((r) => ({ ...r, conv_arrived: pct(r.arrived, r.leads) }));
  });

  // -------------------------------------------------------------------------
  // AI assistant (§54) — deterministic intent matching over the local DB
  // -------------------------------------------------------------------------
  router.post('/api/ai/ask', ({ req, body }) => {
    const user = requireUser(req);
    const q = String(body.q || '').trim();
    if (!q) throw new Error('empty question');
    const scope = leadScopeSql(user, 'l');
    const S = scope.sql;
    const P = scope.params;
    const has = (...words) => words.some((w) => q.includes(w));

    // 1. Who should I call back today?
    if (has('לחזור', 'חזרה', 'להתקשר היום', 'اتصال', 'أعاود')) {
      const rows = all(
        `SELECT l.id, l.first_name, l.last_name, l.phone_norm, l.temperature, t.title, t.due_at
         FROM tasks t JOIN leads l ON l.id=t.lead_id
         WHERE t.done_at IS NULL AND t.due_at <= datetime('now','+1 day') AND ${S}
         ORDER BY t.due_at LIMIT 40`, ...P,
      );
      return answer(`יש ${rows.length} לקוחות שצריך לחזור אליהם היום`, rows, 'tasks');
    }
    // 2. Asked for treatment X but never scheduled
    if (has('לא קבע', 'בלי תור', 'ולא קבע', 'لم يحجز')) {
      const treatment = matchTreatment(q);
      const rows = all(
        `SELECT l.id, l.first_name, l.last_name, l.phone_norm, l.temperature, l.status_key, l.created_at
         FROM leads l
         WHERE ${S} AND l.archived=0
           AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.lead_id=l.id AND a.status!='cancelled')
           ${treatment ? 'AND EXISTS (SELECT 1 FROM lead_treatments lt WHERE lt.lead_id=l.id AND lt.treatment_id=?)' : ''}
         ORDER BY l.score DESC LIMIT 40`, ...P, ...(treatment ? [treatment.id] : []),
      );
      return answer(
        `${rows.length} לידים${treatment ? ` בנושא ${treatment.name_he}` : ''} ללא תור`, rows, 'leads',
      );
    }
    // 3. Opened an email but never answered
    if (has('פתח מייל', 'פתחו מייל', 'فتح البريد')) {
      const rows = all(
        `SELECT DISTINCT l.id, l.first_name, l.last_name, l.phone_norm, l.temperature, l.score
         FROM leads l JOIN messages m ON m.lead_id=l.id
         WHERE ${S} AND m.channel='email' AND m.opens>0
           AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.lead_id=l.id AND x.direction='in')
           AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.lead_id=l.id AND c.outcome='answered')
         ORDER BY l.score DESC LIMIT 40`, ...P,
      );
      return answer(`${rows.length} לידים פתחו מייל ולא הגיבו`, rows, 'leads');
    }
    // 4. Hot leads from a given source this week
    if (has('חמים', 'חם', 'ساخن')) {
      const source = matchSource(q);
      const rows = all(
        `SELECT l.id, l.first_name, l.last_name, l.phone_norm, l.score, l.source, l.campaign_name
         FROM leads l WHERE ${S} AND l.temperature='hot' AND l.archived=0
           ${source ? 'AND l.source LIKE ?' : ''}
           ${has('שבוע', 'أسبوع') ? "AND l.created_at >= datetime('now','-7 days')" : ''}
         ORDER BY l.score DESC LIMIT 40`, ...P, ...(source ? [`%${source}%`] : []),
      );
      return answer(`${rows.length} לידים חמים${source ? ` מ-${source}` : ''}`, rows, 'leads');
    }
    // 5. Untouched leads
    if (has('לא טופל', 'לא טופלו', 'ללא טיפול', 'لم تتم معالجته')) {
      const rows = all(
        `SELECT l.id, l.first_name, l.last_name, l.phone_norm, l.created_at, l.source
         FROM leads l WHERE ${S} AND l.archived=0 AND l.first_response_at IS NULL
         ORDER BY l.created_at LIMIT 40`, ...P,
      );
      return answer(`${rows.length} לידים שלא טופלו כלל`, rows, 'leads');
    }
    // 6. Today's appointments
    if (has('תורים', 'תור היום', 'مواعيد')) {
      const rows = all(
        `SELECT a.id, a.start_at, a.status, a.lead_id, l.first_name, l.last_name, l.phone_norm,
                t.name_he AS title
         FROM appointments a JOIN leads l ON l.id=a.lead_id
         LEFT JOIN treatments t ON t.id=a.treatment_id
         WHERE date(a.start_at,'localtime')=date('now','localtime') AND a.status!='cancelled'
         ORDER BY a.start_at`,
      );
      return answer(`${rows.length} תורים היום`, rows, 'appointments');
    }
    // 7. Revenue question
    if (has('הכנסה', 'הכנסות', 'כסף', 'إيراد')) {
      const r = get(
        `SELECT COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(paid),0) AS paid, COUNT(*) AS deals
         FROM deals WHERE created_at >= datetime('now','-30 days')`,
      );
      return {
        text: `ב-30 הימים האחרונים נוצרו ${r.deals} עסקאות בהיקף ₪${Math.round(r.amount).toLocaleString('he-IL')}, מתוכן שולמו ₪${Math.round(r.paid).toLocaleString('he-IL')}.`,
        kind: 'stat',
        rows: [],
      };
    }

    // Fallback: free-text search over the customer base
    const term = `%${q}%`;
    const rows = all(
      `SELECT l.id, l.first_name, l.last_name, l.phone_norm, l.temperature, l.status_key FROM leads l
       WHERE ${S} AND (l.first_name LIKE ? OR l.last_name LIKE ? OR l.phone_norm LIKE ? OR l.email LIKE ?
             OR l.city LIKE ? OR l.campaign_name LIKE ?)
       LIMIT 30`, ...P, term, term, term, term, term, term,
    );
    return answer(
      rows.length ? `נמצאו ${rows.length} לקוחות התואמים לחיפוש` : 'לא הבנתי את השאלה — נסה: "מי צריך חזרה היום?"',
      rows, 'leads',
    );
  });

  router.get('/api/ai/suggestions', ({ req }) => {
    const user = requireUser(req);
    const scope = leadScopeSql(user, 'l');
    const rows = all(
      `SELECT l.id, l.first_name, l.last_name, l.score, l.temperature, l.phone_norm
       FROM leads l JOIN statuses s ON s.key=l.status_key
       WHERE ${scope.sql} AND l.archived=0 AND s.stage IN ('new','working')
       ORDER BY l.score DESC LIMIT 8`, ...scope.params,
    );
    return rows.map((r) => ({
      ...r,
      full_name: `${r.first_name} ${r.last_name}`.trim(),
      phone_pretty: prettyPhone(r.phone_norm),
      recommendation: nextBestAction(r.id),
    }));
  });
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const answer = (text, rows, kind) => ({ text, rows, kind });

function matchTreatment(q) {
  const rows = all('SELECT * FROM treatments WHERE active=1');
  return rows.find((t) => q.includes(t.name_he) || q.includes(t.name_ar)) ||
    rows.find((t) => q.includes(t.name_he.slice(0, 4)));
}
function matchSource(q) {
  const map = { פייסבוק: 'facebook', facebook: 'facebook', אינסטגרם: 'instagram', instagram: 'instagram',
    גוגל: 'google', google: 'google', 'דף נחיתה': 'landing', וואטסאפ: 'whatsapp' };
  for (const [k, v] of Object.entries(map)) if (q.toLowerCase().includes(k.toLowerCase())) return v;
  return null;
}
