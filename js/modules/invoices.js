// Invoices: monthly billing run, one-off invoices (installation, shifting, repairs), invoice view, print and WhatsApp.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtDate, today, num, AppError, lc } from '../core/utils.js';
import { cur, badge, pager, monthLabel, currentMonth, addDays, monthOf } from '../core/views.js';
import { getSettings, pref } from '../core/settings.js';
import * as Auth from '../services/auth.js';
import * as WA from '../services/whatsapp.js';
import { generateMonthlyRun, createInvoice, voidInvoice, statusFor, isOverdue } from '../services/billing.js';
import { PAYMENT_METHODS } from '../db/schema.js';

const $ = window.jQuery;
const STATUS_FILTERS = { '': 'All', unpaid: 'Unpaid', partial: 'Partial', overdue: 'Overdue', paid: 'Paid', void: 'Void' };

// ---------- List ----------
// The chosen month is remembered on this device (the router does not carry query strings).
async function renderList($c, ctx, ym = pref.get('invoiceMonth', currentMonth())) {
  $c.off('.inv');
  pref.set('invoiceMonth', ym);
  const [invoices, subs] = await Promise.all([idb.getAll('invoices'), idb.getAll('subscribers')]);
  const subById = new Map(subs.map((s) => [s.id, s]));
  const inMonth = invoices.filter((i) => monthOf(i.issueDate) === ym);
  const live = inMonth.filter((i) => i.status !== 'void');
  const billed = live.reduce((s, i) => s + i.total, 0);
  const collected = live.reduce((s, i) => s + i.paid, 0);
  const outstanding = live.reduce((s, i) => s + Math.max(0, i.total - i.paid), 0);
  let filter = '';
  $c.html(`
    ${UI.pageHeader('Invoices', Auth.can('billing.manage') ? `<a class="btn btn-primary btn-sm" href="#/invoices/run"><i class="bi bi-lightning-charge me-1"></i>Monthly run</a>` : '')}
    <div class="filters mb-2">
      <div><label class="form-label small mb-0">Month</label><input type="month" class="form-control form-control-sm" id="inv-month" value="${esc(ym)}"></div>
      <div class="flex-grow-1"><label class="form-label small mb-0">Customer</label><input type="search" class="form-control form-control-sm" id="inv-q" placeholder="Name, code or invoice no." autocomplete="off"></div>
    </div>
    <div class="row g-2 mb-3">
      <div class="col-4"><div class="mini-stat"><div class="small text-body-secondary">Billed</div><div class="fw-bold" data-count="${billed}" data-money="1">0</div></div></div>
      <div class="col-4"><div class="mini-stat"><div class="small text-body-secondary">Paid on these</div><div class="fw-bold text-success" data-count="${collected}" data-money="1">0</div></div></div>
      <div class="col-4"><div class="mini-stat"><div class="small text-body-secondary">Outstanding</div><div class="fw-bold text-danger" data-count="${outstanding}" data-money="1">0</div></div></div>
    </div>
    <div class="chips mb-3">${Object.entries(STATUS_FILTERS).map(([k, l]) => `<button class="chip ${k === '' ? 'active' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
    <div class="list-card" id="inv-list"></div>`);
  UI.countUp($c[0], (n, el) => `${cur()} ${fmtNum(n)}`);

  const draw = () => {
    const q = lc($c.find('#inv-q').val() || '');
    const rows = inMonth.filter((i) => {
      const s = subById.get(i.subscriberId);
      const st = i.status === 'void' ? 'void' : statusFor(i);
      if (filter === 'overdue' && !isOverdue(i)) return false;
      if (filter && filter !== 'overdue' && st !== filter) return false;
      if (q && !(i.number.toLowerCase().includes(q) || lc(s?.name || '').includes(q) || lc(s?.number || '').includes(q))) return false;
      return true;
    }).sort((a, b) => (b.issueDate + b.number).localeCompare(a.issueDate + a.number));
    pager($c.find('#inv-list'), rows, (i) => {
      const s = subById.get(i.subscriberId);
      const st = i.status === 'void' ? 'void' : isOverdue(i) ? 'overdue' : statusFor(i);
      return `<a class="list-row" href="#/invoices/${encodeURIComponent(i.id)}">
        ${UI.avatar(s?.name || '?')}
        <div class="main min-w-0"><div class="title text-truncate">${esc(s?.name || 'Unknown customer')} <span class="small text-body-secondary">${esc(i.number)}</span></div>
          <div class="sub">${esc(s?.number || '')} · due ${fmtDate(i.dueDate)}</div></div>
        <div class="end text-end"><div class="fw-semibold">${esc(cur())} ${fmtNum(i.total)}</div><div>${badge(st)}</div></div></a>`;
    }, 60, UI.emptyState(inMonth.length ? 'No invoices match' : `No invoices for ${monthLabel(ym)}`, 'receipt',
      Auth.can('billing.manage') ? '<a class="btn btn-primary btn-sm mt-2" href="#/invoices/run">Run monthly billing</a>' : ''));
  };
  $c.on('input.inv', '#inv-q', draw);
  $c.on('change.inv', '#inv-month', (e) => { if (e.target.value) renderList($c, ctx, e.target.value); });
  $c.on('click.inv', '[data-f]', function () {
    filter = this.dataset.f; $c.find('[data-f]').removeClass('active'); $(this).addClass('active'); draw();
  });
  draw();
}

// ---------- Monthly run ----------
async function renderRun($c) {
  $c.off('.inv');
  const b = getSettings().billing;
  const period = currentMonth();
  $c.html(`
    ${UI.pageHeader('Monthly billing run', '', '#/invoices')}
    <div class="card-soft p-3 p-md-4 reveal">
      <div class="d-flex flex-wrap align-items-end gap-3">
        <div><label class="form-label small mb-1">Billing month</label><input type="month" class="form-control" id="run-month" value="${period}" style="max-width:200px"></div>
        <div class="small text-body-secondary">Issue date <b>${esc(String(b.billingDay || 1))}</b> of the month · due after <b>${esc(String(b.dueDays))}</b> days</div>
      </div>
      <div id="run-preview" class="mt-3"></div>
      <div class="d-flex gap-2 mt-3">
        <button class="btn btn-primary" id="run-go" disabled><i class="bi bi-lightning-charge me-1"></i>Generate invoices</button>
      </div>
      <div class="small text-body-secondary mt-3">Each customer is billed once per month. Running the same month again only adds customers who were missed, so it is safe to repeat.</div>
    </div>`);

  const preview = async () => {
    const ym = $c.find('#run-month').val();
    const [subs, plans, invoices] = await Promise.all([idb.getAll('subscribers'), idb.getAll('plans'), idb.getAll('invoices')]);
    const planById = new Map(plans.map((p) => [p.id, p]));
    const billedKeys = new Set(invoices.filter((i) => i.periodKey).map((i) => i.periodKey));
    let eligible = 0; let already = 0; let noPlan = 0; let total = 0;
    for (const s of subs) {
      if (s.status !== 'active' && s.status !== 'suspended') continue;
      const plan = planById.get(s.planId);
      if (!plan) { noPlan++; continue; }
      if (billedKeys.has(`${s.id}|${ym}`)) { already++; continue; }
      eligible++; total += s.customPrice ?? plan.price;
    }
    $c.find('#run-preview').html(`<div class="row g-2">
      <div class="col-6 col-md-3"><div class="mini-stat"><div class="small text-body-secondary">Will be billed</div><div class="fw-bold fs-5">${eligible}</div></div></div>
      <div class="col-6 col-md-3"><div class="mini-stat"><div class="small text-body-secondary">Estimated total</div><div class="fw-bold fs-5">${esc(cur())} ${fmtNum(total)}</div></div></div>
      <div class="col-6 col-md-3"><div class="mini-stat"><div class="small text-body-secondary">Already billed</div><div class="fw-bold fs-5">${already}</div></div></div>
      <div class="col-6 col-md-3"><div class="mini-stat ${noPlan ? 'warn' : ''}"><div class="small text-body-secondary">No plan (skipped)</div><div class="fw-bold fs-5">${noPlan}</div></div></div>
    </div>`);
    $c.find('#run-go').prop('disabled', eligible === 0);
    $c.find('#run-go').data('eligible', eligible);
  };
  $c.on('change.inv', '#run-month', preview);
  $c.on('click.inv', '#run-go', async function () {
    const ym = $c.find('#run-month').val();
    const ok = await UI.confirmDialog(`Create ${$(this).data('eligible')} invoices for ${monthLabel(ym)}? Customers already billed for this month are skipped.`, { okLabel: 'Generate', okClass: 'btn-primary' });
    if (!ok) return;
    try {
      const res = await UI.withLoading(() => generateMonthlyRun(ym), 'Creating invoices…');
      UI.toast(`${res.created} invoices created${res.skipped ? `, ${res.skipped} already existed` : ''}`);
      pref.set('invoiceMonth', ym);
      location.hash = '#/invoices';
    } catch (e) { UI.toastError(e); }
  });
  await preview();
}

// ---------- One-off invoice ----------
function lineRow(i, desc = '', amt = '') {
  return `<div class="line-row d-flex gap-2 mb-2">
    <input class="form-control" name="desc" placeholder="Description, e.g. Installation charges" value="${esc(desc)}" maxlength="160" aria-label="Description">
    <input class="form-control" name="amt" type="number" min="0" step="0.01" placeholder="Amount" value="${esc(amt)}" style="max-width:140px" aria-label="Amount">
    <button type="button" class="btn btn-light text-danger" data-rm aria-label="Remove line"><i class="bi bi-x-lg"></i></button></div>`;
}
async function renderNew($c, subId) {
  $c.off('.inv');
  const sub = await idb.get('subscribers', subId);
  if (!sub) { $c.html(UI.emptyState('Customer not found.', 'person-x')); return; }
  $c.html(`
    ${UI.pageHeader(`New invoice · ${sub.name}`, '', `#/subscribers/${encodeURIComponent(subId)}`)}
    <form class="card-soft p-3 p-md-4" id="new-inv" novalidate>
      <div class="small text-body-secondary mb-3">Use this for installation, shifting, repairs, late fees or any other charge. Monthly plan bills are created by the monthly run.</div>
      <div id="lines">${lineRow(0, 'Installation charges', '')}</div>
      <button type="button" class="btn btn-sm btn-outline-primary mb-3" id="add-line"><i class="bi bi-plus-lg me-1"></i>Add line</button>
      <div class="row g-2">
        <div class="col-sm-6"><label class="form-label">Issue date</label><input type="date" class="form-control" name="issueDate" value="${today()}"></div>
        <div class="col-sm-6"><label class="form-label">Due date</label><input type="date" class="form-control" name="dueDate" value="${addDays(today(), num(getSettings().billing.dueDays, 10))}"></div>
        <div class="col-12"><label class="form-label">Note (optional)</label><input class="form-control" name="note" maxlength="300"></div>
      </div>
      <div class="d-flex justify-content-between align-items-center mt-3 flex-wrap gap-2">
        <div class="fs-5 fw-bold">Total: <span id="new-total">${esc(cur())} 0.00</span></div>
        <button class="btn btn-primary" type="submit"><i class="bi bi-check2 me-1"></i>Create invoice</button>
      </div>
      <div class="alert alert-danger small mt-3 d-none" id="new-err"></div>
    </form>`);
  const recalc = () => {
    const t = [...$c.find('.line-row input[name=amt]')].reduce((s, el) => s + num(el.value), 0);
    $c.find('#new-total').text(`${cur()} ${fmtNum(t)}`);
  };
  $c.on('input.inv', '.line-row input', recalc);
  $c.on('click.inv', '#add-line', () => { $c.find('#lines').append(lineRow(0)); });
  $c.on('click.inv', '[data-rm]', function () { if ($c.find('.line-row').length > 1) $(this).closest('.line-row').remove(); recalc(); });
  $c.on('submit.inv', '#new-inv', async (e) => {
    e.preventDefault();
    const items = $c.find('.line-row').toArray().map((r) => ({ description: $(r).find('[name=desc]').val(), amount: $(r).find('[name=amt]').val() }));
    const f = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      const inv = await createInvoice({ subscriberId: subId, items: items.filter((x) => x.description || x.amount), issueDate: f.issueDate || today(), dueDate: f.dueDate || null, note: f.note || '' });
      UI.toast(`Invoice ${inv.number} created`);
      location.hash = `#/invoices/${encodeURIComponent(inv.id)}`;
    } catch (err) { $c.find('#new-err').text(err.message).removeClass('d-none'); }
  });
  recalc();
}

