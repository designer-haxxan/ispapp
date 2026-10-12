// Settings: business profile, payment numbers on invoices, billing rules, tax, WhatsApp and appearance.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtDateTime, num, uuid, nowISO } from '../core/utils.js';
import { getSettings, saveSettings, applyTheme } from '../core/settings.js';
import * as Auth from '../services/auth.js';

const $ = window.jQuery;

const field = (label, name, value, { type = 'text', hint = '', attrs = '' } = {}) => `<div class="col-md-6">
  <label class="form-label">${esc(label)}</label>
  <input class="form-control" name="${esc(name)}" type="${type}" value="${esc(value ?? '')}" ${attrs}>
  ${hint ? `<div class="form-text">${esc(hint)}</div>` : ''}</div>`;

async function render$(el) {
  const $c = $(el);
  $c.off('.set');
  const s = getSettings();
  const canEdit = Auth.can('settings.manage');
  const audit = (await idb.getAll('auditLog')).sort((a, b) => (b.at || '').localeCompare(a.at || '')).slice(0, 25);
  const u = Auth.user();
  $c.html(`
    ${UI.pageHeader('Settings')}
    <form id="set-form" class="row g-3" novalidate>
      <div class="col-12"><div class="card-soft p-3 p-md-4 reveal">
        <div class="fw-semibold mb-2"><i class="bi bi-building me-1"></i>Business profile</div>
        <div class="row g-3">
          ${field('ISP / business name', 'business.name', s.business.name)}
          ${field('Helpline phone', 'business.phone', s.business.phone, { hint: 'Shown on invoices and in WhatsApp messages' })}
          ${field('Office address', 'business.address', s.business.address)}
          ${field('PTA licence number', 'business.ptaLicence', s.business.ptaLicence)}
          ${field('NTN', 'business.ntn', s.business.ntn)}
          ${field('Invoice footer', 'business.footer', s.business.footer)}
        </div></div></div>

      <div class="col-12"><div class="card-soft p-3 p-md-4 reveal">
        <div class="fw-semibold mb-1"><i class="bi bi-wallet2 me-1"></i>How customers pay</div>
        <div class="small text-body-secondary mb-2">These appear on every invoice and reminder so customers know where to pay.</div>
        <div class="row g-3">
          ${field('JazzCash number', 'payment.jazzcash', s.payment.jazzcash, { attrs: 'inputmode="tel"' })}
          ${field('Easypaisa number', 'payment.easypaisa', s.payment.easypaisa, { attrs: 'inputmode="tel"' })}
          ${field('Raast ID / IBAN', 'payment.raast', s.payment.raast)}
          ${field('Bank account', 'payment.bank', s.payment.bank, { hint: 'Bank name, account title and IBAN' })}
        </div></div></div>

      <div class="col-lg-6"><div class="card-soft p-3 p-md-4 h-100 reveal">
        <div class="fw-semibold mb-2"><i class="bi bi-receipt me-1"></i>Billing rules</div>
        <div class="row g-3">
          ${field('Billing day (1–28)', 'billing.billingDay', s.billing.billingDay, { type: 'number', attrs: 'min="1" max="28" step="1"', hint: 'Invoices are dated on this day of the month' })}
          ${field('Due after (days)', 'billing.dueDays', s.billing.dueDays, { type: 'number', attrs: 'min="0" max="60" step="1"' })}
          ${field('Suspend after (days overdue)', 'billing.suspendAfterDays', s.billing.suspendAfterDays, { type: 'number', attrs: 'min="0" max="120" step="1"', hint: 'Used to decide who gets an overdue notice' })}
          ${field('Sales tax rate (%)', 'taxRate', s.taxRate, { type: 'number', attrs: 'min="0" max="100" step="0.01"', hint: 'Confirm the rate for your services with your accountant. 0 means no tax line.' })}
          <div class="col-12"><div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" role="switch" id="autoCredit" name="billing.autoApplyCredit" ${s.billing.autoApplyCredit ? 'checked' : ''}>
            <label class="form-check-label" for="autoCredit">Use advance credit automatically on the next invoice</label></div></div>
        </div></div></div>

      <div class="col-lg-6"><div class="card-soft p-3 p-md-4 h-100 reveal">
        <div class="fw-semibold mb-2"><i class="bi bi-whatsapp me-1"></i>WhatsApp & appearance</div>
        <div class="row g-3">
          ${field('Country code', 'whatsapp.countryCode', s.whatsapp.countryCode, { attrs: 'inputmode="numeric"', hint: 'Pakistan is 92. Numbers starting with 03 are converted automatically.' })}
          <div class="col-md-6"><label class="form-label">Theme</label>
            <select class="form-select" name="theme"><option value="auto" ${s.theme === 'auto' ? 'selected' : ''}>Match device</option>
            <option value="light" ${s.theme === 'light' ? 'selected' : ''}>Light</option><option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>Dark</option></select></div>
        </div>
        <div class="small text-body-secondary mt-3">Message wording is edited under <a href="#/messages">WhatsApp → Templates</a>.</div>
      </div></div>

      <div class="col-12 d-flex gap-2">
        ${canEdit ? '<button class="btn btn-primary" type="submit"><i class="bi bi-check2 me-1"></i>Save settings</button>' : '<div class="small text-body-secondary">Only the owner or a manager can change settings.</div>'}
      </div>
    </form>

    <div class="card-soft p-3 mt-3 reveal">
      <div class="fw-semibold mb-1">Signed in</div>
      <div class="small text-body-secondary">${esc(u?.name || '')} · ${esc(Auth.ROLES[u?.role] || '')}</div>
    </div>

    <div class="section-title mt-3"><h2>Recent activity</h2></div>
    <div class="list-card">${audit.length ? audit.map((a) => `<div class="list-row">
      <div class="main min-w-0"><div class="title">${esc(a.action)} <span class="small text-body-secondary">${esc(a.entity || '')}</span></div>
      <div class="sub text-truncate">${esc(a.detail || '')}${a.by ? ` · ${esc(a.by)}` : ''}</div></div>
      <div class="end small text-body-secondary">${fmtDateTime(a.at)}</div></div>`).join('') : UI.emptyState('No activity yet', 'clock-history')}</div>`);

  $c.on('submit.set', '#set-form', async (e) => {
    e.preventDefault();
    if (!Auth.can('settings.manage')) return UI.toast('You do not have permission to change settings.', 'warning');
    const f = Object.fromEntries(new FormData(e.currentTarget).entries());
    const patch = { business: {}, payment: {}, billing: {}, whatsapp: {} };
    for (const [k, v] of Object.entries(f)) {
      const [group, key] = k.includes('.') ? k.split('.') : [null, k];
      if (group) patch[group][key] = v;
      else patch[key] = v;
    }
    patch.billing.billingDay = Math.min(28, Math.max(1, Math.round(num(patch.billing.billingDay, 1))));
    patch.billing.dueDays = Math.max(0, Math.round(num(patch.billing.dueDays, 10)));
    patch.billing.suspendAfterDays = Math.max(0, Math.round(num(patch.billing.suspendAfterDays, 7)));
    patch.billing.autoApplyCredit = e.currentTarget.querySelector('#autoCredit').checked;
    patch.taxRate = Math.min(100, Math.max(0, num(patch.taxRate, 0)));
    patch.whatsapp.countryCode = String(patch.whatsapp.countryCode || '92').replace(/\D/g, '') || '92';
    patch.theme = ['auto', 'light', 'dark'].includes(patch.theme) ? patch.theme : 'auto';
    saveSettings(patch);
    applyTheme();
    try {
      await idb.write(['auditLog'], (t) => t.add('auditLog', { id: uuid(), at: nowISO(), action: 'settings.save', entity: 'settings', detail: 'Business settings updated', by: u?.name || '' }));
    } catch { /* logging must not block saving */ }
    UI.toast('Settings saved');
    render$(el);
  });
}

export default {
  async render(el) { return render$(el); },
  destroy() {},
};
