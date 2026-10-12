// Collections: take a payment (cash, JazzCash, Easypaisa, Raast, bank), show today's totals by method,
// print or WhatsApp a receipt, and void a mistaken payment.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtDate, today, AppError, lc } from '../core/utils.js';
import { cur, pager } from '../core/views.js';
import { getSettings } from '../core/settings.js';
import { PAYMENT_METHODS } from '../db/schema.js';
import * as Auth from '../services/auth.js';
import * as WA from '../services/whatsapp.js';
import { recordPayment, voidPayment, loadBalances, balanceOf } from '../services/billing.js';

const $ = window.jQuery;

const methodOpts = (sel) => Object.entries(PAYMENT_METHODS).map(([k, l]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');

// Customer search for the picker. Matches name, mobile, CNIC or customer code.
async function searchCustomers(q) {
  const subs = await idb.getAll('subscribers');
  const bal = await loadBalances();
  const needle = lc(q); const digits = q.replace(/\D/g, '');
  return subs.filter((s) => s.status !== 'disconnected' && (!needle || lc(s.name).includes(needle) || lc(s.number).includes(needle)
    || (digits && (String(s.phone || '').includes(digits) || String(s.cnic || '').replace(/\D/g, '').includes(digits)))))
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 40)
    .map((s) => {
      const b = balanceOf(bal, s.id);
      return { id: s.id, value: s, title: s.name, subtitle: `${s.number}${s.area ? ` · ${s.area}` : ''}`,
        right: b.balance > 0.004 ? `Due ${fmtNum(b.balance)}` : b.balance < -0.004 ? `Credit ${fmtNum(-b.balance)}` : 'Clear' };
    });
}

async function todaySummary() {
  const payments = await idb.getAll('payments');
  const subs = await idb.getAll('subscribers');
  const subById = new Map(subs.map((s) => [s.id, s]));
  const mine = payments.filter((p) => !p.voided && p.date === today()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const byMethod = {};
  for (const p of mine) byMethod[p.method] = (byMethod[p.method] || 0) + p.amount;
  return { mine, byMethod, subById, total: mine.reduce((s, p) => s + p.amount, 0) };
}

function receiptHtml(p, sub) {
  const s = getSettings();
  return `<div class="invoice-print">
    <div class="ip-head"><div><div class="ip-biz">${esc(s.business.name)}</div>
      <div class="ip-small">${esc(s.business.address || '')}${s.business.phone ? ` · ${esc(s.business.phone)}` : ''}</div></div>
      <div class="ip-title">RECEIPT<div class="ip-small">${esc(p.number)}</div></div></div>
    <div class="ip-grid"><div><b>Received from</b><br>${esc(sub?.name || '')}<br>Code: ${esc(sub?.number || '')}</div>
      <div><b>Date</b> ${fmtDate(p.date)}<br><b>Method</b> ${esc(PAYMENT_METHODS[p.method] || p.method)}<br>${p.reference ? `<b>Reference</b> ${esc(p.reference)}<br>` : ''}<b>Collected by</b> ${esc(p.collectedBy || '')}</div></div>
    <table class="ip-table"><tbody><tr><td>Amount received</td><td class="r"><b>${esc(cur())} ${fmtNum(p.amount)}</b></td></tr>
      ${(p.allocations || []).map((a) => `<tr><td class="ip-small">Applied to invoice</td><td class="r ip-small">${fmtNum(a.amount)}</td></tr>`).join('')}</tbody></table>
    <div class="ip-small">${esc(s.business.footer || '')}</div></div>`;
}

function printReceipt(p, sub) {
  $('#print-area').html(receiptHtml(p, sub));
  window.print();
}

// Collect form for one customer. Shows balance, oldest due date and suggests the amount due.
async function renderCollect($c, preselect = null) {
  $c.off('.col');
  const bal = await loadBalances();
  const summary = await todaySummary();
  const canVoid = Auth.can('payment.void');
  $c.html(`
    ${UI.pageHeader('Collect payment')}
    <div class="row g-3">
      <div class="col-lg-6">
        <form class="card-soft p-3 p-md-4 reveal" id="collect-form" novalidate>
          <label class="form-label">Customer</label>
          <button type="button" class="pick-trigger w-100 text-start" id="pick-cust">
            <i class="bi bi-search me-2"></i><span id="cust-label">Tap to find a customer</span></button>
          <div id="cust-card" class="mt-3 d-none">
            <div class="bal-strip">
              <div><div class="small text-body-secondary">Balance</div><div class="fw-bold" id="cust-bal">—</div></div>
              <div><div class="small text-body-secondary">Oldest due</div><div class="fw-medium" id="cust-due">—</div></div>
            </div>
          </div>
          <div class="row g-2 mt-1">
            <div class="col-sm-6"><label class="form-label">Amount (${esc(cur())}) *</label><input name="amount" type="number" min="1" step="0.01" class="form-control form-control-lg" inputmode="decimal" required></div>
            <div class="col-sm-6"><label class="form-label">Method</label><select name="method" class="form-select">${methodOpts('cash')}</select></div>
            <div class="col-sm-6"><label class="form-label">Transaction ID / reference</label><input name="reference" class="form-control" maxlength="80" placeholder="e.g. JazzCash TID"></div>
            <div class="col-sm-6"><label class="form-label">Date received</label><input name="date" type="date" class="form-control" value="${today()}"></div>
            <div class="col-12"><label class="form-label">Note (optional)</label><input name="note" class="form-control" maxlength="300"></div>
          </div>
          <div class="quick-amounts mt-3" id="quick"></div>
          <button class="btn btn-success btn-lg w-100 mt-3" type="submit" id="collect-btn" disabled><i class="bi bi-check2-circle me-1"></i>Record payment</button>
          <div class="alert alert-danger small mt-3 d-none" id="collect-err"></div>
        </form>
      </div>
      <div class="col-lg-6">
        <div class="viz-card reveal">
          <div class="viz-head"><div><div class="ttl">Today's collections</div><div class="sub">${summary.mine.length} payment${summary.mine.length === 1 ? '' : 's'} · ${fmtDate(today())}</div></div>
            <div class="fw-bold fs-5" data-count="${summary.total}" data-money="1">0</div></div>
          <div class="method-grid">${Object.entries(PAYMENT_METHODS).map(([k, l]) => `<div class="method-tile ${summary.byMethod[k] ? 'on' : ''}">
            <div class="small text-body-secondary">${esc(l)}</div><div class="fw-semibold">${fmtNum(summary.byMethod[k] || 0)}</div></div>`).join('')}</div>
        </div>
        <div class="section-title mt-3"><h2>Recent payments today</h2><a href="#/invoices">Invoices</a></div>
        <div class="list-card" id="today-list"></div>
      </div>
    </div>`);
  UI.countUp($c[0], (n) => `${cur()} ${fmtNum(n)}`);

  let sub = null; let due = 0; let credit = 0;
  const setCustomer = (s) => {
    sub = s;
    const b = balanceOf(bal, s.id);
    due = Math.max(0, b.balance); credit = Math.max(0, -b.balance);
    $c.find('#cust-label').text(`${s.name} · ${s.number}`);
    $c.find('#pick-cust').addClass('picked');
    $c.find('#cust-card').removeClass('d-none');
    $c.find('#cust-bal').text(b.balance > 0.004 ? `Due ${cur()} ${fmtNum(b.balance)}` : b.balance < -0.004 ? `Credit ${cur()} ${fmtNum(-b.balance)}` : 'Clear').toggleClass('text-danger', b.balance > 0.004).toggleClass('text-success', b.balance < -0.004);
    $c.find('#cust-due').text(b.oldestDue ? fmtDate(b.oldestDue) : '—');
    const quick = [];
    if (due > 0) quick.push(['Full balance', due]);
    if (b.overdue > 0 && b.overdue < due) quick.push(['Overdue only', b.overdue]);
    $c.find('#quick').html(quick.map(([l, v]) => `<button type="button" class="chip" data-amt="${v}">${esc(l)} · ${fmtNum(v)}</button>`).join(''));
    $c.find('[name=amount]').val(due > 0 ? due.toFixed(2) : '');
    $c.find('#collect-btn').prop('disabled', false);
  };
  if (preselect) {
    const s = await idb.get('subscribers', preselect);
    if (s) setCustomer(s);
  }
  $c.on('click.col', '#pick-cust', async () => {
    const picked = await UI.pick({ title: 'Find customer', search: searchCustomers, placeholder: 'Name, mobile, CNIC or code' });
    if (picked?.value) setCustomer(picked.value);
  });
  $c.on('click.col', '[data-amt]', function () { $c.find('[name=amount]').val(Number(this.dataset.amt).toFixed(2)); });

  $c.on('submit.col', '#collect-form', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget).entries());
    if (!sub) { $c.find('#collect-err').text('Choose a customer first.').removeClass('d-none'); return; }
    const btn = $c.find('#collect-btn').prop('disabled', true);
    try {
      const p = await recordPayment({ subscriberId: sub.id, amount: f.amount, method: f.method, reference: f.reference, date: f.date || today(), note: f.note });
      UI.toast(`Received ${cur()} ${fmtNum(p.amount)} · ${p.number}`);
      showReceiptSheet(p, sub);
      renderCollect($c, null);
    } catch (err) {
      $c.find('#collect-err').text(err.message).removeClass('d-none');
      btn.prop('disabled', false);
    }
  });

  // Today's list
  pager($c.find('#today-list'), summary.mine, (p) => {
    const s = summary.subById.get(p.subscriberId);
    return `<div class="list-row">
      ${UI.avatar(s?.name || '?')}
      <div class="main min-w-0"><div class="title text-truncate">${esc(s?.name || 'Unknown')}</div>
        <div class="sub">${esc(p.number)} · ${esc(PAYMENT_METHODS[p.method] || p.method)}${p.reference ? ` · ${esc(p.reference)}` : ''}</div></div>
      <div class="end d-flex align-items-center gap-2"><span class="fw-semibold text-success">+${fmtNum(p.amount)}</span>
        <button class="btn btn-sm btn-light" data-receipt="${esc(p.id)}" aria-label="Receipt"><i class="bi bi-printer"></i></button>
        ${canVoid ? `<button class="btn btn-sm btn-light text-danger" data-void="${esc(p.id)}" aria-label="Void payment"><i class="bi bi-slash-circle"></i></button>` : ''}</div></div>`;
  }, 40, UI.emptyState('No payments collected today yet', 'cash-coin'));
  $c.on('click.col', '[data-receipt]', async function () {
    const p = await idb.get('payments', this.dataset.receipt);
    const s = p && await idb.get('subscribers', p.subscriberId);
    if (p) printReceipt(p, s);
  });
  $c.on('click.col', '[data-void]', async function () {
    const id = this.dataset.void;
    const reason = await UI.formModal({
      title: 'Void payment', submitLabel: 'Void payment', submitClass: 'btn-danger',
      body: `<p class="small">The amount is taken back off the invoices it paid. The record stays for audit.</p>
        <label class="form-label">Reason *</label><input name="reason" class="form-control" required maxlength="200" placeholder="e.g. Wrong customer">`,
      onSubmit: (v) => { if (!v.reason?.trim()) throw new AppError('Enter a reason.'); return v.reason.trim(); },
    });
    if (!reason) return;
    try { await voidPayment(id, reason); UI.toast('Payment voided', 'warning'); renderCollect($c, preselect); } catch (e) { UI.toastError(e); }
  });
}

