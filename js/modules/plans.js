// Internet plans (packages): speed, monthly price and how many customers use each one.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, uuid, nowISO, num, clean, AppError, lc } from '../core/utils.js';
import { cur } from '../core/views.js';
import * as Auth from '../services/auth.js';
import { TYPES } from './subscribers.js';

const $ = window.jQuery;

// Illustrative starter packages. Prices are placeholders: replace them with your own rates before billing.
const SAMPLE = [
  { name: 'Basic 10 Mbps', speedMbps: 10, price: 1500, type: 'fiber' },
  { name: 'Standard 20 Mbps', speedMbps: 20, price: 2000, type: 'fiber' },
  { name: 'Plus 35 Mbps', speedMbps: 35, price: 2500, type: 'fiber' },
  { name: 'Pro 60 Mbps', speedMbps: 60, price: 3500, type: 'fiber' },
];

// Speed gauge: the arc fills in proportion to the speed (100 Mbps = full scale; faster plans fill the arc completely).
function gauge(mbps) {
  const v = Math.min(1, Math.max(0, Number(mbps) || 0) / 100);
  return `<div class="speed-gauge" style="--g:${(v * 75).toFixed(1)}" role="img" aria-label="${Number(mbps) || 0} Mbps">
    <svg viewBox="0 0 84 84" aria-hidden="true"><circle class="g-track" cx="42" cy="42" r="34" pathLength="100"/><circle class="g-fill" cx="42" cy="42" r="34" pathLength="100"/></svg>
    <div class="g-val"><div><span data-count="${Number(mbps) || 0}">0</span><small>MBPS</small></div></div></div>`;
}

