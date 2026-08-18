// Automation rules (spec §40, §41)
import { api } from '../api.js';
import { store, TRIGGER_LABEL, ACTION_LABEL, statusName } from '../store.js';
import { esc, fmtRelative, skeleton, toast, formModal, confirmDialog, empty, modal, $, $$, fresh} from '../ui.js';

export async function render(view) {
  view = fresh(view);
  const [rules, templates] = await Promise.all([
    api.get('/api/automations'),
    api.get('/api/templates'),
  ]);

  view.innerHTML = `
    <div class="row-between mb">
      <div>
        <h3>⚡ אוטומציות</h3>
        <div class="tiny dim">כללים שרצים לבד — הודעות, משימות, שינויי סטטוס והתראות למנהל</div>
      </div>
      <button class="btn btn-primary btn-sm" id="add-rule">＋ אוטומציה</button>
    </div>

    <div class="stack">
      ${rules.length ? rules.map((r) => `
        <div class="card card-pad">
          <div class="row-between" style="align-items:flex-start">
            <div style="min-width:0">
              <div class="flex">
                <label class="switch"><input type="checkbox" data-toggle="${r.id}" ${r.active ? 'checked' : ''}>
                  <span class="track"></span></label>
                <div class="bold">${esc(r.name)}</div>
              </div>
              <div class="tiny dim" style="margin-top:6px">
                טריגר: <b>${esc(TRIGGER_LABEL[r.trigger] || r.trigger)}</b>
                ${r.delay_min ? ` · השהיה ${r.delay_min} דק׳` : ''}
                ${r.conditions?.hours ? ` · אחרי ${r.conditions.hours} שעות` : ''}
                ${r.conditions?.hours_before ? ` · ${r.conditions.hours_before} שעות לפני` : ''}
                ${r.conditions?.to?.length ? ` · לסטטוס ${r.conditions.to.map(statusName).join(', ')}` : ''}
              </div>
              <div class="flex-wrap" style="margin-top:8px">
                ${(r.actions || []).map((a) => `<span class="chip tiny">${actionIcon(a.type)} ${esc(describeAction(a, templates))}</span>`).join(' → ')}
              </div>
              <div class="tiny dim" style="margin-top:8px">
                הופעל ${r.runs} פעמים${r.last_run_at ? ` · לאחרונה ${fmtRelative(r.last_run_at)}` : ''}
              </div>
            </div>
            <div class="flex">
              <button class="btn btn-sm" data-edit="${r.id}">✎</button>
              <button class="btn btn-sm btn-ghost" data-del="${r.id}">🗑</button>
            </div>
          </div>
        </div>`).join('') : empty('אין אוטומציות מוגדרות', '⚡')}
    </div>

    <div class="card card-pad mt">
      <h3 class="mb">📖 דוגמאות לזרימות מומלצות</h3>
      <div class="tiny muted" style="line-height:2">
        <b>ליד חדש</b> → WhatsApp אוטומטי → מייל → משימה לנציג → אם אין מענה 3 שעות → תזכורת →
        אם אין טיפול 24 שעות → התראה למנהל<br>
        <b>לא ענה</b> → ניסיון 1 → משימה בעוד 3 שעות → ניסיון 2 → משימה מחר → WhatsApp אוטומטי → סטטוס No Answer Follow-up<br>
        <b>נקבע תור</b> → הודעת אישור → תזכורת 24 שעות לפני התור
      </div>
    </div>`;

  view.querySelector('#add-rule').addEventListener('click', () => ruleForm(null, templates, view));
  view.addEventListener('click', async (e) => {
    const tg = e.target.closest('[data-toggle]');
    if (tg) {
      await api.patch(`/api/automations/${tg.dataset.toggle}`, { active: tg.checked });
      toast(tg.checked ? 'האוטומציה הופעלה' : 'האוטומציה הושבתה', 'ok');
      return;
    }
    const ed = e.target.closest('[data-edit]');
    if (ed) { ruleForm(rules.find((r) => r.id === Number(ed.dataset.edit)), templates, view); return; }
    const del = e.target.closest('[data-del]');
    if (del && (await confirmDialog('למחוק את האוטומציה?', { danger: true }))) {
      await api.del(`/api/automations/${del.dataset.del}`);
      render(view);
    }
  });
}

