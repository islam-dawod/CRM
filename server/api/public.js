// Public (unauthenticated) endpoints: lead intake webhooks, email tracking,
// appointment confirmation links and a demo landing page.
// Spec §12, §21, §25, §26.
import { all, get, run, update, setting } from '../db.js';
import { bad, forbidden, notFound, sendText, sendJson, readBody } from '../lib/http.js';
import { nowIso, addEvent, notify, parseJson, recomputeScore, prettyPhone } from '../lib/util.js';
import { intakeLead, receiveMessage, setAppointmentStatus, leadName } from '../lib/services.js';

const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

function checkKey(query, headers) {
  const cfg = setting('integrations', {});
  const expected = cfg.webhook_key;
  const given = query.key || headers['x-webhook-key'];
  if (!expected) return true;
  if (given !== expected) throw forbidden('invalid webhook key');
  return true;
}

export default function register(router) {
  // -------------------------------------------------------------------------
  // Generic lead intake — landing pages, website forms, Zapier, Make (§26)
  // POST /hooks/lead?key=...
  // -------------------------------------------------------------------------
  router.post('/hooks/lead', ({ body, query, req }) => {
    checkKey(query, req.headers);
    const payload = { ...query, ...body };
    if (!payload.phone && !payload.email) throw bad('phone or email required');
    const result = intakeLead(payload, {
      source: payload.source || 'landing_page',
      raw: payload,
    });
    return {
      ok: true,
      lead_id: result.lead.id,
      duplicate: result.duplicate,
      message: result.duplicate ? `לקוח קיים (${result.days_ago} ימים)` : 'ליד נוצר',
    };
  });

  // -------------------------------------------------------------------------
  // Facebook / Instagram Lead Ads (§25)
  // GET  → webhook verification handshake
  // POST → leadgen notification
  // -------------------------------------------------------------------------
  router.get('/hooks/facebook', ({ query, res }) => {
    const cfg = setting('integrations', {});
    const verify = cfg?.facebook?.verify_token || 'crm-verify';
    if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === verify) {
      sendText(res, 200, String(query['hub.challenge'] || ''));
      return;
    }
    throw forbidden('verification failed');
  });

  router.post('/hooks/facebook', ({ body }) => {
    const created = [];
    // Real Graph payload: entry[].changes[].value  |  test payload: flat object
    const entries = Array.isArray(body?.entry) ? body.entry : [];
    const fields = [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        if (change.field && change.field !== 'leadgen') continue;
        fields.push(change.value || {});
      }
    }
    if (!fields.length && (body.phone || body.field_data)) fields.push(body);

    for (const value of fields) {
      const answers = {};
      for (const f of value.field_data || []) {
        answers[String(f.name || '').toLowerCase()] = Array.isArray(f.values) ? f.values[0] : f.values;
      }
      const payload = {
        full_name: answers.full_name || answers.name || value.full_name || value.name,
        first_name: answers.first_name,
        last_name: answers.last_name,
        phone: answers.phone_number || answers.phone || value.phone,
        email: answers.email || value.email,
        city: answers.city || value.city,
        treatment: answers.treatment || answers.service || value.treatment,
        language: answers.language,
        campaign_name: value.campaign_name || value.adgroup_name || body.campaign_name,
        ad_name: value.ad_name || body.ad_name,
        ad_set: value.adset_name || body.ad_set,
        utm_source: 'facebook',
        utm_campaign: value.campaign_name || body.campaign_name,
        utm_medium: 'paid_social',
        utm_content: value.ad_name,
        external_id: value.leadgen_id || value.id,
      };
      if (!payload.phone && !payload.email) continue;
      const platform = value.platform === 'instagram' ? 'instagram' : 'facebook_lead_ads';
      const r = intakeLead(payload, { source: platform, raw: value });
      created.push({ lead_id: r.lead.id, duplicate: r.duplicate });
    }
    return { ok: true, created };
  });

  // -------------------------------------------------------------------------
  // WhatsApp inbound (Meta Cloud API shape) (§9)
  // -------------------------------------------------------------------------
  router.get('/hooks/whatsapp', ({ query, res }) => {
    const cfg = setting('integrations', {});
    const verify = cfg?.whatsapp?.verify_token || 'crm-verify';
    if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === verify) {
      sendText(res, 200, String(query['hub.challenge'] || ''));
      return;
    }
    throw forbidden('verification failed');
  });

  router.post('/hooks/whatsapp', ({ body }) => {
    const handled = [];
    const values = [];
    for (const entry of body?.entry || []) {
      for (const change of entry.changes || []) values.push(change.value || {});
    }
    if (!values.length && body.from) values.push({ messages: [body] });

    for (const value of values) {
      // status callbacks — delivered / read
      for (const st of value.statuses || []) {
        const msg = get('SELECT * FROM messages WHERE external_id=?', st.id);
        if (msg) update('messages', msg.id, { status: st.status === 'read' ? 'read' : st.status });
      }
      for (const m of value.messages || []) {
        const from = '+' + String(m.from || '').replace(/\D/g, '');
        let lead = get('SELECT * FROM leads WHERE phone_norm=? OR whatsapp=?', from, from);
        if (!lead) {
          const profileName = value.contacts?.[0]?.profile?.name || '';
          const r = intakeLead({ phone: from, full_name: profileName }, { source: 'whatsapp', raw: m });
          lead = r.lead;
        }
        const text = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || '[מדיה]';
        receiveMessage(lead.id, { channel: 'whatsapp', body: text, externalId: m.id });

        // Reply buttons from an appointment confirmation (§21)
        const reply = (m.interactive?.button_reply?.id || m.button?.payload || '').toLowerCase();
        if (reply.includes('confirm') || /^(מאשר|اؤكد)/.test(text)) {
          const appt = get(
            `SELECT * FROM appointments WHERE lead_id=? AND status='scheduled' ORDER BY start_at LIMIT 1`, lead.id,
          );
          if (appt) setAppointmentStatus(appt.id, 'confirmed', null);
        }
        handled.push({ lead_id: lead.id });
      }
    }
    return { ok: true, handled };
  });

  // -------------------------------------------------------------------------
  // Email tracking (§12) — open pixel + click redirect
  // Note: pixel tracking is blocked by many privacy tools, so open counts are
  // indicative, never exact (called out in the spec itself).
  // -------------------------------------------------------------------------
  router.get('/t/o/:tid', ({ params, res }) => {
    const msg = get('SELECT * FROM messages WHERE tracking_id=?', params.tid);
    if (msg) {
      run(
        `UPDATE messages SET opens=opens+1, status=CASE WHEN status='clicked' THEN status ELSE 'opened' END,
           first_open_at=COALESCE(first_open_at, ?), last_open_at=? WHERE id=?`,
        nowIso(), nowIso(), msg.id,
      );
      const fresh = get('SELECT opens FROM messages WHERE id=?', msg.id);
      addEvent(msg.lead_id, 'email_open', `הלקוח פתח את המייל${fresh.opens > 1 ? ` (פעם ${fresh.opens})` : ''}`, {
        meta: { message_id: msg.id, opens: fresh.opens },
      });
      const lead = get('SELECT * FROM leads WHERE id=?', msg.lead_id);
      if (lead?.owner_id && fresh.opens === 1) {
        notify(lead.owner_id, {
          type: 'email_open', title: 'הלקוח פתח את המייל', body: leadName(lead), leadId: lead.id,
        });
      }
      recomputeScore(msg.lead_id);
    }
    res.writeHead(200, {
      'Content-Type': 'image/gif',
      'Content-Length': PIXEL.length,
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    });
    res.end(PIXEL);
  });

  router.get('/t/c/:tid', ({ params, query, res }) => {
    const msg = get('SELECT * FROM messages WHERE tracking_id=?', params.tid);
    const target = query.u || '/';
    if (msg) {
      run("UPDATE messages SET clicks=clicks+1, status='clicked' WHERE id=?", msg.id);
      addEvent(msg.lead_id, 'email_click', 'הלקוח לחץ על קישור במייל', { meta: { url: target } });
      recomputeScore(msg.lead_id);
    }
    res.writeHead(302, { Location: target });
    res.end();
  });

  // -------------------------------------------------------------------------
  // Appointment confirmation link (§21)
  // -------------------------------------------------------------------------
  router.get('/confirm/:token', ({ params, query, res }) => {
    const appt = get(
      `SELECT a.*, l.first_name, l.last_name, t.name_he AS treatment_he
       FROM appointments a JOIN leads l ON l.id=a.lead_id
       LEFT JOIN treatments t ON t.id=a.treatment_id WHERE a.confirm_token=?`, params.token,
    );
    if (!appt) throw notFound('הקישור אינו תקין');
    const action = query.action;
    let message = '';
    if (action === 'confirm') {
      setAppointmentStatus(appt.id, 'confirmed', null);
      message = 'התור אושר, תודה! נתראה בקרוב.';
    } else if (action === 'cancel') {
      setAppointmentStatus(appt.id, 'cancelled', null);
      message = 'התור בוטל. נציג יחזור אליך לתיאום מועד חדש.';
    } else if (action === 'change') {
      addEvent(appt.lead_id, 'appointment', 'הלקוח ביקש לשנות את מועד התור', { meta: { appointment_id: appt.id } });
      const lead = get('SELECT * FROM leads WHERE id=?', appt.lead_id);
      if (lead?.owner_id) {
        notify(lead.owner_id, {
          type: 'appointment_change', title: 'בקשה לשינוי תור', body: leadName(lead),
          leadId: lead.id, level: 'urgent',
        });
      }
      message = 'קיבלנו את הבקשה. נציג יחזור אליך בהקדם לתיאום מועד חדש.';
    }
    const when = new Intl.DateTimeFormat('he-IL', {
      timeZone: 'Asia/Jerusalem', dateStyle: 'full', timeStyle: 'short',
    }).format(new Date(appt.start_at));
    sendText(res, 200, confirmPage({ appt, when, message }), 'text/html; charset=utf-8');
  });

  // -------------------------------------------------------------------------
  // Demo landing page — shows the full Facebook/LP → CRM flow end to end (§26)
  // -------------------------------------------------------------------------
  router.get('/demo/landing', ({ res }) => {
    const cfg = setting('integrations', {});
    const treatments = all('SELECT name_he FROM treatments WHERE active=1 ORDER BY sort');
    sendText(res, 200, landingPage(treatments, cfg.webhook_key || ''), 'text/html; charset=utf-8');
  });
}

