// Import customers from a CSV: download the template, upload a file, review every row, then import the ready ones.
import * as UI from '../core/ui.js';
import { esc, downloadFile } from '../core/utils.js';
import * as Auth from '../services/auth.js';
import * as CSV from '../services/csv.js';
import * as Import from '../services/importer.js';

const $ = window.jQuery;
const PREVIEW_ROWS = 150;

const tile = (label, value, tone) => `<div class="col-6 col-md-3"><div class="imp-tile tone-${tone}">
  <div class="small text-body-secondary">${esc(label)}</div><div class="imp-num" data-count="${value}">0</div></div></div>`;

// Groups similar problems ("Mobile "…" was saved by Excel…") so 43 identical problems show as one line.
function groupIssues(rows) {
  const groups = new Map();
  for (const r of rows) for (const i of r.issues) {
    if (i.level === 'info') continue;
    const key = `${i.level}|${i.text.replace(/"[^"]*"/g, '"…"')}`;
    const g = groups.get(key) || { level: i.level, text: i.text, count: 0 };
    g.count++;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => (a.level === 'error' ? -1 : 1) - (b.level === 'error' ? -1 : 1) || b.count - a.count);
}

function resultHtml(prep) {
  const { counts, newPlans, recognised, ignored, rows } = prep;
  const groups = groupIssues(rows);
  const shown = rows.slice(0, PREVIEW_ROWS);
  const statusBadge = { ready: '<span class="badge-soft tone-success">Ready</span>', skip: '<span class="badge-soft tone-secondary">Exists</span>', fix: '<span class="badge-soft tone-danger">Fix</span>' };
  return `
    <div class="row g-2 mb-3">
      ${tile('Ready to import', counts.ready, 'good')}
      ${tile('Already exist', counts.skip, 'muted')}
      ${tile('Need fixing', counts.fix, 'bad')}
      ${tile('New plans', newPlans.length, 'info')}
    </div>

    <div class="small mb-2"><b>Columns recognised:</b> ${recognised.map((r) => `<span class="col-chip ok">${esc(r.header)}</span>`).join(' ') || '—'}</div>
    ${ignored.length ? `<div class="small text-body-secondary mb-3"><b>Not used:</b> ${esc(ignored.join(', '))}</div>` : ''}

    ${newPlans.length ? `<div class="alert alert-info small"><b>${newPlans.length} package${newPlans.length === 1 ? '' : 's'} will be created as plans:</b> ${newPlans.map((p) => esc(p.name)).join(', ')}.
      They are created at price 0 so nothing is billed until you set the prices in <a href="#/plans">Plans &amp; pricing</a>.</div>` : ''}

    ${groups.length ? `<div class="card-soft p-3 mb-3"><div class="fw-semibold mb-2">Things to check</div>
      ${groups.slice(0, 10).map((g) => `<div class="imp-issue ${g.level}"><span class="imp-count">${g.count}</span> ${esc(g.text)}</div>`).join('')}
      ${groups.length > 10 ? `<div class="small text-body-secondary">+${groups.length - 10} more kinds of problem, see the problem report.</div>` : ''}</div>` : ''}

    <div class="table-responsive card-soft p-2 mb-3">
      <table class="table table-sm align-middle mb-0 imp-table">
        <thead><tr><th>Line</th><th>Name</th><th>Mobile</th><th>Package</th><th>Status</th></tr></thead>
        <tbody>${shown.map((r) => `<tr class="${r.result === 'fix' ? 'row-fix' : ''}">
          <td class="text-body-secondary">${r.line}</td>
          <td class="text-truncate" style="max-width:180px">${esc(r.name || '—')}</td>
          <td>${r.phone ? esc(r.phone) : '<span class="text-danger">—</span>'}</td>
          <td>${esc(r.pkg || '—')}</td>
          <td>${statusBadge[r.result]}${r.issues.some((i) => i.level === 'error') ? `<div class="small text-danger">${esc(r.issues.find((i) => i.level === 'error').text)}</div>` : ''}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
    ${rows.length > PREVIEW_ROWS ? `<div class="small text-body-secondary mb-3">Showing the first ${PREVIEW_ROWS} of ${rows.length} rows. The full list is in the problem report.</div>` : ''}

    <div class="d-flex flex-wrap gap-2 align-items-center">
      <button class="btn btn-success btn-lg" data-import ${counts.ready ? '' : 'disabled'}><i class="bi bi-cloud-check me-1"></i>Import ${counts.ready} customer${counts.ready === 1 ? '' : 's'}</button>
      ${counts.fix + counts.skip ? '<button class="btn btn-outline-secondary" data-report><i class="bi bi-filetype-csv me-1"></i>Download problem report</button>' : ''}
    </div>
    <div class="small text-body-secondary mt-2">Rows that need fixing are not imported. Correct them in your file and upload it again. Existing customers are never overwritten.</div>`;
}

function doneHtml(res) {
  return `<div class="imp-done reveal">
    <div class="success-check"><i class="bi bi-check2"></i></div>
    <div class="fw-bold fs-5 mt-2">Import complete</div>
    <div class="row g-2 mt-2 text-start">
      ${tile('Customers added', res.customers, 'good')}
      ${tile('Opening balances', res.invoices, 'info')}
      ${tile('Plans created', res.plansCreated, 'info')}
      ${tile('Need fixing', res.needsFix, 'bad')}
    </div>
    <div class="d-flex flex-wrap gap-2 justify-content-center mt-3">
      <a class="btn btn-primary" href="#/subscribers">View customers</a>
      <a class="btn btn-outline-primary" href="#/plans">Set plan prices</a>
    </div></div>`;
}

async function renderPage($c) {
  $c.off('.imp');
  let prep = null;
  $c.html(`
    ${UI.pageHeader('Import customers', '', '#/subscribers')}
    <div class="row g-3">
      <div class="col-lg-5"><div class="card-soft p-3 p-md-4 reveal">
        <div class="imp-step"><span class="step-no">1</span><span class="fw-semibold">Get the template</span></div>
        <p class="small text-body-secondary mt-2">One row per customer. You can also upload your billing system's customer export as it is: columns such as <i>Username</i>, <i>Full Name</i>, <i>Phone</i>, <i>NID</i>, <i>Package</i> and <i>Expiry</i> are recognised automatically.</p>
        <div class="d-flex flex-wrap gap-1 mb-3">${CSV.TEMPLATE_COLUMNS.map((c) => `<span class="col-chip">${esc(c)}</span>`).join('')}</div>
        <button class="btn btn-outline-primary" data-template><i class="bi bi-download me-1"></i>Download template (CSV)</button>
        <div class="imp-tip mt-3"><i class="bi bi-lightbulb"></i><span>In Excel, select the Mobile column and set Format → Text before typing numbers. Otherwise 03001234567 becomes 3.00123E+10 and the digits are lost.</span></div>
      </div></div>

      <div class="col-lg-7"><div class="card-soft p-3 p-md-4 reveal">
        <div class="imp-step"><span class="step-no">2</span><span class="fw-semibold">Upload the file</span></div>
        <p class="small text-body-secondary mt-2">CSV only. In Excel use <i>Save as → CSV UTF-8</i> so names in Urdu are kept. Nothing is saved until you confirm in step 3.</p>
        <input type="file" class="form-control" id="imp-file" accept=".csv,text/csv" ${Auth.can('subscriber.manage') ? '' : 'disabled'}>
        <div id="imp-result" class="mt-3"></div>
      </div></div>
    </div>`);

  $c.on('click.imp', '[data-template]', () => {
    downloadFile('isp-desk-customers-template.csv', '﻿' + CSV.templateCSV(), 'text/csv;charset=utf-8');
  });

  $c.on('change.imp', '#imp-file', async function () {
    const file = this.files?.[0];
    const $r = $c.find('#imp-result');
    prep = null;
    if (!file) return $r.empty();
    $r.html(UI.spinner('Checking file…'));
    try {
      prep = await Import.analyse(await file.text());
      $r.html(resultHtml(prep));
      UI.countUp($r[0], (n) => String(Math.round(n)));
    } catch (e) {
      $r.html(`<div class="alert alert-danger small"><i class="bi bi-exclamation-octagon me-1"></i>${esc(e.message || String(e))}</div>`);
    }
  });

  $c.on('click.imp', '[data-report]', () => {
    if (prep) downloadFile('import-problems.csv', '﻿' + Import.problemsCSV(prep), 'text/csv;charset=utf-8');
  });

  $c.on('click.imp', '[data-import]', async () => {
    if (!prep || !prep.counts.ready) return;
    const ok = await UI.confirmDialog(`Add ${prep.counts.ready} customers now? ${prep.counts.skip} existing customers will be skipped, and ${prep.counts.fix} rows that need fixing will not be imported.`, { okLabel: 'Import', okClass: 'btn-success' });
    if (!ok) return;
    try {
      const res = await UI.withLoading(() => Import.commit(prep), 'Importing customers…');
      prep = null;
      $c.find('#imp-result').html(doneHtml(res));
      UI.countUp($c.find('#imp-result')[0], (n) => String(Math.round(n)));
      UI.toast(`${res.customers} customers imported`);
    } catch (e) { UI.toastError(e); }
  });
}

export default {
  async render(el) { return renderPage($(el)); },
  destroy() {},
};