// After a payment: offer a WhatsApp receipt and printing, both optional.
function showReceiptSheet(p, sub) {
  const phone = WA.normalizePhone(sub.phone);
  const m = UI.modal({
    title: 'Payment recorded', size: 'sm', fullscreenMobile: false,
    body: `<div class="text-center py-2"><div class="success-check"><i class="bi bi-check2"></i></div>
      <div class="fw-semibold mt-2">${esc(cur())} ${fmtNum(p.amount)} from ${esc(sub.name)}</div>
      <div class="small text-body-secondary">${esc(p.number)} · ${esc(PAYMENT_METHODS[p.method] || p.method)}</div></div>`,
    footer: `<button class="btn btn-light" data-print>Print receipt</button>${phone && Auth.can('whatsapp.send') ? '<button class="btn btn-success" data-wa><i class="bi bi-whatsapp me-1"></i>Send receipt</button>' : ''}<button class="btn btn-primary" data-bs-dismiss="modal">Done</button>`,
  });
  m.$el.on('click', '[data-print]', () => printReceipt(p, sub));
  m.$el.on('click', '[data-wa]', async () => {
    // The receipt message states the balance left after this payment.
    const bal = balanceOf(await loadBalances(), sub.id);
    const text = WA.fillTemplate('paid', WA.customerVars(sub, null, bal, { amount: WA.money(p.amount), receipt: p.number }));
    window.open(WA.waLink(phone, text), '_blank', 'noopener');
    await WA.logMessage({ subscriberId: sub.id, phone, text, template: 'paid' }).catch(() => {});
    UI.toast('WhatsApp opened. Press Send there.', 'info');
  });
}

export default {
  async render(el, ctx) {
    const $c = $(el);
    $c.off('.col');
    const [a, b] = ctx.params || [];
    if (a === 'receipt' && b) {
      const p = await idb.get('payments', decodeURIComponent(b));
      const s = p && await idb.get('subscribers', p.subscriberId);
      if (!p) { $c.html(UI.emptyState('Receipt not found.', 'receipt')); return; }
      $c.html(`${UI.pageHeader(`Receipt ${p.number}`, '', '#/collect')}
        <div class="card-soft p-3"><div class="small">${esc(s?.name || '')} · ${fmtDate(p.date)} · ${esc(PAYMENT_METHODS[p.method] || p.method)}</div>
        <div class="fs-4 fw-bold text-success mt-1">${esc(cur())} ${fmtNum(p.amount)}</div>
        ${p.voided ? `<div class="alert alert-secondary small mt-2 mb-0">Void: ${esc(p.voidReason || '')}</div>` : ''}
        <button class="btn btn-outline-primary btn-sm mt-3" data-print><i class="bi bi-printer me-1"></i>Print</button></div>`);
      $c.on('click.col', '[data-print]', () => printReceipt(p, s));
      return;
    }
    return renderCollect($c, a || null);
  },
  destroy() {},
};
