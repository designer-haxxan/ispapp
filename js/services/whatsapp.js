// WhatsApp messaging. The app cannot send WhatsApp messages on its own (that needs the WhatsApp Business API and a
// server). Instead each message opens WhatsApp (Web or app) with the text filled in, and the staff member taps Send.
// Every message the desk opens is logged against the customer.
import * as idb from '../db/idb.js';
import { uuid, nowISO, round2, fmtDate } from '../core/utils.js';
import { getSettings, template } from '../core/settings.js';
import * as Auth from './auth.js';

// Pakistani mobile/landline → international digits: 0302-8863131 → 923028863131. Returns '' if not usable.
export function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = getSettings().whatsapp.countryCode + d.slice(1);
  else if (d.length === 10 && d.startsWith('3')) d = getSettings().whatsapp.countryCode + d;
  return d.length >= 11 && d.length <= 13 ? d : '';
}

export const waLink = (phone, text) => `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;

// Payment instructions printed in invoices and reminders, from the Settings → Payment section.
export function paymentText() {
  const p = getSettings().payment;
  const parts = [];
  if (p.jazzcash) parts.push(`JazzCash ${p.jazzcash}`);
  if (p.easypaisa) parts.push(`Easypaisa ${p.easypaisa}`);
  if (p.raast) parts.push(`Raast ${p.raast}`);
  if (p.bank) parts.push(`Bank: ${p.bank}`);
  return parts.join(', ') || 'cash at our office';
}

// Money in the same format as the rest of the app: Rs 1,500.00
export function money(n) { return `${getSettings().currency} ${round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

// Fills {placeholders}. Unknown placeholders become empty text, so a template never shows raw braces.
export function fillTemplate(name, vars = {}) {
  const b = getSettings().business;
  const all = { business: b.name, phone: b.phone, payment: paymentText(), ...vars };
  return template(name).replace(/\{(\w+)\}/g, (_, k) => (all[k] ?? '')).replace(/\s+/g, ' ').trim();
}

// Variables for a customer message. `extra` adds template-specific values (amount, ticket, receipt...).
export function customerVars(sub, plan, bal, extra = {}) {
  return {
    name: sub.name.split(' ')[0],
    fullName: sub.name,
    code: sub.number,
    plan: plan?.name || '',
    balance: money(bal?.balance ?? 0),
    due: bal?.oldestDue ? fmtDate(bal.oldestDue) : '',
    area: sub.area || '',
    ...extra,
  };
}

export const monthVar = (ym) => new Date(ym + '-01T00:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

// Logs a message the desk opened in WhatsApp. Kept for the customer's history and for the message log screen.
export async function logMessage({ subscriberId = null, phone, text, template: tpl = 'custom' }) {
  Auth.require('whatsapp.send');
  const rec = { id: uuid(), at: nowISO(), subscriberId, phone, template: tpl, text: String(text).slice(0, 1200), by: Auth.user()?.name || '' };
  await idb.write(['messages'], (t) => t.add('messages', rec));
  return rec;
}

// Display form for a stored number: 923001234567 → +92 300 1234567
export function displayPhone(stored) {
  const d = String(stored || '').replace(/\D/g, '');
  if (d.length < 11) return stored || '';
  return `+${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5)}`;
}
