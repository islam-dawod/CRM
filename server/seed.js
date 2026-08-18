// Seeds reference data (statuses, treatments, roles, templates, automations)
// and — with --demo — a realistic set of leads so the UI has something to show.
import { db, all, get, run, insert, setSetting, setting, DATA_DIR } from './db.js';
import { hashPassword } from './lib/auth.js';
import { nowIso, plusMinutes, plusDays, normalizePhone, recomputeScore, token } from './lib/util.js';

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------
export const STATUSES = [
  ['new',                  'ליד חדש',            'عميل محتمل جديد',   'New lead',            '#3b82f6', 'new',       1],
  ['contacted',            'נוצר קשר',           'تم التواصل',        'Contacted',           '#6366f1', 'working',   1],
  ['no_answer',            'לא ענה',             'لم يرد',            'No answer',           '#f59e0b', 'working',   1],
  ['attempt_1',            'ניסיון התקשרות 1',   'محاولة اتصال 1',    'Attempt 1',           '#fbbf24', 'working',   0],
  ['attempt_2',            'ניסיון התקשרות 2',   'محاولة اتصال 2',    'Attempt 2',           '#fbbf24', 'working',   0],
  ['attempt_3',            'ניסיון התקשרות 3',   'محاولة اتصال 3',    'Attempt 3',           '#f97316', 'working',   0],
  ['call_back',            'לחזור מאוחר יותר',   'معاودة الاتصال',    'Call back later',     '#a855f7', 'working',   1],
  ['wrong_number',         'מספר לא נכון',       'رقم خاطئ',          'Wrong number',        '#94a3b8', 'lost',      0],
  ['interested',           'מתעניין',            'مهتم',              'Interested',          '#14b8a6', 'working',   0],
  ['needs_consult',        'צריך ייעוץ',         'بحاجة لاستشارة',    'Needs consultation',  '#06b6d4', 'working',   0],
  ['awaiting_decision',    'ממתין להחלטה',       'بانتظار القرار',    'Awaiting decision',   '#8b5cf6', 'working',   0],
  ['appointment_set',      'נקבע תור',           'تم تحديد موعد',     'Appointment set',     '#22c55e', 'scheduled', 1],
  ['appointment_confirmed','תור אושר',           'تم تأكيد الموعد',   'Appointment confirmed','#16a34a','scheduled', 1],
  ['appointment_cancelled','ביטל תור',           'ألغى الموعد',       'Appointment cancelled','#ef4444','working',   0],
  ['no_show',              'לא הגיע',            'لم يحضر',           'No show',             '#dc2626', 'working',   0],
  ['arrived',              'הגיע למרפאה',        'وصل للعيادة',       'Arrived',             '#10b981', 'arrived',   1],
  ['consulted',            'עבר ייעוץ',          'تمت الاستشارة',     'Consulted',           '#0ea5e9', 'arrived',   0],
  ['quote_sent',           'קיבל הצעה',          'استلم عرض سعر',     'Quote sent',          '#0284c7', 'treatment', 0],
  ['treatment_approved',   'אישר טיפול',         'وافق على العلاج',   'Treatment approved',  '#059669', 'treatment', 0],
  ['treatment_started',    'התחיל טיפול',        'بدأ العلاج',        'Treatment started',   '#047857', 'treatment', 0],
  ['treatment_done',       'טיפול הסתיים',       'انتهى العلاج',      'Treatment completed', '#15803d', 'won',       1],
  ['not_interested',       'לא מעוניין',         'غير مهتم',          'Not interested',      '#64748b', 'lost',      1],
  ['irrelevant',           'ליד לא רלוונטי',     'غير ذي صلة',        'Irrelevant',          '#475569', 'lost',      0],
];

export const TREATMENTS = [
  ['השתלות שיניים', 'زراعة الأسنان',   'Dental implants',  '#0ea5e9', 14000],
  ['יישור שיניים',  'تقويم الأسنان',   'Orthodontics',     '#8b5cf6', 18000],
  ['ניתוח',         'عملية جراحية',    'Oral surgery',     '#ef4444', 9000],
  ['ייעוץ',         'استشارة',         'Consultation',     '#22c55e', 250],
  ['טיפול שיניים',  'علاج الأسنان',    'General dentistry','#f59e0b', 800],
  ['אסתטיקה',       'تجميل الأسنان',   'Aesthetics',       '#ec4899', 6500],
  ['טיפול אחר',     'علاج آخر',        'Other',            '#64748b', 0],
];

