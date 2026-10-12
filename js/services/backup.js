// JSON backup export, validation and restore (replace or merge). Never includes passwords or session tokens.
import * as idb from '../db/idb.js';
import { DATA_STORES } from '../db/schema.js';
import { CONFIG } from '../config.js';
import { getSettings, replaceSettings } from '../core/settings.js';
import { nowISO } from '../core/utils.js';
import * as Auth from './auth.js';

export const FORMAT = 'ispdesk-backup';

// Fields every record must have, per collection.
const REQUIRED = {
  plans: ['name', 'price'], subscribers: ['name', 'number', 'status'], invoices: ['number', 'subscriberId', 'total', 'paid', 'status', 'issueDate', 'dueDate'],
  payments: ['number', 'subscriberId', 'amount', 'date', 'method'], expenses: ['date', 'amount', 'category'], inventory: ['name', 'qty'],
  stockMoves: ['itemId', 'qty', 'type', 'date'], tickets: ['number', 'subscriberId', 'status'], messages: ['at'], auditLog: ['at', 'action'],
};

async function sha256(text) {
  if (!crypto?.subtle) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createBackup() {
  Auth.require('backup.export');
  const data = await idb.read(DATA_STORES, async (t) => {
    const out = {};
    for (const s of DATA_STORES) out[s] = await t.getAll(s);
    return out;
  });
  const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length]));
  const u = Auth.user();
  return {
    format: FORMAT, backupVersion: CONFIG.BACKUP_VERSION, appVersion: CONFIG.APP_VERSION, schemaVersion: CONFIG.SCHEMA_VERSION,
    createdAt: nowISO(), createdBy: u ? { name: u.name } : null,
    counts, checksum: await sha256(JSON.stringify(data)), settings: getSettings(), data,
  };
}

// Checks structure, versions, required fields, duplicates and the checksum. Nothing is written here.
export async function validateBackup(obj) {
  const errors = []; const warnings = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['The file is not a valid JSON object.'], warnings };
  if (obj.format !== FORMAT) errors.push('This file is not an ISP Desk backup.');
  if (!Number.isInteger(obj.backupVersion)) errors.push('Missing backup version.');
  else if (obj.backupVersion > CONFIG.BACKUP_VERSION) errors.push(`This backup was made by a newer app version (backup v${obj.backupVersion}). Update the app first.`);
  if (!obj.data || typeof obj.data !== 'object') errors.push('Backup contains no data section.');
  if (errors.length) return { ok: false, errors, warnings };
  const counts = {};
  for (const store of DATA_STORES) {
    const list = obj.data[store];
    if (list === undefined) { counts[store] = 0; continue; }
    if (!Array.isArray(list)) { errors.push(`Collection "${store}" is not a list.`); continue; }
    counts[store] = list.length;
    const keyField = store === 'meta' ? 'key' : 'id';
    const seen = new Set();
    for (const r of list) {
      if (!r || typeof r !== 'object') { errors.push(`"${store}" contains an invalid record.`); break; }
      if (!r[keyField]) { errors.push(`"${store}" has a record without ${keyField}.`); break; }
      if (seen.has(r[keyField])) { errors.push(`"${store}" has a duplicate ${keyField}: ${r[keyField]}.`); break; }
      seen.add(r[keyField]);
      for (const f of REQUIRED[store] || []) if (r[f] === undefined || r[f] === null || r[f] === '') { errors.push(`"${store}" record ${r[keyField]} is missing ${f}.`); break; }
    }
  }
  const recount = Object.fromEntries(DATA_STORES.map((s) => [s, Array.isArray(obj.data[s]) ? obj.data[s].length : 0]));
  for (const s of DATA_STORES) if (obj.counts && obj.counts[s] !== undefined && obj.counts[s] !== recount[s]) errors.push(`Record count for "${s}" does not match the header (file may be truncated).`);
  if (obj.checksum) {
    const actual = await sha256(JSON.stringify(obj.data));
    if (actual && actual !== obj.checksum) errors.push('Checksum mismatch: the file was changed or damaged.');
  } else warnings.push('This backup has no checksum; its integrity cannot be verified.');
  return { ok: errors.length === 0, errors, warnings, counts };
}

// Replace: erases local data and loads the backup. Merge: adds missing records and updates newer ones.
export async function restoreBackup(obj, mode) {
  Auth.require('backup.export');
  const stores = DATA_STORES.filter((s) => s !== 'meta');
  await idb.write([...stores, 'meta'], async (t) => {
    if (mode === 'replace') {
      for (const s of stores) await t.clear(s);
      await t.clear('meta');
    }
    for (const s of stores) {
      for (const r of obj.data[s] || []) {
        if (mode === 'merge') {
          const existing = await t.get(s, r.id);
          if (existing && (existing.updatedAt || existing.at || '') >= (r.updatedAt || r.at || '')) continue;
        }
        await t.put(s, r);
      }
    }
    // Counters: keep the highest so new numbers never collide with restored ones.
    for (const m of obj.data.meta || []) {
      if (!String(m.key).startsWith('counter.')) { await t.put('meta', m); continue; }
      const cur = await t.get('meta', m.key);
      if (!cur || (mode === 'replace') || m.value > cur.value) await t.put('meta', m);
    }
  });
  if (obj.settings) replaceSettings(obj.settings);
  return true;
}
