// Complaints and faults: every "internet is down", "slow", or "wrong bill" call is logged, assigned, resolved and acknowledged on WhatsApp.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtDate, today, uuid, nowISO, AppError, clean } from '../core/utils.js';
import { badge, pager, daysBetween } from '../core/views.js';
import { TICKET_CATEGORIES } from '../db/schema.js';
import * as Auth from '../services/auth.js';
import * as WA from '../services/whatsapp.js';
import { balanceOf, loadBalances, nextNumber } from '../services/billing.js';
import { getSettings } from '../core/settings.js';

const $ = window.jQuery;
const STATUS = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' };

async function saveTicket(f, subId) {
  Auth.require('ticket.manage');
  const issue = TICKET_CATEGORIES[f.issue] ? f.issue : 'other';
  if (!subId) throw new AppError('Choose a customer.');
  const desc = clean(f.description, 500);
  return idb.write(['tickets', 'subscribers', 'meta', 'auditLog'], async (t) => {
    if (!await t.get('subscribers', subId)) throw new AppError('Customer not found.');
    const now = nowISO();
    const rec = {
      id: uuid(), number: await nextNumber(t, 'ticket', 'TKT'), subscriberId: subId, issue, priority: f.priority === 'high' ? 'high' : 'normal',
      description: desc, assignedTo: clean(f.assignedTo, 60), status: 'open', createdAt: now, createdDate: today(), updatedAt: now,
      by: Auth.user()?.name || '',
    };
    await t.add('tickets', rec);
    return rec;
  });
}

async function updateTicket(id, patch) {
  Auth.require('ticket.manage');
  return idb.write(['tickets'], async (t) => {
    const r = await t.get('tickets', id);
    if (!r) throw new AppError('Complaint not found.');
    Object.assign(r, patch, { updatedAt: nowISO() });
    if (patch.status === 'resolved') r.resolvedAt = nowISO();
    await t.put('tickets', r);
    return r;
  });
}

