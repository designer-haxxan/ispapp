// Customers (subscribers): list, add/edit, status (active / suspended / disconnected), history and WhatsApp.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtDate, today, num, uuid, nowISO, AppError, clean, lc, debounce } from '../core/utils.js';
import { cur, badge, pager, monthLabel } from '../core/views.js';
import { PAYMENT_METHODS } from '../db/schema.js';
import * as Auth from '../services/auth.js';
import * as WA from '../services/whatsapp.js';
import { loadBalances, balanceOf, nextNumber, statusFor } from '../services/billing.js';

const $ = window.jQuery;

export const TYPES = { fiber: 'Fiber (FTTH)', wireless: 'Wireless', lte: 'LTE / 4G', cable: 'Cable / LAN' };
export const STATUSES = { pending: 'Pending install', active: 'Active', suspended: 'Suspended', disconnected: 'Disconnected' };
const opts = (obj, sel) => Object.entries(obj).map(([k, l]) => `<option value="${esc(k)}" ${k === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');

// CNIC: 13 digits, shown as 35202-1234567-1. Blank is allowed.
export function normalizeCnic(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length !== 13) throw new AppError('CNIC must have 13 digits, e.g. 35202-1234567-1.');
  return `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`;
}

function formBody(s, plans) {
  const v = (k, d = '') => esc(s?.[k] ?? d);
  const planOpts = plans.filter((p) => p.active !== false || p.id === s?.planId)
    .map((p) => `<option value="${esc(p.id)}" ${s?.planId === p.id ? 'selected' : ''}>${esc(p.name)} · ${esc(cur())} ${fmtNum(p.price)}</option>`).join('');
  return `<div class="row g-2">
    <div class="col-12"><label class="form-label">Full name *</label><input name="name" class="form-control" required value="${v('name')}"></div>
    <div class="col-sm-6"><label class="form-label">Mobile (WhatsApp) *</label><input name="phone" class="form-control" inputmode="tel" placeholder="0300 1234567" value="${v('phone')}"></div>
    <div class="col-sm-6"><label class="form-label">CNIC</label><input name="cnic" class="form-control" inputmode="numeric" placeholder="35202-1234567-1" value="${v('cnic')}"></div>
    <div class="col-sm-6"><label class="form-label">Plan</label><select name="planId" class="form-select"><option value="">No plan yet</option>${planOpts}</select></div>
    <div class="col-sm-6"><label class="form-label">Custom monthly price (optional)</label><input name="customPrice" type="number" step="0.01" min="0" class="form-control" placeholder="Use plan price" value="${s?.customPrice ?? ''}"></div>
    <div class="col-sm-6"><label class="form-label">Connection type</label><select name="type" class="form-select">${opts(TYPES, s?.type || 'fiber')}</select></div>
    <div class="col-sm-6"><label class="form-label">Status</label><select name="status" class="form-select">${opts(STATUSES, s?.status || 'pending')}</select></div>
    <div class="col-sm-6"><label class="form-label">Installation date</label><input type="date" name="installDate" class="form-control" value="${v('installDate', today())}"></div>
    <div class="col-sm-6"><label class="form-label">Area / society / street</label><input name="area" class="form-control" value="${v('area')}"></div>
    <div class="col-12"><label class="form-label">Address</label><input name="address" class="form-control" value="${v('address')}"></div>
    <div class="col-sm-6"><label class="form-label">PPPoE / login username</label><input name="pppoeUser" class="form-control" value="${v('pppoeUser')}"></div>
    <div class="col-sm-6"><label class="form-label">IP address</label><input name="ipAddress" class="form-control" value="${v('ipAddress')}"></div>
    <div class="col-sm-6"><label class="form-label">ONU / router serial</label><input name="equipment" class="form-control" value="${v('equipment')}"></div>
    <div class="col-sm-6"><label class="form-label">Email</label><input type="email" name="email" class="form-control" value="${v('email')}"></div>
    <div class="col-12"><label class="form-label">Notes</label><textarea name="notes" class="form-control" rows="2">${v('notes')}</textarea></div>
  </div>`;
}

// Validates the form and writes the customer in one transaction. Duplicate mobile numbers are refused.
async function saveSubscriber(existing, f) {
  Auth.require('subscriber.manage');
  const name = clean(f.name, 120);
  if (!name) throw new AppError('Enter the customer name.');
  const phone = f.phone ? WA.normalizePhone(f.phone) : '';
  if (f.phone && !phone) throw new AppError('Enter a valid mobile number, e.g. 0300 1234567.');
  const cnic = normalizeCnic(f.cnic);
  const customPrice = f.customPrice === '' || f.customPrice == null ? null : round(num(f.customPrice));
  if (customPrice !== null && customPrice < 0) throw new AppError('Custom price cannot be negative.');
  const status = STATUSES[f.status] ? f.status : 'pending';
  if (status === 'active' && !f.planId) throw new AppError('An active customer needs a plan.');
  return idb.write(['subscribers', 'meta', 'auditLog'], async (t) => {
    if (phone) {
      const clash = (await t.getAllByIndex('subscribers', 'phone', phone)).find((s) => s.id !== existing?.id);
      if (clash) throw new AppError(`This mobile number already belongs to ${clash.name} (${clash.number}).`);
    }
    const now = nowISO();
    const rec = {
      ...(existing || {}),
      id: existing?.id || uuid(),
      number: existing?.number || await nextNumber(t, 'customer', 'CUS'),
      name, nameLc: lc(name), phone, cnic, email: clean(f.email, 120), area: clean(f.area, 80), address: clean(f.address, 200),
      type: TYPES[f.type] ? f.type : 'fiber', planId: f.planId || null, customPrice,
      status, installDate: f.installDate || today(), pppoeUser: clean(f.pppoeUser, 80), ipAddress: clean(f.ipAddress, 40),
      equipment: clean(f.equipment, 80), notes: clean(f.notes, 400), createdAt: existing?.createdAt || now, updatedAt: now,
    };
    if (!rec.phone) delete rec.phone;
    if (!rec.area) delete rec.area;
    await t.put('subscribers', rec);
    await t.add('auditLog', { id: uuid(), at: now, action: existing ? 'subscriber.edit' : 'subscriber.create', entity: rec.number, detail: name, by: Auth.user()?.name || '' });
    return rec;
  });
}
const round = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function openForm(existing, plans, onDone) {
  return UI.formModal({
    title: existing ? `Edit ${existing.name}` : 'Add customer',
    size: 'lg',
    body: formBody(existing, plans),
    submitLabel: existing ? 'Save changes' : 'Add customer',
    onSubmit: async (f) => {
      const saved = await saveSubscriber(existing, f);
      UI.toast(existing ? 'Customer updated' : `Customer ${saved.number} added`);
      onDone?.(saved);
      return saved;
    },
  });
}

async function setStatus(sub, status) {
  Auth.require('subscriber.manage');
  await idb.write(['subscribers', 'auditLog'], async (t) => {
    const s = await t.get('subscribers', sub.id);
    if (!s) throw new AppError('Customer not found.');
    s.status = status; s.updatedAt = nowISO();
    await t.put('subscribers', s);
    await t.add('auditLog', { id: uuid(), at: nowISO(), action: `subscriber.${status}`, entity: s.number, detail: s.name, by: Auth.user()?.name || '' });
  });
}

// Deletes only customers with no billing or complaint history. Anyone else is disconnected instead.
async function deleteSubscriber(sub) {
  Auth.require('subscriber.manage');
  return idb.write(['subscribers', 'invoices', 'payments', 'tickets', 'auditLog'], async (t) => {
    const history = (await t.countByIndex('invoices', 'subscriberId', sub.id)) + (await t.countByIndex('payments', 'subscriberId', sub.id)) + (await t.countByIndex('tickets', 'subscriberId', sub.id));
    if (history) throw new AppError('This customer has invoices, payments or complaints. Disconnect them instead to keep the records.');
    await t.delete('subscribers', sub.id);
    await t.add('auditLog', { id: uuid(), at: nowISO(), action: 'subscriber.delete', entity: sub.number, detail: sub.name, by: Auth.user()?.name || '' });
  });
}

// ---------- List ----------
function rowHtml(s, bal, plan) {
  const b = balanceOf(bal, s.id);
  const bText = b.balance > 0.004 ? `<span class="text-danger fw-semibold">Due ${esc(cur())} ${fmtNum(b.balance)}</span>`
    : b.balance < -0.004 ? `<span class="text-success fw-semibold">Credit ${esc(cur())} ${fmtNum(-b.balance)}</span>` : '<span class="text-body-secondary">Clear</span>';
  return `<a class="list-row" href="#/subscribers/${encodeURIComponent(s.id)}">
    ${UI.avatar(s.name)}
    <div class="main min-w-0"><div class="title text-truncate">${esc(s.name)} <span class="small text-body-secondary">${esc(s.number)}</span></div>
      <div class="sub text-truncate">${esc(plan?.name || 'No plan')} · ${esc(TYPES[s.type] || '')}${s.area ? ` · ${esc(s.area)}` : ''}</div></div>
    <div class="end text-end"><div>${badge(s.status, STATUSES[s.status])}</div><div class="small mt-1">${bText}</div></div></a>`;
}

async function renderList($c, ctx) {
  $c.off('.sub');
  const [subs, plans, bal] = await Promise.all([idb.getAll('subscribers'), idb.getAll('plans'), loadBalances()]);
  const planById = new Map(plans.map((p) => [p.id, p]));
  const counts = Object.fromEntries(Object.keys(STATUSES).map((k) => [k, subs.filter((s) => s.status === k).length]));
  $c.html(`
    ${UI.pageHeader('Customers', Auth.can('subscriber.manage') ? '<a class="btn btn-outline-primary btn-sm" href="#/import"><i class="bi bi-upload me-1"></i>Import</a> <button class="btn btn-primary btn-sm" data-add><i class="bi bi-person-plus me-1"></i>Add customer</button>' : '')}
    <div class="filters mb-3">
      <input type="search" class="form-control" id="sub-q" placeholder="Search name, mobile, CNIC, code or area" autocomplete="off">
    </div>
    <div class="chips mb-3" role="tablist">
      <button class="chip active" data-status="">All · ${subs.length}</button>
      ${Object.entries(STATUSES).map(([k, l]) => `<button class="chip" data-status="${k}">${esc(l)} · ${counts[k]}</button>`).join('')}
    </div>
    <div class="list-card" id="sub-list"></div>`);
  let status = '';
  const draw = () => {
    const q = lc($c.find('#sub-q').val() || '');
    const digits = q.replace(/\D/g, '');
    const list = subs.filter((s) => (!status || s.status === status) && (!q
      || lc(s.name).includes(q) || lc(s.number).includes(q) || lc(s.area || '').includes(q)
      || (digits && (String(s.phone || '').includes(digits) || String(s.cnic || '').replace(/\D/g, '').includes(digits)))))
      .sort((a, b) => a.name.localeCompare(b.name));
    pager($c.find('#sub-list'), list, (s) => rowHtml(s, bal, planById.get(s.planId)), 60,
      UI.emptyState(q || status ? 'No customers match this search' : 'No customers yet. Add your first connection.', 'people',
        Auth.can('subscriber.manage') ? '<button class="btn btn-primary btn-sm mt-2" data-add><i class="bi bi-person-plus me-1"></i>Add customer</button>' : ''));
  };
  $c.on('input.sub', '#sub-q', debounce(draw, 150));
  $c.on('click.sub', '[data-status]', function () {
    status = this.dataset.status;
    $c.find('[data-status]').removeClass('active'); $(this).addClass('active');
    draw();
  });
  // After adding a customer, open their page (the add form must not reopen on top of the list).
  const openNew = (s) => { location.hash = `#/subscribers/${encodeURIComponent(s.id)}`; };
  $c.on('click.sub', '[data-add]', () => openForm(null, plans, openNew));
  draw();
  if (ctx.params?.[0] === 'new') openForm(null, plans, openNew);
}

