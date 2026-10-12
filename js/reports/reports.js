// Profit & loss: a month in detail, a 12-month profit line, and a CSV export for the accountant.
import * as UI from '../core/ui.js';
import { esc, fmtNum, round2, downloadFile, toCSV } from '../core/utils.js';
import { cur, ring, monthLabel, currentMonth, addMonths, pct } from '../core/views.js';
import { pref } from '../core/settings.js';
import { loadFinance, monthSummary, trend, niceMax, compact } from '../services/finance.js';

const $ = window.jQuery;

// 12-month profit line with an area fill. The line draws itself in when it appears.
function drawProfit(box, months) {
  const W = Math.max(300, box.clientWidth); const H = 230;
  const m = { t: 24, r: 12, b: 28, l: 52 };
  const iw = W - m.l - m.r; const ih = H - m.t - m.b;
  const vals = months.map((x) => x.profit);
  const hi = Math.max(0, ...vals); const lo = Math.min(0, ...vals);
  const top = niceMax(Math.max(hi, Math.abs(lo) || 1));
  const bottom = lo < 0 ? -top : 0;
  const y = (v) => m.t + ih - ((v - bottom) / (top - bottom || 1)) * ih;
  const x = (i) => m.l + (iw / Math.max(1, months.length - 1)) * i;
  const pts = months.map((mo, i) => [x(i), y(mo.profit)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${x(months.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Net profit or loss for the last twelve months"><defs>
    <linearGradient id="pl-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22c55e" stop-opacity=".35"/><stop offset="1" stop-color="#22c55e" stop-opacity="0"/></linearGradient></defs><g class="grid">`;
  for (const t of [top, (top + bottom) / 2, bottom]) svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>`;
  svg += `<line class="zero" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/></g><g class="axis">`;
  for (const t of [top, bottom]) svg += `<text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`;
  months.forEach((mo, i) => { svg += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" ${i === months.length - 1 ? 'font-weight="700"' : ''}>${esc(monthLabel(mo.ym).split(' ')[0])}</text>`; });
  svg += `</g><path class="pl-area" d="${area}" fill="url(#pl-grad)"/>
    <path class="pl-line" d="${line}" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" pathLength="1"/>`;
  pts.forEach(([px, py], i) => {
    const neg = months[i].profit < 0;
    svg += `<circle class="pl-dot ${neg ? 'neg' : ''}" cx="${px}" cy="${py}" r="4" style="animation-delay:${(i * 0.08 + 0.4).toFixed(2)}s"/>`;
    svg += `<rect class="bar-hit" data-i="${i}" x="${px - iw / months.length / 2}" y="${m.t}" width="${iw / months.length}" height="${ih}"/>`;
  });
  svg += '</svg><div class="viz-tip"></div>';
  box.innerHTML = svg;
  const tip = box.querySelector('.viz-tip');
  box.querySelectorAll('.bar-hit').forEach((el) => {
    const show = () => {
      const mo = months[+el.dataset.i];
      tip.innerHTML = `<b>${esc(monthLabel(mo.ym))}</b><br>Billed ${esc(cur())} ${fmtNum(mo.billed)}<br>Expenses ${esc(cur())} ${fmtNum(mo.expenses)}<br><span class="${mo.profit >= 0 ? 'text-success' : 'text-danger'}">${mo.profit >= 0 ? 'Profit' : 'Loss'} ${esc(cur())} ${fmtNum(Math.abs(mo.profit))}</span>`;
      tip.style.left = `${Math.min(W - 150, Math.max(60, +el.getAttribute('x') + iw / months.length / 2))}px`;
      tip.style.top = `${Math.max(14, y(mo.profit))}px`;
      tip.classList.add('show');
    };
    el.addEventListener('mouseenter', show); el.addEventListener('click', show);
    el.addEventListener('mouseleave', () => tip.classList.remove('show'));
  });
}

const row = (label, value, cls = '', sub = '') => `<div class="pl-row ${cls}"><div><div>${esc(label)}</div>${sub ? `<div class="small text-body-secondary">${esc(sub)}</div>` : ''}</div>
  <div class="fw-semibold num">${value}</div></div>`;

async function render$(el, ctx) {
  const $c = $(el);
  $c.off('.rep');
  const ym = ctx.ym || pref.get('reportMonth', currentMonth());
  pref.set('reportMonth', ym);
  const fin = await loadFinance();
  const m = monthSummary(fin, ym);
  const months = trend(fin, ym, 12);
  const outstanding = round2(fin.invoices.filter((i) => i.status !== 'void').reduce((s, i) => s + Math.max(0, i.total - i.paid), 0));
  const verdict = m.profit >= 0 ? 'Profit' : 'Loss';
  const money = (n) => `${esc(cur())} ${fmtNum(n)}`;

  $c.html(`
    ${UI.pageHeader('Profit & loss', '<button class="btn btn-outline-secondary btn-sm" data-csv><i class="bi bi-filetype-csv me-1"></i>Export CSV</button>')}
    <div class="filters mb-3">
      <div><label class="form-label small mb-0">Month</label><input type="month" class="form-control form-control-sm" id="rep-month" value="${esc(ym)}"></div>
      <div class="d-flex align-items-end gap-1"><button class="btn btn-sm btn-outline-secondary" data-step="-1">&larr;</button><button class="btn btn-sm btn-outline-secondary" data-step="1">&rarr;</button></div>
    </div>

    <div class="pl-hero reveal ${m.profit < 0 ? 'is-loss' : ''}">
      <div class="d-flex justify-content-between align-items-start gap-3 flex-wrap">
        <div><div class="small opacity-75">${monthLabel(ym)} · ${verdict}</div>
          <div class="pl-big" data-count="${Math.abs(m.profit)}" data-money="1">0</div>
          <div class="small opacity-75">Billed minus expenses (accrual view)</div></div>
        ${ring(m.collectionRate, { size: 96, stroke: 9, label: 'collected', tint: '#ffffff' })}
      </div>
    </div>

    <div class="row g-3 mt-1">
      <div class="col-lg-6"><div class="card-soft p-3 reveal">
        <div class="fw-semibold mb-1">Income</div>
        ${row('Monthly plan bills', money(m.plan), '', `${m.invoiceCount} invoices issued`)}
        ${row('Other charges (installation, repairs…)', money(m.charges))}
        ${row('Total billed', money(m.billed), 'pl-total')}
        ${row('Collected in cash / wallets', money(m.collected), 'text-success', `${m.paymentCount} payments dated this month`)}
        ${row('Still to collect (all invoices)', money(outstanding), 'text-danger')}
      </div></div>
      <div class="col-lg-6"><div class="card-soft p-3 reveal">
        <div class="fw-semibold mb-1">Expenses</div>
        ${m.byCategory.length ? m.byCategory.map(([c, v]) => row(c, money(v))).join('') : '<div class="small text-body-secondary py-2">No expenses this month</div>'}
        ${row('Total expenses', money(m.expenses), 'pl-total')}
        ${row(m.profit >= 0 ? 'Net profit' : 'Net loss', money(Math.abs(m.profit)), m.profit >= 0 ? 'text-success' : 'text-danger')}
        ${row('Cash flow (collected − expenses)', money(m.cashFlow), m.cashFlow >= 0 ? 'text-success' : 'text-danger')}
      </div></div>
    </div>

    <div class="viz-card mt-3 reveal">
      <div class="viz-head"><div><div class="ttl">Net profit, last 12 months</div><div class="sub">Green is profit, the line dips below zero for loss months</div></div></div>
      <div class="viz" id="pl-chart"></div>
    </div>

    <div class="section-title mt-3"><h2>Month by month</h2></div>
    <div class="table-responsive card-soft p-2"><table class="table table-sm table-report align-middle mb-0">
      <thead><tr><th>Month</th><th class="num">Billed</th><th class="num">Collected</th><th class="num">Expenses</th><th class="num">Profit / loss</th></tr></thead>
      <tbody>${months.slice().reverse().map((x) => `<tr class="${x.ym === ym ? 'table-active' : ''}"><td><a href="#" data-goto="${x.ym}">${esc(monthLabel(x.ym))}</a></td>
        <td class="num">${fmtNum(x.billed)}</td><td class="num">${fmtNum(x.collected)}</td><td class="num">${fmtNum(x.expenses)}</td>
        <td class="num fw-semibold ${x.profit < 0 ? 'text-danger' : 'text-success'}">${x.profit < 0 ? '−' : ''}${fmtNum(Math.abs(x.profit))}</td></tr>`).join('')}</tbody></table></div>
    <div class="small text-body-secondary mt-3">Billed counts invoices issued in the month. Collected counts payments received in the month. Use the accountant's figures for tax filing.</div>`);

  // Counters: money for the headline, percentage for the collection ring.
  UI.countUp($c[0], (n, el) => (el.dataset.pct ? pct(n) : `${m.profit < 0 && !el.dataset.pct ? '−' : ''}${cur()} ${fmtNum(n)}`));
  drawProfit($c.find('#pl-chart')[0], months);

  const go = (v) => { pref.set('reportMonth', v); render$(el, { ...ctx, ym: v }); };
  $c.on('change.rep', '#rep-month', (e) => { if (e.target.value) go(e.target.value); });
  $c.on('click.rep', '[data-step]', function () { go(addMonths(ym, +this.dataset.step)); });
  $c.on('click.rep', '[data-goto]', function (e) { e.preventDefault(); go(this.dataset.goto); });
  $c.on('click.rep', '[data-csv]', () => {
    const rows = [['Month', 'Billed', 'Plan bills', 'Other charges', 'Collected', 'Expenses', 'Profit / loss', 'Cash flow', 'Collection rate %']];
    for (const x of trend(fin, ym, 12)) rows.push([x.ym, x.billed, x.plan, x.charges, x.collected, x.expenses, x.profit, x.cashFlow, x.collectionRate]);
    rows.push([]); rows.push(['Expenses by category, ' + ym]);
    for (const [c, v] of m.byCategory) rows.push([c, v]);
    downloadFile(`profit-loss-${ym}.csv`, '﻿' + toCSV(rows), 'text/csv;charset=utf-8');
  });
}

export default {
  async render(el, ctx) { return render$(el, ctx); },
  destroy() {},
};
