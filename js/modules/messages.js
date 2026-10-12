// WhatsApp centre: reminder queues, area outage notice, editable message templates and a message log.
// Each message opens WhatsApp with the text ready. Staff press Send there. Nothing is sent automatically.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtDate, fmtNum, lc } from '../core/utils.js';
import { cur } from '../core/views.js';
import { getSettings, saveSettings, DEFAULT_TEMPLATES, template } from '../core/settings.js';
import * as Auth from '../services/auth.js';
import * as WA from '../services/whatsapp.js';
import { loadBalances, balanceOf } from '../services/billing.js';

const $ = window.jQuery;
const TEMPLATE_HELP = 'Placeholders: {name} first name, {fullName}, {code}, {plan}, {amount}, {balance}, {due}, {month}, {area}, {payment}, {business}, {phone}, {ticket}, {issue}, {receipt}';

// Builds the recipient list for a queue. Each entry is one customer with the text ready to open.
async function queue(kind) {
  const [subs, plans, bal] = await Promise.all([idb.getAll('subscribers'), idb.getAll('plans'), loadBalances()]);
  const planById = new Map(plans.map((p) => [p.id, p]));
  const rows = [];
  for (const s of subs) {
    if (s.status === 'disconnected' || s.status === 'pending') continue;
    const b = balanceOf(bal, s.id);
    if (kind === 'overdue' && !(b.overdue > 0)) continue;
    if (kind === 'unpaid' && !(b.balance > 0.004)) continue;
    if (kind === 'area' && (!s.area || !(s.status === 'active' || s.status === 'suspended'))) continue;
    const phone = WA.normalizePhone(s.phone);
    if (!phone) continue;
    const plan = planById.get(s.planId);
    const tpl = kind === 'overdue' ? 'overdue' : kind === 'unpaid' ? 'reminder' : 'outage';
    const text = WA.fillTemplate(tpl, WA.customerVars(s, plan, b, { payment: WA.paymentText() }));
    rows.push({ sub: s, phone, text, tpl, balance: b.balance, overdue: b.overdue });
  }
  return rows.sort((a, b) => (b.overdue || b.balance) - (a.overdue || a.balance));
}

function queueRow(r, i) {
  return `<div class="list-row" data-row="${i}">
    ${UI.avatar(r.sub.name)}
    <div class="main min-w-0"><div class="title text-truncate">${esc(r.sub.name)}</div>
      <div class="sub">${esc(r.sub.number)} · ${r.tpl === 'outage' ? esc(r.sub.area || '') : `${r.overdue > 0 ? 'overdue' : 'due'} ${esc(cur())} ${fmtNum(r.tpl === 'overdue' ? r.overdue : r.balance)}`}</div></div>
    <div class="end d-flex gap-1">
      <button class="btn btn-sm btn-light" data-copy="${i}" aria-label="Copy message"><i class="bi bi-clipboard"></i></button>
      <button class="btn btn-sm btn-success" data-send="${i}"><i class="bi bi-whatsapp me-1"></i>Send</button>
    </div></div>`;
}

