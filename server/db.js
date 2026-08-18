// Database layer — node:sqlite (built into Node >= 22.5, zero external deps)
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
export const DATA_DIR = process.env.CRM_DATA_DIR || join(ROOT, 'data');
export const UPLOAD_DIR = join(DATA_DIR, 'uploads');

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'crm.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'agent',   -- admin|manager|agent|reception|doctor
  lang          TEXT NOT NULL DEFAULT 'he',
  color         TEXT,
  specialties   TEXT,                            -- JSON array of treatment ids
  receives_leads INTEGER NOT NULL DEFAULT 1,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Editable pipeline statuses (spec §4: "הסטטוסים יהיו ניתנים לעריכה על ידי מנהל המערכת")
CREATE TABLE IF NOT EXISTS statuses (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  key       TEXT NOT NULL UNIQUE,
  name_he   TEXT NOT NULL,
  name_ar   TEXT NOT NULL,
  name_en   TEXT NOT NULL,
  color     TEXT NOT NULL DEFAULT '#64748b',
  stage     TEXT NOT NULL DEFAULT 'open',  -- new|working|scheduled|arrived|treatment|won|lost
  in_kanban INTEGER NOT NULL DEFAULT 1,
  sort      INTEGER NOT NULL DEFAULT 0,
  active    INTEGER NOT NULL DEFAULT 1
);

-- Editable treatment catalogue (spec §5)
CREATE TABLE IF NOT EXISTS treatments (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name_he  TEXT NOT NULL,
  name_ar  TEXT NOT NULL,
  name_en  TEXT NOT NULL,
  color    TEXT NOT NULL DEFAULT '#0ea5e9',
  price    REAL NOT NULL DEFAULT 0,
  sort     INTEGER NOT NULL DEFAULT 0,
  active   INTEGER NOT NULL DEFAULT 1
);

-- One customer -> one card (spec §58)
CREATE TABLE IF NOT EXISTS leads (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name     TEXT NOT NULL DEFAULT '',
  last_name      TEXT NOT NULL DEFAULT '',
  phone          TEXT,
  phone_norm     TEXT,
  whatsapp       TEXT,
  email          TEXT,
  language       TEXT NOT NULL DEFAULT 'he',
  city           TEXT,
  gender         TEXT,
  birth_date     TEXT,
  status_key     TEXT NOT NULL DEFAULT 'new',
  temperature    TEXT NOT NULL DEFAULT 'warm',   -- hot|warm|cold
  score          INTEGER NOT NULL DEFAULT 0,
  owner_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source         TEXT NOT NULL DEFAULT 'manual',
  campaign_name  TEXT,
  ad_name        TEXT,
  ad_set         TEXT,
  utm_source     TEXT,
  utm_campaign   TEXT,
  utm_medium     TEXT,
  utm_content    TEXT,
  utm_term       TEXT,
  landing_page   TEXT,
  external_id    TEXT,
  next_action_at TEXT,
  first_response_at TEXT,
  last_contact_at   TEXT,
  arrived_at     TEXT,
  closed_at      TEXT,
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  archived       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_phone   ON leads(phone_norm);
CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads(status_key);
CREATE INDEX IF NOT EXISTS idx_leads_owner   ON leads(owner_id);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);

CREATE TABLE IF NOT EXISTS lead_treatments (
  lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  treatment_id INTEGER NOT NULL REFERENCES treatments(id) ON DELETE CASCADE,
  PRIMARY KEY (lead_id, treatment_id)
);

-- Every inquiry, even a repeat one from a known phone number (spec §27)
CREATE TABLE IF NOT EXISTS lead_submissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id       INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  source        TEXT,
  campaign_name TEXT,
  ad_name       TEXT,
  ad_set        TEXT,
  utm           TEXT,          -- JSON
  payload       TEXT,          -- JSON raw
  is_duplicate  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Chronological customer history (spec §8)
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,   -- lead_created|status|call|whatsapp|email|email_open|email_click|note|task|appointment|assign|document|automation|payment
  actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  meta       TEXT,            -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id, id);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL,           -- whatsapp|email|facebook|instagram|sms
  direction    TEXT NOT NULL,           -- in|out
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  subject      TEXT,
  body         TEXT NOT NULL DEFAULT '',
  media        TEXT,                    -- JSON array of {name,url,mime}
  status       TEXT NOT NULL DEFAULT 'sent',  -- queued|sent|delivered|read|opened|clicked|failed
  opens        INTEGER NOT NULL DEFAULT 0,
  clicks       INTEGER NOT NULL DEFAULT 0,
  first_open_at TEXT,
  last_open_at  TEXT,
  tracking_id  TEXT UNIQUE,
  external_id  TEXT,
  read_at      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_msg_lead ON messages(lead_id, id);
