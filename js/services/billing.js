// Billing engine: monthly invoice runs, ad-hoc invoices, payments with allocation, voids and balances.
// Every operation runs in ONE IndexedDB transaction, so a failure never leaves half-written money data.
// Balances are never stored as a single number: they are always derived from invoices and payments.
import * as idb from '../db/idb.js';
import { PAYMENT_METHODS } from '../db/schema.js';
import { round2, nowISO, uuid, AppError, today, num } from '../core/utils.js';
import { getSettings } from '../core/settings.js';
import { addDays, monthOf } from '../core/views.js';
import * as Auth from './auth.js';

const EPS = 0.005;
const pad2 = (n) => String(n).padStart(2, '0');

// Gap-free sequential numbers (INV-000001, RCP-000001) from a counter inside the same transaction.
export async function nextNumber(t, key, prefix) {
  const row = (await t.get('meta', `counter.${key}`)) || { key: `counter.${key}`, value: 0 };
  row.value += 1;
  await t.put('meta', row);
  return `${prefix}-${String(row.value).padStart(6, '0')}`;
}

async function audit(t, action, entity, detail) {
  await t.add('auditLog', { id: uuid(), at: nowISO(), action, entity, detail, by: Auth.user()?.name || '' });
}

// Invoice status from the amount paid so far.
export function statusFor(inv) {
  if (inv.status === 'void') return 'void';
  if (inv.paid >= inv.total - EPS) return 'paid';
  return inv.paid > EPS ? 'partial' : 'unpaid';
}
export const isOpen = (inv) => inv.status !== 'void' && inv.total - inv.paid > EPS;
export const isOverdue = (inv) => isOpen(inv) && inv.dueDate < today();

const byIssue = (a, b) => (a.issueDate + a.number).localeCompare(b.issueDate + b.number);
const byDate = (a, b) => (a.date + a.number).localeCompare(b.date + b.number);
const allocatedOf = (p) => round2((p.allocations || []).reduce((s, a) => s + a.amount, 0));

// Assign unpaid money (payments not yet matched, i.e. advance credit) to the oldest open invoices.
async function allocateOpen(t, subscriberId) {
  const invoices = (await t.getAllByIndex('invoices', 'subscriberId', subscriberId)).filter(isOpen).sort(byIssue);
  if (!invoices.length) return;
  const payments = (await t.getAllByIndex('payments', 'subscriberId', subscriberId)).filter((p) => !p.voided).sort(byDate);
  const changed = new Set();
  for (const p of payments) {
    let left = round2(p.amount - allocatedOf(p));
    if (left <= EPS) continue;
    for (const inv of invoices) {
      const due = round2(inv.total - inv.paid);
      if (due <= EPS) continue;
      const take = Math.min(left, due);
      inv.paid = round2(inv.paid + take);
      inv.status = statusFor(inv);
      p.allocations = [...(p.allocations || []), { invoiceId: inv.id, amount: take }];
      changed.add(inv.id);
      left = round2(left - take);
      if (left <= EPS) break;
    }
    await t.put('payments', p);
  }
  for (const inv of invoices) if (changed.has(inv.id)) await t.put('invoices', inv);
}

// Adds an invoice inside a running transaction. Plan invoices pass periodKey so the unique index blocks duplicates.
async function insertInvoice(t, { subscriberId, items, issueDate, dueDate, period = null, periodKey = null, note = '' }) {
  const s = getSettings();
  const lines = items.map((i) => ({
    kind: i.kind === 'plan' ? 'plan' : 'charge',
    description: String(i.description || '').trim().slice(0, 160),
    amount: round2(num(i.amount)),
  })).filter((l) => l.description && l.amount);
  const subtotal = round2(lines.reduce((a, l) => a + l.amount, 0));
  if (!lines.length || subtotal <= 0) throw new AppError('Invoice total must be more than zero.');
  const tax = round2(subtotal * (num(s.taxRate) || 0) / 100);
  const number = await nextNumber(t, 'invoice', 'INV');
  const inv = {
    id: uuid(), number, subscriberId, period, issueDate, dueDate, items: lines,
    subtotal, tax, total: round2(subtotal + tax), paid: 0, status: 'unpaid', note: String(note || '').slice(0, 300),
    createdAt: nowISO(), createdBy: Auth.user()?.name || '',
  };
  if (periodKey) inv.periodKey = periodKey;
  await t.add('invoices', inv);
  if (s.billing.autoApplyCredit) await allocateOpen(t, subscriberId);
  return inv;
}