const USERS = [
  { name: 'איסלאם (מנהל מערכת)', email: 'admin@clinic.local',     role: 'admin',     color: '#0f172a' },
  { name: 'עומר מנהל',            email: 'manager@clinic.local',   role: 'manager',   color: '#7c3aed' },
  { name: 'רנא',                  email: 'rana@clinic.local',      role: 'agent',     color: '#0ea5e9' },
  { name: 'סאלי',                 email: 'sally@clinic.local',     role: 'agent',     color: '#f59e0b' },
  { name: 'מרים',                 email: 'mariam@clinic.local',    role: 'agent',     color: '#ec4899' },
  { name: 'נור (קבלה)',           email: 'reception@clinic.local', role: 'reception', color: '#14b8a6' },
  { name: 'ד"ר ח\'אלד',           email: 'doctor@clinic.local',    role: 'doctor',    color: '#22c55e' },
];

const WA_TEMPLATES = [
  ['new_lead', 'ליד חדש — תודה על הפנייה', 'he',
    'שלום {{first_name}}, תודה שפנית אלינו בנושא {{treatment}}. נציג/ת המרפאה יחזור אליך בהקדם. 🦷'],
  ['no_answer', 'לא ענה — מתי נוח לדבר?', 'he',
    'שלום {{first_name}}, ניסינו ליצור איתך קשר בעקבות פנייתך בנושא {{treatment}}. מתי יהיה נוח לדבר?'],
  ['appointment_reminder', 'תזכורת תור', 'he',
    'שלום {{first_name}}, מזכירים לך על התור שנקבע ל-{{appointment_date}} בשעה {{appointment_time}}. נשמח לראותך!'],
  ['appointment_confirm', 'אישור תור', 'he',
    'שלום {{first_name}}, נקבע עבורך תור במרפאה בתאריך {{appointment_date}} בשעה {{appointment_time}}. אנא אשר/י הגעה.'],
  ['price_quote', 'שליחת הצעת מחיר', 'he',
    'שלום {{first_name}}, מצורפת הצעת המחיר עבור {{treatment}}. נשמח לענות על כל שאלה.'],
  ['new_lead_ar', 'عميل جديد — شكراً لتواصلك', 'ar',
    'مرحباً {{first_name}}، شكراً لتواصلك معنا بخصوص {{treatment}}. سيتواصل معك أحد ممثلي العيادة قريباً. 🦷'],
  ['no_answer_ar', 'لم يرد — متى يناسبك؟', 'ar',
    'مرحباً {{first_name}}، حاولنا التواصل معك بخصوص {{treatment}}. متى يناسبك التحدث؟'],
  ['appointment_reminder_ar', 'تذكير بالموعد', 'ar',
    'مرحباً {{first_name}}، نذكرك بموعدك بتاريخ {{appointment_date}} الساعة {{appointment_time}}.'],
];