// ---------------------------------------------------------------------------
const SHELL = (title, inner) => `<!doctype html>
<html lang="he" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
    font-family:"Segoe UI",Rubik,system-ui,-apple-system,sans-serif;
    background:linear-gradient(160deg,#0f172a,#1e293b);color:#e2e8f0}
  .card{background:#fff;color:#0f172a;border-radius:20px;padding:32px;max-width:460px;width:100%;
    box-shadow:0 24px 60px rgba(0,0,0,.35)}
  h1{margin:0 0 8px;font-size:22px} p{margin:0 0 16px;color:#475569;line-height:1.6}
  label{display:block;font-size:13px;font-weight:600;margin:12px 0 6px}
  input,select{width:100%;padding:12px 14px;border:1px solid #cbd5e1;border-radius:12px;font-size:15px;font-family:inherit}
  button{width:100%;margin-top:18px;padding:14px;border:0;border-radius:12px;background:#0ea5e9;color:#fff;
    font-size:16px;font-weight:700;cursor:pointer}
  button:hover{background:#0284c7}
  .ok{background:#dcfce7;color:#166534;padding:14px;border-radius:12px;margin-top:16px;display:none}
  .muted{font-size:12px;color:#64748b;margin-top:14px}
  .row{display:flex;gap:10px} .row>*{flex:1}
  a{color:#0ea5e9}
</style></head><body><div class="card">${inner}</div></body></html>`;