// ---------- Detail ----------
function printInvoice(inv, sub, plan, payments) {
  const s = getSettings();
  const rows = inv.items.map((i) => `<tr><td>${esc(i.description)}</td><td class="r">${fmtNum(i.amount)}</td></tr>`).join('');
  const pay = payments.map((p) => `<tr><td>${fmtDate(p.date)}</td><td>${esc(PAYMENT_METHODS[p.method] || p.method)}</td><td class="r">${fmtNum(p.amount)}</td></tr>`).join('');
  $('#print-area').html(`<div class="invoice-print">
    <div class="ip-head"><div><div class="ip-biz">${esc(s.business.name)}</div>
      <div class="ip-small">${esc(s.business.address || '')}${s.business.phone ? ` · ${esc(s.business.phone)}` : ''}</div>
      ${s.business.ptaLicence ? `<div class="ip-small">PTA licence: ${esc(s.business.ptaLicence)}</div>` : ''}</div>
      <div class="ip-title">INVOICE<div class="ip-small">${esc(inv.number)}</div></div></div>
    <div class="ip-grid">
      <div><b>Bill to</b><br>${esc(sub.name)}<br>Code: ${esc(sub.number)}<br>${sub.phone ? esc(sub.phone) + '<br>' : ''}${esc(sub.area || '')}${sub.area ? '<br>' : ''}${esc(sub.address || '')}</div>
      <div><b>Issued</b> ${fmtDate(inv.issueDate)}<br><b>Due</b> ${fmtDate(inv.dueDate)}<br><b>Plan</b> ${esc(plan?.name || '—')}<br><b>Status</b> ${esc(inv.status === 'void' ? 'Void' : statusFor(inv))}</div>
    </div>
    <table class="ip-table"><thead><tr><th>Description</th><th class="r">Amount (${esc(cur())})</th></tr></thead><tbody>${rows}</tbody>
      <tfoot><tr><td class="r">Subtotal</td><td class="r">${fmtNum(inv.subtotal)}</td></tr>
      ${inv.tax ? `<tr><td class="r">Sales tax</td><td class="r">${fmtNum(inv.tax)}</td></tr>` : ''}
      <tr><td class="r"><b>Total</b></td><td class="r"><b>${fmtNum(inv.total)}</b></td></tr>
      <tr><td class="r">Paid</td><td class="r">${fmtNum(inv.paid)}</td></tr>
      <tr><td class="r"><b>Balance due</b></td><td class="r"><b>${fmtNum(Math.max(0, inv.total - inv.paid))}</b></td></tr></tfoot></table>
    ${pay ? `<table class="ip-table"><thead><tr><th>Payments</th><th>Method</th><th class="r">Amount</th></tr></thead><tbody>${pay}</tbody></table>` : ''}
    <div class="ip-small mt-2"><b>How to pay:</b> ${esc(WA.paymentText())}</div>
    <div class="ip-small">${esc(s.business.footer || '')}</div>
  </div>`);
  window.print();
}