const EMAIL_TEMPLATES = [
  ['consult_info', 'פרטי הייעוץ שלך במרפאה', 'he', 'פרטי הייעוץ שלך במרפאה',
    'שלום {{first_name}},\n\nתודה על פנייתך בנושא {{treatment}}.\nהייעוץ במרפאה כולל בדיקה, צילום ותוכנית טיפול אישית.\n\nנשמח לתאם עבורך מועד נוח.\n\nבברכה,\n{{owner}} | {{clinic}}'],
  ['price_offer', 'הצעת מחיר', 'he', 'הצעת מחיר עבור {{treatment}}',
    'שלום {{first_name}},\n\nמצורפת הצעת המחיר עבור {{treatment}}.\nההצעה תקפה ל-30 יום וכוללת ליווי מלא לאורך הטיפול.\n\nבברכה,\n{{owner}} | {{clinic}}'],
  ['treatment_info', 'מידע על הטיפול', 'he', 'כל מה שחשוב לדעת על {{treatment}}',
    'שלום {{first_name}},\n\nריכזנו עבורך את המידע החשוב על {{treatment}}: שלבי הטיפול, זמני החלמה ואפשרויות מימון.\n\nבברכה,\n{{clinic}}'],
  ['appointment_reminder', 'תזכורת תור', 'he', 'תזכורת: תור ב-{{appointment_date}}',
    'שלום {{first_name}},\n\nתזכורת לתור שנקבע ל-{{appointment_date}} בשעה {{appointment_time}}.\n\nנשמח לראותך,\n{{clinic}}'],
  ['post_treatment', 'לאחר טיפול', 'he', 'איך אתה מרגיש אחרי הטיפול?',
    'שלום {{first_name}},\n\nמקווים שאתה מרגיש טוב לאחר הטיפול. אם יש שאלה או אי-נוחות — אנחנו כאן.\n\nבברכה,\n{{clinic}}'],
  ['follow_up', 'Follow-up', 'he', 'עדיין מתעניין ב{{treatment}}?',
    'שלום {{first_name}},\n\nרצינו לבדוק אם עדיין רלוונטי עבורך הטיפול בנושא {{treatment}}.\nנשמח לתאם ייעוץ ללא התחייבות.\n\nבברכה,\n{{owner}}'],
];

const AUTOMATIONS = [
  {
    name: 'ליד חדש — וואטסאפ + מייל + משימה',
    trigger: 'lead_created',
    conditions: {},
    delay_min: 0,
    actions: [
      { type: 'send_whatsapp', template: 'new_lead' },
      { type: 'send_email', template: 'consult_info' },
      { type: 'create_task', title: 'ליד חדש — ליצור קשר', in_minutes: 15, priority: 'urgent' },
    ],
  },
  {
    name: 'אין מענה אחרי 3 שעות — תזכורת',
    trigger: 'no_touch',
    conditions: { hours: 3, status_stage: ['new'] },
    delay_min: 0,
    actions: [{ type: 'create_task', title: 'ליד לא טופל 3 שעות', in_minutes: 0, priority: 'urgent' }],
  },
  {
    name: 'ליד ללא טיפול 24 שעות — התראה למנהל',
    trigger: 'no_touch',
    conditions: { hours: 24, status_stage: ['new', 'working'] },
    delay_min: 0,
    actions: [{ type: 'notify_manager', title: 'ליד ללא טיפול מעל 24 שעות' }],
  },
  {
    name: 'לא ענה — וואטסאפ אוטומטי + משימה מחר',
    trigger: 'status_changed',
    conditions: { to: ['no_answer', 'attempt_2'] },
    delay_min: 180,
    actions: [
      { type: 'send_whatsapp', template: 'no_answer' },
      { type: 'create_task', title: 'ניסיון חוזר — לא ענה', in_minutes: 1440, priority: 'normal' },
      { type: 'set_status', status: 'attempt_2' },
    ],
  },
  {
    name: 'נקבע תור — שליחת אישור',
    trigger: 'appointment_created',
    conditions: {},
    delay_min: 0,
    actions: [{ type: 'send_whatsapp', template: 'appointment_confirm' }],
  },
  {
    name: 'תזכורת תור 24 שעות מראש',
    trigger: 'appointment_upcoming',
    conditions: { hours_before: 24 },
    delay_min: 0,
    actions: [{ type: 'send_whatsapp', template: 'appointment_reminder' }],
  },
];

