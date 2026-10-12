// IndexedDB schema definition and migrations.
import { CONFIG } from '../config.js';

export const DB_NAME = `${CONFIG.APP_ID}_db`;
// Database and keys of the previous POS build. Never modified by this app.
export const LEGACY_DB_NAME = 'disterp_pos';
export const DB_VERSION = 1;

// Stores that make up the business data (included in backups).
export const DATA_STORES = [
  'plans', 'subscribers', 'invoices', 'payments', 'expenses',
  'inventory', 'stockMoves', 'tickets', 'messages', 'auditLog', 'meta',
];

const STORES = {
  meta: { keyPath: 'key', indexes: {} },
  plans: { indexes: { nameLc: 'nameLc', active: 'active' } },
  // number: customer code (CUS-000001). Phone is stored normalised (923XXXXXXXXX) for WhatsApp links.
  subscribers: { indexes: { number: ['number', true], nameLc: 'nameLc', phone: 'phone', area: 'area', status: 'status', planId: 'planId' } },
  // periodKey = "<subscriberId>|<YYYY-MM>" only on monthly plan invoices. The unique index stops a
  // monthly run from billing the same customer twice for the same month. Voiding removes the key.
  invoices: { indexes: { number: ['number', true], periodKey: ['periodKey', true], subscriberId: 'subscriberId', status: 'status', issueDate: 'issueDate', dueDate: 'dueDate' } },
  payments: { indexes: { number: ['number', true], subscriberId: 'subscriberId', date: 'date', method: 'method' } },
  expenses: { indexes: { date: 'date', category: 'category' } },
  inventory: { indexes: { nameLc: 'nameLc', category: 'category' } },
  stockMoves: { indexes: { itemId: 'itemId', date: 'date', subscriberId: 'subscriberId' } },
  tickets: { indexes: { number: ['number', true], subscriberId: 'subscriberId', status: 'status', createdDate: 'createdDate' } },
  messages: { indexes: { at: 'at', subscriberId: 'subscriberId' } },
  auditLog: { indexes: { at: 'at' } },
};

export const PAYMENT_METHODS = {
  cash: 'Cash',
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
  raast: 'Raast / IBFT',
  bank: 'Bank transfer',
  other: 'Other',
};

export const EXPENSE_CATEGORIES = [
  'Bandwidth / IP transit', 'Fiber & cable', 'Routers & ONUs', 'Tower / POP rent', 'Electricity & generator',
  'Fuel & transport', 'Staff salaries', 'Repairs & maintenance', 'Licences & taxes', 'Marketing', 'Office & misc',
];

export const INVENTORY_CATEGORIES = ['ONU / CPE', 'Router', 'Fiber cable', 'UTP / LAN cable', 'Connectors & patch cords', 'Splitter & box', 'Wireless radio', 'Other'];

export const TICKET_CATEGORIES = { fault: 'No internet / fault', slow: 'Slow speed', billing: 'Billing dispute', shifting: 'Shifting / relocation', other: 'Other' };

export function upgrade(db, oldVersion, t) {
  if (oldVersion < 1) {
    for (const [name, def] of Object.entries(STORES)) {
      const os = db.createObjectStore(name, { keyPath: def.keyPath || 'id' });
      for (const [idx, spec] of Object.entries(def.indexes)) {
        const [keyPath, unique] = Array.isArray(spec) ? spec : [spec, false];
        os.createIndex(idx, keyPath, { unique: !!unique });
      }
    }
    const now = new Date().toISOString();
    t.objectStore('meta').put({ key: 'schemaVersion', value: 1 });
    t.objectStore('meta').put({ key: 'createdAt', value: now });
  }
  // Future migrations: if (oldVersion < 2) { ... }
}