async function renderPage(el) {
  const $c = $(el);
  $c.off('.wa');
  const [subs, logs] = await Promise.all([idb.getAll('subscribers'), idb.getAll('messages')]);
  const areas = [...new Set(subs.filter((s) => s.area && s.status === 'active').map((s) => s.area))].sort();
  const sentToday = logs.filter((m) => (m.at || '').slice(0, 10) === new Date().toISOString().slice(0, 10)).length;
  const canSend = Auth.can('whatsapp.send');
  $c.html(`
    ${UI.pageHeader('WhatsApp', '')}
    <div class="wa-hero reveal mb-3">
      <div class="d-flex align-items-center gap-3">
        <div class="wa-badge"><i class="bi bi-whatsapp"></i></div>
        <div class="flex-grow-1 min-w-0"><div class="fw-bold">Reminders & notices</div>
          <div class="small">Each tap opens WhatsApp with the text ready. Press Send there. Messages sent today: <b>${sentToday}</b></div></div>
      </div>
      <div class="d-flex flex-wrap gap-2 mt-3">
        <button class="btn btn-light btn-sm" id="notify-btn"><i class="bi bi-bell me-1"></i>Desktop alerts</button>
        <span class="small opacity-75">Phone number format: 03XX XXXXXXX or 92XXXXXXXXXX.</span>
      </div>
    </div>

    <ul class="nav nav-pills gap-2 mb-3" role="tablist">
      <li><button class="nav-link active" data-tab="overdue">Overdue</button></li>
      <li><button class="nav-link" data-tab="unpaid">All unpaid</button></li>
      <li><button class="nav-link" data-tab="area">Area outage</button></li>
      <li><button class="nav-link" data-tab="templates">Templates</button></li>
      <li><button class="nav-link" data-tab="log">Log</button></li>
    </ul>
    <div id="wa-body"></div>`);

  // `current` holds the queue shown on screen; the [data-send] and [data-copy] buttons index into it.
  let current = [];
  const tabs = {
    overdue: async () => {
      current = await queue('overdue');
      return `<div class="small text-body-secondary mb-2">${current.length} customer${current.length === 1 ? '' : 's'} with an overdue bill.</div>${listBox(current)}`;
    },
    unpaid: async () => {
      current = await queue('unpaid');
      return `<div class="small text-body-secondary mb-2">${current.length} customer${current.length === 1 ? '' : 's'} with a balance due.</div>${listBox(current)}`;
    },
    area: async () => `<div class="card-soft p-3 mb-3">
        <label class="form-label">Area</label>
        <select class="form-select" id="area-pick"><option value="">Choose an area</option>${areas.map((a) => `<option>${esc(a)}</option>`).join('')}</select>
        <div class="small text-body-secondary mt-2">Use this when there is an outage. The notice says the team is working on it.</div>
      </div><div id="area-list"></div>`,
    templates: async () => {
      const s = getSettings();
      return `<div class="small text-body-secondary mb-2">${TEMPLATE_HELP}</div>
        ${Object.keys(DEFAULT_TEMPLATES).map((k) => `<div class="mb-3"><label class="form-label text-capitalize">${esc(k)}</label>
          <textarea class="form-control" rows="3" data-tpl="${k}">${esc(template(k))}</textarea></div>`).join('')}
        <div class="d-flex gap-2"><button class="btn btn-primary" data-save-tpl ${canSend ? '' : 'disabled'}>Save templates</button>
        <button class="btn btn-light" data-reset-tpl>Reset to default</button></div>
        ${s.whatsapp.templates && Object.keys(s.whatsapp.templates).length ? '<div class="small text-body-secondary mt-2">Custom templates are in use.</div>' : ''}`;
    },
    log: async () => {
      const recent = logs.sort((a, b) => (b.at || '').localeCompare(a.at || '')).slice(0, 200);
      const byId = new Map(subs.map((s) => [s.id, s]));
      return `<div class="list-card">${recent.length ? recent.map((m) => `<div class="list-row">
        <div class="main min-w-0"><div class="title text-truncate">${esc(byId.get(m.subscriberId)?.name || m.phone || 'Message')} <span class="small text-body-secondary">${esc(m.template)}</span></div>
          <div class="sub text-truncate">${esc(m.text)}</div></div>
        <div class="end small text-body-secondary">${fmtDate(m.at?.slice(0, 10))}</div></div>`).join('') : UI.emptyState('No messages sent from this desk yet', 'whatsapp')}</div>`;
    },
  };

  const show = async (tab) => {
    $c.find('[data-tab]').removeClass('active');
    $c.find(`[data-tab="${tab}"]`).addClass('active');
    $c.find('#wa-body').html(UI.spinner());
    $c.find('#wa-body').html(await tabs[tab]());
    if (tab === 'area') {
      $c.find('#area-pick').on('change', async function () {
        const area = this.value;
        if (!area) return $c.find('#area-list').empty();
        current = (await queue('area')).filter((r) => lc(r.sub.area) === lc(area));
        $c.find('#area-list').html(listBox(current));
      });
    }
  };
  const listBox = (rows) => rows.length ? `<div class="list-card">${rows.map((r, i) => queueRow(r, i)).join('')}</div>`
    : UI.emptyState('Nobody to message here', 'check2-circle');

  $c.on('click.wa', '[data-tab]', function () { show(this.dataset.tab); });
  $c.on('click.wa', '[data-send]', async function () {
    const r = current[+this.dataset.send];
    if (!r) return;
    if (!canSend) return UI.toast('You do not have permission to send messages.', 'warning');
    window.open(WA.waLink(r.phone, r.text), '_blank', 'noopener');
    await WA.logMessage({ subscriberId: r.sub.id, phone: r.phone, text: r.text, template: r.tpl }).catch(() => {});
    $(this).replaceWith('<span class="badge-soft tone-success"><i class="bi bi-check2"></i> Opened</span>');
  });
  $c.on('click.wa', '[data-copy]', async function () {
    const r = current[+this.dataset.copy];
    try { await navigator.clipboard.writeText(r.text); UI.toast('Message copied'); } catch { UI.toast('Could not copy. Select the text manually.', 'warning'); }
  });
  $c.on('click.wa', '[data-save-tpl]', () => {
    const patch = {};
    $c.find('[data-tpl]').each(function () { patch[this.dataset.tpl] = this.value.trim() || DEFAULT_TEMPLATES[this.dataset.tpl]; });
    saveSettings({ whatsapp: { templates: patch } });
    UI.toast('Templates saved');
  });
  $c.on('click.wa', '[data-reset-tpl]', () => {
    saveSettings({ whatsapp: { templates: {} } });
    UI.toast('Templates reset to default'); show('templates');
  });
  $c.on('click.wa', '#notify-btn', async () => {
    if (!('Notification' in window)) return UI.toast('Notifications are not supported on this device.', 'warning');
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm !== 'granted') return UI.toast('Allow notifications in the browser to get alerts.', 'warning');
    const bal = await loadBalances();
    const overdue = [...bal.values()].filter((b) => b.overdue > 0).length;
    new Notification('ISP Desk', { body: `${overdue} customer${overdue === 1 ? '' : 's'} with overdue bills. Open WhatsApp reminders.`, icon: 'icons/icon-192.png' });
  });
  await show('overdue');
}

export default {
  async render(el) { return renderPage(el); },
  destroy() {},
};
