// WhatsApp + Email template library (spec §42, §43)
import { api } from '../api.js';
import { store } from '../store.js';
import { esc, skeleton, toast, formModal, confirmDialog, empty, fresh} from '../ui.js';

let channel = 'whatsapp';

const VARS = ['first_name', 'last_name', 'full_name', 'phone', 'treatment', 'owner', 'clinic',
  'appointment_date', 'appointment_time', 'city'];

export async function render(view) {
  view = fresh(view);
  const templates = await api.get('/api/templates', { channel });
  view.innerHTML = `
    <div class="row-between mb" style="flex-wrap:wrap;gap:10px">
      <div class="seg">
        <button data-ch="whatsapp" class="${channel === 'whatsapp' ? 'active' : ''}">💬 WhatsApp</button>
        <button data-ch="email" class="${channel === 'email' ? 'active' : ''}">✉️ מייל</button>
      </div>
      <button class="btn btn-primary btn-sm" id="add-tpl">＋ תבנית</button>
    </div>

    <div class="card card-pad mb">
      <div class="tiny dim mb">משתנים זמינים — יוחלפו אוטומטית בפרטי הלקוח:</div>
      <div class="flex-wrap">${VARS.map((v) => `<span class="chip tiny">{{${v}}}</span>`).join('')}</div>
    </div>

    <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">
      ${templates.length ? templates.map((t) => `
        <div class="card card-pad">
          <div class="row-between mb">
            <div>
              <div class="bold">${esc(t.name)}</div>
              <div class="tiny dim">${t.lang === 'ar' ? '🇸🇦 ערבית' : t.lang === 'en' ? '🇬🇧 אנגלית' : '🇮🇱 עברית'}
                ${t.key ? ` · <code>${esc(t.key)}</code>` : ''}</div>
            </div>
            <div class="flex">
              <button class="btn btn-sm" data-edit="${t.id}">✎</button>
              <button class="btn btn-sm btn-ghost" data-del="${t.id}">🗑</button>
            </div>
          </div>
          ${t.subject ? `<div class="small bold mb">${esc(t.subject)}</div>` : ''}
          <div class="tl-body" style="margin:0">${esc(t.body)}</div>
        </div>`).join('') : empty('אין תבניות', '📝')}
    </div>`;

  view.addEventListener('click', async (e) => {
    const ch = e.target.closest('[data-ch]');
    if (ch) { channel = ch.dataset.ch; render(view); return; }
    const ed = e.target.closest('[data-edit]');
    if (ed) { tplForm(templates.find((t) => t.id === Number(ed.dataset.edit)), view); return; }
    const del = e.target.closest('[data-del]');
    if (del && (await confirmDialog('למחוק את התבנית?', { danger: true }))) {
      await api.del(`/api/templates/${del.dataset.del}`);
      render(view);
    }
  });
  view.querySelector('#add-tpl').addEventListener('click', () => tplForm(null, view));
}

async function tplForm(tpl, view) {
  const data = await formModal({
    title: tpl ? 'עריכת תבנית' : '＋ תבנית חדשה',
    wide: true,
    fields: [
      { name: 'name', label: 'שם התבנית', required: true, value: tpl?.name },
      {
        name: 'lang', label: 'שפה', type: 'select', value: tpl?.lang || 'he',
        options: [{ value: 'he', label: 'עברית' }, { value: 'ar', label: 'ערבית' }, { value: 'en', label: 'אנגלית' }],
      },
      ...(channel === 'email' ? [{ name: 'subject', label: 'נושא', value: tpl?.subject }] : []),
      {
        name: 'body', label: 'תוכן ההודעה', type: 'textarea', rows: 7, required: true, value: tpl?.body,
        hint: 'אפשר להשתמש במשתנים כמו {{first_name}} ו-{{treatment}}',
      },
    ],
  });
  if (!data) return;
  try {
    if (tpl) await api.patch(`/api/templates/${tpl.id}`, data);
    else await api.post('/api/templates', { ...data, channel });
    toast('נשמר', 'ok');
    render(view);
  } catch (err) { toast(err.message, 'err'); }
}
