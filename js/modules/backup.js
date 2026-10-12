// Backup & restore screen. Export downloads one JSON file. Import validates it and shows what it contains first.
import * as UI from '../core/ui.js';
import { esc, fmtDateTime, downloadFile } from '../core/utils.js';
import { pref } from '../core/settings.js';
import * as Auth from '../services/auth.js';
import * as Backup from '../services/backup.js';
import { CONFIG } from '../config.js';

const $ = window.jQuery;

async function exportNow() {
  const obj = await UI.withLoading(() => Backup.createBackup(), 'Preparing backup…');
  const stamp = new Date().toISOString().slice(0, 10);
  downloadFile(`isp-desk-backup-${stamp}.json`, JSON.stringify(obj, null, 2), 'application/json');
  pref.set('lastBackupAt', new Date().toISOString());
  return obj;
}

function summaryTable(counts) {
  const labels = { subscribers: 'Customers', invoices: 'Invoices', payments: 'Payments', expenses: 'Expenses', inventory: 'Inventory items', tickets: 'Complaints', plans: 'Plans' };
  return `<table class="table table-sm mb-0">${Object.entries(labels).map(([k, l]) => `<tr><td>${esc(l)}</td><td class="text-end fw-semibold">${counts[k] || 0}</td></tr>`).join('')}</table>`;
}

async function renderPage($c) {
  $c.off('.bk');
  const last = pref.get('lastBackupAt');
  const canExport = Auth.can('backup.export');
  $c.html(`
    ${UI.pageHeader('Backup & restore')}
    <div class="row g-3">
      <div class="col-lg-6"><div class="card-soft p-3 p-md-4 h-100 reveal">
        <div class="d-flex align-items-center gap-3 mb-2"><div class="icon-chip tint-green"><i class="bi bi-cloud-arrow-down"></i></div>
          <div><div class="fw-semibold">Download a backup</div><div class="small text-body-secondary">Keep it on Google Drive, a USB stick or email to yourself.</div></div></div>
        <div class="small mb-3">Last backup: <b>${last ? fmtDateTime(last) : 'never'}</b>. Back up at least weekly, and before any month-end run.</div>
        <button class="btn btn-primary" data-export ${canExport ? '' : 'disabled'}><i class="bi bi-download me-1"></i>Download backup</button>
      </div></div>
      <div class="col-lg-6"><div class="card-soft p-3 p-md-4 h-100 reveal">
        <div class="d-flex align-items-center gap-3 mb-2"><div class="icon-chip tint-amber"><i class="bi bi-cloud-arrow-up"></i></div>
          <div><div class="fw-semibold">Restore from a backup</div><div class="small text-body-secondary">Check the file before anything changes.</div></div></div>
        <input type="file" class="form-control" id="bk-file" accept="application/json,.json" ${canExport ? '' : 'disabled'}>
        <div id="bk-result" class="mt-3"></div>
      </div></div>
    </div>
    <div class="small text-body-secondary mt-3">Data is stored on this device only. A backup holds customers, invoices, payments and expenses. It contains no passwords and no login session. Settings such as your business name and payment numbers are included.</div>
    <div class="small text-body-secondary mt-1">App ${esc(CONFIG.APP_VERSION)} · backup format v${CONFIG.BACKUP_VERSION}</div>`);

  $c.on('click.bk', '[data-export]', async () => {
    try { await exportNow(); UI.toast('Backup downloaded'); renderPage($c); }
    catch (e) { UI.toastError(e); }
  });

  $c.on('change.bk', '#bk-file', async function () {
    const file = this.files?.[0];
    const $r = $c.find('#bk-result');
    if (!file) return $r.empty();
    $r.html(UI.spinner());
    let obj;
    try { obj = JSON.parse(await file.text()); } catch { $r.html('<div class="alert alert-danger small">This file is not valid JSON.</div>'); return; }
    const v = await Backup.validateBackup(obj);
    if (!v.ok) { $r.html(`<div class="alert alert-danger small"><b>This backup cannot be restored:</b><ul class="mb-0">${v.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`); return; }
    $r.html(`<div class="alert alert-success small mb-2"><i class="bi bi-shield-check me-1"></i>The file is valid. Made ${obj.createdAt ? fmtDateTime(obj.createdAt) : 'at an unknown time'}${obj.createdBy?.name ? ` by ${esc(obj.createdBy.name)}` : ''}.</div>
      ${v.warnings.length ? `<div class="alert alert-warning small">${v.warnings.map(esc).join('<br>')}</div>` : ''}
      <div class="card-soft p-2 mb-3">${summaryTable(v.counts)}</div>
      <div class="d-flex flex-wrap gap-2">
        <button class="btn btn-outline-primary btn-sm" data-restore="merge">Merge into this device</button>
        <button class="btn btn-outline-danger btn-sm" data-restore="replace">Replace all data</button>
      </div>
      <div class="small text-body-secondary mt-2"><b>Merge</b> adds missing records and updates newer ones. <b>Replace</b> erases this device's data first.</div>`);
    $r.data('backup', obj);
  });

  $c.on('click.bk', '[data-restore]', async function () {
    const mode = this.dataset.restore;
    const obj = $c.find('#bk-result').data('backup');
    if (!obj) return;
    if (mode === 'replace') {
      const typed = await UI.formModal({
        title: 'Replace all data', submitLabel: 'Replace everything', submitClass: 'btn-danger',
        body: `<p class="small">This erases the customers, invoices, payments, expenses and stock on this device, then loads the backup. Export a backup first if you are not sure.</p>
          <label class="form-label">Type REPLACE to confirm</label><input name="confirm" class="form-control" autocomplete="off">`,
        onSubmit: (v) => { if (v.confirm !== 'REPLACE') throw new Error('Type REPLACE exactly to confirm.'); return true; },
      });
      if (!typed) return;
    } else if (!await UI.confirmDialog('Merge this backup into the data on this device? Nothing is deleted.', { okLabel: 'Merge' })) return;
    try {
      await UI.withLoading(() => Backup.restoreBackup(obj, mode), 'Restoring…');
      UI.toast(mode === 'replace' ? 'Data replaced from backup' : 'Backup merged');
      setTimeout(() => location.reload(), 600);
    } catch (e) { UI.toastError(e); }
  });
}

export default {
  async render(el) { return renderPage($(el)); },
  destroy() {},
};
