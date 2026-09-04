/**
 * Hand-rolled SVG charts.
 *
 * A charting library would be a CDN request the webview's CSP forbids and a
 * few hundred kilobytes for two chart types. These are the two the OneProvider
 * dashboard draws — cost over time and requests over time — rendered as plain
 * SVG strings so they cost nothing and inherit the panel's own palette.
 *
 * Every value shown is a reading, so the axis is labelled and the series is
 * drawn on a real scale rather than normalized into a decorative squiggle.
 */
const Charts = (function () {
  const W = 560;
  const H = 170;
  const PAD_LEFT = 42;
  const PAD_RIGHT = 8;
  const PAD_TOP = 12;
  const PAD_BOTTOM = 18;

  /**
   * Round a maximum up to a readable axis bound (1, 2, 5 × 10^n) so the
   * gridline labels are numbers a person can hold in their head.
   */
  function niceMax(value) {
    if (!(value > 0)) {
      return 1;
    }
    const magnitude = 10 ** Math.floor(Math.log10(value));
    const normalized = value / magnitude;
    const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return step * magnitude;
  }

  /**
   * Area chart with gridlines and a labelled Y axis.
   * @param points {{label: string, value: number}[]}
   * @param options {{color: string, format: (n:number)=>string, everyNthLabel?: number}}
   */
  function area(points, options) {
    if (!points || points.length === 0) {
      return '<div class="chart-empty">No data</div>';
    }

    const color = options.color;
    const format = options.format || String;
    const max = niceMax(Math.max(...points.map((p) => p.value)));
    const plotW = W - PAD_LEFT - PAD_RIGHT;
    const plotH = H - PAD_TOP - PAD_BOTTOM;

    const x = (i) =>
      points.length === 1 ? PAD_LEFT + plotW / 2 : PAD_LEFT + (i / (points.length - 1)) * plotW;
    const y = (v) => PAD_TOP + plotH - (Math.max(0, v) / max) * plotH;

    const line = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`)
      .join(' ');
    const fill = `${line} L${x(points.length - 1).toFixed(1)},${PAD_TOP + plotH} L${x(0).toFixed(1)},${PAD_TOP + plotH} Z`;

    const gridlines = [0, 0.25, 0.5, 0.75, 1]
      .map((t) => {
        const gy = PAD_TOP + plotH * t;
        const label = format(max * (1 - t));
        return (
          `<line x1="${PAD_LEFT}" y1="${gy}" x2="${W - PAD_RIGHT}" y2="${gy}"/>` +
          `<text class="chart-axis" x="${PAD_LEFT - 5}" y="${gy + 3}" text-anchor="end">${escapeText(label)}</text>`
        );
      })
      .join('');

    // Dense ranges (24 hourly buckets) would collide if every tick were drawn.
    const every = options.everyNthLabel || Math.max(1, Math.ceil(points.length / 8));
    const xLabels = points
      .map((p, i) =>
        i % every === 0 || i === points.length - 1
          ? `<text class="chart-axis" x="${x(i).toFixed(1)}" y="${H - 5}" text-anchor="middle">${escapeText(p.label)}</text>`
          : '',
      )
      .join('');

    const gradientId = `grad-${Math.random().toString(36).slice(2, 8)}`;

    return `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeText(options.ariaLabel || 'Time series')}">
        <defs>
          <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <g class="chart-grid">${gridlines}</g>
        <path d="${fill}" fill="url(#${gradientId})"/>
        <path d="${line}" fill="none" stroke="${color}" stroke-width="1.5"
              stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
        ${xLabels}
      </svg>
    `;
  }

  /**
   * Stacked token bar for one day.
   * @param segments {{key: string, tokens: number}[]}
   * @param scaleMax the largest daily total, so days are comparable to each other
   */
  function stackedBar(segments, scaleMax) {
    const total = segments.reduce((sum, s) => sum + s.tokens, 0);
    if (total === 0 || scaleMax <= 0) {
      return '';
    }
    return segments
      .filter((s) => s.tokens > 0)
      .map(
        (s) =>
          `<span class="swatch-${s.key.replace('_', '-')}" style="width:${((s.tokens / scaleMax) * 100).toFixed(2)}%" title="${escapeText(s.key)}: ${s.tokens.toLocaleString()}"></span>`,
      )
      .join('');
  }

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return { area, stackedBar, niceMax };
})();