function ticketForm(subs) {
  return `<div class="row g-2">
    <div class="col-12"><label class="form-label">Customer *</label>
      <select name="subId" class="form-select" required><option value="">Select customer</option>${subs.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} · ${esc(s.number)}</option>`).join('')}</select></div>
    <div class="col-sm-6"><label class="form-label">Problem *</label><select name="issue" class="form-select">${Object.entries(TICKET_CATEGORIES).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></div>
    <div class="col-sm-6"><label class="form-label">Priority</label><select name="priority" class="form-select"><option value="normal">Normal</option><option value="high">High (area outage)</option></select></div>
    <div class="col-12"><label class="form-label">Details</label><textarea name="description" class="form-control" rows="2" maxlength="500" placeholder="e.g. Red light on ONU, no internet since morning"></textarea></div>
    <div class="col-12"><label class="form-label">Assigned to</label><input name="assignedTo" class="form-control" maxlength="60" placeholder="Technician name"></div>
  </div>`;
}

async function renderList($c, ctx) {
  $c.off('.tkt');
  const [tickets, subs] = await Promise.all([idb.getAll('tickets'), idb.getAll('subscribers')]);
  const subById = new Map(subs.map((s) => [s.id, s]));
  const open = tickets.filter((t) => t.status !== 'resolved');
  const high = open.filter((t) => t.priority === 'high').length;
  const aged = open.filter((t) => daysBetween(t.createdDate, today()) >= 2).length;
  let filter = 'open';
  $c.html(`
    ${UI.pageHeader('Complaints & faults', Auth.can('ticket.manage') ? '<button class="btn btn-primary btn-sm" data-add><i class="bi bi-plus-lg me-1"></i>Log complaint</button>' : '')}
    <div class="row g-2 mb-3">
      <div class="col-4"><div class="mini-stat"><div class="small text-body-secondary">Open</div><div class="fw-bold fs-5">${open.length}</div></div></div>
      <div class="col-4"><div class="mini-stat ${high ? 'warn' : ''}"><div class="small text-body-secondary">High priority</div><div class="fw-bold fs-5">${high}</div></div></div>
      <div class="col-4"><div class="mini-stat ${aged ? 'warn' : ''}"><div class="small text-body-secondary">2+ days old</div><div class="fw-bold fs-5">${aged}</div></div></div>
    </div>
    <div class="chips mb-3">${[['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved'], ['', 'All']].map(([k, l]) => `<button class="chip ${k === filter ? 'active' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
    <div class="list-card" id="tkt-list"></div>`);
  const draw = () => {
    const list = tickets.filter((t) => !filter || (filter === 'open' ? t.status !== 'resolved' : t.status === filter))
      .sort((a, b) => (b.priority === 'high') - (a.priority === 'high') || (b.createdAt || '').localeCompare(a.createdAt || ''));
    pager($c.find('#tkt-list'), list, (t) => {
      const s = subById.get(t.subscriberId);
      const age = daysBetween(t.createdDate, today());
      return `<a class="list-row" href="#/tickets/${encodeURIComponent(t.id)}">
        <div class="icon-chip tint-${t.priority === 'high' ? 'red' : t.status === 'resolved' ? 'green' : 'amber'}"><i class="bi bi-${t.issue === 'billing' ? 'receipt' : 'tools'}"></i></div>
        <div class="main min-w-0"><div class="title text-truncate">${esc(TICKET_CATEGORIES[t.issue] || t.issue)} <span class="small text-body-secondary">${esc(t.number)}</span></div>
          <div class="sub text-truncate">${esc(s?.name || 'Unknown')} · ${esc(s?.area || '')} · ${age === 0 ? 'today' : `${age}d ago`}${t.assignedTo ? ` · ${esc(t.assignedTo)}` : ''}</div></div>
        <div class="end">${badge(t.status, STATUS[t.status])}${t.priority === 'high' ? '<div class="small text-danger fw-semibold mt-1">High</div>' : ''}</div></a>`;
    }, 60, UI.emptyState('No complaints here. Good.', 'check2-circle'));
  };
  draw();
  $c.on('click.tkt', '[data-f]', function () { filter = this.dataset.f; $c.find('[data-f]').removeClass('active'); $(this).addClass('active'); draw(); });
  $c.on('click.tkt', '[data-add]', async () => {
    const r = await openNew(subs);
    if (r) location.hash = `#/tickets/${encodeURIComponent(r.id)}`;
  });
}

// Returns the new complaint, or null if cancelled. The caller decides where to go next.
async function openNew(subs, preselect = '') {
  if (!subs.length) { UI.toast('Add a customer first', 'warning'); return null; }
  const r = await UI.formModal({
    title: 'Log complaint', body: ticketForm(subs.filter((s) => s.status !== 'disconnected')), submitLabel: 'Log complaint',
    onShown: (m) => { if (preselect) m.find('[name=subId]').val(preselect); },
    onSubmit: (f) => saveTicket(f, f.subId),
  });
  if (r) UI.toast(`Complaint ${r.number} logged`);
  return r || null;
}

async function renderDetail($c, id, ctx) {
  $c.off('.tkt');
  const t = await idb.get('tickets', id);
  if (!t) { $c.html(UI.emptyState('Complaint not found.', 'tools', '<a class="btn btn-primary btn-sm mt-2" href="#/tickets">Back</a>')); return; }
  const sub = await idb.get('subscribers', t.subscriberId);
  const plans = await idb.getAll('plans');
  const plan = plans.find((p) => p.id === sub?.planId);
  const phone = WA.normalizePhone(sub?.phone);
  const age = daysBetween(t.createdDate, today());
  ctx.setTitle?.(t.number);
  $c.html(`
    ${UI.pageHeader(`${t.number}`, '', '#/tickets')}
    <div class="profile-card reveal">
      <div class="d-flex justify-content-between align-items-start gap-2 flex-wrap">
        <div><div class="fw-bold fs-5">${esc(TICKET_CATEGORIES[t.issue] || t.issue)}</div>
          <a href="#/subscribers/${encodeURIComponent(t.subscriberId)}">${esc(sub?.name || 'Unknown')}</a>
          <div class="small text-body-secondary">${esc(sub?.number || '')} · ${esc(sub?.area || '')}${phone ? ` · ${esc(WA.displayPhone(phone))}` : ''}</div></div>
        <div class="text-end">${badge(t.status, STATUS[t.status])}${t.priority === 'high' ? ' <span class="badge-soft tone-danger">High</span>' : ''}
          <div class="small text-body-secondary mt-1">Opened ${fmtDate(t.createdDate)} · ${age === 0 ? 'today' : `${age} days ago`}</div></div>
      </div>
      ${t.description ? `<p class="mt-3 mb-0">${esc(t.description)}</p>` : ''}
      ${t.assignedTo ? `<div class="small mt-2">Assigned to <b>${esc(t.assignedTo)}</b></div>` : ''}
      ${t.resolution ? `<div class="alert alert-success small mt-3 mb-0"><b>Resolved:</b> ${esc(t.resolution)}</div>` : ''}
      <div class="d-flex flex-wrap gap-2 mt-3 action-bar">
        ${Auth.can('ticket.manage') && t.status === 'open' ? '<button class="btn btn-sm btn-outline-primary" data-st="in_progress"><i class="bi bi-play me-1"></i>Start work</button>' : ''}
        ${Auth.can('ticket.manage') && t.status !== 'resolved' ? '<button class="btn btn-sm btn-success" data-resolve><i class="bi bi-check2 me-1"></i>Mark resolved</button>' : ''}
        ${Auth.can('ticket.manage') && t.status === 'resolved' ? '<button class="btn btn-sm btn-outline-secondary" data-st="open">Reopen</button>' : ''}
        ${Auth.can('whatsapp.send') && phone ? '<button class="btn btn-sm btn-outline-success" data-wa><i class="bi bi-whatsapp me-1"></i>Acknowledge on WhatsApp</button>' : ''}
      </div>
    </div>`);

  $c.on('click.tkt', '[data-st]', async function () {
    try { await updateTicket(id, { status: this.dataset.st }); UI.toast('Updated'); renderDetail($c, id, ctx); } catch (e) { UI.toastError(e); }
  });
  $c.on('click.tkt', '[data-resolve]', async () => {
    const note = await UI.formModal({
      title: 'Mark resolved', submitLabel: 'Resolve',
      body: `<label class="form-label">What was done *</label><textarea name="note" class="form-control" rows="3" required maxlength="300" placeholder="e.g. Replaced ONU, cable re-fixed at pole"></textarea>`,
      onSubmit: (v) => { if (!v.note?.trim()) throw new AppError('Describe what was done.'); return v.note.trim(); },
    });
    if (!note) return;
    try { await updateTicket(id, { status: 'resolved', resolution: note }); UI.toast('Complaint resolved'); renderDetail($c, id, ctx); } catch (e) { UI.toastError(e); }
  });
  $c.on('click.tkt', '[data-wa]', async () => {
    const bal = balanceOf(await loadBalances(), sub.id);
    const text = WA.fillTemplate('ticket', WA.customerVars(sub, plan, bal, { ticket: t.number, issue: (TICKET_CATEGORIES[t.issue] || '').toLowerCase(), phone: getSettings().business.phone }));
    window.open(WA.waLink(phone, text), '_blank', 'noopener');
    await WA.logMessage({ subscriberId: sub.id, phone, text, template: 'ticket' }).catch(() => {});
    UI.toast('WhatsApp opened. Press Send there.', 'info');
  });
}

export default {
  async render(el, ctx) {
    const $c = $(el);
    const [a, b] = ctx.params || [];
    if (a === 'new') {
      const subs = await idb.getAll('subscribers');
      const r = await openNew(subs, b ? decodeURIComponent(b) : '');
      if (r) { location.hash = `#/tickets/${encodeURIComponent(r.id)}`; return; }
      return renderList($c, ctx);
    }
    if (a) return renderDetail($c, decodeURIComponent(a), ctx);
    return renderList($c, ctx);
  },
  destroy() {},
};