// Creates one invoice with any number of lines (ad-hoc charges: installation, shifting, repairs, late fee...).
export async function createInvoice({ subscriberId, items, dueDate = null, issueDate = today(), note = '' }) {
  Auth.require('billing.manage');
  return idb.write(['invoices', 'subscribers', 'payments', 'meta', 'auditLog'], async (t) => {
    const sub = await t.get('subscribers', subscriberId);
    if (!sub) throw new AppError('Customer not found.');
    const due = dueDate || addDays(issueDate, num(getSettings().billing.dueDays, 10));
    const inv = await insertInvoice(t, { subscriberId, items, issueDate, dueDate: due, note });
    await audit(t, 'invoice.create', inv.number, `${sub.name} ${inv.total}`);
    return inv;
  });
}

// Monthly run for a period "YYYY-MM": bills every active or suspended subscriber once, at their plan price.
// Re-running the same month skips customers who already have that month's invoice.
export async function generateMonthlyRun(period) {
  Auth.require('billing.manage');
  if (!/^\d{4}-\d{2}$/.test(period || '')) throw new AppError('Choose a valid billing month.');
  const b = getSettings().billing;
  const day = Math.min(28, Math.max(1, num(b.billingDay, 1)));
  const issueDate = `${period}-${pad2(day)}`;
  const dueDate = addDays(issueDate, num(b.dueDays, 10));
  return idb.write(['subscribers', 'plans', 'invoices', 'payments', 'meta', 'auditLog'], async (t) => {
    const plans = new Map((await t.getAll('plans')).map((p) => [p.id, p]));
    const subs = (await t.getAll('subscribers')).sort((a, c) => a.number.localeCompare(c.number));
    const res = { created: 0, skipped: 0, noPlan: 0, total: 0 };
    for (const sub of subs) {
      if (sub.status !== 'active' && sub.status !== 'suspended') continue;
      const plan = plans.get(sub.planId);
      // No plan, or a plan still at price 0 (e.g. created by an import): skip rather than fail the whole run.
      const amount = sub.customPrice ?? plan?.price;
      if (!plan || !(amount > 0)) { res.noPlan++; continue; }
      const periodKey = `${sub.id}|${period}`;
      if (await t.getByIndex('invoices', 'periodKey', periodKey)) { res.skipped++; continue; }
      const inv = await insertInvoice(t, {
        subscriberId: sub.id, period, periodKey, issueDate, dueDate,
        items: [{ kind: 'plan', description: `${plan.name} · ${period}`, amount }],
      });
      res.created++; res.total = round2(res.total + inv.total);
    }
    await audit(t, 'billing.run', period, `${res.created} invoices, ${res.total}`);
    return res;
  });
}

// Records a payment and matches it to the oldest open invoices. Extra money stays as advance credit.
export async function recordPayment({ subscriberId, amount, method = 'cash', reference = '', date = today(), note = '' }) {
  Auth.require('payment.record');
  const amt = round2(num(amount));
  if (!(amt > 0)) throw new AppError('Enter an amount greater than zero.');
  if (!PAYMENT_METHODS[method]) throw new AppError('Choose a valid payment method.');
  return idb.write(['payments', 'invoices', 'subscribers', 'meta', 'auditLog'], async (t) => {
    const sub = await t.get('subscribers', subscriberId);
    if (!sub) throw new AppError('Customer not found.');
    const number = await nextNumber(t, 'receipt', 'RCP');
    const p = {
      id: uuid(), number, subscriberId, date, amount: amt, method,
      reference: String(reference || '').trim().slice(0, 80), note: String(note || '').slice(0, 300),
      allocations: [], collectedBy: Auth.user()?.name || '', createdAt: nowISO(),
    };
    await t.add('payments', p);
    await allocateOpen(t, subscriberId);
    await audit(t, 'payment.record', number, `${sub.name} ${amt} ${method}`);
    return t.get('payments', p.id);
  });
}

