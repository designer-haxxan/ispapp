// Lightweight settings/preferences stored in LocalStorage (never operational data or secrets).
import { storageKey } from '../config.js';

const KEY = storageKey('settings');

export const DEFAULT_TEMPLATES = {
  invoice: 'Assalam o Alaikum {name}, your {plan} internet bill for {month} is {amount}. Due date: {due}. Pay via {payment}. Customer code {code}. Thank you - {business}',
  reminder: 'Assalam o Alaikum {name}, a friendly reminder that your internet bill of {balance} is pending (due {due}). Please pay to avoid service interruption. Pay via {payment}. - {business}',
  overdue: 'Assalam o Alaikum {name}, your internet bill of {balance} is overdue. Your connection may be suspended if it is not paid soon. Pay via {payment}. Helpline {phone}. - {business}',
  paid: 'Thank you {name}! We received {amount} for your internet bill. Remaining balance: {balance}. Receipt {receipt}. - {business}',
  ticket: 'Assalam o Alaikum {name}, we have logged your complaint {ticket} ({issue}). Our team is working on it. Helpline {phone}. - {business}',
  outage: 'Assalam o Alaikum {name}, we are aware of an internet outage in {area}. Our team is working on it and service will be restored as soon as possible. Sorry for the inconvenience. - {business}',
};

export const DEFAULT_SETTINGS = {
  business: { name: 'My ISP', address: '', phone: '', ptaLicence: '', ntn: '', footer: 'Please pay before the due date to avoid suspension.' },
  payment: { jazzcash: '', easypaisa: '', bank: '', raast: '' },
  currency: 'Rs',
  taxRate: 0, // percent, e.g. 16 for 16 % sales tax. Confirm the rate for your services with your accountant.
  billing: { dueDays: 10, suspendAfterDays: 7, billingDay: 1, autoApplyCredit: true },
  allowNegativeStock: false,
  whatsapp: { countryCode: '92', templates: {} },
  theme: 'auto',
};

function merge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

let cache = null;
export function getSettings() {
  if (!cache) {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { stored = {}; }
    cache = merge(DEFAULT_SETTINGS, stored);
  }
  return cache;
}

// Message template in use: the user's override if set, otherwise the default.
export function template(name) {
  return getSettings().whatsapp.templates?.[name] || DEFAULT_TEMPLATES[name];
}

export function saveSettings(patch) {
  cache = merge(getSettings(), patch);
  localStorage.setItem(KEY, JSON.stringify(cache));
  document.dispatchEvent(new CustomEvent('settings:changed', { detail: cache }));
  return cache;
}

export function replaceSettings(all) {
  cache = merge(DEFAULT_SETTINGS, all || {});
  localStorage.setItem(KEY, JSON.stringify(cache));
  document.dispatchEvent(new CustomEvent('settings:changed', { detail: cache }));
}

// Small per-device preference helpers
export const pref = {
  get(k, d = null) { try { const v = localStorage.getItem(storageKey('pref.' + k)); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { localStorage.setItem(storageKey('pref.' + k), JSON.stringify(v)); },
};

export function applyTheme() {
  const t = getSettings().theme;
  const dark = t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b1020' : '#f4f5fb');
}
