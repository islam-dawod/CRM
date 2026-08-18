// Global app state loaded once from /api/bootstrap.
import { api } from './api.js';
import { lang, nameOf } from './i18n.js';

export const store = {
  user: null,
  statuses: [],
  treatments: [],
  users: [],
  settings: {},
  permissions: {},
  sources: [],
  counts: { notifications: 0, inbox: 0, tasks: {} },
  listeners: new Set(),
};

export async function loadBootstrap() {
  const data = await api.get('/api/bootstrap');
  Object.assign(store, data);
  return store;
}

export function onChange(fn) {
  store.listeners.add(fn);
  return () => store.listeners.delete(fn);
}
export function emitChange() {
  store.listeners.forEach((fn) => fn());
}

// --------------------------------------------------------------- lookups ---
export const statusByKey = (key) => store.statuses.find((s) => s.key === key);
export const statusName = (key) => nameOf(statusByKey(key)) || key || '';
export const statusColor = (key) => statusByKey(key)?.color || '#64748b';
export const treatmentById = (id) => store.treatments.find((t) => t.id === Number(id));
export const treatmentName = (id) => nameOf(treatmentById(id));
export const userById = (id) => store.users.find((u) => u.id === Number(id));
export const userName = (id) => userById(id)?.name || '';
export const agents = () => store.users.filter((u) => ['agent', 'reception', 'manager'].includes(u.role));
export const doctors = () => store.users.filter((u) => u.role === 'doctor');

export const kanbanStatuses = () => store.statuses.filter((s) => s.in_kanban);

export const ROLE_LABEL = {
  admin: 'מנהל מערכת', manager: 'מנהל', agent: 'נציג', reception: 'קבלה', doctor: 'רופא',
};

export const OUTCOME_LABEL = {
  answered: 'ענה', no_answer: 'לא ענה', busy: 'תפוס', wrong_number: 'מספר שגוי',
  call_back: 'לחזור מאוחר יותר', appointment: 'נקבע תור', not_interested: 'לא מעוניין',
};

export const APPT_STATUS_LABEL = {
  scheduled: 'נקבע', confirmed: 'אושר', arrived: 'הגיע', no_show: 'לא הגיע',
  cancelled: 'בוטל', done: 'בוצע',
};
export const APPT_STATUS_COLOR = {
  scheduled: '#22c55e', confirmed: '#16a34a', arrived: '#10b981', no_show: '#dc2626',
  cancelled: '#94a3b8', done: '#15803d',
};

export const DEAL_STAGE_LABEL = {
  quoted: 'הצעת מחיר', approved: 'אושר', in_treatment: 'בטיפול', completed: 'הושלם', cancelled: 'בוטל',
};

export const TRIGGER_LABEL = {
  lead_created: 'ליד חדש נכנס',
  status_changed: 'שינוי סטטוס',
  no_answer: 'שיחה ללא מענה',
  no_touch: 'ליד ללא טיפול X שעות',
  appointment_created: 'נקבע תור',
  appointment_upcoming: 'תור מתקרב',
  message_in: 'הודעה נכנסת מלקוח',
};

export const ACTION_LABEL = {
  send_whatsapp: 'שליחת WhatsApp',
  send_email: 'שליחת מייל',
  create_task: 'יצירת משימה',
  set_status: 'שינוי סטטוס',
  assign: 'הקצאת נציג',
  notify_manager: 'התראה למנהל',
  notify_owner: 'התראה לנציג',
  add_note: 'הוספת הערה',
};
