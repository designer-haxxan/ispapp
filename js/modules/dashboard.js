// Dashboard: this month at a glance, the last six months as a chart, and the customers who need a call today.
import * as UI from '../core/ui.js';
import { esc, fmtNum, today, round2 } from '../core/utils.js';
import { cur, ring, monthLabel, currentMonth } from '../core/views.js';
import { pref } from '../core/settings.js';
import * as Auth from '../services/auth.js';
import { loadFinance, monthSummary, trend, niceMax, compact } from '../services/finance.js';
import { loadBalances } from '../services/billing.js';
import * as WA from '../services/whatsapp.js';
import * as idb from '../db/idb.js';

const $ = window.jQuery;

// Grouped bars: billed (indigo) and expenses (rose) per month, with a hover tooltip. Drawn at real width.
function drawTrend(box, months) {
  const W = Math.max(300, box.clientWidth); const H = 220;
  const m = { t: 22, r: 8, b: 28, l: 44 };
  const iw = W - m.l - m.r; const ih = H - m.t - m.b;
  const max = niceMax(Math.max(1, ...months.map((x) => Math.max(x.billed, x.expenses))));
  const band = iw / months.length; const bw = Math.min(18, band * 0.3);
  const y = (v) => m.t + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  const barPath = (x, top, w, h) => {
    if (h <= 0) return '';
    const r = Math.min(4, h, w / 2);
    return `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${top + h} Z`;
  };
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Billed and expenses for the last six months"><g class="grid">`;
  for (const t of ticks) svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>`;
  svg += '</g><g class="axis">';
  for (const t of ticks) svg += `<text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`;
  months.forEach((x, i) => {
    const cx = m.l + band * i + band / 2;
    svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle" ${i === months.length - 1 ? 'font-weight="700"' : ''}>${esc(monthLabel(x.ym).split(' ')[0])}</text>`;
  });
  svg += '</g>';
  months.forEach((x, i) => {
    const left = m.l + band * i + band / 2 - bw - 2;
    const right = m.l + band * i + band / 2 + 2;
    const hb = m.t + ih - y(x.billed); const he = m.t + ih - y(x.expenses);
    svg += `<path class="bar" d="${barPath(left, y(x.billed), bw, hb)}" style="animation-delay:${i * 0.06}s"/>`;
    svg += `<path class="bar bar-exp" d="${barPath(right, y(x.expenses), bw, he)}" style="animation-delay:${i * 0.06 + 0.12}s"/>`;
    svg += `<rect class="bar-hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}"/>`;
  });
  svg += '</svg><div class="viz-tip"></div>';
  box.innerHTML = svg;
  const tip = box.querySelector('.viz-tip');
  const show = (el) => {
    const x = months[+el.dataset.i];
    tip.innerHTML = `<b>${esc(monthLabel(x.ym))}</b><br>Billed ${esc(cur())} ${fmtNum(x.billed)}<br>Expenses ${esc(cur())} ${fmtNum(x.expenses)}<br><span class="${x.profit >= 0 ? 'text-success' : 'text-danger'}">${x.profit >= 0 ? 'Profit' : 'Loss'} ${esc(cur())} ${fmtNum(Math.abs(x.profit))}</span>`;
    tip.style.left = `${+el.getAttribute('x') + band / 2}px`;
    tip.style.top = `${Math.max(14, y(Math.max(x.billed, x.expenses)))}px`;
    tip.classList.add('show');
  };
  box.querySelectorAll('.bar-hit').forEach((el) => {
    el.addEventListener('mouseenter', () => show(el));
    el.addEventListener('click', () => show(el));
    el.addEventListener('mouseleave', () => tip.classList.remove('show'));
  });
}