const actionIcon = (t) => ({
  send_whatsapp: '💬', send_email: '✉️', create_task: '⏰', set_status: '🔄',
  assign: '👤', notify_manager: '🚨', notify_owner: '🔔', add_note: '📝',
}[t] || '•');

function describeAction(a, templates) {
  const tpl = templates.find((t) => t.key === a.template);
  switch (a.type) {
    case 'send_whatsapp': return `WhatsApp: ${tpl?.name || a.template || 'הודעה'}`;
    case 'send_email': return `מייל: ${tpl?.name || a.template || 'הודעה'}`;
    case 'create_task': return `משימה: ${a.title} (${a.in_minutes ?? 60} דק׳)`;
    case 'set_status': return `סטטוס → ${statusName(a.status)}`;
    case 'notify_manager': return `התראה למנהל: ${a.title || ''}`;
    case 'notify_owner': return `התראה לנציג`;
    case 'assign': return 'הקצאת נציג';
    case 'add_note': return 'הוספת הערה';
    default: return a.type;
  }
}

async function ruleForm(rule, templates, view) {
  const waTemplates = templates.filter((t) => t.channel === 'whatsapp');
  const mailTemplates = templates.filter((t) => t.channel === 'email');
  const actions = rule?.actions ? structuredClone(rule.actions) : [];

  modal({
    title: rule ? 'עריכת אוטומציה' : '＋ אוטומציה חדשה',
    wide: true,
    body: `
      <div class="field"><label>שם</label><input class="input" id="a-name" value="${esc(rule?.name || '')}"></div>
      <div class="grid-3">
        <div class="field"><label>טריגר</label>
          <select class="input" id="a-trigger">
            ${Object.entries(TRIGGER_LABEL).map(([k, v]) => `<option value="${k}" ${rule?.trigger === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
          </select></div>
        <div class="field"><label>השהיה (דקות)</label>
          <input class="input" id="a-delay" type="number" value="${rule?.delay_min || 0}"></div>
        <div class="field"><label>תנאי שעות (no_touch / תור מתקרב)</label>
          <input class="input" id="a-hours" type="number" value="${rule?.conditions?.hours || rule?.conditions?.hours_before || ''}"></div>
      </div>
      <div class="field"><label>תנאי: סטטוס יעד (לטריגר "שינוי סטטוס")</label>
        <select class="input" id="a-to" multiple size="4">
          ${store.statuses.map((s) => `<option value="${s.key}" ${rule?.conditions?.to?.includes(s.key) ? 'selected' : ''}>${esc(s.name_he)}</option>`).join('')}
        </select></div>

      <div class="field"><label>פעולות</label><div id="a-actions" class="stack"></div>
        <div class="flex-wrap mt">
          ${Object.entries(ACTION_LABEL).map(([k, v]) => `<button class="btn btn-sm" data-add-action="${k}">＋ ${esc(v)}</button>`).join('')}
        </div>
      </div>`,
    footer: '<button class="btn" data-close>ביטול</button><button class="btn btn-primary" id="a-save">שמירה</button>',
    onMount(root, close) {
      const list = $('#a-actions', root);
      const draw = () => {
        list.innerHTML = actions.length ? actions.map((a, i) => `
          <div class="card card-pad" style="padding:10px">
            <div class="row-between">
              <b class="small">${actionIcon(a.type)} ${esc(ACTION_LABEL[a.type] || a.type)}</b>
              <button class="btn btn-sm btn-ghost" data-rm="${i}">✕</button>
            </div>
            <div class="mt">${actionFields(a, i, waTemplates, mailTemplates)}</div>
          </div>`).join('') : '<div class="tiny dim">לא נבחרו פעולות</div>';
      };
      draw();

      root.addEventListener('click', (e) => {
        const add = e.target.closest('[data-add-action]');
        if (add) {
          const type = add.dataset.addAction;
          actions.push({ type, ...(type === 'create_task' ? { title: 'משימה', in_minutes: 60 } : {}) });
          draw();
          return;
        }
        const rm = e.target.closest('[data-rm]');
        if (rm) { actions.splice(Number(rm.dataset.rm), 1); draw(); }
      });
      root.addEventListener('input', (e) => {
        const f = e.target.closest('[data-af]');
        if (!f) return;
        const [i, key] = f.dataset.af.split(':');
        actions[Number(i)][key] = f.type === 'number' ? Number(f.value) : f.value;
      });
      root.addEventListener('change', (e) => {
        const f = e.target.closest('[data-af]');
        if (!f) return;
        const [i, key] = f.dataset.af.split(':');
        actions[Number(i)][key] = f.type === 'number' ? Number(f.value) : f.value;
      });

      $('#a-save', root).addEventListener('click', async () => {
        const trigger = $('#a-trigger', root).value;
        const hours = Number($('#a-hours', root).value) || undefined;
        const conditions = {};
        if (trigger === 'no_touch' && hours) conditions.hours = hours;
        if (trigger === 'appointment_upcoming' && hours) conditions.hours_before = hours;
        const to = [...$('#a-to', root).selectedOptions].map((o) => o.value);
        if (trigger === 'status_changed' && to.length) conditions.to = to;

        const payload = {
          name: $('#a-name', root).value || 'אוטומציה',
          trigger,
          delay_min: Number($('#a-delay', root).value) || 0,
          conditions,
          actions,
          active: true,
        };
        try {
          if (rule) await api.patch(`/api/automations/${rule.id}`, payload);
          else await api.post('/api/automations', payload);
          toast('נשמר', 'ok');
          close();
          render(view);
        } catch (err) { toast(err.message, 'err'); }
      });
    },
  });
}

function actionFields(a, i, waTemplates, mailTemplates) {
  if (a.type === 'send_whatsapp' || a.type === 'send_email') {
    const list = a.type === 'send_whatsapp' ? waTemplates : mailTemplates;
    return `<select class="input" data-af="${i}:template">
      <option value="">— בחר תבנית —</option>
      ${list.map((t) => `<option value="${esc(t.key)}" ${a.template === t.key ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
    </select>`;
  }
  if (a.type === 'create_task') {
    return `<div class="grid-3">
      <input class="input" data-af="${i}:title" value="${esc(a.title || '')}" placeholder="כותרת המשימה">
      <input class="input" type="number" data-af="${i}:in_minutes" value="${a.in_minutes ?? 60}" placeholder="בעוד X דקות">
      <select class="input" data-af="${i}:priority">
        ${[['low', 'נמוכה'], ['normal', 'רגילה'], ['urgent', 'דחוף']].map(([v, l]) =>
          `<option value="${v}" ${a.priority === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></div>`;
  }
  if (a.type === 'set_status') {
    return `<select class="input" data-af="${i}:status">
      ${store.statuses.map((s) => `<option value="${s.key}" ${a.status === s.key ? 'selected' : ''}>${esc(s.name_he)}</option>`).join('')}
    </select>`;
  }
  if (a.type === 'notify_manager' || a.type === 'notify_owner') {
    return `<input class="input" data-af="${i}:title" value="${esc(a.title || '')}" placeholder="כותרת ההתראה">`;
  }
  if (a.type === 'add_note') {
    return `<input class="input" data-af="${i}:body" value="${esc(a.body || '')}" placeholder="תוכן ההערה">`;
  }
  return '';
}