// ---------- Detail ----------
async function renderDetail($c, id, ctx) {
  $c.off('.sub');
  const data = await idb.read(['subscribers', 'plans', 'invoices', 'payments', 'tickets', 'messages'], async (t) => ({
    sub: await t.get('subscribers', id),
    plans: await t.getAll('plans'),
    invoices: await t.getAllByIndex('invoices', 'subscriberId', id),
    payments: await t.getAllByIndex('payments', 'subscriberId', id),
    tickets: await t.getAllByIndex('tickets', 'subscriberId', id),
    messages: await t.getAllByIndex('messages', 'subscriberId', id),
  }));
  const { sub, plans } = data;
  if (!sub) { $c.html(UI.emptyState('This customer no longer exists.', 'person-x', '<a class="btn btn-primary btn-sm mt-2" href="#/subscribers">Back to customers</a>')); return; }
  ctx.setTitle?.(sub.name);
  const bal = await loadBalances();
  const b = balanceOf(bal, id);
  const plan = plans.find((p) => p.id === sub.planId);
  const price = sub.customPrice ?? plan?.price ?? 0;
  const invoices = data.invoices.sort((a, c) => (c.issueDate + c.number).localeCompare(a.issueDate + a.number));
  const payments = data.payments.filter((p) => !p.voided).sort((a, c) => (c.date + c.number).localeCompare(a.date + a.number));
  const tickets = data.tickets.sort((a, c) => (c.createdAt || '').localeCompare(a.createdAt || ''));
  const msgs = data.messages.sort((a, c) => (c.at || '').localeCompare(a.at || '')).slice(-30).reverse();
  const canManage = Auth.can('subscriber.manage');
  const phone = WA.normalizePhone(sub.phone);
  const dl = (k, v) => v ? `<div class="d-flex justify-content-between gap-3 py-2 border-bottom"><span class="text-body-secondary small">${esc(k)}</span><span class="text-end small fw-medium">${v}</span></div>` : '';
  const tile = (label, value, tone = '') => `<div class="col-4"><div class="bal-tile ${tone}"><div class="small text-body-secondary">${esc(label)}</div><div class="fw-bold">${esc(cur())} ${fmtNum(value)}</div></div></div>`;

  $c.html(`
    ${UI.pageHeader(sub.name, '', '#/subscribers')}
    <div class="profile-card reveal">
      <div class="d-flex align-items-center gap-3">
        ${UI.avatar(sub.name, 'avatar-lg')}
        <div class="min-w-0 flex-grow-1">
          <div class="fw-bold text-truncate fs-5">${esc(sub.name)}</div>
          <div class="small text-body-secondary">${esc(sub.number)} · ${esc(plan?.name || 'No plan')} · ${esc(TYPES[sub.type] || '')}</div>
          <div class="mt-1">${badge(sub.status, STATUSES[sub.status])}</div>
        </div>
      </div>
      <div class="row g-2 mt-2">
        ${tile('Outstanding', b.outstanding, b.outstanding > 0 ? 'bad' : '')}
        ${tile('Overdue', b.overdue, b.overdue > 0 ? 'bad' : '')}
        ${tile('Advance credit', b.credit, b.credit > 0 ? 'good' : '')}
      </div>
      <div class="d-flex flex-wrap gap-2 mt-3 action-bar">
        ${Auth.can('payment.record') ? `<a class="btn btn-success btn-sm" href="#/collect/${encodeURIComponent(id)}"><i class="bi bi-cash-coin me-1"></i>Collect</a>` : ''}
        ${Auth.can('billing.manage') ? `<a class="btn btn-outline-primary btn-sm" href="#/invoices/new/${encodeURIComponent(id)}"><i class="bi bi-receipt me-1"></i>New invoice</a>` : ''}
        ${Auth.can('whatsapp.send') && phone ? '<button class="btn btn-outline-success btn-sm" data-msg><i class="bi bi-whatsapp me-1"></i>WhatsApp</button>' : ''}
        ${Auth.can('ticket.manage') ? `<a class="btn btn-outline-danger btn-sm" href="#/tickets/new/${encodeURIComponent(id)}"><i class="bi bi-tools me-1"></i>Log complaint</a>` : ''}
        ${canManage ? '<button class="btn btn-light btn-sm" data-edit><i class="bi bi-pencil me-1"></i>Edit</button>' : ''}
      </div>
    </div>

    <div class="row g-3 mt-1">
      <div class="col-lg-5">
        <div class="card-soft p-3">
          <div class="fw-semibold mb-1">Connection</div>
          ${dl('Mobile', phone ? esc(WA.displayPhone(phone)) : '')}
          ${dl('CNIC', esc(sub.cnic || ''))}
          ${dl('Email', esc(sub.email || ''))}
          ${dl('Area', esc(sub.area || ''))}
          ${dl('Address', esc(sub.address || ''))}
          ${dl('Monthly price', `${esc(cur())} ${fmtNum(price)}${sub.customPrice != null ? ' <span class="text-body-secondary">(custom)</span>' : ''}`)}
          ${dl('Installed', sub.installDate ? fmtDate(sub.installDate) : '')}
          ${dl('Expiry (from import)', sub.expiryDate ? fmtDate(sub.expiryDate) : '')}
          ${dl('PPPoE user', esc(sub.pppoeUser || ''))}
          ${dl('IP address', esc(sub.ipAddress || ''))}
          ${dl('ONU / router', esc(sub.equipment || ''))}
          ${dl('Notes', esc(sub.notes || ''))}
          ${canManage ? `<div class="d-flex flex-wrap gap-2 mt-3">
            ${sub.status !== 'active' && sub.status !== 'disconnected' ? '<button class="btn btn-sm btn-success" data-status="active"><i class="bi bi-play-circle me-1"></i>Activate</button>' : ''}
            ${sub.status === 'active' ? '<button class="btn btn-sm btn-warning" data-status="suspended"><i class="bi bi-pause-circle me-1"></i>Suspend</button>' : ''}
            ${sub.status === 'suspended' ? '<button class="btn btn-sm btn-success" data-status="active"><i class="bi bi-play-circle me-1"></i>Reactivate</button>' : ''}
            ${sub.status !== 'disconnected' ? '<button class="btn btn-sm btn-outline-danger" data-status="disconnected"><i class="bi bi-x-circle me-1"></i>Disconnect</button>' : ''}
            <button class="btn btn-sm btn-light text-danger" data-delete><i class="bi bi-trash me-1"></i>Delete</button>
          </div>` : ''}
        </div>
      </div>
      <div class="col-lg-7">
        <div class="section-title"><h2>Invoices</h2><a href="#/invoices">All invoices</a></div>
        <div class="list-card">${invoices.length ? invoices.slice(0, 12).map((i) => `<a class="list-row" href="#/invoices/${encodeURIComponent(i.id)}">
          <div class="main min-w-0"><div class="title text-truncate">${esc(i.number)} · ${esc(monthLabel(i.period || i.issueDate.slice(0, 7)))}</div>
          <div class="sub">Due ${fmtDate(i.dueDate)} · ${esc(cur())} ${fmtNum(i.total)}</div></div>
          <div class="end">${badge(i.status === 'void' ? 'void' : statusFor(i))}</div></a>`).join('') : UI.emptyState('No invoices yet', 'receipt')}</div>

        <div class="section-title mt-3"><h2>Payments</h2></div>
        <div class="list-card">${payments.length ? payments.slice(0, 8).map((p) => `<div class="list-row">
          <div class="main min-w-0"><div class="title">${esc(p.number)} · ${esc(PAYMENT_METHODS[p.method] || p.method)}</div>
          <div class="sub">${fmtDate(p.date)}${p.reference ? ` · ref ${esc(p.reference)}` : ''}</div></div>
          <div class="end fw-semibold text-success">+${esc(cur())} ${fmtNum(p.amount)}</div></div>`).join('') : UI.emptyState('No payments yet', 'wallet2')}</div>

        <div class="section-title mt-3"><h2>Complaints</h2><a href="#/tickets">All complaints</a></div>
        <div class="list-card">${tickets.length ? tickets.slice(0, 6).map((t) => `<a class="list-row" href="#/tickets/${encodeURIComponent(t.id)}">
          <div class="main min-w-0"><div class="title text-truncate">${esc(t.number)} · ${esc(t.issue || '')}</div><div class="sub">${fmtDate(t.createdAt?.slice(0, 10))}</div></div>
          <div class="end">${badge(t.status)}</div></a>`).join('') : UI.emptyState('No complaints logged', 'check2-circle')}</div>

        <div class="section-title mt-3"><h2>WhatsApp history</h2></div>
        <div class="list-card">${msgs.length ? msgs.slice(0, 10).map((m) => `<div class="list-row">
          <div class="main min-w-0"><div class="title">${esc(m.template || 'message')}</div><div class="sub text-truncate">${esc(m.text)}</div></div>
          <div class="end small text-body-secondary">${fmtDate(m.at?.slice(0, 10))}</div></div>`).join('') : UI.emptyState('No messages sent yet', 'whatsapp')}</div>
      </div>
    </div>`);

  $c.on('click.sub', '[data-status]', async function () {
    const st = this.dataset.status;
    const ok = await UI.confirmDialog(`Change ${sub.name} to "${STATUSES[st]}"?${st === 'disconnected' ? ' Billing stops for this customer; history is kept.' : ''}`, { okLabel: STATUSES[st], okClass: st === 'disconnected' ? 'btn-danger' : 'btn-primary' });
    if (!ok) return;
    try { await setStatus(sub, st); UI.toast('Status updated'); renderDetail($c, id, ctx); } catch (e) { UI.toastError(e); }
  });
  $c.on('click.sub', '[data-edit]', () => openForm(sub, plans, () => renderDetail($c, id, ctx)));
  $c.on('click.sub', '[data-delete]', async () => {
    const ok = await UI.confirmDialog(`Delete ${sub.name} permanently? Only customers without any billing or complaint history can be deleted.`, { okLabel: 'Delete', okClass: 'btn-danger' });
    if (!ok) return;
    try { await deleteSubscriber(sub); UI.toast('Customer deleted'); location.hash = '#/subscribers'; } catch (e) { UI.toastError(e); }
  });
  $c.on('click.sub', '[data-msg]', () => openMessageMenu(sub, plan, b, phone));
}

