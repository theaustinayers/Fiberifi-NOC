// A small dependency-free line chart. Both series share one axis, and hovering shows the exact values.
import { h } from './lib.js';

const NS = 'http://www.w3.org/2000/svg';
const WIDTH = 900;
const HEIGHT = 240;
const PAD = { top: 12, right: 12, bottom: 24, left: 86 };

function svg(tag, attrs, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  el.append(...children);
  return el;
}

function niceMax(value) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((n) => n * power >= value);
  return step * power;
}

function timeLabel(ts, span) {
  const date = new Date(ts * 1000);
  if (span > 172800) return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  // Over a few minutes the labels would all round to the same minute.
  if (span <= 900) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// series: [{ key, label, className }]. rows: [{ ts, [key]: number }]
export function lineChart({ rows, series, format, max, label }) {
  const holder = h('div', { class: 'chart' });
  if (rows.length < 2) {
    holder.append(h('div', { class: 'empty' }, 'Not enough data yet. Graphs fill in as the router is polled.'));
    return holder;
  }

  const top = max ?? niceMax(Math.max(...rows.flatMap((row) => series.map((s) => row[s.key] ?? 0))));
  const t0 = rows[0].ts;
  const t1 = rows.at(-1).ts;
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const x = (ts) => PAD.left + ((ts - t0) / (t1 - t0 || 1)) * innerW;
  const y = (value) => PAD.top + innerH - (Math.min(value, top) / top) * innerH;

  const chart = svg('svg', { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, role: 'img', 'aria-label': label });

  for (let i = 0; i <= 4; i += 1) {
    const value = (top / 4) * i;
    chart.append(
      svg('line', { x1: PAD.left, x2: WIDTH - PAD.right, y1: y(value), y2: y(value), class: 'grid' }),
      svg('text', { x: PAD.left - 8, y: y(value) + 4, 'text-anchor': 'end', class: 'tick' }, format(value)),
    );
  }
  for (let i = 0; i <= 4; i += 1) {
    const ts = t0 + ((t1 - t0) / 4) * i;
    const anchor = i === 0 ? 'start' : i === 4 ? 'end' : 'middle';
    chart.append(svg('text', { x: x(ts), y: HEIGHT - 6, 'text-anchor': anchor, class: 'tick' }, timeLabel(ts, t1 - t0)));
  }

  for (const s of series) {
    // A missing sample breaks the line instead of drawing a slope across the gap.
    let path = '';
    let pen = false;
    for (const row of rows) {
      const value = row[s.key];
      if (value === null || value === undefined) {
        pen = false;
        continue;
      }
      path += `${pen ? 'L' : 'M'}${x(row.ts).toFixed(1)} ${y(value).toFixed(1)}`;
      pen = true;
    }
    chart.append(svg('path', { d: path, class: `line ${s.className}` }));
  }

  const cross = svg('line', { y1: PAD.top, y2: PAD.top + innerH, class: 'cross', visibility: 'hidden' });
  chart.append(cross);

  const tip = h('div', { class: 'chart-tip', hidden: true });
  const show = (event) => {
    const box = chart.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * WIDTH;
    const ts = t0 + ((px - PAD.left) / innerW) * (t1 - t0);
    const row = rows.reduce((best, r) => (Math.abs(r.ts - ts) < Math.abs(best.ts - ts) ? r : best), rows[0]);
    cross.setAttribute('x1', x(row.ts));
    cross.setAttribute('x2', x(row.ts));
    cross.setAttribute('visibility', 'visible');
    tip.replaceChildren(
      h('b', null, new Date(row.ts * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: t1 - t0 <= 900 ? 'medium' : 'short' })),
      ...series.map((s) => h('div', null, h('i', { class: `swatch ${s.className}` }), `${s.label}: ${row[s.key] === null || row[s.key] === undefined ? '—' : format(row[s.key])}`)),
    );
    tip.hidden = false;
    const left = (x(row.ts) / WIDTH) * box.width;
    tip.style.left = `${Math.min(left + 12, box.width - 190)}px`;
  };
  chart.addEventListener('pointermove', show);
  chart.addEventListener('pointerleave', () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
  });

  const latest = rows.at(-1);
  holder.append(
    h(
      'div',
      { class: 'legend' },
      series.map((s) => h('span', null, h('i', { class: `swatch ${s.className}` }), `${s.label} `, h('b', null, latest[s.key] === null || latest[s.key] === undefined ? '—' : format(latest[s.key])))),
    ),
    chart,
    tip,
  );
  return holder;
}
