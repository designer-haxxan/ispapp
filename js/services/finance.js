// Profit & loss figures, computed from invoices, payments and expenses. Shared by the dashboard and reports.
//   Billed (revenue, accrual) = invoices issued in the month, excluding voids
//   Collected (cash in)       = payments dated in the month, excluding voids
//   Expenses                  = expenses dated in the month
//   Profit / loss             = Billed - Expenses (accrual view, what the business earned)
// Cash view (Collected - Expenses) is shown next to it, because a customer who has not paid is still a debt.
import * as idb from '../db/idb.js';
import { round2 } from '../core/utils.js';
import { monthOf, addMonths } from '../core/views.js';

export async function loadFinance() {
  return idb.read(['invoices', 'payments', 'expenses', 'subscribers', 'plans'], async (t) => ({
    invoices: await t.getAll('invoices'),
    payments: await t.getAll('payments'),
    expenses: await t.getAll('expenses'),
    subscribers: await t.getAll('subscribers'),
    plans: await t.getAll('plans'),
  }));
}

export function monthSummary({ invoices, payments, expenses }, ym) {
  const inv = invoices.filter((i) => i.status !== 'void' && monthOf(i.issueDate) === ym);
  const pay = payments.filter((p) => !p.voided && monthOf(p.date) === ym);
  const exp = expenses.filter((e) => monthOf(e.date) === ym);
  const billed = round2(inv.reduce((s, i) => s + i.total, 0));
  const plan = round2(inv.reduce((s, i) => s + i.items.filter((x) => x.kind === 'plan').reduce((a, x) => a + x.amount, 0), 0));
  const collected = round2(pay.reduce((s, p) => s + p.amount, 0));
  const expenseTotal = round2(exp.reduce((s, e) => s + e.amount, 0));
  const byCategory = new Map();
  for (const e of exp) byCategory.set(e.category, round2((byCategory.get(e.category) || 0) + e.amount));
  const profit = round2(billed - expenseTotal);
  return {
    ym, billed, plan, charges: round2(billed - plan), collected, expenses: expenseTotal, profit,
    cashFlow: round2(collected - expenseTotal),
    invoiceCount: inv.length, paymentCount: pay.length,
    collectionRate: billed > 0 ? Math.min(100, round2((collected / billed) * 100)) : 0,
    byCategory: [...byCategory.entries()].sort((a, b) => b[1] - a[1]),
  };
}

// Last N months ending at `endYm`, oldest first.
export function trend(data, endYm, n = 6) {
  return Array.from({ length: n }, (_, k) => monthSummary(data, addMonths(endYm, k - (n - 1))));
}

// Nice upper bound for chart axes.
export function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

// Compact money for chart labels: 1250000 → 1.3M, 45000 → 45k
export const compact = (n) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