// ---------------------------------------------------------------------------
export function seedReference() {
  for (const [i, s] of STATUSES.entries()) {
    const [key, he, ar, en, color, stage, kanban] = s;
    if (get('SELECT 1 AS x FROM statuses WHERE key=?', key)) continue;
    insert('statuses', {
      key, name_he: he, name_ar: ar, name_en: en, color, stage, in_kanban: kanban, sort: i, active: 1,
    });
  }
  for (const [i, t] of TREATMENTS.entries()) {
    const [he, ar, en, color, price] = t;
    if (get('SELECT 1 AS x FROM treatments WHERE name_he=?', he)) continue;
    insert('treatments', { name_he: he, name_ar: ar, name_en: en, color, price, sort: i, active: 1 });
  }
  for (const u of USERS) {
    if (get('SELECT 1 AS x FROM users WHERE email=?', u.email)) continue;
    insert('users', {
      name: u.name,
      email: u.email,
      password_hash: hashPassword(process.env.CRM_SEED_PASSWORD || '123456'),
      role: u.role,
      color: u.color,
      lang: 'he',
      receives_leads: u.role === 'agent' ? 1 : 0,
      active: 1,
    });
  }
  for (const [key, name, lang, body] of WA_TEMPLATES) {
    if (get('SELECT 1 AS x FROM templates WHERE channel=? AND key=?', 'whatsapp', key)) continue;
    insert('templates', { channel: 'whatsapp', key, name, lang, body, active: 1 });
  }
  for (const [key, name, lang, subject, body] of EMAIL_TEMPLATES) {
    if (get('SELECT 1 AS x FROM templates WHERE channel=? AND key=?', 'email', key)) continue;
    insert('templates', { channel: 'email', key, name, lang, subject, body, active: 1 });
  }
  for (const a of AUTOMATIONS) {
    if (get('SELECT 1 AS x FROM automations WHERE name=?', a.name)) continue;
    insert('automations', {
      name: a.name,
      trigger: a.trigger,
      conditions: JSON.stringify(a.conditions),
      actions: JSON.stringify(a.actions),
      delay_min: a.delay_min,
      active: 1,
    });
  }
  if (setting('clinic') == null) {
    setSetting('clinic', {
      name: 'Elite Dental',
      phone: '04-000-0000',
      address: 'חיפה',
      timezone: 'Asia/Jerusalem',
      branches: ['ראשי', 'סניף צפון'],
      default_lang: 'he',
      country_code: '972',
    });
  }
  if (setting('assignment') == null) {
    setSetting('assignment', { mode: 'round_robin', last_user_id: null, by_specialty: false });
  }
  if (setting('sla') == null) {
    setSetting('sla', { first_response_min: 15, overdue_task_min: 15, escalate_min: 60, untouched_hours: 24 });
  }
  if (setting('integrations') == null) {
    setSetting('integrations', {
      whatsapp: { provider: 'simulator', phone_number_id: '', token: '', verify_token: 'crm-verify' },
      email: { provider: 'simulator', from: 'clinic@example.com', smtp_host: '', smtp_user: '' },
      facebook: { verify_token: 'crm-verify', page_id: '' },
      webhook_key: token(12),
    });
  }
}

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------
const FIRST = ['מוחמד', 'סוהא', 'יוסף', 'לינא', 'ראמי', 'אמירה', 'סמיר', 'נור', 'חנאן', 'טארק', 'מיסא', 'עלי',
  'רים', 'ג\'ריס', 'סאלם', 'הבה', 'איאד', 'שירין', 'בשאר', 'דלאל', 'עומר', 'ראניה', 'כרים', 'מאיה'];
const LAST = ['עלי', 'חסן', 'חורי', 'זועבי', 'עואד', 'סרור', 'דאהר', 'נסאר', 'עבאס', 'שחאדה', 'מנסור', 'ג\'בר'];
const CITIES = ['חיפה', 'נצרת', 'עכו', 'שפרעם', 'טמרה', 'סח\'נין', 'כרמיאל', 'טירה', 'באקה', 'ירושלים'];
const SOURCES = ['facebook_lead_ads', 'facebook_campaign', 'instagram', 'landing_page', 'website', 'whatsapp', 'google_ads', 'phone', 'manual'];
const CAMPAIGNS = [
  { name: 'Implant Campaign August', ad: 'Implant Video A', set: 'Haifa 30-60', utm: 'facebook', med: 'cpc' },
  { name: 'Ortho Teens Summer', ad: 'Braces Carousel', set: 'North 15-25', utm: 'facebook', med: 'cpc' },
  { name: 'Google Search — Implants', ad: 'Exact — dental implant', set: 'Search IL', utm: 'google', med: 'cpc' },
  { name: 'Aesthetics Instagram', ad: 'Smile Reel', set: 'Lookalike 1%', utm: 'instagram', med: 'social' },
  { name: 'Landing — Free Consult', ad: 'LP Hero', set: '-', utm: 'landing', med: 'referral' },
];