async function renderDetail($c, id, ctx) {
  $c.off('.inv');
  const { inv, payments, plans } = await idb.read(['invoices', 'payments', 'plans'], async (t) => ({
    inv: await t.get('invoices', id), payments: await t.getAll('payments'), plans: await t.getAll('plans'),
  }));
  if (!inv) { $c.html(UI.emptyState('Invoice not found.', 'receipt', '<a class="btn btn-primary btn-sm mt-2" href="#/invoices">Back to invoices</a>')); return; }
  const sub = await idb.get('subscribers', inv.subscriberId);
  const plan = plans.find((p) => p.id === sub?.planId);
  const applied = payments.filter((p) => !p.voided && (p.allocations || []).some((a) => a.invoiceId === inv.id));
  const appliedWithAmt = applied.map((p) => ({ ...p, applied: p.allocations.filter((a) => a.invoiceId === inv.id).reduce((s, a) => s + a.amount, 0) }));
  const st = inv.status === 'void' ? 'void' : isOverdue(inv) ? 'overdue' : statusFor(inv);
  const due = Math.max(0, inv.total - inv.paid);
  ctx.setTitle?.(inv.number);
  $c.html(`
    ${UI.pageHeader(inv.number, '', '#/invoices')}
    <div class="profile-card reveal">
      <div class="d-flex justify-content-between align-items-start gap-2 flex-wrap">
        <div><div class="small text-body-secondary">Customer</div>
          <a class="fw-bold fs-5" href="#/subscribers/${encodeURIComponent(inv.subscriberId)}">${esc(sub?.name || 'Unknown')}</a>
          <div class="small text-body-secondary">${esc(sub?.number || '')} · ${esc(plan?.name || '')}</div></div>
        <div class="text-end">${badge(st)}<div class="fs-4 fw-bold mt-1">${esc(cur())} ${fmtNum(inv.total)}</div>
          <div class="small ${due > 0 ? 'text-danger' : 'text-success'}">${due > 0 ? `Balance due ${esc(cur())} ${fmtNum(due)}` : 'Fully paid'}</div></div>
      </div>
      <div class="row g-2 mt-2 small">
        <div class="col-6 col-md-3"><span class="text-body-secondary">Issued</span><div class="fw-medium">${fmtDate(inv.issueDate)}</div></div>
        <div class="col-6 col-md-3"><span class="text-body-secondary">Due</span><div class="fw-medium">${fmtDate(inv.dueDate)}</div></div>
        <div class="col-6 col-md-3"><span class="text-body-secondary">Billing month</span><div class="fw-medium">${inv.period ? monthLabel(inv.period) : 'One-off'}</div></div>
        <div class="col-6 col-md-3"><span class="text-body-secondary">Created by</span><div class="fw-medium">${esc(inv.createdBy || '—')}</div></div>
      </div>
      <div class="d-flex flex-wrap gap-2 mt-3 action-bar">
        ${inv.status !== 'void' && due > 0 && Auth.can('payment.record') ? `<a class="btn btn-success btn-sm" href="#/collect/${encodeURIComponent(inv.subscriberId)}"><i class="bi bi-cash-coin me-1"></i>Collect</a>` : ''}
        <button class="btn btn-outline-primary btn-sm" data-print><i class="bi bi-printer me-1"></i>Print</button>
        ${Auth.can('whatsapp.send') && sub && WA.normalizePhone(sub.phone) ? '<button class="btn btn-outline-success btn-sm" data-wa><i class="bi bi-whatsapp me-1"></i>Send on WhatsApp</button>' : ''}
        ${Auth.can('invoice.void') && inv.status !== 'void' ? '<button class="btn btn-outline-danger btn-sm" data-void><i class="bi bi-slash-circle me-1"></i>Void</button>' : ''}
      </div>
    </div>

    <div class="card-soft p-3 mt-3">
      <div class="table-responsive"><table class="table table-sm align-middle mb-0 table-report">
        <thead><tr><th>Description</th><th class="num">Amount</th></tr></thead>
        <tbody>${inv.items.map((i) => `<tr><td>${esc(i.description)}${i.kind === 'plan' ? ' <span class="badge-soft tone-primary">plan</span>' : ''}</td><td class="num">${fmtNum(i.amount)}</td></tr>`).join('')}</tbody>
        <tfoot>
          <tr><td class="text-end">Subtotal</td><td class="num">${fmtNum(inv.subtotal)}</td></tr>
          ${inv.tax ? `<tr><td class="text-end">Sales tax</td><td class="num">${fmtNum(inv.tax)}</td></tr>` : ''}
          <tr class="fw-semibold"><td class="text-end">Total</td><td class="num">${fmtNum(inv.total)}</td></tr>
          <tr><td class="text-end">Paid</td><td class="num text-success">${fmtNum(inv.paid)}</td></tr>
        </tfoot></table></div>
      ${inv.note ? `<div class="small text-body-secondary mt-2">Note: ${esc(inv.note)}</div>` : ''}
      ${inv.voidReason ? `<div class="alert alert-secondary small mt-2 mb-0">Void reason: ${esc(inv.voidReason)}</div>` : ''}
    </div>

    <div class="section-title mt-3"><h2>Payments applied</h2></div>
    <div class="list-card">${appliedWithAmt.length ? appliedWithAmt.map((p) => `<a class="list-row" href="#/collect/receipt/${encodeURIComponent(p.id)}">
      <div class="main"><div class="title">${esc(p.number)} · ${esc(PAYMENT_METHODS[p.method] || p.method)}</div><div class="sub">${fmtDate(p.date)}</div></div>
      <div class="end fw-semibold text-success">${esc(cur())} ${fmtNum(p.applied)}</div></a>`).join('') : UI.emptyState('No payments applied yet', 'wallet2')}</div>`);

  $c.on('click.inv', '[data-print]', () => printInvoice(inv, sub || { name: '', number: '' }, plan, appliedWithAmt));
  $c.on('click.inv', '[data-wa]', () => {
    const phone = WA.normalizePhone(sub.phone);
    const text = WA.fillTemplate(due > 0 ? 'reminder' : 'paid', WA.customerVars(sub, plan, { balance: due, oldestDue: inv.dueDate }, { amount: WA.money(inv.total), receipt: inv.number, month: WA.monthVar(inv.period || inv.issueDate.slice(0, 7)) }));
    window.open(WA.waLink(phone, text), '_blank', 'noopener');
    WA.logMessage({ subscriberId: sub.id, phone, text, template: due > 0 ? 'reminder' : 'paid' }).catch(() => {});
    UI.toast('WhatsApp opened. Press Send there.', 'info');
  });
  $c.on('click.inv', '[data-void]', async () => {
    const reason = await voidReasonPrompt(inv);
    if (reason === null) return;
    try { await voidInvoice(id, reason); UI.toast('Invoice voided'); renderDetail($c, id, ctx); } catch (e) { UI.toastError(e); }
  });
}

function voidReasonPrompt(inv) {
  return UI.formModal({
    title: `Void ${inv.number}`, submitLabel: 'Void invoice', submitClass: 'btn-danger',
    body: `<p class="small">The invoice stays in the records as void, so numbering and reports remain correct. An invoice with payments cannot be voided until those payments are voided.</p>
      <label class="form-label">Reason *</label><input name="reason" class="form-control" required maxlength="200" placeholder="e.g. Duplicate bill">`,
    onSubmit: (v) => { if (!v.reason?.trim()) throw new AppError('Enter a reason.'); return v.reason.trim(); },
  }).then((r) => r ?? null);
}

export default {
  async render(el, ctx) {
    const $c = $(el);
    const [a, b] = ctx.params || [];
    if (a === 'run') return renderRun($c);
    if (a === 'new' && b) return renderNew($c, decodeURIComponent(b));
    if (a) return renderDetail($c, decodeURIComponent(a), ctx);
    return renderList($c, ctx);
  },
  destroy() {},
};
