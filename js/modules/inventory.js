// Inventory for an ISP: ONUs, routers, fibre drop cable, connectors and so on.
// Stock moves in (received from supplier), out (issued to a customer or used on a repair) and adjusts.
// Each change is one transaction that updates both the stock move log and the item quantity.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtDate, today, num, uuid, nowISO, AppError, clean, lc } from '../core/utils.js';
import { getSettings } from '../core/settings.js';
import { INVENTORY_CATEGORIES } from '../db/schema.js';
import * as Auth from '../services/auth.js';

const $ = window.jQuery;
const UNITS = ['pcs', 'metre', 'roll', 'box', 'pair'];

function itemForm(i) {
  const v = (k, d = '') => esc(i?.[k] ?? d);
  return `<div class="row g-2">
    <div class="col-12"><label class="form-label">Item name *</label><input name="name" class="form-control" required maxlength="80" placeholder="e.g. Huawei HG8145 ONU" value="${v('name')}"></div>
    <div class="col-sm-6"><label class="form-label">Category</label><select name="category" class="form-select">${INVENTORY_CATEGORIES.map((c) => `<option ${i?.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
    <div class="col-sm-6"><label class="form-label">Unit</label><select name="unit" class="form-select">${UNITS.map((u) => `<option ${i?.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
    <div class="col-sm-6"><label class="form-label">Cost per unit (${esc(getSettings().currency)})</label><input name="cost" type="number" min="0" step="0.01" class="form-control" value="${v('cost')}"></div>
    <div class="col-sm-6"><label class="form-label">Re-order level</label><input name="minQty" type="number" min="0" step="1" class="form-control" value="${v('minQty', 5)}"></div>
    ${i ? '' : `<div class="col-sm-6"><label class="form-label">Opening stock</label><input name="qty" type="number" min="0" step="1" class="form-control" value="0"></div>`}
  </div>`;
}

async function saveItem(existing, f) {
  Auth.require('inventory.manage');
  const name = clean(f.name, 80);
  if (!name) throw new AppError('Enter the item name.');
  const rec = {
    ...(existing || {}), id: existing?.id || uuid(), name, nameLc: lc(name),
    category: INVENTORY_CATEGORIES.includes(f.category) ? f.category : 'Other', unit: UNITS.includes(f.unit) ? f.unit : 'pcs',
    cost: Math.max(0, num(f.cost)), minQty: Math.max(0, Math.round(num(f.minQty))), qty: existing?.qty ?? 0,
    active: true, createdAt: existing?.createdAt || nowISO(), updatedAt: nowISO(),
  };
  const opening = Math.max(0, Math.round(num(f.qty)));
  await idb.write(['inventory', 'stockMoves'], async (t) => {
    await t.put('inventory', rec);
    if (!existing && opening > 0) {
      rec.qty = opening;
      await t.put('inventory', rec);
      await t.add('stockMoves', { id: uuid(), itemId: rec.id, date: today(), qty: opening, type: 'in', note: 'Opening stock', at: nowISO(), by: Auth.user()?.name || '' });
    }
  });
  return rec;
}

// Moves stock. qty > 0 adds stock; qty < 0 takes it out. Refuses to go below zero unless the setting allows it.
export async function moveStock(itemId, qty, { type, subscriberId = null, note = '' }) {
  Auth.require('inventory.manage');
  const n = Math.round(num(qty));
  if (!n) throw new AppError('Enter a quantity.');
  return idb.write(['inventory', 'stockMoves', 'subscribers'], async (t) => {
    const item = await t.get('inventory', itemId);
    if (!item) throw new AppError('Item not found.');
    const next = item.qty + n;
    if (next < 0 && !getSettings().allowNegativeStock) throw new AppError(`Only ${item.qty} ${item.unit} of ${item.name} in stock.`);
    item.qty = next; item.updatedAt = nowISO();
    await t.put('inventory', item);
    const sub = subscriberId ? await t.get('subscribers', subscriberId) : null;
    await t.add('stockMoves', { id: uuid(), itemId, date: today(), qty: n, type, subscriberId, note: clean(note, 160) || (sub ? `Issued to ${sub.name}` : ''), at: nowISO(), by: Auth.user()?.name || '' });
    return item;
  });
}

async function renderList($c) {
  $c.off('.inv');
  const items = (await idb.getAll('inventory')).sort((a, b) => a.name.localeCompare(b.name));
  const low = items.filter((i) => i.qty <= (i.minQty || 0));
  const value = items.reduce((s, i) => s + Math.max(0, i.qty) * (i.cost || 0), 0);
  const canEdit = Auth.can('inventory.manage');
  let cat = '';
  $c.html(`
    ${UI.pageHeader('Inventory', canEdit ? '<button class="btn btn-primary btn-sm" data-add><i class="bi bi-plus-lg me-1"></i>New item</button>' : '')}
    <div class="row g-2 mb-3">
      <div class="col-6"><div class="mini-stat"><div class="small text-body-secondary">Items</div><div class="fw-bold fs-5">${items.length}</div></div></div>
      <div class="col-6"><div class="mini-stat ${low.length ? 'warn' : ''}"><div class="small text-body-secondary">Low stock</div><div class="fw-bold fs-5">${low.length}</div></div></div>
      <div class="col-12"><div class="mini-stat"><div class="small text-body-secondary">Stock value (at cost)</div><div class="fw-bold" data-count="${value}" data-money="1">0</div></div></div>
    </div>
    <div class="chips mb-3"><button class="chip active" data-cat="">All</button>${INVENTORY_CATEGORIES.map((c) => `<button class="chip" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <div class="list-card" id="inv-items"></div>`);
  UI.countUp($c[0], (n) => `${getSettings().currency} ${fmtNum(n)}`);

  const draw = () => {
    const list = items.filter((i) => !cat || i.category === cat);
    $c.find('#inv-items').html(list.length ? list.map((i) => {
      const isLow = i.qty <= (i.minQty || 0);
      return `<div class="list-row">
        <div class="icon-chip tint-${isLow ? 'red' : 'indigo'}"><i class="bi bi-${i.category === 'Router' || i.category === 'ONU / CPE' ? 'hdd-network' : 'box-seam'}"></i></div>
        <div class="main min-w-0"><a class="title text-truncate d-block text-decoration-none" href="#/inventory/${encodeURIComponent(i.id)}">${esc(i.name)}</a>
          <div class="sub">${esc(i.category)} · re-order at ${i.minQty || 0} ${esc(i.unit)}</div></div>
        <div class="end d-flex align-items-center gap-2">
          <div class="text-end"><div class="fw-bold ${i.qty < 0 ? 'text-danger' : ''}">${i.qty} <span class="small fw-normal">${esc(i.unit)}</span></div>${isLow ? '<span class="badge-soft tone-danger">Low</span>' : ''}</div>
          ${canEdit ? `<div class="btn-group btn-group-sm"><button class="btn btn-light" data-in="${esc(i.id)}" aria-label="Stock in"><i class="bi bi-plus-lg"></i></button>
            <button class="btn btn-light" data-out="${esc(i.id)}" aria-label="Issue"><i class="bi bi-dash-lg"></i></button>
            <button class="btn btn-light" data-edit="${esc(i.id)}" aria-label="Edit"><i class="bi bi-pencil"></i></button></div>` : ''}
        </div></div>`;
    }).join('') : UI.emptyState('No items in this category', 'boxes'));
  };
  $c.on('click.inv', '[data-cat]', function () { cat = this.dataset.cat; $c.find('[data-cat]').removeClass('active'); $(this).addClass('active'); draw(); });
  $c.on('click.inv', '[data-add]', async () => {
    const r = await UI.formModal({ title: 'New inventory item', body: itemForm(null), submitLabel: 'Create item', onSubmit: (f) => saveItem(null, f) });
    if (r) { UI.toast('Item created'); renderList($c); }
  });
  $c.on('click.inv', '[data-edit]', async function () {
    const i = items.find((x) => x.id === this.dataset.edit);
    const r = await UI.formModal({ title: `Edit ${i.name}`, body: itemForm(i), submitLabel: 'Save', onSubmit: (f) => saveItem(i, f) });
    if (r) { UI.toast('Item saved'); renderList($c); }
  });
  $c.on('click.inv', '[data-in],[data-out]', async function () {
    const isIn = this.hasAttribute('data-in');
    const i = items.find((x) => x.id === this.dataset.in || x.id === this.dataset.out);
    if (!i) return;
    const subs = isIn ? [] : await idb.getAll('subscribers');
    const body = `<div class="row g-2"><div class="col-sm-5"><label class="form-label">Quantity (${esc(i.unit)})</label><input name="qty" type="number" min="1" step="1" class="form-control" required value="1"></div>
      ${isIn ? '' : `<div class="col-sm-7"><label class="form-label">Issued to customer (optional)</label><select name="sub" class="form-select"><option value="">Not linked</option>${subs.filter((s) => s.status !== 'disconnected').sort((a, b) => a.name.localeCompare(b.name)).map((s) => `<option value="${esc(s.id)}">${esc(s.name)} · ${esc(s.number)}</option>`).join('')}</select></div>`}
      <div class="col-12"><label class="form-label">Note</label><input name="note" class="form-control" maxlength="160" placeholder="${isIn ? 'e.g. Supplier invoice 1182' : 'e.g. Installation, replaced faulty ONU'}"></div></div>`;
    const r = await UI.formModal({
      title: `${isIn ? 'Stock in' : 'Issue'} · ${i.name}`, body, submitLabel: isIn ? 'Add stock' : 'Issue stock',
      onSubmit: async (f) => {
        const q = Math.abs(Math.round(num(f.qty)));
        if (!q) throw new AppError('Enter a quantity.');
        await moveStock(i.id, isIn ? q : -q, { type: isIn ? 'in' : 'issue', subscriberId: f.sub || null, note: f.note });
        return true;
      },
    });
    if (r) { UI.toast(isIn ? 'Stock added' : 'Stock issued'); renderList($c); }
  });
}

async function renderHistory($c, id) {
  const [item, moves] = await Promise.all([idb.get('inventory', id), idb.getAllByIndex('stockMoves', 'itemId', id)]);
  if (!item) { $c.html(UI.emptyState('Item not found.', 'boxes')); return; }
  const subs = new Map((await idb.getAll('subscribers')).map((s) => [s.id, s]));
  const rows = moves.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  $c.html(`${UI.pageHeader(item.name, '', '#/inventory')}
    <div class="profile-card mb-3"><div class="small text-body-secondary">${esc(item.category)}</div>
      <div class="fs-3 fw-bold">${item.qty} ${esc(item.unit)} <span class="small fw-normal text-body-secondary">in stock</span></div></div>
    <div class="list-card">${rows.length ? rows.map((m) => `<div class="list-row">
      <div class="main min-w-0"><div class="title">${m.type === 'in' ? 'Stock in' : 'Issued'} ${m.subscriberId && subs.get(m.subscriberId) ? `· ${esc(subs.get(m.subscriberId).name)}` : ''}</div>
      <div class="sub">${fmtDate(m.date)}${m.note ? ` · ${esc(m.note)}` : ''} · ${esc(m.by || '')}</div></div>
      <div class="end fw-semibold ${m.qty > 0 ? 'text-success' : 'text-danger'}">${m.qty > 0 ? '+' : ''}${m.qty}</div></div>`).join('') : UI.emptyState('No stock moves yet', 'clock-history')}</div>`);
}

export default {
  async render(el, ctx) {
    const $c = $(el);
    if (ctx.params?.[0]) return renderHistory($c, decodeURIComponent(ctx.params[0]));
    return renderList($c);
  },
  destroy() {},
};