let rngState = 42;
function rnd() {
  rngState = (rngState * 1664525 + 1013904223) % 4294967296;
  return rngState / 4294967296;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

export function seedDemo(count = 70) {
  if (get('SELECT COUNT(*) AS n FROM leads').n > 0) {
    console.log('· leads already exist — skipping demo data');
    return;
  }
  const agents = all("SELECT * FROM users WHERE role='agent'");
  const doctors = all("SELECT * FROM users WHERE role='doctor'");
  const treatments = all('SELECT * FROM treatments');
  const now = Date.now();
  let phoneSeq = 5200000;

  for (let i = 0; i < count; i++) {
    const createdDaysAgo = Math.floor(rnd() * 45);
    const created = new Date(now - createdDaysAgo * 86400000 - int(0, 20) * 3600000);
    const first = pick(FIRST);
    const last = pick(LAST);
    const source = pick(SOURCES);
    const camp = ['facebook_lead_ads', 'facebook_campaign', 'instagram', 'google_ads', 'landing_page'].includes(source)
      ? pick(CAMPAIGNS)
      : null;
    const owner = pick(agents);
    const phone = normalizePhone('0' + (phoneSeq++));
    const treatment = pick(treatments);
    const lang = chance(0.35) ? 'ar' : 'he';

    // Where in the funnel did this lead end up?
    const roll = rnd();
    let statusKey = 'new';
    if (roll > 0.9) statusKey = 'treatment_done';
    else if (roll > 0.82) statusKey = 'treatment_started';
    else if (roll > 0.74) statusKey = 'arrived';
    else if (roll > 0.64) statusKey = 'appointment_confirmed';
    else if (roll > 0.56) statusKey = 'appointment_set';
    else if (roll > 0.46) statusKey = 'interested';
    else if (roll > 0.36) statusKey = 'call_back';
    else if (roll > 0.26) statusKey = 'no_answer';
    else if (roll > 0.18) statusKey = 'not_interested';
    else if (roll > 0.08) statusKey = 'contacted';
    if (createdDaysAgo < 1 && roll > 0.4) statusKey = 'new';

    const leadId = insert('leads', {
      first_name: first,
      last_name: last,
      phone,
      phone_norm: phone,
      whatsapp: phone,
      email: chance(0.75) ? `lead${i}@example.com` : null,
      language: lang,
      city: pick(CITIES),
      status_key: statusKey,
      owner_id: statusKey === 'new' && chance(0.3) ? null : owner.id,
      source,
      campaign_name: camp?.name || null,
      ad_name: camp?.ad || null,
      ad_set: camp?.set || null,
      utm_source: camp?.utm || null,
      utm_campaign: camp?.name || null,
      utm_medium: camp?.med || null,
      utm_content: camp?.ad || null,
      landing_page: source === 'landing_page' ? '/lp/implants' : null,
      created_at: created.toISOString(),
      updated_at: created.toISOString(),
    });
    insert('lead_treatments', { lead_id: leadId, treatment_id: treatment.id });
    if (chance(0.2)) {
      const extra = pick(treatments);
      if (extra.id !== treatment.id) insert('lead_treatments', { lead_id: leadId, treatment_id: extra.id });
    }
    insert('lead_submissions', {
      lead_id: leadId,
      source,
      campaign_name: camp?.name || null,
      ad_name: camp?.ad || null,
      ad_set: camp?.set || null,
      utm: JSON.stringify({ source: camp?.utm, campaign: camp?.name, medium: camp?.med }),
      payload: JSON.stringify({ full_name: `${first} ${last}`, phone, treatment: treatment.name_he }),
      created_at: created.toISOString(),
    });
    insert('events', {
      lead_id: leadId,
      type: 'lead_created',
      title: `הליד התקבל מ-${source}`,
      meta: JSON.stringify({ source, campaign: camp?.name }),
      created_at: created.toISOString(),
    });

    if (statusKey === 'new') {
      run('UPDATE leads SET score=?, temperature=? WHERE id=?', 20, 'cold', leadId);
      continue;
    }

    // First response
    const respMin = int(2, 240);
    const firstResp = new Date(created.getTime() + respMin * 60000);
    run('UPDATE leads SET first_response_at=?, last_contact_at=? WHERE id=?',
      firstResp.toISOString(), firstResp.toISOString(), leadId);

    // Calls
    const callCount = int(1, 4);
    let t = firstResp.getTime();
    for (let c = 0; c < callCount; c++) {
      const outcome = c === callCount - 1
        ? (['appointment_set', 'appointment_confirmed', 'arrived', 'treatment_started', 'treatment_done'].includes(statusKey)
            ? 'appointment'
            : statusKey === 'not_interested' ? 'not_interested' : pick(['answered', 'no_answer', 'call_back']))
        : pick(['no_answer', 'answered', 'busy']);
      const at = new Date(t + c * int(1, 20) * 3600000);
      insert('calls', {
        lead_id: leadId,
        user_id: owner.id,
        outcome,
        duration_sec: outcome === 'answered' || outcome === 'appointment' ? int(45, 420) : 0,
        summary: outcome === 'answered' ? 'הלקוח ביקש פרטים על מחיר ומשך הטיפול.' : null,
        created_at: at.toISOString(),
      });
      insert('events', {
        lead_id: leadId, type: 'call', actor_id: owner.id,
        title: `שיחה — ${outcome}`, created_at: at.toISOString(),
      });
    }

    // WhatsApp thread
    if (chance(0.8)) {
      const at = new Date(firstResp.getTime() + 5 * 60000);
      insert('messages', {
        lead_id: leadId, channel: 'whatsapp', direction: 'out', user_id: owner.id,
        body: `שלום ${first}, תודה שפנית אלינו בנושא ${treatment.name_he}. נציג המרפאה יחזור אליך בהקדם.`,
        status: 'delivered', created_at: at.toISOString(),
      });
      if (chance(0.55)) {
        const reply = new Date(at.getTime() + int(4, 90) * 60000);
        insert('messages', {
          lead_id: leadId, channel: 'whatsapp', direction: 'in',
          body: pick(['שלום, אני יכול להגיע ביום חמישי?', 'כמה עולה הטיפול?', 'مرحبا، متى يمكنني الحضور؟', 'אשמח לפרטים נוספים']),
          status: 'read', read_at: chance(0.7) ? reply.toISOString() : null, created_at: reply.toISOString(),
        });
      }
    }

    // Email + tracking
    if (chance(0.6)) {
      const at = new Date(firstResp.getTime() + 20 * 60000);
      const opens = chance(0.5) ? int(1, 3) : 0;
      insert('messages', {
        lead_id: leadId, channel: 'email', direction: 'out', user_id: owner.id,
        subject: 'פרטי הייעוץ שלך במרפאה',
        body: `שלום ${first},\n\nתודה על פנייתך בנושא ${treatment.name_he}.`,
        status: opens ? 'opened' : 'delivered',
        opens,
        clicks: opens && chance(0.4) ? 1 : 0,
        first_open_at: opens ? new Date(at.getTime() + 3600000).toISOString() : null,
        last_open_at: opens ? new Date(at.getTime() + 7200000).toISOString() : null,
        tracking_id: token(10),
        created_at: at.toISOString(),
      });
    }

    // Appointment
    if (['appointment_set', 'appointment_confirmed', 'arrived', 'treatment_started', 'treatment_done', 'no_show'].includes(statusKey)) {
      const future = ['appointment_set', 'appointment_confirmed'].includes(statusKey);
      const start = future
        ? new Date(now + int(0, 10) * 86400000 + int(8, 17) * 3600000)
        : new Date(created.getTime() + int(2, 12) * 86400000);
      start.setMinutes(chance(0.5) ? 0 : 30, 0, 0);
      const apptStatus = statusKey === 'appointment_set' ? 'scheduled'
        : statusKey === 'appointment_confirmed' ? 'confirmed'
        : statusKey === 'no_show' ? 'no_show'
        : statusKey === 'arrived' ? 'arrived' : 'done';
      const apptId = insert('appointments', {
        lead_id: leadId,
        treatment_id: treatment.id,
        doctor_id: pick(doctors)?.id || null,
        created_by: owner.id,
        branch: 'ראשי',
        start_at: start.toISOString(),
        end_at: new Date(start.getTime() + 45 * 60000).toISOString(),
        status: apptStatus,
        confirm_token: token(10),
        confirmed_at: ['confirmed', 'arrived', 'done'].includes(apptStatus) ? start.toISOString() : null,
        arrived_at: ['arrived', 'done'].includes(apptStatus) ? start.toISOString() : null,
        created_at: new Date(start.getTime() - 3 * 86400000).toISOString(),
      });
      insert('events', {
        lead_id: leadId, type: 'appointment', actor_id: owner.id,
        title: 'נקבע תור', meta: JSON.stringify({ appointment_id: apptId }),
        created_at: new Date(start.getTime() - 3 * 86400000).toISOString(),
      });
      if (['arrived', 'treatment_started', 'treatment_done'].includes(statusKey)) {
        run('UPDATE leads SET arrived_at=? WHERE id=?', start.toISOString(), leadId);
      }
    }

    // Deals / revenue
    if (['treatment_started', 'treatment_done'].includes(statusKey)) {
      const amount = treatment.price ? treatment.price * (0.8 + rnd() * 0.6) : int(2000, 20000);
      const paid = statusKey === 'treatment_done' ? amount : amount * (0.2 + rnd() * 0.4);
      const dealId = insert('deals', {
        lead_id: leadId,
        treatment_id: treatment.id,
        title: treatment.name_he,
        amount: Math.round(amount / 100) * 100,
        paid: Math.round(paid / 100) * 100,
        stage: statusKey === 'treatment_done' ? 'completed' : 'in_treatment',
        created_by: owner.id,
        created_at: new Date(created.getTime() + 10 * 86400000).toISOString(),
      });
      insert('payments', { deal_id: dealId, amount: Math.round(paid / 100) * 100, method: 'card' });
      if (statusKey === 'treatment_done') run('UPDATE leads SET closed_at=? WHERE id=?', nowIso(), leadId);
    }

    // Open follow-up task
    if (['contacted', 'no_answer', 'call_back', 'interested', 'appointment_set'].includes(statusKey)) {
      const due = new Date(now + int(-48, 72) * 3600000);
      insert('tasks', {
        lead_id: leadId,
        user_id: owner.id,
        created_by: owner.id,
        title: statusKey === 'no_answer' ? 'ניסיון חוזר — לא ענה' : 'חזרה ללקוח',
        kind: 'callback',
        priority: due < new Date() ? 'urgent' : 'normal',
        due_at: due.toISOString(),
        created_at: firstResp.toISOString(),
      });
    }

    if (chance(0.25)) {
      insert('events', {
        lead_id: leadId, type: 'note', actor_id: owner.id,
        title: 'הערה פנימית',
        body: pick(['הלקוח דובר ערבית בלבד.', 'לא להתקשר לפני 17:00.', 'מעוניין במימון/תשלומים.', 'הופנה על ידי לקוח קיים.']),
        created_at: firstResp.toISOString(),
      });
    }
    recomputeScore(leadId);
  }

  // A couple of unread inbox items dated today so the dashboard has life
  const recent = all('SELECT id, first_name FROM leads ORDER BY id DESC LIMIT 6');
  for (const l of recent.slice(0, 4)) {
    insert('messages', {
      lead_id: l.id, channel: 'whatsapp', direction: 'in',
      body: pick(['שלום, אני יכול להגיע ביום חמישי?', 'כמה עולה השתלה אחת?', 'مرحبا، هل يوجد موعد اليوم؟']),
      status: 'delivered',
      created_at: new Date(now - int(10, 300) * 60000).toISOString(),
    });
  }
  console.log(`· seeded ${count} demo leads`);
}

// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  if (process.argv.includes('--reset')) {
    for (const t of ['mentions', 'automation_log', 'automation_jobs', 'payments', 'deals', 'documents',
      'notifications', 'appointments', 'tasks', 'calls', 'messages', 'events', 'lead_submissions',
      'lead_treatments', 'leads', 'audit_log', 'sessions']) {
      run(`DELETE FROM ${t}`);
    }
    console.log('· cleared transactional tables');
  }
  seedReference();
  if (!process.argv.includes('--no-demo')) seedDemo(Number(process.env.CRM_DEMO_LEADS || 70));
  console.log(`✓ seed complete → ${DATA_DIR}`);
  console.log('  login: admin@clinic.local / ' + (process.env.CRM_SEED_PASSWORD || '123456'));
}