// Choose which WhatsApp message to open for this customer. The app opens WhatsApp with the text ready; you press Send.
export function openMessageMenu(sub, plan, bal, phone) {
  const vars = WA.customerVars(sub, plan, bal, { amount: WA.money(plan?.price ?? sub.customPrice ?? 0), month: WA.monthVar(today().slice(0, 7)) });
  const choices = [
    ['reminder', 'Payment reminder', 'bi-bell'],
    ['overdue', 'Overdue notice', 'bi-exclamation-triangle'],
    ['custom', 'Write a custom message', 'bi-pencil-square'],
  ];
  const m = UI.modal({
    title: `WhatsApp · ${sub.name}`, size: 'md',
    body: `<div class="list-group">${choices.map(([k, l, i]) => `<button class="list-group-item list-group-item-action d-flex gap-2 align-items-center py-3" data-tpl="${k}"><i class="bi ${i} text-success"></i>${esc(l)}</button>`).join('')}</div>
      <textarea class="form-control mt-3 d-none" id="wa-custom" rows="3" placeholder="Type your message"></textarea>
      <div class="small text-body-secondary mt-2">Opens WhatsApp with the text filled in. You still press Send.</div>`,
    footer: '<button class="btn btn-light" data-bs-dismiss="modal">Close</button>',
  });
  m.$el.on('click', '[data-tpl]', async function () {
    const k = this.dataset.tpl;
    let text;
    if (k === 'custom') {
      const $ta = m.$el.find('#wa-custom').removeClass('d-none');
      if (!$ta.val().trim()) { $ta.trigger('focus'); return; }
      text = $ta.val().trim();
    } else text = WA.fillTemplate(k, vars);
    window.open(WA.waLink(phone, text), '_blank', 'noopener');
    await WA.logMessage({ subscriberId: sub.id, phone, text, template: k }).catch(() => {});
    UI.toast('WhatsApp opened. Press Send there.', 'info');
  });
}

export default {
  async render(el, ctx) {
    this.destroy();
    const $c = $(el);
    if (ctx.params?.[0] && ctx.params[0] !== 'new') return renderDetail($c, decodeURIComponent(ctx.params[0]), ctx);
    return renderList($c, ctx);
  },
  destroy() {},
};