// Reverses a payment: its amount is taken back off every invoice it paid. The record stays for the audit trail.
export async function voidPayment(id, reason = '') {
  Auth.require('payment.void');
  return idb.write(['payments', 'invoices', 'meta', 'auditLog'], async (t) => {
    const p = await t.get('payments', id);
    if (!p) throw new AppError('Payment not found.');
    if (p.voided) throw new AppError('This payment is already void.');
    for (const a of p.allocations || []) {
      const inv = await t.get('invoices', a.invoiceId);
      if (!inv) continue;
      inv.paid = round2(Math.max(0, inv.paid - a.amount));
      inv.status = statusFor(inv);
      await t.put('invoices', inv);
    }
    p.voided = true; p.voidedAt = nowISO(); p.voidReason = String(reason).slice(0, 200);
    await t.put('payments', p);
    await audit(t, 'payment.void', p.number, reason);
    return p;
  });
}

// Voids an invoice. Invoices with payments must have those payments voided first, so nothing is orphaned.
// The record is kept (numbers stay gap-free), and the month's billing key is released so it can be re-billed.
export async function voidInvoice(id, reason = '') {
  Auth.require('invoice.void');
  return idb.write(['invoices', 'meta', 'auditLog'], async (t) => {
    const inv = await t.get('invoices', id);
    if (!inv) throw new AppError('Invoice not found.');
    if (inv.status === 'void') throw new AppError('This invoice is already void.');
    if (inv.paid > EPS) throw new AppError('This invoice has payments. Void those payments first.');
    inv.status = 'void'; inv.voidedAt = nowISO(); inv.voidReason = String(reason).slice(0, 200);
    delete inv.periodKey;
    await t.put('invoices', inv);
    await audit(t, 'invoice.void', inv.number, reason);
    return inv;
  });
}

// Balances per subscriber, computed from records:
//   billed      = sum of live invoices
//   paid        = amount applied to those invoices
//   credit      = money received but not yet matched to an invoice (advance)
//   outstanding = billed - paid (what is still owed on invoices)
//   balance     = outstanding - credit (negative means the customer has advance credit)
export function computeBalances(invoices, payments) {
  const m = new Map();
  const get = (id) => {
    if (!m.has(id)) m.set(id, { billed: 0, paid: 0, received: 0, outstanding: 0, overdue: 0, credit: 0, balance: 0, oldestDue: null });
    return m.get(id);
  };
  for (const i of invoices) {
    if (i.status === 'void') continue;
    const b = get(i.subscriberId);
    b.billed += i.total; b.paid += i.paid;
    const due = round2(i.total - i.paid);
    if (due > EPS) {
      b.outstanding += due;
      if (i.dueDate < today()) b.overdue += due;
      if (!b.oldestDue || i.dueDate < b.oldestDue) b.oldestDue = i.dueDate;
    }
  }
  for (const p of payments) { if (!p.voided) get(p.subscriberId).received += p.amount; }
  for (const b of m.values()) {
    b.billed = round2(b.billed); b.paid = round2(b.paid); b.received = round2(b.received);
    b.outstanding = round2(b.outstanding); b.overdue = round2(b.overdue);
    b.credit = round2(Math.max(0, b.received - b.paid));
    b.balance = round2(b.outstanding - b.credit);
  }
  return m;
}

const EMPTY = { billed: 0, paid: 0, received: 0, outstanding: 0, overdue: 0, credit: 0, balance: 0, oldestDue: null };
export const balanceOf = (map, id) => map.get(id) || EMPTY;

export async function loadBalances() {
  return idb.read(['invoices', 'payments'], async (t) => computeBalances(await t.getAll('invoices'), await t.getAll('payments')));
}

// Invoices for one month (by issue date), for the billing and reports screens.
export const invoicesInMonth = (invoices, ym) => invoices.filter((i) => monthOf(i.issueDate) === ym);
export const paymentsInMonth = (payments, ym) => payments.filter((p) => !p.voided && monthOf(p.date) === ym);