const confirmPage = ({ appt, when, message }) => SHELL(
  'אישור תור',
  `<h1>שלום ${appt.first_name} 👋</h1>
   <p>התור שלך${appt.treatment_he ? ` ל${appt.treatment_he}` : ''} נקבע ל:<br><b>${when}</b></p>
   ${message ? `<div class="ok" style="display:block">${message}</div>` : `
     <a href="?action=confirm"><button type="button">מאשר/ת הגעה ✓</button></a>
     <a href="?action=change"><button type="button" style="background:#f59e0b">רוצה לשנות מועד</button></a>
     <a href="?action=cancel"><button type="button" style="background:#ef4444">ביטול תור</button></a>`}
   <p class="muted">סטטוס נוכחי: ${appt.status}</p>`,
);

const landingPage = (treatments, key) => SHELL(
  'קבעו ייעוץ — דף נחיתה לדוגמה',
  `<h1>ייעוץ ראשוני ללא עלות</h1>
   <p>השאירו פרטים ונחזור אליכם. הטופס הזה שולח ישירות ל-CRM עם כל פרטי הקמפיין וה-UTM.</p>
   <form id="f">
     <label>שם מלא</label><input name="full_name" required placeholder="מוחמד עלי">
     <div class="row">
       <div><label>טלפון</label><input name="phone" required placeholder="05X-XXXXXXX"></div>
       <div><label>עיר</label><input name="city" placeholder="חיפה"></div>
     </div>
     <label>אימייל</label><input name="email" type="email" placeholder="name@example.com">
     <label>טיפול מבוקש</label>
     <select name="treatment">${treatments.map((t) => `<option>${t.name_he}</option>`).join('')}</select>
     <button>שלחו לי פרטים</button>
   </form>
   <div class="ok" id="ok"></div>
   <p class="muted">Endpoint: <code>POST /hooks/lead?key=${key}</code></p>
   <script>
     const params = new URLSearchParams(location.search);
     document.getElementById('f').addEventListener('submit', async (e) => {
       e.preventDefault();
       const data = Object.fromEntries(new FormData(e.target));
       const res = await fetch('/hooks/lead?key=${key}', {
         method: 'POST', headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
           ...data, source: 'landing_page', landing_page: location.pathname,
           campaign_name: params.get('utm_campaign') || 'Landing — Free Consult',
           ad_name: params.get('utm_content'),
           utm_source: params.get('utm_source') || 'landing',
           utm_campaign: params.get('utm_campaign'),
           utm_medium: params.get('utm_medium') || 'referral',
           utm_content: params.get('utm_content'),
         }),
       });
       const json = await res.json();
       const ok = document.getElementById('ok');
       ok.style.display = 'block';
       ok.textContent = json.duplicate
         ? 'תודה! זיהינו אותך כלקוח קיים — הפנייה צורפה לכרטיס שלך.'
         : 'תודה! הפנייה התקבלה ונציג יחזור אליך בהקדם.';
       e.target.reset();
     });
   </script>`,
);
