// Expenses: bandwidth, fibre, tower rent, generator fuel, salaries and so on, by month and category.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtDate, today, num, uuid, nowISO, AppError, clean } from '../core/utils.js';
import { cur, pager, monthLabel, currentMonth, addMonths, monthOf } from '../core/views.js';
import { pref } from '../core/settings.js';
import { EXPENSE_CATEGORIES } from '../db/schema.js';
import * as Auth from '../services/auth.js';

const $ = window.jQuery;

function expenseForm(e) {
  const v = (k, d = '') => esc(e?.[k] ?? d);
  return `<div class="row g-2">
    <div class="col-sm-6"><label class="form-label">Date *</label><input type="date" name="date" class="form-control" required value="${v('date', today())}"></div>
    <div class="col-sm-6"><label class="form-label">Amount (${esc(cur())}) *</label><input type="number" name="amount" min="0.01" step="0.01" class="form-control" required value="${v('amount')}"></div>
    <div class="col-12"><label class="form-label">Category *</label><select name="category" class="form-select">${EXPENSE_CATEGORIES.map((c) => `<option ${e?.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
    <div class="col-12"><label class="form-label">Paid to / vendor</label><input name="vendor" class="form-control" maxlength="80" placeholder="e.g. PTCL, WAPDA, fuel pump" value="${v('vendor')}"></div>
    <div class="col-12"><label class="form-label">Note</label><input name="note" class="form-control" maxlength="200" value="${v('note')}"></div>
  </div>`;
}

async function saveExpense(existing, f) {
  Auth.require('expense.manage');
  const amount = Math.round(num(f.amount) * 100) / 100;
  if (!(amount > 0)) throw new AppError('Enter an amount greater than zero.');
  if (!f.date) throw new AppError('Choose a date.');
  const rec = {
    ...(existing || {}), id: existing?.id || uuid(), date: f.date, amount, category: EXPENSE_CATEGORIES.includes(f.category) ? f.category : 'Office & misc',
    vendor: clean(f.vendor, 80), note: clean(f.note, 200), createdAt: existing?.createdAt || nowISO(), updatedAt: nowISO(),
    by: Auth.user()?.name || '',
  };
  await idb.write(['expenses'], (t) => t.put('expenses', rec));
  return rec;
}

async function renderList($c, ym = pref.get('expenseMonth', currentMonth())) {
  $c.off('.exp');
  pref.set('expenseMonth', ym);
  const all = await idb.getAll('expenses');
  const list = all.filter((e) => monthOf(e.date) === ym).sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
  const total = list.reduce((s, e) => s + e.amount, 0);
  const byCat = new Map();
  for (const e of list) byCat.set(e.category, (byCat.get(e.category) || 0) + e.amount);
  const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  const max = cats[0]?.[1] || 1;
  const canEdit = Auth.can('expense.manage');
  $c.html(`
    ${UI.pageHeader('Expenses', canEdit ? '<button class="btn btn-primary btn-sm" data-add><i class="bi bi-plus-lg me-1"></i>Add expense</button>' : '')}
    <div class="filters mb-3"><div><label class="form-label small mb-0">Month</label><input type="month" class="form-control form-control-sm" id="exp-month" value="${esc(ym)}"></div>
      <div class="d-flex align-items-end"><button class="btn btn-sm btn-outline-secondary" data-prev>&larr; Previous</button></div></div>
    <div class="profile-card mb-3 reveal">
      <div class="small text-body-secondary">${monthLabel(ym)} expenses</div>
      <div class="fs-3 fw-bold" data-count="${total}" data-money="1">0</div>
      <div class="small text-body-secondary">${list.length} entries</div>
    </div>
    <div class="card-soft p-3 mb-3">
      <div class="fw-semibold mb-2">By category</div>
      ${cats.length ? cats.map(([c, v]) => `<div class="hbar mb-2"><div class="d-flex justify-content-between small"><span>${esc(c)}</span><span class="fw-medium">${esc(cur())} ${fmtNum(v)}</span></div>
        <div class="track"><div class="fill" style="width:${(v / max * 100).toFixed(1)}%"></div></div></div>`).join('') : '<div class="small text-body-secondary">No expenses this month</div>'}
    </div>
    <div class="list-card" id="exp-list"></div>`);
  UI.countUp($c[0], (n) => `${cur()} ${fmtNum(n)}`);
  pager($c.find('#exp-list'), list, (e) => `<div class="list-row">
      <div class="icon-chip tint-amber"><i class="bi bi-wallet2"></i></div>
      <div class="main min-w-0"><div class="title text-truncate">${esc(e.category)}</div>
        <div class="sub text-truncate">${fmtDate(e.date)}${e.vendor ? ` · ${esc(e.vendor)}` : ''}${e.note ? ` · ${esc(e.note)}` : ''}</div></div>
      <div class="end d-flex align-items-center gap-2"><span class="fw-semibold text-danger">−${fmtNum(e.amount)}</span>
        ${canEdit ? `<button class="btn btn-sm btn-light" data-edit="${esc(e.id)}" aria-label="Edit"><i class="bi bi-pencil"></i></button>
        <button class="btn btn-sm btn-light text-danger" data-del="${esc(e.id)}" aria-label="Delete"><i class="bi bi-trash"></i></button>` : ''}</div></div>`,
    60, UI.emptyState(`No expenses for ${monthLabel(ym)}`, 'wallet2'));

  $c.on('change.exp', '#exp-month', (ev) => { if (ev.target.value) renderList($c, ev.target.value); });
  $c.on('click.exp', '[data-prev]', () => renderList($c, addMonths(ym, -1)));
  const reload = () => renderList($c, ym);
  $c.on('click.exp', '[data-add]', async () => {
    const r = await UI.formModal({ title: 'Add expense', body: expenseForm(null), submitLabel: 'Save expense', onSubmit: (f) => saveExpense(null, f) });
    if (r) { UI.toast('Expense saved'); reload(); }
  });
  $c.on('click.exp', '[data-edit]', async function () {
    const e = all.find((x) => x.id === this.dataset.edit);
    const r = await UI.formModal({ title: 'Edit expense', body: expenseForm(e), submitLabel: 'Save', onSubmit: (f) => saveExpense(e, f) });
    if (r) { UI.toast('Expense updated'); reload(); }
  });
  $c.on('click.exp', '[data-del]', async function () {
    if (!await UI.confirmDialog('Delete this expense? Profit & loss will update.', { okLabel: 'Delete', okClass: 'btn-danger' })) return;
    try {
      Auth.require('expense.manage');
      await idb.write(['expenses'], (t) => t.delete('expenses', this.dataset.del));
      UI.toast('Expense deleted'); reload();
    } catch (err) { UI.toastError(err); }
  });
}

export default {
  async render(el) { await renderList($(el)); },
  destroy() {},
};
