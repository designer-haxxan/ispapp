// Reusable view fragments: money, status badges, month helpers, date filters and paging.
import { esc, fmtNum, today, monthStart, round2 } from './utils.js';
import { getSettings } from './settings.js';

export const cur = () => getSettings().currency;
export const money = (n) => `${esc(cur())} ${fmtNum(n)}`;

// Status pill. tone: success | warning | danger | secondary | info | primary
const TONES = {
  active: 'success', paid: 'success', resolved: 'success', done: 'success',
  pending: 'warning', partial: 'warning', in_progress: 'info', open: 'warning',
  overdue: 'danger', unpaid: 'danger', suspended: 'warning', disconnected: 'secondary', void: 'secondary',
};
const LABELS = {
  in_progress: 'In progress', unpaid: 'Unpaid', void: 'Void', pending: 'Pending', overdue: 'Overdue',
};
export function badge(status, label = null) {
  const tone = TONES[status] || 'secondary';
  const text = label || LABELS[status] || (status ? status.charAt(0).toUpperCase() + status.slice(1) : '');
  return `<span class="badge-soft tone-${tone}">${esc(text)}</span>`;
}

// "2026-10" -> "Oct 2026"
export function monthLabel(ym) {
  if (!ym) return '';
  const d = new Date(ym + '-01T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}
export const currentMonth = () => today().slice(0, 7);
export const addMonths = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
// Adds days to a YYYY-MM-DD string (local calendar arithmetic, no timezone drift).
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
export const monthOf = (dateStr) => String(dateStr || '').slice(0, 7);
export function monthRange(ym) {
  return [ym + '-01', addDays(addMonths(ym, 1) + '-01', -1)];
}
export const pct = (n) => `${round2(n).toFixed(1)}%`;

export function dateFilter(from, to, extra = '') {
  return `<form class="filters date-filter">
    <div><label class="form-label small mb-0">From</label><input type="date" name="from" class="form-control form-control-sm" value="${esc(from)}"></div>
    <div><label class="form-label small mb-0">To</label><input type="date" name="to" class="form-control form-control-sm" value="${esc(to)}"></div>
    ${extra}
    <div class="d-flex align-items-end gap-1" style="flex:0 0 auto">
      <div class="btn-group btn-group-sm">
        <button type="button" class="btn btn-outline-secondary" data-range="today">Today</button>
        <button type="button" class="btn btn-outline-secondary" data-range="month">Month</button>
        <button type="button" class="btn btn-outline-secondary" data-range="all">All</button>
      </div>
      <button class="btn btn-primary btn-sm">Apply</button>
    </div></form>`;
}
export function rangeFor(key) {
  if (key === 'today') return [today(), today()];
  if (key === 'month') return [monthStart(), today()];
  return ['2000-01-01', today()];
}
// Wires the quick-range buttons; calls cb(from, to, values) on apply.
export function bindDateFilter($root, cb) {
  $root.on('click', '.date-filter [data-range]', function () {
    const [f, t] = rangeFor(this.dataset.range);
    const $f = $(this).closest('form');
    $f.find('[name=from]').val(f); $f.find('[name=to]').val(t);
    $f.trigger('submit');
  });
  $root.on('submit', '.date-filter', function (e) {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(this).entries());
    cb(fd.from || '2000-01-01', fd.to || today(), fd);
  });
}

// Simple incremental "show more" list rendering (keeps the DOM small).
export function pager($container, items, rowFn, pageSize = 50, empty = '') {
  let shown = 0;
  const more = () => {
    const chunk = items.slice(shown, shown + pageSize);
    shown += chunk.length;
    $container.find('.pager-more').remove();
    $container.append(chunk.map(rowFn).join(''));
    if (shown < items.length) $container.append(`<button class="list-row pager-more justify-content-center text-primary">Show more (${items.length - shown} remaining)</button>`);
  };
  $container.empty();
  if (!items.length) { $container.html(empty); return; }
  $container.off('click.pager').on('click.pager', '.pager-more', more);
  more();
}

// Animated SVG ring (0–100). Used for collection rate and similar percentages.
export function ring(value, { size = 104, stroke = 10, label = '', tint = 'var(--brand)' } = {}) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const r = (size - stroke) / 2; const c = 2 * Math.PI * r;
  return `<div class="ring" style="width:${size}px;height:${size}px" role="img" aria-label="${esc(label)} ${v.toFixed(0)} percent">
    <svg viewBox="0 0 ${size} ${size}"><circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"/>
    <circle class="ring-fill" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}" stroke="${tint}"
      stroke-dasharray="${c}" style="--ring-from:${c};--ring-to:${c * (1 - v / 100)}"/></svg>
    <div class="ring-val"><b data-count="${v.toFixed(1)}" data-pct="1">0%</b><span>${esc(label)}</span></div></div>`;
}
