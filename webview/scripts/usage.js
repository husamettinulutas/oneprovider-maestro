/**
 * The Usage panel.
 *
 * Two accountings, side by side and clearly labelled, because they legitimately
 * disagree:
 *
 *   SESSION   — priced locally the instant a Copilot turn ends. Immediate, and
 *               only covers traffic this extension sent.
 *   ACCOUNT   — OneProvider's own ledger. Authoritative, covers Claude Code and
 *               Codex too, and settles in the background, so it lags.
 *
 * Presenting one without the other would make normal lag look like a bug.
 * Section order mirrors the OneProvider web dashboard.
 */
const UsagePanel = (function () {
  const RANGES = [
    { days: 1, label: '24h' },
    { days: 3, label: '3d' },
    { days: 7, label: '7d' },
    { days: 30, label: '30d' },
  ];

  const TOKEN_SERIES = [
    { key: 'input', label: 'Input' },
    { key: 'output', label: 'Output' },
    { key: 'cache_read', label: 'Cache read' },
    { key: 'cache_creation', label: 'Cache write' },
  ];

  let state = { usage: undefined, session: undefined, error: undefined, loading: false, days: 1 };

  function update(next) {
    state = { ...state, ...next };
  }

  function currentRange() {
    return state.usage ? state.usage.days : state.days;
  }

  function render(container) {
    container.innerHTML = [
      renderHeader(),
      renderSession(),
      state.error ? renderError() : '',
      state.usage ? renderAccount(state.usage) : renderAccountPlaceholder(),
      renderLinks(),
    ].join('');
    bind(container);
  }

  // ── Header ────────────────────────────────────────────────────────────────

  function renderHeader() {
    const range = currentRange();
    const buttons = RANGES.map(
      (r) =>
        `<button data-range="${r.days}" class="${r.days === range ? 'active' : ''}">${r.label}</button>`,
    ).join('');

    return `
      <div class="section-head">
        <h2 class="section-title">[ Telemetry ]</h2>
        <span class="section-meta">${state.loading ? 'Syncing…' : lastSyncLabel()}</span>
      </div>
      <div style="display:flex; gap:var(--u2); align-items:center; flex-wrap:wrap;">
        <div class="range" role="group" aria-label="Time range">${buttons}</div>
        <button class="btn" data-action="refresh">↻ Refresh</button>
        <button class="btn" data-action="reset-session">Reset session</button>
      </div>
    `;
  }

  function lastSyncLabel() {
    if (!state.usage) {
      return '—';
    }
    return `Synced ${new Date(state.usage.fetchedAt).toLocaleTimeString()}`;
  }

  // ── Session ───────────────────────────────────────────────────────────────

  function renderSession() {
    const s = state.session;
    if (!s) {
      return '';
    }

    const cacheTokens = s.cacheReadTokens + s.cacheWriteTokens;
    const models = s.perModel
      .slice(0, 6)
      .map(
        (m) => `
        <div class="usage-model">
          <div class="usage-model-head">
            <span class="usage-model-name" title="${esc(m.modelId)}">${esc(m.modelId)}</span>
            <span class="usage-model-count">${m.requests}</span>
          </div>
          <div class="usage-model-tokens">
            <span>Tok ${fmtTokens(m.tokens)}</span>
            <span>Est ${fmtUsd(m.estimatedCost)}</span>
          </div>
        </div>`,
      )
      .join('');

    return `
      <div class="section-head">
        <h3 class="section-title">[ This session ]</h3>
        <span class="section-meta">Since ${new Date(s.startedAt).toLocaleTimeString()} · Copilot traffic only</span>
      </div>
      <dl class="metrics standalone">
        ${metric('Est. spend', fmtUsd(s.estimatedCost), s.estimatedCost > 0 ? 'hazard' : '')}
        ${metric('Requests', String(s.requests))}
        ${metric('Input', fmtTokens(s.inputTokens))}
        ${metric('Output', fmtTokens(s.outputTokens))}
        ${metric('Cache', fmtTokens(cacheTokens))}
      </dl>
      ${models ? `<div class="usage-models">${models}</div>` : ''}
      <div class="strip">
        <span class="strip-tag">Note</span>
        <span>Session spend is estimated locally from the bundled OneProvider rate card so it updates the moment a turn ends. OneProvider's own ledger below is what you are actually billed — it settles in the background, so a gap between the two is lag, not a discrepancy. Claude Code and Codex talk to OneProvider directly, so their usage appears only in the account figures.</span>
      </div>
    `;
  }

  // ── Account ───────────────────────────────────────────────────────────────

  function renderError() {
    return `
      <div class="strip alert">
        <span class="strip-tag">Account</span>
        <span>${esc(state.error)}</span>
      </div>
    `;
  }

  function renderAccountPlaceholder() {
    if (state.loading) {
      return `<div class="strip"><span class="strip-tag">Account</span><span>Reading balance from OneProvider…</span></div>`;
    }
    if (state.error) {
      return '';
    }
    return `
      <div class="empty">
        <div class="empty-sigil">[ No account data ]</div>
        <div class="empty-title">Balance unavailable</div>
        <div class="empty-desc">Set your OneProvider API key to read this key's balance, spend and request history.</div>
      </div>
    `;
  }

  function renderAccount(usage) {
    const snap = usage.snapshot;
    const remaining = snap.quota_usd > 0 ? (snap.balance_usd / snap.quota_usd) * 100 : 0;
    const low = remaining < 10;
    const agg = usage.usage ? usage.usage.aggregated : undefined;

    const statusClass =
      usage.status === 'active' ? 'ok' : usage.status === 'paused' ? '' : 'bad';

    return `
      <div class="section-head">
        <h3 class="section-title">[ Account ]</h3>
        <code class="section-meta" style="text-transform:none">${esc(usage.key.masked || '')}</code>
      </div>

      <div class="balance">
        <div class="balance-head">
          <span class="state ${statusClass}"><i class="state-dot"></i>${esc(usage.status)}</span>
          ${usage.key.name ? `<span class="micro">${esc(usage.key.name)}</span>` : ''}
          ${
            // The key name and the marketplace are frequently the same word;
            // printing it twice reads as a rendering bug.
            usage.key.marketplace_name &&
            usage.key.marketplace_name.toLowerCase() !== (usage.key.name || '').toLowerCase()
              ? `<span class="micro">${esc(usage.key.marketplace_name)}</span>`
              : ''
          }
        </div>

        <div class="balance-figure">
          <div>
            <p class="balance-amount">${fmtUsd(snap.balance_usd)}</p>
            <div class="balance-sub">Available · ${remaining.toFixed(1)}% of ${fmtUsd(snap.quota_usd)}</div>
          </div>
          <div class="balance-expiry">
            <div class="micro">Expires</div>
            <div class="num" style="font-size:var(--data-lg); margin-top:var(--u1);">${fmtDate(usage.key.expires_at)}</div>
          </div>
        </div>

        <div class="meter"><div class="meter-fill ${low ? 'low' : ''}" style="width:${Math.max(0, Math.min(100, remaining)).toFixed(2)}%"></div></div>

        <dl class="metrics">
          ${metric('Lifetime top-ups', fmtUsd(snap.quota_usd))}
          ${metric('Spent so far', fmtUsd(snap.quota_used_usd))}
          ${metric('Last checked', fmtDateTime(usage.key.last_check), '', true)}
          ${metric('Range', `${usage.days}d`)}
        </dl>
      </div>

      ${agg && agg.total_requests > 0 ? renderUsageBody(usage, agg) : renderNoUsage()}
    `;
  }

  function renderNoUsage() {
    return `
      <div class="strip">
        <span class="strip-tag">Usage</span>
        <span>No requests recorded in this window yet. Widen the range, or send a request through Copilot, Claude Code or Codex.</span>
      </div>
    `;
  }

  function renderUsageBody(usage, agg) {
    const hourly = usage.days === 1;
    const costPoints = hourly
      ? fillHours(agg.per_hour).map((h) => ({ label: h.hour.slice(11, 13), value: h.cost }))
      : agg.per_day.map((d) => ({ label: d.date.slice(5), value: d.cost }));
    const reqPoints = hourly
      ? fillHours(agg.per_hour).map((h) => ({ label: h.hour.slice(11, 13), value: h.requests }))
      : agg.per_day.map((d) => ({ label: d.date.slice(5), value: d.requests }));

    return `
      <dl class="metrics standalone">
        ${metric('Total cost', fmtUsd(agg.total_cost))}
        ${metric('Requests', agg.total_requests.toLocaleString())}
        ${metric('Input tokens', fmtTokens(agg.tokens.input))}
        ${metric('Output tokens', fmtTokens(agg.tokens.output))}
        ${metric('Cache read', fmtTokens(agg.tokens.cache_read))}
        ${metric('Cache write', fmtTokens(agg.tokens.cache_creation))}
      </dl>

      <div class="chart-pair">
        <div class="chart">
          <div class="chart-head">
            <span class="micro">Cost per ${hourly ? 'hour' : 'day'}</span>
            <span class="micro">USD</span>
          </div>
          ${Charts.area(costPoints, {
            color: 'var(--series-cost)',
            format: (n) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`,
            ariaLabel: 'Cost over time',
          })}
        </div>
        <div class="chart">
          <div class="chart-head">
            <span class="micro">Requests per ${hourly ? 'hour' : 'day'}</span>
            <span class="micro">Count</span>
          </div>
          ${Charts.area(reqPoints, {
            color: 'var(--series-output)',
            format: (n) => String(Math.round(n)),
            ariaLabel: 'Requests over time',
          })}
        </div>
      </div>

      ${renderBreakdown(agg)}
      ${renderModelUsage(usage, agg)}
      ${renderLog(usage)}
    `;
  }

  /**
   * The hourly series only contains hours that saw traffic, so a quiet hour
   * would silently shorten the axis. Pad the last 24 with explicit zeros.
   */
  function fillHours(perHour) {
    const now = new Date();
    const filled = [];
    for (let back = 23; back >= 0; back--) {
      const stamp = new Date(now.getTime() - back * 3600_000).toISOString().slice(0, 13);
      const found = (perHour || []).find((h) => h.hour && h.hour.startsWith(stamp));
      filled.push(found || { hour: `${stamp}:00:00`, cost: 0, requests: 0 });
    }
    return filled;
  }

  function renderBreakdown(agg) {
    const days = (agg.per_day || [])
      .filter((d) => d.tokens)
      .map((d) => ({ date: d.date, cost: d.cost, tokens: d.tokens }))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (days.length === 0) {
      return '';
    }

    const scaleMax = Math.max(
      1,
      ...days.map((d) => d.tokens.input + d.tokens.output + d.tokens.cache_read + d.tokens.cache_creation),
    );

    const legend = TOKEN_SERIES.map(
      (s) => `<span><i class="swatch-${s.key.replace('_', '-')}"></i>${s.label}</span>`,
    ).join('');

    const rows = days
      .map((d) => {
        const total = d.tokens.input + d.tokens.output + d.tokens.cache_read + d.tokens.cache_creation;
        const segments = TOKEN_SERIES.map((s) => ({ key: s.key, tokens: d.tokens[s.key] || 0 }));
        return `
          <div class="day-row">
            <span class="day-label">${esc(d.date.slice(5))}</span>
            <div class="day-bar" title="${esc(d.date)} · ${total.toLocaleString()} tokens · ${fmtUsd(d.cost)}">${Charts.stackedBar(segments, scaleMax)}</div>
            <span class="day-total">${fmtTokens(total)}</span>
          </div>`;
      })
      .join('');

    return `
      <div class="breakdown">
        <div class="chart-head">
          <span class="micro">Token breakdown by day</span>
          <div class="legend">${legend}</div>
        </div>
        <div class="day-rows">${rows}</div>
      </div>
    `;
  }

  function renderModelUsage(usage, agg) {
    const perModel = agg.per_model || [];
    if (perModel.length === 0) {
      return '';
    }

    // The per-model aggregate carries request counts only; token totals come
    // from the recent rows, so they cover the sample rather than the range.
    const tokensByModel = new Map();
    for (const row of usage.usage.recent_rows || []) {
      const id = row.model || 'unknown';
      const bucket = tokensByModel.get(id) || { input: 0, output: 0, cache: 0, total: 0 };
      bucket.input += row.input_tokens;
      bucket.output += row.output_tokens;
      bucket.cache += row.cache_read_tokens + row.cache_creation_tokens;
      bucket.total += row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_creation_tokens;
      tokensByModel.set(id, bucket);
    }

    const totalRequests = agg.total_requests || 1;
    const cards = perModel
      .map((m) => {
        const share = (m.requests / totalRequests) * 100;
        const t = tokensByModel.get(m.model);
        return `
          <div class="usage-model">
            <div class="usage-model-head">
              <span class="usage-model-name" title="${esc(m.model)}">${esc(m.model)}</span>
              <span class="usage-model-count">${m.requests}</span>
              <span class="usage-model-share">${share.toFixed(1)}%</span>
            </div>
            <div class="share-bar"><span style="width:${share.toFixed(2)}%"></span></div>
            ${
              t
                ? `<div class="usage-model-tokens">
                     <span>Total ${fmtTokens(t.total)}</span>
                     <span>In ${fmtTokens(t.input)}</span>
                     <span>Out ${fmtTokens(t.output)}</span>
                     ${t.cache > 0 ? `<span>Cache ${fmtTokens(t.cache)}</span>` : ''}
                   </div>`
                : ''
            }
          </div>`;
      })
      .join('');

    return `
      <div class="section-head">
        <h3 class="section-title">[ Model usage ]</h3>
        <span class="section-meta">${agg.total_requests} total req</span>
      </div>
      <div class="usage-models">${cards}</div>
    `;
  }

  function renderLog(usage) {
    const rows = usage.usage.recent_rows || [];
    if (rows.length === 0) {
      return '';
    }

    const body = rows
      .map(
        (r) => `
        <tr>
          <td>${r.created_at ? esc(new Date(r.created_at).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })) : '—'}</td>
          <td class="col-model">${esc(r.model || '—')}</td>
          <td class="col-num">${fmtTokens(r.input_tokens)}</td>
          <td class="col-num">${fmtTokens(r.output_tokens)}</td>
          <td class="col-num">${fmtTokens(r.cache_read_tokens + r.cache_creation_tokens)}</td>
          <td class="col-num">${r.duration_ms > 0 ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
          <td class="col-cost">${fmtUsd(r.total_cost)}</td>
        </tr>`,
      )
      .join('');

    return `
      <div class="log">
        <div class="log-head">
          <span class="section-title">[ Recent activity ]</span>
          <span class="section-meta">${rows.length} most recent</span>
        </div>
        <div class="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Time</th><th>Model</th>
                <th class="col-num">In</th><th class="col-num">Out</th><th class="col-num">Cache</th>
                <th class="col-num">Duration</th><th class="col-cost">Cost</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderLinks() {
    return `
      <div class="linkrow">
        <button data-open="https://dashboard.oneprovider.dev/">↗ Web dashboard</button>
        <button data-open="https://t.me/oneprovider_robot">↗ Top up</button>
        <button data-open="https://oneprovider.dev/docs">↗ Docs</button>
      </div>
    `;
  }

  // ── Events ────────────────────────────────────────────────────────────────

  function bind(container) {
    container.querySelectorAll('[data-range]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const days = Number(btn.dataset.range);
        state.days = days;
        vscodeApi.postMessage({ type: 'getUsage', days, force: true });
      });
    });

    const refresh = container.querySelector('[data-action="refresh"]');
    if (refresh) {
      refresh.addEventListener('click', () =>
        vscodeApi.postMessage({ type: 'getUsage', days: currentRange(), force: true }),
      );
    }

    const reset = container.querySelector('[data-action="reset-session"]');
    if (reset) {
      reset.addEventListener('click', () => vscodeApi.postMessage({ type: 'resetSessionUsage' }));
    }

    container.querySelectorAll('[data-open]').forEach((btn) => {
      btn.addEventListener('click', () =>
        vscodeApi.postMessage({ type: 'openExternal', url: btn.dataset.open }),
      );
    });
  }

  // ── Formatting ────────────────────────────────────────────────────────────

  function metric(label, value, modifier, small) {
    return `
      <div class="metric">
        <dt>${esc(label)}</dt>
        <dd class="${modifier || ''} ${small ? 'small' : ''}">${esc(value)}</dd>
      </div>`;
  }

  function fmtUsd(value) {
    if (typeof value !== 'number' || !isFinite(value)) {
      return '$0.00';
    }
    if (value === 0) {
      return '$0.00';
    }
    return Math.abs(value) < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
  }

  function fmtTokens(count) {
    if (!count) {
      return '0';
    }
    if (count >= 1_000_000) {
      return `${(count / 1_000_000).toFixed(2)}M`;
    }
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}K`;
    }
    return String(count);
  }

  function fmtDate(value) {
    if (!value) {
      return '—';
    }
    const date = new Date(value);
    return isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
  }

  function fmtDateTime(value) {
    if (!value) {
      return '—';
    }
    const date = new Date(value);
    return isNaN(date.getTime()) ? '—' : date.toLocaleString();
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return { update, render, fmtUsd, fmtTokens };
})();
