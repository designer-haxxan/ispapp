// CSV reading and customer-row mapping. Pure functions only (no browser or database access), so they can be
// tested in Node. Works with our own template and with UISP-style exports: columns are matched by header name.

export const TEMPLATE_COLUMNS = [
  'Full Name', 'Mobile', 'CNIC', 'Address', 'Area', 'Package', 'Username', 'Connection Type',
  'Status', 'Installation Date', 'Balance', 'Expiry Date', 'Email', 'Notes',
];
export const TEMPLATE_EXAMPLE = [
  'Example Customer', '0300 1234567', '35202-1234567-1', 'House 12, Street 4', 'Gulberg', 'Standard 20 Mbps',
  'cust_example', 'Fiber (FTTH)', 'Active', '2026-10-01', '0', '2026-11-01', '', 'EXAMPLE ROW: replace or delete it',
];

// Header names we understand, normalised (lower case, letters and digits only).
const ALIASES = {
  name: ['fullname', 'name', 'customername', 'subscribername', 'client'],
  phone: ['mobile', 'phone', 'mobilenumber', 'phonenumber', 'whatsapp', 'contact'],
  cnic: ['cnic', 'nid', 'idcard'],
  address: ['address', 'fulladdress'],
  area: ['area', 'zone', 'society', 'location', 'town'],
  package: ['package', 'plan', 'servicepackage', 'tariff'],
  username: ['username', 'pppoeuser', 'pppoeusername', 'loginname', 'login'],
  type: ['connectiontype', 'type'],
  service: ['service', 'protocol'],
  status: ['status', 'accountstatus'],
  installDate: ['installationdate', 'installdate', 'created', 'createddate', 'startdate'],
  balance: ['balance', 'outstanding', 'amountdue', 'due'],
  expiry: ['expirydate', 'expiry', 'expires', 'nextdue', 'duedate'],
  email: ['email'],
  notes: ['notes', 'note', 'remarks', 'comment'],
  seller: ['seller', 'reseller', 'agent'],
  ip: ['ipaddress', 'ipmac', 'ip'],
  customPrice: ['customprice', 'monthlyprice', 'price'],
};
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const STATUS_WORDS = [['disconnect', 'disconnected'], ['inactive', 'disconnected'], ['suspend', 'suspended'], ['expired', 'suspended'], ['pending', 'pending'], ['active', 'active']];
const TYPE_WORDS = [['fiber', 'fiber'], ['fibre', 'fiber'], ['ftth', 'fiber'], ['wireless', 'wireless'], ['wifi', 'wireless'], ['radio', 'wireless'], ['lte', 'lte'], ['4g', 'lte'], ['cable', 'cable'], ['lan', 'cable']];
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Detects the delimiter from the header line (commas, semicolons as used by Excel in some regions, or tabs).
export function parseCSV(text) {
  text = String(text || '').replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => first.split(ch).length - 1;
  const delim = count(';') > count(',') && count(';') >= count('\t') ? ';' : count('\t') > count(',') ? '\t' : ',';
  const rows = []; let row = []; let field = ''; let i = 0; let quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === delim) { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

// Maps each known field to its column index. Unknown columns are reported, not silently dropped.
export function mapColumns(headers) {
  const columns = {}; const recognised = []; const ignored = [];
  headers.forEach((h, idx) => {
    const key = norm(h);
    const field = Object.keys(ALIASES).find((f) => ALIASES[f].includes(key) && !(f in columns));
    if (field) { columns[field] = idx; recognised.push({ field, header: String(h).trim() }); }
    else if (String(h).trim()) ignored.push(String(h).trim());
  });
  return { columns, recognised, ignored };
}

// Excel saves long numbers as 3.83827E+11, which loses digits. Such values cannot be repaired from the file.
export const isScientific = (raw) => /^\s*[+-]?\d+(\.\d+)?E[+-]?\d+\s*$/i.test(String(raw ?? ''));

// Pakistani mobile → 923XXXXXXXXX. Returns '' when the value is not a usable number.
export function normalizePhoneDigits(raw, cc = '92') {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = cc + d.slice(1);
  else if (d.length === 10 && d.startsWith('3')) d = cc + d;
  return d.length >= 11 && d.length <= 13 ? d : '';
}

export function formatCnic(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length === 13 ? `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}` : '';
}

// Accepts 2026-10-01, 2026-10-01 10:43:35, 26 Sep 2026, 01/10/2026 (day first). Returns YYYY-MM-DD or ''.
export function parseDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return ok(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) return ok(+m[3], MONTHS[m[2].toLowerCase()] + 1, +m[1]);
  return '';
}
function ok(y, mo, d) {
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseMoney(raw) {
  const s = String(raw ?? '').replace(/[, ]|Rs\.?/gi, '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

const pickWord = (text, table) => { const t = String(text || '').toLowerCase(); return (table.find(([k]) => t.includes(k)) || [])[1] || null; };

// Turns the parsed table into customer records with issues attached to each row.
// today: YYYY-MM-DD, used for default status (expired → suspended) and default install date.
export function mapRows(table, today) {
  if (!table.length) return { fatal: 'The file is empty.', records: [], recognised: [], ignored: [] };
  const [headers, ...body] = table;
  const { columns, recognised, ignored } = mapColumns(headers);
  if (columns.name === undefined) {
    return { fatal: 'No "Full Name" column was found. Use the template, or check that the first row holds the column titles.', records: [], recognised, ignored };
  }
  const get = (row, field) => (columns[field] === undefined ? '' : String(row[columns[field]] ?? '').trim());
  const records = body.map((row, k) => {
    const line = k + 2; // header is line 1
    const issues = [];
    const err = (text) => issues.push({ level: 'error', text });
    const warn = (text) => issues.push({ level: 'warning', text });

    const name = get(row, 'name').replace(/\s+/g, ' ').slice(0, 120);
    if (!name) err('Full name is missing.');

    const rawPhone = get(row, 'phone');
    let phone = '';
    // The customer is still imported (so billing works); the number cannot be recovered and is left blank.
    if (isScientific(rawPhone)) warn(`Mobile "${rawPhone}" was saved by Excel as scientific notation and lost digits. It was left blank: add the number on the customer page.`);
    else if (rawPhone) { phone = normalizePhoneDigits(rawPhone); if (!phone) err(`Mobile "${rawPhone}" is not a valid number.`); }
    else warn('No mobile number: WhatsApp reminders will not work for this customer.');

    const rawCnic = get(row, 'cnic');
    const cnic = formatCnic(rawCnic);
    if (rawCnic && !cnic) warn(`CNIC "${rawCnic}" does not have 13 digits. It was not imported.`);

    const pkg = get(row, 'package').replace(/\s+/g, ' ');
    const speedMatch = pkg.match(/(\d+(?:\.\d+)?)\s*m(?:bps)?\b/i);
    if (!pkg) warn('No package: the customer is imported as pending and will not be billed.');

    const expiryDate = parseDate(get(row, 'expiry'));
    const installDate = parseDate(get(row, 'installDate')) || today;
    if (get(row, 'installDate') && !parseDate(get(row, 'installDate'))) warn(`Installation date "${get(row, 'installDate')}" not understood. Today was used.`);

    const rawStatus = get(row, 'status');
    let status = pickWord(rawStatus, STATUS_WORDS);
    if (!status) status = expiryDate && expiryDate < today ? 'suspended' : 'active';
    if (status === 'active' && !pkg) { status = 'pending'; }

    const rawType = get(row, 'type');
    let type = pickWord(rawType, TYPE_WORDS);
    if (!type) {
      type = 'fiber';
      if (rawType && !/pppoe|hotspot/i.test(rawType)) warn(`Connection type "${rawType}" not recognised. Fiber was used.`);
    }

    const balanceRaw = get(row, 'balance');
    let balance = parseMoney(balanceRaw);
    if (balance === null && balanceRaw) warn(`Balance "${balanceRaw}" is not a number and was ignored.`);
    if (balance !== null && balance < 0) { warn(`Balance ${balance} is a credit and was not imported.`); balance = 0; }

    const customPrice = parseMoney(get(row, 'customPrice'));
    const username = get(row, 'username').slice(0, 80);
    const notes = [get(row, 'notes'), get(row, 'seller') && `Reseller: ${get(row, 'seller')}`,
      get(row, 'service') && !/^pppoe$/i.test(get(row, 'service')) ? `Service: ${get(row, 'service')}` : '',
      get(row, 'service') && /^pppoe$/i.test(get(row, 'service')) ? 'Service: PPPoE' : '', get(row, 'ip') && `IP: ${get(row, 'ip')}`]
      .filter(Boolean).join(' · ').slice(0, 400);

    return {
      line, name, phone, cnic, address: get(row, 'address').slice(0, 200), area: get(row, 'area').slice(0, 80),
      pkg, speedMbps: speedMatch ? Math.round(Number(speedMatch[1])) : null, username, type, status,
      installDate, expiryDate, balance: balance || 0, customPrice: customPrice && customPrice > 0 ? customPrice : null,
      email: get(row, 'email').slice(0, 120), notes, issues,
    };
  });
  return { fatal: null, records, recognised, ignored, headers };
}

// Blank CSV used as the template: header row plus one example line to copy from.
export function templateCSV() {
  const esc = (v) => (/[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [TEMPLATE_COLUMNS, TEMPLATE_EXAMPLE].map((r) => r.map(esc).join(',')).join('\r\n');
}
