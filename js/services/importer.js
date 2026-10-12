// Customer import: checks a CSV against existing customers, then writes the ready rows in one transaction.
// Rows with errors are never imported. Duplicates (same login, mobile or CNIC) are skipped, not overwritten.
import * as idb from '../db/idb.js';
import { uuid, nowISO, today, AppError, lc, toCSV } from '../core/utils.js';
import * as Auth from './auth.js';
import * as CSV from './csv.js';
import { nextNumber } from './billing.js';

// Reads and checks a file. Nothing is written here.
export async function analyse(text) {
  Auth.require('subscriber.manage');
  const res = CSV.mapRows(CSV.parseCSV(text), today());
  if (res.fatal) throw new AppError(res.fatal);
  const [subs, plans] = await idb.read(['subscribers', 'plans'], async (t) => [await t.getAll('subscribers'), await t.getAll('plans')]);

  const planNames = new Set(plans.map((p) => lc(p.name)));
  const taken = { user: new Set(), phone: new Set(), cnic: new Set() };
  for (const s of subs) {
    if (s.pppoeUser) taken.user.add(lc(s.pppoeUser));
    if (s.phone) taken.phone.add(s.phone);
    if (s.cnic) taken.cnic.add(s.cnic);
  }
  const newPlans = new Map();
  const rows = res.records.map((r) => {
    const issues = [...r.issues];
    const hasError = issues.some((i) => i.level === 'error');
    const existing = (r.username && taken.user.has(lc(r.username))) || (r.phone && taken.phone.has(r.phone)) || (r.cnic && taken.cnic.has(r.cnic));
    let result = hasError ? 'fix' : existing ? 'skip' : 'ready';
    if (existing && !hasError) issues.push({ level: 'info', text: 'A customer with this login, mobile or CNIC already exists. It will be skipped.' });
    // Duplicates inside the file: the first occurrence wins.
    if (result === 'ready') {
      if (r.username) taken.user.add(lc(r.username));
      if (r.phone) taken.phone.add(r.phone);
      if (r.cnic) taken.cnic.add(r.cnic);
    }
    if (r.pkg && result !== 'fix' && !planNames.has(lc(r.pkg)) && !newPlans.has(lc(r.pkg))) {
      newPlans.set(lc(r.pkg), { name: r.pkg, speedMbps: r.speedMbps || 0 });
    }
    return { ...r, issues, result };
  });
  // Rows flagged "skip" because of a duplicate inside the file must not count as existing customers.
  const counts = { ready: 0, skip: 0, fix: 0 };
  for (const r of rows) counts[r.result]++;
  return { rows, counts, newPlans: [...newPlans.values()], recognised: res.recognised, ignored: res.ignored, headers: res.headers };
}

// Writes the ready rows: creates missing plans (price 0 until set), customers, and opening-balance invoices.
export async function commit(prep) {
  Auth.require('subscriber.manage');
  const ready = prep.rows.filter((r) => r.result === 'ready');
  if (!ready.length) throw new AppError('No rows are ready to import.');
  const day = today(); const now = nowISO();
  const user = Auth.user()?.name || '';
  return idb.write(['plans', 'subscribers', 'invoices', 'meta', 'auditLog'], async (t) => {
    const planByName = new Map((await t.getAll('plans')).map((p) => [lc(p.name), p]));
    let plansCreated = 0;
    for (const np of prep.newPlans) {
      if (planByName.has(lc(np.name))) continue;
      const p = {
        id: uuid(), name: np.name, nameLc: lc(np.name), speedMbps: np.speedMbps || 0, price: 0, type: 'fiber', active: true,
        description: 'Imported. Set the price before billing.', createdAt: now, updatedAt: now,
      };
      await t.add('plans', p);
      planByName.set(lc(p.name), p);
      plansCreated++;
    }
    let customers = 0; let invoices = 0;
    for (const r of ready) {
      const plan = r.pkg ? planByName.get(lc(r.pkg)) : null;
      const rec = {
        id: uuid(), number: await nextNumber(t, 'customer', 'CUS'),
        name: r.name, nameLc: lc(r.name), phone: r.phone, cnic: r.cnic, email: r.email, area: r.area, address: r.address,
        type: r.type, planId: plan?.id || null, customPrice: r.customPrice,
        // Status from the file (active, suspended, pending...). An active customer needs a plan, so fall back to pending.
        status: r.status === 'active' && !plan ? 'pending' : r.status,
        installDate: r.installDate, expiryDate: r.expiryDate, pppoeUser: r.username, notes: r.notes,
        imported: true, createdAt: now, updatedAt: now,
      };
      for (const k of Object.keys(rec)) if (rec[k] === '' || rec[k] === null || rec[k] === undefined) delete rec[k];
      await t.add('subscribers', rec);
      customers++;
      if (r.balance > 0) {
        const amount = Math.round(r.balance * 100) / 100;
        await t.add('invoices', {
          id: uuid(), number: await nextNumber(t, 'invoice', 'INV'), subscriberId: rec.id, period: null,
          issueDate: day, dueDate: day, items: [{ kind: 'charge', description: 'Opening balance (imported)', amount }],
          subtotal: amount, tax: 0, total: amount, paid: 0, status: 'unpaid', note: 'Balance carried over from import', createdAt: now, createdBy: user,
        });
        invoices++;
      }
    }
    await t.add('auditLog', { id: uuid(), at: now, action: 'import.customers', entity: 'import', detail: `${customers} customers, ${invoices} opening balances, ${plansCreated} plans created`, by: user });
    return { customers, invoices, plansCreated, skipped: prep.counts.skip, needsFix: prep.counts.fix };
  });
}

// A CSV of every row that was not imported, with the reasons, so the client can correct and re-upload.
export function problemsCSV(prep) {
  const rows = [['Line', 'Full Name', 'Mobile', 'Package', 'Result', 'Reason']];
  for (const r of prep.rows) {
    if (r.result === 'ready') continue;
    const reasons = r.issues.map((i) => i.text).join(' | ');
    rows.push([r.line, r.name, r.phone || '', r.pkg, r.result === 'fix' ? 'Fix and upload again' : 'Skipped (already exists)', reasons]);
  }
  return toCSV(rows);
}
