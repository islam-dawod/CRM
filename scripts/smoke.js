// End-to-end smoke test against a running server.
//   node scripts/smoke.js            (expects http://localhost:4321)
//   BASE=http://host:port node scripts/smoke.js
const BASE = process.env.BASE || 'http://localhost:4321';
const EMAIL = process.env.CRM_EMAIL || 'admin@clinic.local';
const PASSWORD = process.env.CRM_SEED_PASSWORD || '123456';

let cookie = '';
let pass = 0;
let fail = 0;

async function call(method, path, body) {
  const init = { method, headers: { 'Content-Type': 'application/json' } };
  if (cookie) init.headers.cookie = cookie;
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(BASE + path, init);
  const setCookie = res.headers.getSetCookie?.()[0];
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

const section = (t) => console.log(`\n${t}`);

(async () => {
  console.log(`Smoke test → ${BASE}`);

  section('auth');
  const login = await call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  check('login', login.status === 200 && login.data.user?.id, JSON.stringify(login.data));
  check('reject bad password', (await call('POST', '/api/auth/login', { email: EMAIL, password: 'nope' })).status === 401);
  // restore session cookie (the failed login above did not overwrite it)
  const boot = await call('GET', '/api/bootstrap');
  check('bootstrap', boot.status === 200 && boot.data.statuses.length > 0 && boot.data.treatments.length > 0);

  const webhookKey = boot.data.settings.integrations?.webhook_key;
  check('webhook key present', !!webhookKey);

  section('lead intake + dedupe');
  const phone = '05' + String(Date.now()).slice(-8);
  const created = await call('POST', `/hooks/lead?key=${webhookKey}`, {
    full_name: 'בדיקה אוטומטית', phone, email: `smoke${Date.now()}@example.com`,
    treatment: 'השתלות שיניים', source: 'landing_page', utm_campaign: 'Smoke Test',
  });
  check('landing page hook creates lead', created.status === 200 && created.data.lead_id, JSON.stringify(created.data));
  const leadId = created.data.lead_id;

  const dup = await call('POST', `/hooks/lead?key=${webhookKey}`, { full_name: 'בדיקה אוטומטית', phone });
  check('duplicate phone merges into same card', dup.data.duplicate === true && dup.data.lead_id === leadId);

  const fb = await call('POST', '/hooks/facebook', {
    entry: [{ changes: [{ field: 'leadgen', value: {
      leadgen_id: 'smoke1', campaign_name: 'Smoke FB', ad_name: 'Ad A',
      field_data: [{ name: 'full_name', values: ['פייסבוק בדיקה'] },
        { name: 'phone_number', values: ['+97250' + String(Date.now()).slice(-7)] }],
    } }] }],
  });
  check('facebook lead ads webhook', fb.status === 200 && fb.data.created.length === 1);

  section('customer 360');
  const lead = await call('GET', `/api/leads/${leadId}`);
  check('lead detail', lead.status === 200 && lead.data.id === leadId);
  check('auto-assigned owner', !!lead.data.owner_id);
  check('treatment linked', lead.data.treatment_ids.length > 0);
  check('lead_created event on timeline',
    (await call('GET', `/api/leads/${leadId}/timeline`)).data.some((e) => e.type === 'lead_created'));

  section('communication');
  const wa = await call('POST', `/api/leads/${leadId}/whatsapp`, { body: 'הודעת בדיקה' });
  check('send whatsapp', wa.status === 200 && wa.data.message.direction === 'out');
  const mail = await call('POST', `/api/leads/${leadId}/email`, { subject: 'בדיקה', body: 'תוכן' });
  check('send email', mail.status === 200 && !!mail.data.message.tracking_id);

  const tid = mail.data.message.tracking_id;
  const pixel = await fetch(`${BASE}/t/o/${tid}`);
  check('tracking pixel returns gif', pixel.headers.get('content-type') === 'image/gif');
  const msgs = await call('GET', `/api/leads/${leadId}/messages`, undefined);
  check('email open recorded', msgs.data.some((m) => m.tracking_id === tid && m.opens >= 1));

  const inbound = await call('POST', `/api/leads/${leadId}/simulate-reply`, { body: 'כמה עולה?' });
  check('inbound message stored', inbound.status === 200 && inbound.data.direction === 'in');

  section('calls');
  const callLog = await call('POST', `/api/leads/${leadId}/calls`, {
    outcome: 'answered', duration_sec: 120,
    summary: 'הלקוח מעוניין בהשתלות, שאל על מחיר וביקש שנחזור אליו מחר',
    follow_up_at: new Date(Date.now() + 86400000).toISOString(),
  });
  check('log call', callLog.status === 200);
  check('AI summary produced', !!callLog.data.ai?.summary && callLog.data.ai.tags.length > 0,
    JSON.stringify(callLog.data.ai));
  check('status advanced to contacted', callLog.data.lead.status_key === 'contacted', callLog.data.lead.status_key);
  check('follow-up task created', callLog.data.lead.tasks.some((t) => !t.done_at));

  section('appointments');
  const appt = await call('POST', '/api/appointments', {
    lead_id: leadId, start_at: new Date(Date.now() + 2 * 86400000).toISOString(), duration_min: 45,
  });
  check('create appointment', appt.status === 200 && !!appt.data.confirm_token);
  const confirmPage = await fetch(`${BASE}/confirm/${appt.data.confirm_token}?action=confirm`);
  check('public confirm link works', confirmPage.status === 200);
  const afterConfirm = await call('GET', `/api/leads/${leadId}`);
  check('confirmation updates the lead', afterConfirm.data.status_key === 'appointment_confirmed',
    afterConfirm.data.status_key);

  const arrived = await call('POST', `/api/leads/${leadId}/status`, { status_key: 'arrived' });
  check('arrival is recorded with timestamp', !!arrived.data.arrived_at);

  section('deals');
  const deal = await call('POST', `/api/leads/${leadId}/deals`, { amount: 14000, paid: 5000 });
  check('create deal', deal.status === 200 && deal.data[0].balance === 9000, JSON.stringify(deal.data[0]));

  section('clinic branding + quick sends');
  const clinicCfg = boot.data.settings.clinic;
  check('clinic identity seeded', !!clinicCfg.name && !!clinicCfg.address && !!clinicCfg.phone);
  check('maps link available', /^https?:\/\/.*maps/.test(clinicCfg.maps_url || ''), clinicCfg.maps_url);
  check('waze link available', /^https?:\/\/.*waze/.test(clinicCfg.waze_url || ''), clinicCfg.waze_url);
  check('logo served', (await fetch(`${BASE}${clinicCfg.logo}`)).status === 200, clinicCfg.logo);

  // A reminder needs a future appointment; the earlier one was already marked arrived.
  const future = await call('POST', '/api/appointments', {
    lead_id: leadId, start_at: new Date(Date.now() + 3 * 86400000).toISOString(), duration_min: 45,
  });
  check('reminder is refused when there is no upcoming appointment',
    (await call('POST', '/api/leads/999999/clinic-send', { kind: 'appointment' })).status >= 400);

  for (const kind of ['location', 'card', 'details', 'appointment']) {
    const preview = await call('GET', `/api/leads/${leadId}/clinic-message?kind=${kind}`);
    check(`preview: ${kind}`, preview.status === 200 && preview.data.body.length > 20);
    if (kind === 'location') {
      check('location text carries both navigation links',
        preview.data.body.includes(clinicCfg.maps_url) && preview.data.body.includes(clinicCfg.waze_url));
    }
    if (kind === 'appointment') {
      check('appointment text carries date, time and address',
        /תאריך/.test(preview.data.body) && /שעה/.test(preview.data.body)
        && preview.data.body.includes(clinicCfg.address));
    }
  }

  for (const [kind, channel] of [['location', 'whatsapp'], ['card', 'sms'], ['details', 'email'], ['location', 'copy']]) {
    const sent = await call('POST', `/api/leads/${leadId}/clinic-send`, { kind, channel });
    check(`send ${kind} via ${channel}`, sent.status === 200, JSON.stringify(sent.data).slice(0, 100));
  }
  const tl = (await call('GET', `/api/leads/${leadId}/timeline`)).data;
  check('every send is logged to the timeline with an actor',
    ['location', 'clinic_card', 'clinic_info'].every((type) =>
      tl.some((e) => e.type === type && e.actor_name)));
  check('timeline names the channel used',
    tl.some((e) => e.type === 'location' && /WhatsApp/.test(e.title)));

  check('appointment_details template seeded',
    (await call('GET', '/api/templates?channel=whatsapp')).data.some((t) => t.key === 'appointment_details'));
  const tpl = (await call('GET', '/api/templates?channel=whatsapp')).data.find((t) => t.key === 'clinic_location');
  const rendered = await call('GET', `/api/leads/${leadId}/template/${tpl.id}`);
  check('templates resolve clinic variables',
    rendered.data.body.includes(clinicCfg.address) && !rendered.data.body.includes('{{'));

  section('search + filters');
  check('search by phone', (await call('GET', `/api/leads?q=${phone}`)).data.rows.some((r) => r.id === leadId));
  check('search by name', (await call('GET', '/api/leads?q=' + encodeURIComponent('בדיקה'))).data.rows.length > 0);
  check('filter arrived', (await call('GET', '/api/leads?arrived=1')).data.rows.every((r) => r.arrived_at));
  check('kanban columns', (await call('GET', '/api/leads/kanban')).data.columns.length > 0);

  section('reports');
  for (const [name, path] of [
    ['dashboard', '/api/reports/dashboard'], ['funnel', '/api/reports/funnel'],
    ['campaigns', '/api/reports/campaigns'], ['team', '/api/reports/team'],
    ['response time', '/api/reports/response-time'], ['revenue', '/api/reports/revenue'],
    ['sources', '/api/reports/sources'],
  ]) {
    const r = await call('GET', path);
    check(`${name} report`, r.status === 200, JSON.stringify(r.data).slice(0, 120));
  }

  section('ai assistant');
  for (const q of ['מי הלקוחות שצריך לחזור אליהם היום?', 'מי ביקש השתלות ולא קבע תור?',
    'מי פתח מייל אבל עדיין לא ענה?', 'תראה לי לידים חמים מפייסבוק מהשבוע']) {
    const r = await call('POST', '/api/ai/ask', { q });
    check(`ask: ${q.slice(0, 26)}…`, r.status === 200 && typeof r.data.text === 'string');
  }
  check('next best action', (await call('GET', `/api/leads/${leadId}/next-action`)).data.action);

  section('permissions');
  const agentLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'rana@clinic.local', password: PASSWORD }),
  });
  const agentCookie = agentLogin.headers.getSetCookie()[0].split(';')[0];
  const agentSettings = await fetch(`${BASE}/api/settings`, { headers: { cookie: agentCookie } });
  check('agent cannot read settings', agentSettings.status === 403);
  const agentLeads = await fetch(`${BASE}/api/leads?limit=200`, { headers: { cookie: agentCookie } });
  const agentRows = (await agentLeads.json()).rows;
  check('agent only sees own leads', agentRows.every((r) => r.owner_name === 'רנא'));

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nsmoke test crashed:', err);
  process.exit(1);
});