// Network map: the POP on the left and one node per customer on a fibre line. Colour is the real status:
// green = paid up, red = overdue, amber = suspended. Packets run along the lines of the first customers.
function networkMap(subs, bal) {
  const nodes = subs.filter((s) => s.status === 'active' || s.status === 'suspended')
    .map((s) => ({ s, cls: s.status === 'suspended' ? 'susp' : (bal.get(s.id)?.overdue > 0 ? 'late' : 'ok') }))
    .sort((a, b) => a.cls.localeCompare(b.cls));
  const W = 640; const H = 230; const px = 56; const py = H / 2;
  const shown = nodes.slice(0, 48);
  const cols = Math.max(1, Math.ceil(shown.length / 4));
  let body = ''; let packets = '';
  shown.forEach((n, i) => {
    const col = Math.floor(i / 4); const row = i % 4;
    const x = cols > 1 ? 170 + col * (W - 210) / (cols - 1) : 330;
    const y = 30 + row * ((H - 60) / 3);
    const d = `M${px} ${py} Q${(px + x) / 2} ${py} ${x} ${y}`;
    body += `<path class="fibre" d="${d}" style="animation-delay:${(i * -0.2).toFixed(2)}s"/>`;
    if (i < 12) packets += `<circle class="packet" r="2.6"><animateMotion dur="${(2.2 + (i % 3) * 0.4).toFixed(1)}s" begin="${(i * 0.25).toFixed(2)}s" repeatCount="indefinite" path="${d}"/></circle>`;
    body += `<circle class="node ${n.cls}" cx="${x}" cy="${y}" r="6" style="animation-delay:${(i * 0.03).toFixed(2)}s"><title>${esc(n.s.name)} · ${esc(n.s.area || '')}</title></circle>`;
  });
  const counts = { ok: 0, late: 0, susp: 0 };
  for (const n of nodes) counts[n.cls]++;
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="netmap" role="img" aria-label="Customer network map: ${counts.ok} paid up, ${counts.late} overdue, ${counts.susp} suspended">
    <circle class="pop-ring" cx="${px}" cy="${py}" r="26"/>
    <circle class="pop-core" cx="${px}" cy="${py}" r="11"/>
    <text x="${px}" y="${py + 40}" text-anchor="middle">POP</text>
    ${body}${packets}</svg>`;
  return `<div class="viz-card mt-3 reveal netmap-card">
    <div class="viz-head"><div><div class="ttl">Network map</div><div class="sub">Each dot is a live customer · ${nodes.length} connections</div></div>
      <div class="netmap-legend small"><span><i class="lg ok"></i>Paid ${counts.ok}</span><span><i class="lg late"></i>Overdue ${counts.late}</span><span><i class="lg susp"></i>Suspended ${counts.susp}</span></div></div>
    ${nodes.length ? svg : UI.emptyState('Add customers to see them on the network map', 'diagram-3')}
    ${nodes.length > shown.length ? `<div class="small text-body-secondary mt-1">Showing ${shown.length} of ${nodes.length} customers</div>` : ''}
  </div>`;
}

export default {
  async render(el) {
    this.destroy();
    const $el = $(el);
    const u = Auth.user();
    const ym = currentMonth();
    const [fin, bal, ops] = await Promise.all([
      loadFinance(), loadBalances(),
      idb.read(['inventory', 'tickets'], async (t) => ({ items: await t.getAll('inventory'), tickets: await t.getAll('tickets') })),
    ]);
    const cm = monthSummary(fin, ym);
    const months = trend(fin, ym, 6);
    const active = fin.subscribers.filter((s) => s.status === 'active');
    const suspended = fin.subscribers.filter((s) => s.status === 'suspended').length;
    const planById = new Map(fin.plans.map((p) => [p.id, p]));
    const subById = new Map(fin.subscribers.map((s) => [s.id, s]));
    const outstanding = round2([...bal.values()].reduce((s, b) => s + b.outstanding, 0));
    const overdueList = [...bal.entries()].filter(([id, b]) => b.overdue > 0 && subById.has(id))
      .map(([id, b]) => ({ sub: subById.get(id), b })).sort((a, c) => c.b.overdue - a.b.overdue);
    const overdueTotal = round2(overdueList.reduce((s, x) => s + x.b.overdue, 0));
    const openTickets = ops.tickets.filter((t) => t.status !== 'resolved');
    const lowStock = ops.items.filter((i) => i.active !== false && i.qty <= (i.minQty || 0));
    const dueToday = fin.invoices.filter((i) => i.status !== 'void' && i.paid < i.total && i.dueDate === today()).length;
    const lastBackup = pref.get('lastBackupAt');
    const backupDays = lastBackup ? Math.floor((Date.now() - new Date(lastBackup)) / 86400000) : null;
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const sign = cm.profit >= 0 ? 'Profit' : 'Loss';

    const kpi = (icon, tint, label, value, sub = '', href = '') => `<div class="col-6 col-lg-3"><${href ? `a href="${href}"` : 'div'} class="stat-card card-body d-block text-decoration-none p-3 h-100 reveal">
      <div class="kpi"><div class="icon-chip tint-${tint}"><i class="bi bi-${icon}"></i></div><div class="min-w-0"><div class="l">${label}</div>
      <div class="v">${value}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div></div></${href ? 'a' : 'div'}></div>`;
    const tile = (href, icon, tint, title, sub) => `<div class="col-6 col-md-4 col-xl-3">
      <a class="hub-tile" href="${href}"><div class="icon-chip tint-${tint}"><i class="bi bi-${icon}"></i></div>
      <div class="min-w-0"><div class="t">${title}</div><div class="s">${sub}</div></div></a></div>`;

    const reminderRow = ({ sub, b }) => {
      const plan = planById.get(sub.planId);
      const phone = WA.normalizePhone(sub.phone);
      const text = WA.fillTemplate('overdue', WA.customerVars(sub, plan, { ...b, balance: b.balance, oldestDue: b.oldestDue }));
      const link = phone ? WA.waLink(phone, text) : '';
      return `<div class="list-row">
        <div class="avatar tint-${UI.tintFor(sub.name)}">${esc(UI.initials(sub.name))}</div>
        <div class="main min-w-0"><div class="title text-truncate">${esc(sub.name)}</div>
          <div class="sub">${esc(sub.number)} · overdue ${cur()} ${fmtNum(b.overdue)}</div></div>
        <div class="end d-flex gap-1">
          ${link ? `<a class="btn btn-sm btn-success" href="${esc(link)}" target="_blank" rel="noopener" data-wa="${esc(sub.id)}" data-tpl="overdue" aria-label="WhatsApp ${esc(sub.name)}"><i class="bi bi-whatsapp"></i></a>` : ''}
          <a class="btn btn-sm btn-light" href="#/subscribers/${encodeURIComponent(sub.id)}" aria-label="Open customer"><i class="bi bi-chevron-right"></i></a>
        </div></div>`;
    };

    $el.html(`
      <div class="hero-card reveal">
        <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
          <div><div class="hello">${greet}, ${esc(u.name.split(' ')[0])}</div>
          <div class="date">${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div></div>
          <span class="pill"><i class="bi bi-${navigator.onLine ? 'cloud-check' : 'wifi-off'}"></i>${navigator.onLine ? 'Online' : 'Offline'}</span>
        </div>
        <div class="hero-grid">
          <div>
            <div class="lbl">${monthLabel(ym)} · billed</div>
            <div class="big money" data-count="${cm.billed}" data-money="1">0</div>
            <div class="d-flex flex-wrap gap-2 mt-2">
              <span class="pill"><i class="bi bi-wallet2"></i>Collected ${esc(cur())} ${fmtNum(cm.collected)}</span>
              <span class="pill ${sign === 'Loss' ? 'pill-bad' : ''}"><i class="bi bi-graph-${cm.profit >= 0 ? 'up' : 'down'}-arrow"></i>${sign} ${esc(cur())} ${fmtNum(Math.abs(cm.profit))}</span>
            </div>
          </div>
          <div class="hero-ring">${ring(cm.collectionRate, { size: 112, stroke: 11, label: 'collected', tint: '#67e8f9' })}</div>
        </div>
        <div class="d-flex flex-wrap gap-2 mt-3">
          ${Auth.can('billing.manage') ? '<a class="btn hero-cta" href="#/invoices/run"><i class="bi bi-lightning-charge me-1"></i>Run monthly billing</a>' : ''}
          ${Auth.can('payment.record') ? '<a class="btn hero-cta" href="#/collect"><i class="bi bi-cash-coin me-1"></i>Collect payment</a>' : ''}
        </div>
      </div>

      <div class="row g-3 mt-1 stagger">
        ${kpi('people', 'indigo', 'Active customers', String(active.length), `${suspended} suspended`, '#/subscribers')}
        ${kpi('exclamation-circle', 'red', 'Overdue customers', String(overdueList.length), `${esc(cur())} ${fmtNum(overdueTotal)} overdue`, '#/invoices')}
        ${kpi('hourglass-split', 'amber', 'Still to collect', `${esc(cur())} ${fmtNum(outstanding)}`, `${dueToday} due today`, '#/invoices')}
        ${kpi('wallet2', 'green', 'Expenses this month', `${esc(cur())} ${fmtNum(cm.expenses)}`, `${cm.byCategory.length} categories`, '#/expenses')}
      </div>

      ${networkMap(fin.subscribers, bal)}

      <div class="viz-card mt-3 reveal">
        <div class="viz-head"><div><div class="ttl">Billed vs expenses</div><div class="sub">Last six months</div></div>
          <a class="small" href="#/reports">Profit &amp; loss <i class="bi bi-arrow-right"></i></a></div>
        <div class="viz" id="trend-chart"></div>
      </div>

      <div class="row g-3 mt-1">
        <div class="col-lg-7">
          <div class="section-title"><h2>Needs a call today</h2><a href="#/subscribers">All customers</a></div>
          <div class="list-card">${overdueList.length ? overdueList.slice(0, 6).map(reminderRow).join('') : UI.emptyState('No overdue customers. Nice work.', 'check2-circle')}</div>
          ${overdueList.length > 6 ? `<div class="small text-center text-body-secondary mt-2">+${overdueList.length - 6} more in <a href="#/invoices">Invoices</a></div>` : ''}
        </div>
        <div class="col-lg-5">
          <div class="section-title"><h2>Quick actions</h2></div>
          <div class="row g-2">
            ${Auth.can('subscriber.manage') ? tile('#/subscribers/new', 'person-plus', 'green', 'Add customer', 'Connection & plan') : ''}
            ${Auth.can('payment.record') ? tile('#/collect', 'cash-coin', 'amber', 'Collect', 'Cash, JazzCash, Easypaisa') : ''}
            ${tile('#/tickets', 'tools', 'red', 'Complaints', `${openTickets.length} open`)}
            ${tile('#/inventory', 'boxes', 'indigo', 'Inventory', lowStock.length ? `${lowStock.length} low stock` : 'Stock OK')}
            ${Auth.can('whatsapp.send') ? tile('#/messages', 'whatsapp', 'green', 'WhatsApp', 'Reminders & outage notice') : ''}
            ${Auth.can('reports.view') ? tile('#/reports', 'graph-up-arrow', 'violet', 'Profit & loss', 'Month by month') : ''}
          </div>
          ${backupDays === null || backupDays >= 7 ? `<div class="alert alert-warning small mt-3 mb-0 d-flex gap-2 align-items-start"><i class="bi bi-cloud-arrow-down fs-5"></i><div>${backupDays === null ? 'You have never made a backup of this desk.' : `Last backup was ${backupDays} days ago.`} <a href="#/backup">Back up now</a></div></div>` : ''}
          ${lowStock.length ? `<div class="alert alert-danger small mt-2 mb-0"><i class="bi bi-exclamation-triangle me-1"></i>Low stock: ${lowStock.slice(0, 3).map((i) => esc(i.name)).join(', ')}${lowStock.length > 3 ? '…' : ''}</div>` : ''}
        </div>
      </div>`);

    drawTrend($el.find('#trend-chart')[0], months);
    // Counters: money for the hero, percentage for the collection ring.
    UI.countUp($el[0], (n, el) => (el.dataset.pct ? `${Math.round(n)}%` : `${cur()} ${fmtNum(n)}`));
    $el.on('click.dash', '[data-wa]', async (e) => {
      const { wa, tpl } = e.currentTarget.dataset;
      const sub = subById.get(wa);
      if (sub) await WA.logMessage({ subscriberId: sub.id, phone: WA.normalizePhone(sub.phone), text: e.currentTarget.href, template: tpl }).catch(() => {});
    });
  },
  destroy() { $('#content').off('.dash'); },
};
