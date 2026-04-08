// shared/chart.js — Minimal SVG chart renderer.
// We don't bundle Chart.js because the only thing we need is a smooth
// line + axis. SVG is enough, ships less code, and avoids any CDN.

(function (root) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function el(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    if (attrs) for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
    return node;
  }

  // Inline sparkline used in collapsed rows.
  // points: array of { t, p }. width/height in px. positive: bool decides color.
  function sparkline(points, opts = {}) {
    const width = opts.width || 60;
    const height = opts.height || 28;
    const positive = opts.positive !== false;
    const color = positive ? '#00c853' : '#ff1744';
    const svg = el('svg', {
      width: String(width),
      height: String(height),
      viewBox: `0 0 ${width} ${height}`,
      class: 'qt-spark'
    });
    if (!points || points.length < 2) return svg;
    const min = Math.min.apply(null, points.map((p) => p.p));
    const max = Math.max.apply(null, points.map((p) => p.p));
    const span = max - min || 1;
    const stepX = width / (points.length - 1);
    let d = '';
    for (let i = 0; i < points.length; i++) {
      const x = i * stepX;
      const y = height - ((points[i].p - min) / span) * (height - 2) - 1;
      d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2);
    }
    const path = el('path', {
      d,
      fill: 'none',
      stroke: color,
      'stroke-width': '1.5',
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round'
    });
    svg.appendChild(path);
    return svg;
  }

  // Larger interactive line chart for the expanded view.
  // Returns a wrapper element that contains the SVG and a tooltip.
  function lineChart(container, points, opts = {}) {
    container.textContent = '';
    if (!points || points.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'qt-chart-empty';
      empty.textContent = 'No chart data available.';
      container.appendChild(empty);
      return;
    }

    const width = opts.width || container.clientWidth || 320;
    const height = opts.height || 160;
    const padL = 32, padR = 8, padT = 8, padB = 18;
    const positive = opts.positive !== false;
    const color = positive ? '#00c853' : '#ff1744';
    const fill  = positive ? 'rgba(0,200,83,0.12)' : 'rgba(255,23,68,0.12)';

    const svg = el('svg', {
      width: String(width),
      height: String(height),
      viewBox: `0 0 ${width} ${height}`,
      class: 'qt-chart',
      role: 'img'
    });

    const min = Math.min.apply(null, points.map((p) => p.p));
    const max = Math.max.apply(null, points.map((p) => p.p));
    const span = (max - min) || (Math.abs(max) * 0.01 || 1);
    const niceMin = min - span * 0.05;
    const niceMax = max + span * 0.05;
    const niceSpan = niceMax - niceMin;

    const innerW = width - padL - padR;
    const innerH = height - padT - padB;

    function xAt(i) { return padL + (i / Math.max(1, points.length - 1)) * innerW; }
    function yAt(p) { return padT + innerH - ((p - niceMin) / niceSpan) * innerH; }

    // Y-axis ticks (3 lines)
    const ticks = 3;
    for (let i = 0; i <= ticks; i++) {
      const v = niceMin + (niceSpan * i) / ticks;
      const y = yAt(v);
      svg.appendChild(el('line', {
        x1: padL, x2: width - padR, y1: y, y2: y,
        stroke: '#2a2a2a', 'stroke-width': '1'
      }));
      const label = el('text', {
        x: '4', y: String(y + 3),
        fill: '#888', 'font-size': '9', 'font-family': 'system-ui,sans-serif'
      });
      label.textContent = formatNumber(v);
      svg.appendChild(label);
    }

    // Filled area
    let areaD = `M${xAt(0).toFixed(2)},${(padT + innerH).toFixed(2)}`;
    for (let i = 0; i < points.length; i++) {
      areaD += ` L${xAt(i).toFixed(2)},${yAt(points[i].p).toFixed(2)}`;
    }
    areaD += ` L${xAt(points.length - 1).toFixed(2)},${(padT + innerH).toFixed(2)} Z`;
    svg.appendChild(el('path', { d: areaD, fill, stroke: 'none' }));

    // Line
    let lineD = '';
    for (let i = 0; i < points.length; i++) {
      lineD += (i === 0 ? 'M' : 'L') + xAt(i).toFixed(2) + ',' + yAt(points[i].p).toFixed(2);
    }
    svg.appendChild(el('path', {
      d: lineD,
      fill: 'none',
      stroke: color,
      'stroke-width': '1.5',
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round'
    }));

    // Hover tooltip
    const hoverLine = el('line', {
      x1: '0', x2: '0', y1: padT, y2: padT + innerH,
      stroke: '#888', 'stroke-width': '1', 'stroke-dasharray': '2,2',
      visibility: 'hidden'
    });
    svg.appendChild(hoverLine);
    const hoverDot = el('circle', {
      cx: '0', cy: '0', r: '3', fill: color, stroke: '#fff', 'stroke-width': '1',
      visibility: 'hidden'
    });
    svg.appendChild(hoverDot);

    const wrapper = document.createElement('div');
    wrapper.className = 'qt-chart-wrap';
    wrapper.appendChild(svg);

    const tooltip = document.createElement('div');
    tooltip.className = 'qt-chart-tooltip';
    tooltip.style.display = 'none';
    wrapper.appendChild(tooltip);

    function onMove(ev) {
      const rect = svg.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, (px - padL) / innerW));
      const idx = Math.round(ratio * (points.length - 1));
      const point = points[idx];
      if (!point) return;
      const x = xAt(idx);
      const y = yAt(point.p);
      hoverLine.setAttribute('x1', String(x));
      hoverLine.setAttribute('x2', String(x));
      hoverLine.setAttribute('visibility', 'visible');
      hoverDot.setAttribute('cx', String(x));
      hoverDot.setAttribute('cy', String(y));
      hoverDot.setAttribute('visibility', 'visible');
      tooltip.style.display = 'block';
      tooltip.style.left = (x * (rect.width / width)) + 'px';
      tooltip.style.top = (Math.max(0, y - 28) * (rect.height / height)) + 'px';
      tooltip.textContent = formatTooltip(point.t, point.p);
    }
    function onLeave() {
      hoverLine.setAttribute('visibility', 'hidden');
      hoverDot.setAttribute('visibility', 'hidden');
      tooltip.style.display = 'none';
    }
    svg.addEventListener('mousemove', onMove);
    svg.addEventListener('mouseleave', onLeave);

    container.appendChild(wrapper);
  }

  function formatNumber(v) {
    if (Math.abs(v) >= 1000) return v.toFixed(0);
    if (Math.abs(v) >= 100)  return v.toFixed(1);
    return v.toFixed(2);
  }

  function formatTooltip(ts, price) {
    const d = new Date(ts);
    const dt = d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `${dt}  ·  ${price.toFixed(2)}`;
  }

  root.QTChart = { sparkline, lineChart };
})(typeof window !== 'undefined' ? window : globalThis);
