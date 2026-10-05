/* =============================================================================
   charts.js — dependency-free SVG charts.
   -----------------------------------------------------------------------------
   Why hand-rolled instead of Chart.js: no CDN dependency (the CSP stays tight),
   every colour comes from CSS custom properties so themes just work, and each
   instance owns its listeners so `destroy()` genuinely releases everything.

   Every factory returns an instance with { update, destroy }.
   ========================================================================== */

import { esc, num, hashColor, attendanceColor, toneFor } from './format.js';

const NS = 'http://www.w3.org/2000/svg';

const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    node.setAttribute(k, String(v));
  }
  return node;
};

/** Reads a live CSS custom property — this is how charts stay theme-aware. */
function cssVar(name, fallback = '#888') {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

const PALETTE_VARS = [
  '--accent', '--secondary', '--tertiary', '--success',
  '--warning', '--danger', '--info', '--brand',
];

function palette(index) {
  return cssVar(PALETTE_VARS[index % PALETTE_VARS.length], '#ffffff');
}

function niceMax(value) {
  if (!Number.isFinite(value) || value <= 0) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

/* --------------------------------------------------------- tooltip layer -- */
let tipNode = null;

function tooltip() {
  if (!tipNode) {
    tipNode = document.createElement('div');
    tipNode.className = 'chart-tip';
    document.body.append(tipNode);
  }
  return tipNode;
}

function showTip(event, html) {
  const node = tooltip();
  node.innerHTML = html;
  node.style.left = `${event.clientX}px`;
  node.style.top = `${event.clientY}px`;
  node.classList.add('is-visible');
}

function hideTip() {
  tooltip().classList.remove('is-visible');
}

/**
 * Tracks every live chart so a theme switch can repaint them all and a route
 * change can tear them down.
 */
const registry = new Set();

document.addEventListener('hpu:theme', () => {
  registry.forEach((instance) => instance.update());
});

function register(instance) {
  registry.add(instance);
  return instance;
}

export function destroyAllCharts() {
  registry.forEach((instance) => instance.destroy());
  registry.clear();
}

function mount(host, markup, { height = 220 } = {}) {
  if (typeof host === 'string') host = document.querySelector(host);
  if (!host) return null;
  host.innerHTML = markup;
  const svg = host.querySelector('svg');
  if (svg) { svg.setAttribute('height', height); svg.style.height = `${height}px`; }
  return svg;
}

function emptyMarkup(message, height) {
  return `<div class="loader" style="min-height:${height}px;height:${height}px">
    <span class="empty__text">${esc(message)}</span></div>`;
}

/* =========================================================== LINE / AREA == */
/**
 * lineChart(host, { labels, series: [{name, values, color}], height, yMax, area })
 */
export function lineChart(host, config) {
  const cfg = {
    height: 230,
    yMin: 0,
    yMax: null,
    ySuffix: '',
    area: true,
    dots: true,
    padLeft: 38,
    padBottom: 26,
    padTop: 12,
    padRight: 12,
    formatValue: (v) => num(v),
    ...config,
  };

  let node = typeof host === 'string' ? document.querySelector(host) : host;
  if (!node) return register({ update() {}, destroy() {} });

  function draw() {
    const { labels = [], series = [] } = cfg;
    if (!labels.length || !series.length) {
      mount(node, emptyMarkup('No data for this range', cfg.height), { height: cfg.height });
      return;
    }

    const W = Math.max(node.clientWidth || 640, 280);
    const H = cfg.height;
    const innerW = W - cfg.padLeft - cfg.padRight;
    const innerH = H - cfg.padTop - cfg.padBottom;

    const allValues = series.flatMap((s) => s.values.map(Number).filter(Number.isFinite));
    const rawMax = Math.max(...allValues, 0);
    const yMax = cfg.yMax ?? niceMax(rawMax || 1);
    const yMin = cfg.yMin;
    const span = yMax - yMin || 1;

    const xAt = (i) => cfg.padLeft + (labels.length === 1
      ? innerW / 2
      : (i / (labels.length - 1)) * innerW);
    const yAt = (v) => cfg.padTop + innerH - ((Number(v) - yMin) / span) * innerH;

    const ticks = 4;
    const gridLines = Array.from({ length: ticks + 1 }, (_, i) => {
      const value = yMin + (span / ticks) * i;
      const y = yAt(value);
      return `
        <line x1="${cfg.padLeft}" y1="${y.toFixed(1)}" x2="${W - cfg.padRight}" y2="${y.toFixed(1)}"
              stroke="var(--line-faint)" stroke-width="1"/>
        <text x="${cfg.padLeft - 7}" y="${(y + 3.2).toFixed(1)}" text-anchor="end">
          ${esc(cfg.formatValue(value))}
        </text>`;
    }).join('');

    const labelEvery = Math.max(1, Math.ceil(labels.length / (W < 480 ? 4 : 8)));
    const xLabels = labels.map((label, i) => (i % labelEvery === 0 || i === labels.length - 1
      ? `<text x="${xAt(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(label)}</text>`
      : '')).join('');

    const paths = series.map((s, si) => {
      const color = s.color || palette(si);
      const points = s.values.map((v, i) => [xAt(i), yAt(v)]);
      const d = points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
      const fill = cfg.area && points.length > 1
        ? `<path d="${d} L${points[points.length - 1][0].toFixed(1)} ${(cfg.padTop + innerH).toFixed(1)}
             L${points[0][0].toFixed(1)} ${(cfg.padTop + innerH).toFixed(1)} Z"
             fill="url(#grad-${si}-${cfg.uid ?? 'a'})" opacity="0.9"/>`
        : '';
      const dots = cfg.dots
        ? points.map((p, i) => `
            <circle class="chart__dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${labels.length > 14 ? 2 : 3.4}"
                    fill="var(--bg-surface)" stroke="${color}" stroke-width="2"
                    data-label="${esc(labels[i])}" data-value="${esc(cfg.formatValue(s.values[i]))}"
                    data-name="${esc(s.name ?? '')}" data-color="${color}"/>`).join('')
        : '';
      return { fill, stroke: `<path class="chart__line" d="${d}" stroke="${color}"/>`, dots, color };
    }).join('');

    const defs = series.map((s, si) => `
      <linearGradient id="grad-${si}-${cfg.uid ?? 'a'}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${s.color || palette(si)}" stop-opacity="0.34"/>
        <stop offset="100%" stop-color="${s.color || palette(si)}" stop-opacity="0.02"/>
      </linearGradient>`).join('');

    const legend = series.length > 1 ? `
      <div class="chart-legend">
        ${series.map((s, i) => `
          <span class="chart-legend__item">
            <i class="chart-legend__swatch" style="background:${s.color || palette(i)}"></i>
            ${esc(s.name ?? `Series ${i + 1}`)}
          </span>`).join('')}
      </div>` : '';

    const svgMarkup = `
      <svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" height="${H}"
           preserveAspectRatio="none" role="img"
           aria-label="${esc(cfg.ariaLabel ?? 'Line chart')}">
        <defs>${defs}</defs>
        <g class="chart__grid">${gridLines}</g>
        <g class="chart__axis">${xLabels}</g>
        ${paths}
      </svg>${legend}`;

    mount(node, svgMarkup, { height: H });

    const svg = node.querySelector('svg');
    svg.querySelectorAll('.chart__dot').forEach((dot) => {
      dot.addEventListener('pointerenter', (event) => {
        dot.setAttribute('r', '5.5');
        showTip(event, `
          <div class="chart-tip__label">${esc(dot.dataset.label)}</div>
          <div class="chart-tip__row">
            <i class="chart-legend__swatch" style="background:${dot.dataset.color}"></i>
            <span>${esc(dot.dataset.name || 'Value')}</span>
            <span class="chart-tip__value">${esc(dot.dataset.value)}</span>
          </div>`);
      });
      dot.addEventListener('pointermove', (event) => showTip(event, tooltip().innerHTML));
      dot.addEventListener('pointerleave', () => {
        dot.setAttribute('r', labels.length > 14 ? '2' : '3.4');
        hideTip();
      });
    });
  }

  const onResize = (() => {
    let t;
    return () => {
      clearTimeout(t);
      t = setTimeout(draw, 130);
    };
  })();

  window.addEventListener('resize', onResize, { passive: true });
  const observer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(onResize) : null;
  if (observer && node.isConnected) observer.observe(node);

  draw();
  return register({
    update: draw,
    destroy() {
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
      hideTip();
      registry.delete(this);
      node.innerHTML = '';
    },
  });
}

/* ================================================================= BARS == */
/**
 * barChart(host, { labels, values, color, height, horizontal, formatValue, onClick })
 */
export function barChart(host, config) {
  const cfg = {
    height: 220,
    color: null,
    yMax: null,
    horizontal: false,
    formatValue: (v) => num(v),
    ...config,
  };

  let node = typeof host === 'string' ? document.querySelector(host) : host;
  if (!node) return register({ update() {}, destroy() {} });

  function draw() {
    const { labels = [], values = [] } = cfg;
    if (!labels.length) {
      mount(node, emptyMarkup('Nothing recorded yet', cfg.height), { height: cfg.height });
      return;
    }

    const W = Math.max(node.clientWidth || 640, 280);
    const H = cfg.height;
    const pad = { l: cfg.horizontal ? 92 : 34, r: 12, t: 12, b: cfg.horizontal ? 20 : 34 };
    const innerW = W - pad.l - pad.r;
    const innerH = H - pad.t - pad.b;
    const max = cfg.yMax ?? niceMax(Math.max(...values.map((v) => Number(v) || 0), 1));

    let marks = '';
    let bars = '';

    if (cfg.horizontal) {
      const step = innerH / labels.length;
      const height = Math.min(step * 0.62, 26);
      marks = labels.map((label, i) => `
        <text x="${pad.l - 9}" y="${(pad.t + step * i + step / 2 + 3).toFixed(1)}" text-anchor="end">
          ${esc(String(label).slice(0, 16))}
        </text>`).join('');
      bars = values.map((value, i) => {
        const w = Math.max((Number(value) / max) * innerW, value ? 3 : 0);
        const y = pad.t + step * i + (step - height) / 2;
        const color = cfg.color || hashColor(labels[i], null, 56);
        return `
          <rect class="chart__bar" x="${pad.l}" y="${y.toFixed(1)}"
                width="${w.toFixed(1)}" height="${height.toFixed(1)}" fill="${color}"
                style="animation-delay:${i * 42}ms;transform-origin:left center"
                data-label="${esc(labels[i])}" data-value="${esc(cfg.formatValue(value))}"
                data-color="${color}"/>`;
      }).join('');
    } else {
      const slot = innerW / labels.length;
      const width = Math.min(slot * 0.62, 46);
      const step = Math.max(1, Math.ceil(labels.length / (W < 480 ? 8 : 16)));
      marks = labels.map((label, i) => (i % step === 0 || i === labels.length - 1
        ? `<text x="${(pad.l + slot * i + slot / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle">
             ${esc(String(label).slice(0, 10))}</text>`
        : '')).join('');
      bars = values.map((value, i) => {
        const h = Math.max((Number(value) / max) * innerH, value ? 3 : 0);
        const x = pad.l + slot * i + (slot - width) / 2;
        const color = cfg.color || hashColor(labels[i], null, 56);
        return `
          <rect class="chart__bar" x="${x.toFixed(1)}" y="${(pad.t + innerH - h).toFixed(1)}"
                width="${width.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}"
                style="animation-delay:${i * 42}ms"
                data-label="${esc(labels[i])}" data-value="${esc(cfg.formatValue(value))}"
                data-color="${color}"/>`;
      }).join('');
    }

    const gridCount = 4;
    const grid = cfg.horizontal ? '' : Array.from({ length: gridCount + 1 }, (_, i) => {
      const y = pad.t + innerH - (innerH / gridCount) * i;
      return `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}"
                    stroke="var(--line-faint)"/>
              <text x="${pad.l - 7}" y="${(y + 3).toFixed(1)}" text-anchor="end">
                ${esc(cfg.formatValue((max / gridCount) * i))}</text>`;
    }).join('');

    mount(node, `
      <svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" height="${H}"
           role="img" aria-label="${esc(cfg.ariaLabel ?? 'Bar chart')}">
        <g class="chart__grid">${grid}</g>
        ${marks}
        ${bars}
      </svg>`, { height: H });

    node.querySelectorAll('.chart__bar').forEach((rect) => {
      rect.addEventListener('pointerenter', (event) => showTip(event, `
        <div class="chart-tip__label">${esc(rect.dataset.label)}</div>
        <div class="chart-tip__row">
          <i class="chart-legend__swatch" style="background:${rect.dataset.color}"></i>
          <span>${esc(cfg.valueLabel ?? 'Value')}</span>
          <span class="chart-tip__value">${esc(rect.dataset.value)}</span>
        </div>`));
      rect.addEventListener('pointermove', () => showTip(event, tooltip().innerHTML));
      rect.addEventListener('pointerleave', hideTip);
      if (cfg.onClick) {
        rect.style.cursor = 'pointer';
        rect.addEventListener('click', (event) => cfg.onClick(rect.dataset.label, event));
      }
    });
  }

  const onResize = (() => {
    let t;
    return () => { clearTimeout(t); t = setTimeout(draw, 130); };
  })();
  window.addEventListener('resize', onResize, { passive: true });

  draw();
  return register({
    update: draw,
    destroy() {
      window.removeEventListener('resize', onResize);
      hideTip();
      registry.delete(this);
      node.innerHTML = '';
    },
  });
}

/* ================================================================ DONUT == */
/**
 * donutChart(host, { data: [{label, value, color}], size, thickness, centreLabel, centreValue })
 */
export function donutChart(host, config) {
  const cfg = { size: 190, thickness: 20, ...config };

  let node = typeof host === 'string' ? document.querySelector(host) : host;
  if (!node) return register({ update() {}, destroy() {} });

  function draw() {
    const data = (cfg.data ?? []).filter((d) => Number(d.value) > 0);
    if (!data.length) {
      mount(node, emptyMarkup('No distribution data', cfg.size), { height: cfg.size });
      return;
    }

    const size = cfg.size;
    const radius = (size - cfg.thickness) / 2;
    const centre = size / 2;
    const circumference = 2 * Math.PI * radius;
    const total = data.reduce((sum, d) => sum + Number(d.value), 0);

    let offset = 0;
    const arcs = data.map((d, i) => {
      const fraction = Number(d.value) / total;
      const dash = fraction * circumference;
      const colour = d.color || palette(i);
      const arc = `
        <circle cx="${centre}" cy="${centre}" r="${radius}" fill="none"
                stroke="${colour}" stroke-width="${cfg.thickness}"
                stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}"
                stroke-dashoffset="${(-offset).toFixed(2)}"
                transform="rotate(-90 ${centre} ${centre})"
                stroke-linecap="butt"
                data-label="${esc(d.label)}" data-value="${esc(num(d.value))}"
                data-pct="${(fraction * 100).toFixed(1)}" data-color="${colour}"
                style="cursor:pointer;transition:stroke-width .18s ease"
              />`;
      offset += dash;
      return arc;
    }).join('');

    mount(node, `
      <div style="position:relative;display:grid;place-items:center;width:${size}px;height:${size}px;margin-inline:auto">
        <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img"
             aria-label="${esc(cfg.ariaLabel ?? 'Donut chart')}">
          <circle cx="${centre}" cy="${centre}" r="${radius}" fill="none"
                  stroke="var(--bg-inset)" stroke-width="${cfg.thickness}"/>
          ${arcs}
        </svg>
        <div class="ring__label">
          <div class="ring__figure">${esc(cfg.centreValue ?? num(total))}</div>
          <div class="ring__caption">${esc(cfg.centreLabel ?? 'TOTAL')}</div>
        </div>
      </div>
      <div class="chart-legend">
        ${data.map((d, i) => `
          <span class="chart-legend__item">
            <i class="chart-legend__swatch" style="background:${d.color || palette(i)}"></i>
            ${esc(d.label)}
            <strong class="mono">${esc(num(d.value))}</strong>
          </span>`).join('')}
      </div>`, { height: size + 40 });

    node.querySelectorAll('circle[data-label]').forEach((arc) => {
      arc.addEventListener('pointerenter', (event) => {
        arc.setAttribute('stroke-width', String(cfg.thickness + 5));
        showTip(event, `
          <div class="chart-tip__label">${esc(arc.dataset.label)}</div>
          <div class="chart-tip__row">
            <i class="chart-legend__swatch" style="background:${arc.dataset.color}"></i>
            <span>${esc(arc.dataset.pct)}%</span>
            <span class="chart-tip__value">${esc(arc.dataset.value)}</span>
          </div>`);
      });
      arc.addEventListener('pointermove', (event) => showTip(event, tooltip().innerHTML));
      arc.addEventListener('pointerleave', () => {
        arc.setAttribute('stroke-width', String(cfg.thickness));
        hideTip();
      });
    });
  }

  const onResize = (() => {
    let t;
    return () => { clearTimeout(t); t = setTimeout(draw, 130); };
  })();
  window.addEventListener('resize', onResize, { passive: true });

  draw();
  return register({
    update: draw,
    destroy() {
      window.removeEventListener('resize', onResize);
      hideTip();
      registry.delete(this);
      node.innerHTML = '';
    },
  });
}

/* ============================================================== SPARKLINE */
/** Tiny inline trend line — no axes, no tooltip, for stat tiles. */
export function sparkline(values, { width = 120, height = 34, color = null, fill = true } = {}) {
  const data = (values ?? []).map(Number).filter(Number.isFinite);
  if (data.length < 2) return '';

  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const stroke = color || cssVar('--accent');
  const stepX = width / (data.length - 1);

  const points = data.map((v, i) => [
    i * stepX,
    height - 3 - ((v - min) / span) * (height - 6),
  ]);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = fill
    ? `<path d="${d} L${width} ${height} L0 ${height} Z" fill="${stroke}" opacity="0.12"/>`
    : '';
  const last = points[points.length - 1];

  return `
    <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"
         aria-hidden="true" style="display:block;width:100%;height:auto;overflow:visible">
      ${area}
      <path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.9"
            stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.6" fill="${stroke}"/>
    </svg>`;
}

/* ============================================================ PROGRESS RING */
/**
 * Animated SVG ring. Renders the markup only; animate() kicks it off so the
 * caller can sequence it with the rest of the page.
 */
export function progressRing({ value, size = 128, thickness = 10, color = null,
  figure = null, caption = '', id = 'ring' } = {}) {
  const radius = (size - thickness) / 2;
  const centre = size / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.min(Math.max(Number(value) || 0, 0), 100);
  const offset = circumference * (1 - pct / 100);
  const stroke = color || cssVar('--accent');

  return `
    <div class="ring-card" data-ring-wrap data-value="${pct}"
         data-color="${esc(stroke)}" data-caption="${esc(caption)}"
         data-figure="${esc(figure ?? `${pct.toFixed(pct < 10 ? 1 : 0)}%`)}">
      <svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"
           role="img" aria-label="${esc(caption || 'Progress')}: ${pct.toFixed(1)} percent">
        <circle class="ring__track" cx="${centre}" cy="${centre}" r="${radius}"
                style="--ring-w:${thickness}px"/>
        <circle class="ring__value" id="${esc(id)}" cx="${centre}" cy="${centre}" r="${radius}"
                stroke="${stroke}"
                stroke-dasharray="${circumference.toFixed(2)}"
                stroke-dashoffset="${circumference.toFixed(2)}"
                style="--ring-w:${thickness}px"/>
      </svg>
      <div class="ring__label">
        <div class="ring__figure">${esc(figure ?? `${pct.toFixed(pct < 10 ? 1 : 0)}%`)}</div>
        ${caption ? `<div class="ring__caption">${esc(caption)}</div>` : ''}
      </div>
    </div>`;
}

/** Animates every un-animated [data-ring-wrap] found in root. */
export function animateRings(root = document) {
  root.querySelectorAll('[data-ring-wrap]').forEach((wrap) => {
    if (wrap.dataset.ringDone) return;
    wrap.dataset.ringDone = '1';

    const value = Number(wrap.dataset.value) || 0;
    const valueCircle = wrap.querySelector('.ring__value');
    const circumference = valueCircle.getTotalLength();
    const target = circumference * (1 - Math.min(Math.max(value, 0), 100) / 100);
    valueCircle.style.strokeDasharray = `${circumference.toFixed(2)}`;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      valueCircle.style.strokeDashoffset = `${target.toFixed(2)}`;
      return;
    }
    valueCircle.style.transition = 'stroke-dashoffset 1.05s cubic-bezier(.22,1,.36,1)';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      valueCircle.style.strokeDashoffset = `${target.toFixed(2)}`;
    }));
  });
}

export { palette, cssVar, attendanceColor, toneFor };