CREATE INDEX IF NOT EXISTS idx_msg_inbox ON messages(channel, direction, read_at);

CREATE TABLE IF NOT EXISTS calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  direction    TEXT NOT NULL DEFAULT 'out',
  outcome      TEXT NOT NULL,     -- answered|no_answer|busy|wrong_number|call_back|appointment|not_interested
  duration_sec INTEGER NOT NULL DEFAULT 0,
  summary      TEXT,
  ai_summary   TEXT,
  recording_url TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls(lead_id);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  note        TEXT,
  kind        TEXT NOT NULL DEFAULT 'callback',  -- callback|whatsapp|email|meeting|other
  priority    TEXT NOT NULL DEFAULT 'normal',    -- low|normal|urgent
  due_at      TEXT NOT NULL,
  done_at     TEXT,
  snoozed_to  TEXT,
  notified_at TEXT,
  escalated_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(done_at, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, done_at);

CREATE TABLE IF NOT EXISTS appointments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id       INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  treatment_id  INTEGER REFERENCES treatments(id) ON DELETE SET NULL,
  doctor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  branch        TEXT,
  start_at      TEXT NOT NULL,
  end_at        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|confirmed|arrived|no_show|cancelled|done
  notes         TEXT,
  confirm_token TEXT UNIQUE,
  confirmed_at  TEXT,
  arrived_at    TEXT,
  reminded_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appt_start ON appointments(start_at);
CREATE INDEX IF NOT EXISTS idx_appt_lead ON appointments(lead_id);

-- Revenue (spec §24)
CREATE TABLE IF NOT EXISTS deals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  treatment_id INTEGER REFERENCES treatments(id) ON DELETE SET NULL,
  title        TEXT,
  amount       REAL NOT NULL DEFAULT 0,
  paid         REAL NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'ILS',
  stage        TEXT NOT NULL DEFAULT 'quoted', -- quoted|approved|in_treatment|completed|cancelled
  due_date     TEXT,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deals_lead ON deals(lead_id);

CREATE TABLE IF NOT EXISTS payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id    INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  amount     REAL NOT NULL,
  method     TEXT,
  paid_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime        TEXT,
  size        INTEGER NOT NULL DEFAULT 0,
  kind        TEXT DEFAULT 'other',
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_id    INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  level      TEXT NOT NULL DEFAULT 'info',   -- info|warn|urgent
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at, id);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entity     TEXT NOT NULL,
  entity_id  INTEGER,
  action     TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(id DESC);

CREATE TABLE IF NOT EXISTS templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel    TEXT NOT NULL,      -- whatsapp|email
  key        TEXT,
  name       TEXT NOT NULL,
  lang       TEXT NOT NULL DEFAULT 'he',
  subject    TEXT,
  body       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS automations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  trigger     TEXT NOT NULL,   -- lead_created|status_changed|no_answer|no_touch|appointment_created|appointment_upcoming|message_in
  conditions  TEXT NOT NULL DEFAULT '{}',
  actions     TEXT NOT NULL DEFAULT '[]',
  delay_min   INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  runs        INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Queue for delayed automation actions
CREATE TABLE IF NOT EXISTS automation_jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id INTEGER REFERENCES automations(id) ON DELETE CASCADE,
  lead_id       INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  run_at        TEXT NOT NULL,
  actions       TEXT NOT NULL,
  done_at       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_run ON automation_jobs(done_at, run_at);

-- Prevents an automation firing twice for the same lead+rule
CREATE TABLE IF NOT EXISTS automation_log (
  automation_id INTEGER NOT NULL,
  lead_id       INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (automation_id, lead_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mentions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------------------------------------------------------------------------
// Tiny query helpers
// ---------------------------------------------------------------------------
export function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}
export function get(sql, ...params) {
  return db.prepare(sql).get(...params);
}
export function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}
const columnCache = new Map();
export function columns(table) {
  if (!columnCache.has(table)) {
    columnCache.set(table, new Set(all(`PRAGMA table_info(${table})`).map((c) => c.name)));
  }
  return columnCache.get(table);
}

export function insert(table, obj) {
  // Keep every timestamp in the same ISO-8601 UTC format so string ordering works.
  if (columns(table).has('created_at') && obj.created_at === undefined) {
    obj = { ...obj, created_at: new Date().toISOString() };
  }
  const keys = Object.keys(obj);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  const res = db.prepare(sql).run(...keys.map((k) => norm(obj[k])));
  return Number(res.lastInsertRowid);
}
export function update(table, id, obj) {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  if (!keys.length) return 0;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`;
  return db.prepare(sql).run(...keys.map((k) => norm(obj[k])), id).changes;
}
function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

export function setting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key=?', key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}
export function setSetting(key, value) {
  run(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    key,
    JSON.stringify(value),
  );
}

export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