function planForm(p) {
  const v = (k, d = '') => esc(p?.[k] ?? d);
  return `<div class="row g-2">
    <div class="col-12"><label class="form-label">Plan name *</label><input name="name" class="form-control" required placeholder="e.g. Standard 20 Mbps" value="${v('name')}"></div>
    <div class="col-sm-6"><label class="form-label">Speed (Mbps) *</label><input name="speedMbps" type="number" min="1" step="1" class="form-control" value="${v('speedMbps')}"></div>
    <div class="col-sm-6"><label class="form-label">Monthly price (${esc(cur())}) *</label><input name="price" type="number" min="0" step="0.01" class="form-control" value="${v('price')}"></div>
    <div class="col-sm-6"><label class="form-label">Connection type</label><select name="type" class="form-select">${Object.entries(TYPES).map(([k, l]) => `<option value="${k}" ${p?.type === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
    <div class="col-sm-6"><label class="form-label">Sold to new customers</label><select name="active" class="form-select"><option value="1" ${p?.active !== false ? 'selected' : ''}>Yes</option><option value="0" ${p?.active === false ? 'selected' : ''}>No (hidden)</option></select></div>
    <div class="col-12"><label class="form-label">Description (optional)</label><input name="description" class="form-control" placeholder="e.g. Unlimited, 1 static IP extra" value="${v('description')}"></div>
  </div>`;
}

async function savePlan(existing, f) {
  Auth.require('plan.manage');
  const name = clean(f.name, 80);
  const speed = Math.round(num(f.speedMbps));
  const price = Math.round(num(f.price) * 100) / 100;
  if (!name) throw new AppError('Enter a plan name.');
  if (!(speed > 0)) throw new AppError('Enter the speed in Mbps.');
  if (!(price >= 0)) throw new AppError('Enter a valid monthly price.');
  const rec = {
    ...(existing || {}), id: existing?.id || uuid(), name, nameLc: lc(name), speedMbps: speed, price,
    type: TYPES[f.type] ? f.type : 'fiber', active: f.active !== '0', description: clean(f.description, 160),
    createdAt: existing?.createdAt || nowISO(), updatedAt: nowISO(),
  };
  await idb.write(['plans'], (t) => t.put('plans', rec));
  return rec;
}

async function deletePlan(p) {
  Auth.require('plan.manage');
  return idb.write(['plans', 'subscribers'], async (t) => {
    const used = await t.countByIndex('subscribers', 'planId', p.id);
    if (used) throw new AppError(`${used} customer${used === 1 ? ' uses' : 's use'} this plan. Hide it instead (set Sold to new customers: No).`);
    await t.delete('plans', p.id);
  });
}

async function draw($c) {
  const [plans, subs] = await Promise.all([idb.getAll('plans'), idb.getAll('subscribers')]);
  const users = new Map();
  for (const s of subs) if (s.planId && s.status !== 'disconnected') users.set(s.planId, (users.get(s.planId) || 0) + 1);
  plans.sort((a, b) => a.price - b.price);
  const canEdit = Auth.can('plan.manage');
  $c.html(`
    ${UI.pageHeader('Plans & pricing', canEdit ? '<button class="btn btn-primary btn-sm" data-add><i class="bi bi-plus-lg me-1"></i>New plan</button>' : '')}
    ${canEdit && !plans.length ? `<div class="empty-state text-center mb-3"><div class="small text-body-secondary mb-2">Start with sample packages, then change the prices to your own.</div>
      <button class="btn btn-outline-primary btn-sm" data-sample><i class="bi bi-magic me-1"></i>Add sample plans</button></div>` : ''}
    ${plans.length ? `<div class="row g-3 stagger">${plans.map((p) => `
      <div class="col-sm-6 col-xl-3"><div class="plan-card ${p.active === false ? 'is-hidden' : ''} reveal" data-id="${esc(p.id)}">
        <div class="plan-head">
          <div class="min-w-0"><div class="fw-semibold text-truncate">${esc(p.name)}</div>
            <div class="small text-body-secondary">${esc(TYPES[p.type] || '')}</div></div>
          ${gauge(p.speedMbps)}
        </div>
        <div class="plan-price mt-2">${esc(cur())} ${fmtNum(p.price)}<small> /month</small></div>
        <div class="small text-body-secondary">${p.description ? esc(p.description) : '&nbsp;'}</div>
        <div class="d-flex justify-content-between align-items-center mt-2">
          <span class="badge-soft tone-${users.get(p.id) ? 'info' : 'secondary'}"><i class="bi bi-people me-1"></i>${users.get(p.id) || 0} customer${(users.get(p.id) || 0) === 1 ? "" : "s"}</span>
          ${p.active === false ? '<span class="badge-soft tone-secondary">Hidden</span>' : ''}
        </div>
        ${canEdit ? `<div class="d-flex gap-2 mt-3"><button class="btn btn-sm btn-light flex-fill" data-edit="${esc(p.id)}"><i class="bi bi-pencil me-1"></i>Edit</button>
          <button class="btn btn-sm btn-light text-danger" data-del="${esc(p.id)}" aria-label="Delete plan"><i class="bi bi-trash"></i></button></div>` : ''}
      </div></div>`).join('')}</div>`
      : (canEdit ? '' : UI.emptyState('No plans yet. Ask the owner to add them.', 'wifi'))}
    <div class="small text-body-secondary mt-3">Changing a price affects the next monthly run only. Invoices already issued keep their amount.</div>`);
  UI.countUp($c[0], (n) => String(Math.round(n)));

  const reload = () => draw($c);
  $c.off('.plan');
  $c.on('click.plan', '[data-add]', async () => {
    const f = await UI.formModal({ title: 'New plan', body: planForm(null), submitLabel: 'Create plan', onSubmit: (v) => savePlan(null, v) });
    if (f) { UI.toast('Plan created'); reload(); }
  });
  $c.on('click.plan', '[data-sample]', async () => {
    try {
      await idb.write(['plans'], async (t) => {
        for (const s of SAMPLE) await t.add('plans', { id: uuid(), nameLc: lc(s.name), active: true, createdAt: nowISO(), updatedAt: nowISO(), ...s });
      });
      UI.toast('Sample plans added. Check the prices.', 'info'); reload();
    } catch (e) { UI.toastError(e); }
  });
  $c.on('click.plan', '[data-edit]', async function () {
    const p = plans.find((x) => x.id === this.dataset.edit);
    if (!p) return;
    const r = await UI.formModal({ title: `Edit ${p.name}`, body: planForm(p), submitLabel: 'Save plan', onSubmit: (v) => savePlan(p, v) });
    if (r) { UI.toast('Plan saved'); reload(); }
  });
  $c.on('click.plan', '[data-del]', async function () {
    const p = plans.find((x) => x.id === this.dataset.del);
    if (!p || !await UI.confirmDialog(`Delete ${p.name}?`, { okLabel: 'Delete', okClass: 'btn-danger' })) return;
    try { await deletePlan(p); UI.toast('Plan deleted'); reload(); } catch (e) { UI.toastError(e); }
  });
}

export default {
  async render(el) { await draw($(el)); },
  destroy() {},
};
