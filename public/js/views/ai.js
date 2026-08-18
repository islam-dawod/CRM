// CRM AI Assistant — asks questions against the live database (spec §54, §55)
import { api } from '../api.js';
import { esc, avatar, colorFor, fmtDateTime, fmtTime, skeleton, empty, scoreRing, toast, fresh} from '../ui.js';
import { openLead } from './leadPanel.js';

const SUGGESTIONS = [
  'מי הלקוחות שצריך לחזור אליהם היום?',
  'מי ביקש השתלות ולא קבע תור?',
  'מי פתח מייל אבל עדיין לא ענה?',
  'תראה לי לידים חמים מפייסבוק מהשבוע',
  'אילו לידים לא טופלו בכלל?',
  'אילו תורים יש היום?',
  'כמה הכנסות היו בחודש האחרון?',
];

const history = [];

export async function render(view) {
  view = fresh(view);
  view.innerHTML = `
    <div style="display:grid;gap:14px;grid-template-columns:minmax(0,1.4fr) minmax(280px,1fr)">
      <section class="card" style="display:flex;flex-direction:column;min-height:60vh">
        <div class="card-head"><h3>🤖 CRM AI Assistant</h3>
          <span class="tiny dim">שואל ישירות את בסיס הנתונים שלך</span></div>
        <div class="card-pad" id="ai-chat" style="flex:1;overflow-y:auto">
          ${history.length ? '' : `<div class="ai-msg">
            שלום ${esc(document.querySelector('.user-chip .bold')?.textContent || '')} 👋<br>
            אפשר לשאול אותי על הלידים, התורים, המשימות וההכנסות. נסה אחת מההצעות למטה.
          </div>`}
        </div>
        <div class="card-pad" style="border-top:1px solid var(--border)">
          <div class="flex-wrap mb">${SUGGESTIONS.map((s) =>
            `<span class="ai-suggest" data-q="${esc(s)}">${esc(s)}</span>`).join('')}</div>
          <div class="composer">
            <textarea class="input" id="ai-input" rows="2" placeholder="שאל שאלה..."></textarea>
            <button class="btn btn-primary" id="ai-send">שאל</button>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h3>🎯 Next Best Action</h3></div>
        <div id="ai-suggest-list">${skeleton(4)}</div>
      </section>
    </div>`;

  const chat = view.querySelector('#ai-chat');
  history.forEach((h) => chat.insertAdjacentHTML('beforeend', h));
  chat.scrollTop = chat.scrollHeight;

  view.addEventListener('click', (e) => {
    const s = e.target.closest('[data-q]');
    if (s) { ask(s.dataset.q, chat); return; }
    const lead = e.target.closest('[data-lead]');
    if (lead?.dataset.lead) openLead(Number(lead.dataset.lead));
  });
  view.querySelector('#ai-send').addEventListener('click', () => {
    const input = view.querySelector('#ai-input');
    if (input.value.trim()) { ask(input.value.trim(), chat); input.value = ''; }
  });
  view.querySelector('#ai-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); view.querySelector('#ai-send').click(); }
  });

  // Next-best-action recommendations
  const recs = await api.get('/api/ai/suggestions');
  view.querySelector('#ai-suggest-list').innerHTML = recs.length ? recs.map((r) => `
    <div class="day-slot" style="padding:11px 14px;cursor:pointer;align-items:flex-start" data-lead="${r.id}">
      ${scoreRing(r.score)}
      <div style="flex:1;min-width:0">
        <div class="small bold truncate">${esc(r.full_name)}</div>
        <div class="tiny" style="color:var(--purple)">${esc(r.recommendation.label)}</div>
        <div class="tiny dim truncate">${esc(r.recommendation.reasons.join(' · '))}</div>
      </div>
    </div>`).join('') : empty('אין המלצות כרגע', '🤖');
}

async function ask(q, chat) {
  const mine = `<div class="ai-msg me">${esc(q)}</div>`;
  chat.insertAdjacentHTML('beforeend', mine);
  history.push(mine);
  chat.scrollTop = chat.scrollHeight;

  try {
    const res = await api.post('/api/ai/ask', { q });
    const html = `<div class="ai-msg">
      <div class="bold mb">${esc(res.text)}</div>
      ${res.rows?.length ? `<div class="stack" style="gap:6px">${res.rows.slice(0, 12).map((r) => rowHtml(r, res.kind)).join('')}
        ${res.rows.length > 12 ? `<div class="tiny dim">ועוד ${res.rows.length - 12}...</div>` : ''}</div>` : ''}
    </div>`;
    chat.insertAdjacentHTML('beforeend', html);
    history.push(html);
  } catch (err) {
    const html = `<div class="ai-msg" style="color:var(--red)">שגיאה: ${esc(err.message)}</div>`;
    chat.insertAdjacentHTML('beforeend', html);
    history.push(html);
  }
  chat.scrollTop = chat.scrollHeight;
}

function rowHtml(r, kind) {
  const name = [r.first_name, r.last_name].filter(Boolean).join(' ');
  const meta = kind === 'appointments'
    ? `${fmtTime(r.start_at)} · ${esc(r.title || '')}`
    : kind === 'tasks'
      ? `${esc(r.title || '')} · ${fmtDateTime(r.due_at)}`
      : `${esc(r.phone_norm || '')}${r.status_key ? ` · ${esc(r.status_key)}` : ''}`;
  return `<div class="flex" style="background:var(--surface);padding:7px 10px;border-radius:9px;cursor:pointer"
      data-lead="${r.lead_id || r.id}">
    ${avatar(name || '?', colorFor(name), 'sm')}
    <div style="flex:1;min-width:0">
      <div class="small bold truncate">${esc(name || '—')}</div>
      <div class="tiny dim truncate">${meta}</div>
    </div>
    ${r.temperature === 'hot' ? '<span>🔥</span>' : ''}
  </div>`;
}
