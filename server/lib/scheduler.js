// Background ticker: reminders, overdue escalation, appointment reminders,
// delayed automation jobs and "untouched lead" rules (spec §17, §18, §40, §41).
import { all, get, run, update, setting, insert } from '../db.js';
import { nowIso, plusMinutes, notify, notifyManagers, parseJson } from './util.js';
import { executeActions, setAppointmentStatus } from './services.js';

let timer = null;

export function startScheduler(intervalMs = 60_000) {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((e) => console.error('[scheduler]', e));
  }, intervalMs);
  timer.unref?.();
  tick().catch((e) => console.error('[scheduler]', e));
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function tick() {
  const now = nowIso();
  const sla = setting('sla', { overdue_task_min: 15, escalate_min: 60, untouched_hours: 24 });

  // 1. Delayed automation jobs
  for (const job of all('SELECT * FROM automation_jobs WHERE done_at IS NULL AND run_at<=? LIMIT 50', now)) {
    update('automation_jobs', job.id, { done_at: nowIso() });
    const rule = job.automation_id ? get('SELECT * FROM automations WHERE id=?', job.automation_id) : null;
    if (rule && !rule.active) continue;
    await executeActions(rule, job.lead_id, parseJson(job.actions, []));
  }

  // 2. Task due → notify the assignee once
  for (const t of all(
    `SELECT t.*, l.first_name, l.last_name, l.phone_norm FROM tasks t
     LEFT JOIN leads l ON l.id=t.lead_id
     WHERE t.done_at IS NULL AND t.notified_at IS NULL AND t.due_at<=? LIMIT 100`, now,
  )) {
    update('tasks', t.id, { notified_at: nowIso() });
    notify(t.user_id, {
      type: 'task_due',
      title: `הגיע הזמן: ${t.title}`,
      body: t.lead_id ? `${t.first_name || ''} ${t.last_name || ''}`.trim() : '',
      leadId: t.lead_id,
      level: 'urgent',
    });
  }

  // 3. Overdue task → escalate to managers
  const escalateBefore = plusMinutes(-(sla.escalate_min ?? 60));
  for (const t of all(
    `SELECT t.*, l.first_name, l.last_name FROM tasks t
     LEFT JOIN leads l ON l.id=t.lead_id
     WHERE t.done_at IS NULL AND t.escalated_at IS NULL AND t.due_at<=? LIMIT 50`, escalateBefore,
  )) {
    update('tasks', t.id, { escalated_at: nowIso() });
    notifyManagers({
      type: 'task_overdue',
      title: 'משימה באיחור',
      body: `${t.title} — ${(t.first_name || '') + ' ' + (t.last_name || '')}`.trim(),
      leadId: t.lead_id,
      level: 'urgent',
    });
  }

  // 4. Appointment reminders
  for (const rule of all("SELECT * FROM automations WHERE active=1 AND trigger='appointment_upcoming'")) {
    const cond = parseJson(rule.conditions, {});
    const hours = cond.hours_before ?? 24;
    const windowEnd = plusMinutes(hours * 60);
    for (const a of all(
      `SELECT * FROM appointments
       WHERE reminded_at IS NULL AND status IN ('scheduled','confirmed')
         AND start_at > ? AND start_at <= ? LIMIT 50`, now, windowEnd,
    )) {
      update('appointments', a.id, { reminded_at: nowIso() });
      await executeActions(rule, a.lead_id, parseJson(rule.actions, []));
    }
  }

  // 5. Untouched leads
  for (const rule of all("SELECT * FROM automations WHERE active=1 AND trigger='no_touch'")) {
    const cond = parseJson(rule.conditions, {});
    const hours = cond.hours ?? 24;
    const cutoff = plusMinutes(-hours * 60);
    const stages = cond.status_stage || ['new', 'working'];
    const placeholders = stages.map(() => '?').join(',');
    const rows = all(
      `SELECT l.* FROM leads l
       JOIN statuses s ON s.key = l.status_key
       WHERE l.archived=0 AND s.stage IN (${placeholders})
         AND COALESCE(l.last_contact_at, l.created_at) <= ?
         AND NOT EXISTS (SELECT 1 FROM automation_log al WHERE al.automation_id=? AND al.lead_id=l.id)
       LIMIT 50`,
      ...stages, cutoff, rule.id,
    );
    for (const lead of rows) {
      run('INSERT OR IGNORE INTO automation_log(automation_id, lead_id, created_at) VALUES(?,?,?)',
        rule.id, lead.id, nowIso());
      await executeActions(rule, lead.id, parseJson(rule.actions, []));
      run('UPDATE automations SET runs=runs+1, last_run_at=? WHERE id=?', nowIso(), rule.id);
    }
  }

  // 6. Appointments that already ended without an outcome → mark no-show candidates
  for (const a of all(
    `SELECT * FROM appointments WHERE status IN ('scheduled','confirmed') AND end_at < ? LIMIT 50`,
    plusMinutes(-120),
  )) {
    notifyManagers({
      type: 'appointment_pending',
      title: 'תור ללא עדכון הגעה',
      body: `תור #${a.id} הסתיים ולא סומן הגיע/לא הגיע`,
      leadId: a.lead_id,
      level: 'warn',
    });
    setAppointmentStatus(a.id, 'no_show', null);
  }
}
