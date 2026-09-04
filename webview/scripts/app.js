/**
 * OneProvider Maestro — webview shell.
 * Owns tabs, the model browser, the Copilot roster and the two agent panels;
 * the Usage panel renders itself through UsagePanel.
 */
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  let allModels = [];
  let activeCopilotModels = [];
  let integrationStatuses = [];
  let agentRosters = {};
  let pendingRestart = {};
  let hasApiKey = false;
  let lastSync;
  let activeTab = 'browse';
  let searchTimer = null;

  const $ = (sel) => document.querySelector(sel);

  const dom = {
    tabs: {
      browse: { btn: $('#tab-browse'), panel: $('#panel-browse') },
      copilot: { btn: $('#tab-copilot'), panel: $('#panel-copilot') },
      claude: { btn: $('#tab-claude'), panel: $('#panel-claude') },
      codex: { btn: $('#tab-codex'), panel: $('#panel-codex') },
      usage: { btn: $('#tab-usage'), panel: $('#panel-usage') },
    },
    countCopilot: $('#count-copilot'),
    countClaude: $('#count-claude'),
    countCodex: $('#count-codex'),
    search: $('#search'),
    searchClear: $('#search-clear'),
    fVision: $('#f-vision'),
    fTools: $('#f-tools'),
    fThinking: $('#f-thinking'),
    fLive: $('#f-live'),
    fBrand: $('#f-brand'),
    fSort: $('#f-sort'),
    browseMeta: $('#browse-meta'),
    modelList: $('#model-list'),
    copilotList: $('#copilot-list'),
    claudeBody: $('#claude-body'),
    codexBody: $('#codex-body'),
    usageBody: $('#usage-body'),
    keyBtn: $('#key-btn'),
    syncBtn: $('#sync-btn'),
    keyBanner: $('#key-banner'),
    keyBannerBtn: $('#key-banner-btn'),
    loading: $('#loading'),
    toasts: $('#toasts'),
  };

  // ── Agent copy ────────────────────────────────────────────────────────────

  const AGENTS = {
    'claude-code': {
      name: 'Claude Code',
      body: dom.claudeBody,
      defaultLabel: "Claude Code's own model (Anthropic)",
      how:
        'Keep as many models in this list as you like. Claude Code runs <b>one at a time</b>, so activating one writes it into Claude Code\'s settings; the rest just wait here.',
      steps: [
        'Add Claude models from <b>Browse</b> with the <b>Claude</b> button.',
        'Press <b>Activate</b> on the one you want to run.',
        'Start a <b>new Claude Code session</b> — a running session keeps its old config.',
        'No Anthropic login is needed; your OneProvider key authenticates. Your Claude subscription is untouched and comes back the moment you switch to the default.',
      ],
      caveat:
        'Only Claude models can be wired in here. OneProvider routes GPT, Gemini, Grok, GLM, Kimi, DeepSeek and MiMo over its OpenAI-compatible wire, which Claude Code cannot speak — use those in Codex or Copilot.',
    },
    codex: {
      name: 'Codex',
      body: dom.codexBody,
      defaultLabel: "Codex's own model (OpenAI)",
      how:
        'Keep as many models in this list as you like. Codex runs <b>one at a time</b>, so activating one writes a <code>oneprovider</code> provider into <code>~/.codex/config.toml</code> (shared by the Codex CLI and the IDE extension).',
      steps: [
        'Add models from <b>Browse</b> with the <b>Codex</b> button.',
        'Press <b>Activate</b> on the one you want to run.',
        '<b>Restart VS Code once</b> after the first activation so Codex sees the <code>ONEPROVIDER_API_KEY</code> environment variable.',
        'No ChatGPT sign-in is needed. Codex\'s own picker labels the model "Custom" — the real model is the activated one.',
      ],
      caveat:
        'Codex talks to OneProvider over the Responses API. Thinking steps only render for models whose upstream emits reasoning <i>summaries</i>; models that stream raw reasoning still think (and bill for it) without displaying the steps.',
    },
  };

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    bindShell();
    vscodeApi.onMessage(handleMessage);
    vscodeApi.postMessage({ type: 'ready' });
  }

  function bindShell() {
    for (const [name, tab] of Object.entries(dom.tabs)) {
      tab.btn.addEventListener('click', () => switchTab(name));
    }

    dom.search.addEventListener('input', () => {
      const value = dom.search.value;
      dom.searchClear.classList.toggle('visible', value.length > 0);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        Filters.set('search', value);
        renderModels();
      }, 160);
    });

    dom.searchClear.addEventListener('click', () => {
      dom.search.value = '';
      dom.searchClear.classList.remove('visible');
      Filters.set('search', '');
      renderModels();
      dom.search.focus();
    });

    bindChip(dom.fVision, 'vision');
    bindChip(dom.fTools, 'tools');
    bindChip(dom.fThinking, 'thinking');
    bindChip(dom.fLive, 'liveOnly');

    dom.fBrand.addEventListener('change', () => {
      Filters.set('brand', dom.fBrand.value);
      renderModels();
    });
    dom.fSort.addEventListener('change', () => {
      Filters.set('sortBy', dom.fSort.value);
      renderModels();
    });

    dom.syncBtn.addEventListener('click', () => vscodeApi.postMessage({ type: 'syncModels' }));
    dom.keyBtn.addEventListener('click', () => vscodeApi.postMessage({ type: 'setApiKey' }));
    dom.keyBannerBtn.addEventListener('click', () => vscodeApi.postMessage({ type: 'setApiKey' }));
  }

  function bindChip(el, key) {
    el.addEventListener('click', () => {
      Filters.toggle(key);
      el.classList.toggle('active');
      el.setAttribute('aria-pressed', el.classList.contains('active') ? 'true' : 'false');
      renderModels();
    });
  }

  function switchTab(name) {
    activeTab = name;
    for (const [key, tab] of Object.entries(dom.tabs)) {
      const on = key === name;
      tab.btn.classList.toggle('active', on);
      tab.btn.setAttribute('aria-selected', String(on));
      tab.panel.classList.toggle('active', on);
    }

    if (name === 'copilot') {
      renderCopilot();
    }
    if (name === 'claude' || name === 'codex') {
      renderAgents();
      vscodeApi.postMessage({ type: 'getAgentRosters' });
      vscodeApi.postMessage({ type: 'getIntegrationStatus' });
    }
    if (name === 'usage') {
      UsagePanel.render(dom.usageBody);
      vscodeApi.postMessage({ type: 'getUsage' });
    }
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  function handleMessage(msg) {
    switch (msg.type) {
      case 'modelsLoaded':
        allModels = msg.models || [];
        lastSync = msg.lastSync;
        renderBrandOptions();
        renderModels();
        renderCopilot();
        break;
      case 'selectedModelsUpdated':
        // Card state is driven by activeModelsUpdated; this only needs to
        // repaint so a just-added model shows its badge without a round trip.
        renderModels();
        break;
      case 'activeModelsUpdated':
        activeCopilotModels = msg.models || [];
        updateCounts();
        renderCopilot();
        renderModels();
        break;
      case 'copilotToggled':
        toast(msg.message, msg.enabled ? 'success' : 'info');
        break;
      case 'integrationStatus':
        integrationStatuses = msg.statuses || [];
        updateCounts();
        renderAgents();
        renderModels();
        break;
      case 'agentRostersUpdated':
        agentRosters = {};
        (msg.rosters || []).forEach((r) => {
          agentRosters[r.target] = r.models || [];
        });
        updateCounts();
        renderAgents();
        renderModels();
        break;
      case 'integrationApplied':
        toast(msg.message, msg.success ? 'success' : 'error');
        // The config on disk changed, but a running Claude Code / Codex session
        // keeps the config it started with. Say so, or the switch looks broken.
        if (msg.success && msg.target !== 'copilot') {
          pendingRestart[msg.target] = true;
          renderAgents();
        }
        break;
      case 'usageUpdated':
        UsagePanel.update({
          usage: msg.usage,
          session: msg.session,
          error: msg.error,
          loading: !!msg.loading,
        });
        if (activeTab === 'usage') {
          UsagePanel.render(dom.usageBody);
        }
        break;
      case 'error':
        toast(msg.message, 'error');
        break;
      case 'loading':
        dom.loading.classList.toggle('visible', !!msg.isLoading);
        dom.syncBtn.classList.toggle('spinning', !!msg.isLoading);
        break;
      case 'apiKeyStatus':
        hasApiKey = msg.hasKey;
        dom.keyBanner.classList.toggle('hidden', hasApiKey);
        break;
      case 'syncComplete':
        toast(
          msg.newModelsCount > 0
            ? `${msg.newModelsCount} new model(s) available for your key`
            : 'Catalog synced — nothing new',
          'success',
        );
        break;
    }
  }

  // ── Browse ────────────────────────────────────────────────────────────────

  function renderBrandOptions() {
    const brands = [...new Set(allModels.map((m) => m.productFamily))].sort();
    const labels = new Map(allModels.map((m) => [m.productFamily, m.brandLabel]));
    const current = dom.fBrand.value;
    dom.fBrand.innerHTML =
      '<option value="">All brands</option>' +
      brands
        .map((b) => `<option value="${esc(b)}">${esc(labels.get(b) || b)}</option>`)
        .join('');
    dom.fBrand.value = current;
  }

  function renderModels() {
    const filtered = Filters.apply(allModels);
    const liveCount = allModels.filter((m) => m.live).length;

    dom.browseMeta.textContent = `${filtered.length}/${allModels.length} shown · ${liveCount} on key${lastSync ? ` · synced ${new Date(lastSync).toLocaleTimeString()}` : ''}`;

    if (allModels.length === 0) {
      dom.modelList.innerHTML = renderBrowseEmpty();
      bindEmptyActions();
      return;
    }
    if (filtered.length === 0) {
      dom.modelList.innerHTML = `
        <div class="empty">
          <div class="empty-sigil">[ No match ]</div>
          <div class="empty-title">Nothing matches</div>
          <div class="empty-desc">Loosen the filters or clear the search.</div>
          <button class="btn" data-action="clear-filters">Clear filters</button>
        </div>`;
      const clear = dom.modelList.querySelector('[data-action="clear-filters"]');
      if (clear) {
        clear.addEventListener('click', clearFilters);
      }
      return;
    }

    // 100 cards is well past what anyone scans; the note below says so rather
    // than silently truncating.
    const shown = filtered.slice(0, 100);
    dom.modelList.innerHTML = `
      <div class="model-grid">
        ${shown.map(renderModelCard).join('')}
        ${
          filtered.length > shown.length
            ? `<div class="overflow-note">Showing ${shown.length} of ${filtered.length} — refine the filter to see the rest</div>`
            : ''
        }
      </div>`;

    dom.modelList.querySelectorAll('.target-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const { modelId, target } = e.currentTarget.dataset;
        if (target === 'copilot') {
          vscodeApi.postMessage({ type: 'toggleCopilot', modelId });
          return;
        }
        vscodeApi.postMessage({
          type: inRoster(target, modelId) ? 'removeFromAgent' : 'addToAgent',
          target,
          modelId,
        });
      });
    });
  }

  function renderBrowseEmpty() {
    if (!hasApiKey) {
      return `
        <div class="empty">
          <div class="empty-sigil">[ Awaiting key ]</div>
          <div class="empty-title">Set your API key</div>
          <div class="empty-desc">OneProvider's model endpoint answers without a key, but only with its default set. Add your sk-… key to list the models this key can actually call.</div>
          <button class="btn btn-primary" data-action="set-key">Set key</button>
        </div>`;
    }
    return `
      <div class="empty">
        <div class="empty-sigil">[ Empty catalog ]</div>
        <div class="empty-title">No models loaded</div>
        <div class="empty-desc">Sync the catalog to fetch the models available to your key.</div>
        <button class="btn btn-primary" data-action="sync">Sync catalog</button>
      </div>`;
  }

  function bindEmptyActions() {
    const setKey = dom.modelList.querySelector('[data-action="set-key"]');
    if (setKey) {
      setKey.addEventListener('click', () => vscodeApi.postMessage({ type: 'setApiKey' }));
    }
    const sync = dom.modelList.querySelector('[data-action="sync"]');
    if (sync) {
      sync.addEventListener('click', () => vscodeApi.postMessage({ type: 'syncModels' }));
    }
  }

  function renderModelCard(model) {
    const inCopilot = activeCopilotModels.some((m) => m.id === model.id);
    const inClaude = inRoster('claude-code', model.id);
    const inCodex = inRoster('codex', model.id);
    const runningClaude = activeModelOf('claude-code') === model.id;
    const runningCodex = activeModelOf('codex') === model.id;
    const claudeCapable = model.platform === 'anthropic';

    const flags = [];
    if (model.catalogOnly) {
      flags.push('<span class="flag flag-warn">Catalog only</span>');
    }
    if (model.capabilities.vision) {
      flags.push('<span class="flag">Vision</span>');
    }
    if (model.capabilities.toolCalling) {
      flags.push('<span class="flag">Tools</span>');
    }
    if (model.thinkingVariant) {
      flags.push('<span class="flag">Thinking</span>');
    } else if (model.reasoning) {
      flags.push('<span class="flag">Effort</span>');
    }
    if (model.capabilities.imageOutput) {
      flags.push('<span class="flag">Image out</span>');
    }
    if (model.capabilities.videoOutput) {
      flags.push('<span class="flag">Video out</span>');
    }
    if (inCopilot) {
      flags.push('<span class="flag flag-live">In Copilot</span>');
    }
    if (runningClaude) {
      flags.push('<span class="flag flag-live">Running · Claude Code</span>');
    }
    if (runningCodex) {
      flags.push('<span class="flag flag-live">Running · Codex</span>');
    }

    const priced = !!model.pricing;
    const enlisted = inCopilot || inClaude || inCodex;

    return `
      <article class="model-card ${enlisted ? 'enlisted' : ''} ${model.catalogOnly ? 'dormant' : ''}" data-model-id="${esc(model.id)}">
        <div class="card-id">
          <div class="card-brand">
            <span>${esc(model.brandLabel)}</span>
            <span class="card-tier">/ ${esc(model.tier)}</span>
          </div>
          <div class="card-name">${esc(model.name)}</div>
          <code class="card-slug">${esc(model.id)}</code>
        </div>

        ${model.summary ? `<p class="card-summary">${esc(model.summary)}</p>` : ''}

        ${flags.length ? `<div class="flags">${flags.join('')}</div>` : ''}

        <dl class="telemetry">
          <div>
            <dt>Input / M</dt>
            <dd class="${priced ? '' : 'free'}">${priced ? `$${model.pricing.input.toFixed(2)}` : 'usage'}</dd>
          </div>
          <div>
            <dt>Output / M</dt>
            <dd class="${priced ? '' : 'free'}">${priced ? `$${model.pricing.output.toFixed(2)}` : 'usage'}</dd>
          </div>
          <div>
            <dt>Context</dt>
            <dd>${fmtTokens(model.contextLength)}</dd>
          </div>
          <div>
            <dt>Max out</dt>
            <dd>${fmtTokens(model.maxOutputTokens)}</dd>
          </div>
        </dl>

        <div class="card-targets">
          <button class="target-btn ${inCopilot ? 'running' : ''}"
                  data-target="copilot" data-model-id="${esc(model.id)}"
                  title="${inCopilot ? 'Remove from the Copilot Chat picker' : 'Add to the Copilot Chat picker'}">
            ${inCopilot ? '● Copilot' : '+ Copilot'}
          </button>
          <button class="target-btn ${runningClaude ? 'running' : inClaude ? 'enlisted' : ''}"
                  data-target="claude-code" data-model-id="${esc(model.id)}"
                  ${claudeCapable ? '' : 'disabled'}
                  title="${
                    claudeCapable
                      ? inClaude
                        ? 'Remove from the Claude Code list'
                        : 'Add to the Claude Code list'
                      : 'Claude Code speaks the Anthropic wire; this model is routed over the OpenAI-compatible one'
                  }">
            ${runningClaude ? '● Claude' : inClaude ? '✓ Claude' : '+ Claude'}
          </button>
          <button class="target-btn ${runningCodex ? 'running' : inCodex ? 'enlisted' : ''}"
                  data-target="codex" data-model-id="${esc(model.id)}"
                  title="${inCodex ? 'Remove from the Codex list' : 'Add to the Codex list'}">
            ${runningCodex ? '● Codex' : inCodex ? '✓ Codex' : '+ Codex'}
          </button>
        </div>
      </article>`;
  }

  // ── Copilot ───────────────────────────────────────────────────────────────

  function renderCopilot() {
    if (!dom.copilotList) {
      return;
    }
    if (activeCopilotModels.length === 0) {
      dom.copilotList.innerHTML = `
        <div class="empty">
          <div class="empty-sigil">[ No models ]</div>
          <div class="empty-title">Nothing in Copilot yet</div>
          <div class="empty-desc">Open <b>Browse</b> and press <b>+ Copilot</b> on a model card. It appears in the Copilot Chat picker immediately.</div>
        </div>`;
      return;
    }

    dom.copilotList.innerHTML = `<div class="stack">${activeCopilotModels
      .map((am) =>
        renderUnit({
          id: am.id,
          name: am.name,
          actions: `<button class="btn btn-danger" data-remove-copilot="${esc(am.id)}">Remove</button>`,
          extra: renderEffort(am),
        }),
      )
      .join('')}</div>`;

    dom.copilotList.querySelectorAll('[data-remove-copilot]').forEach((btn) => {
      btn.addEventListener('click', () =>
        vscodeApi.postMessage({ type: 'removeActiveModel', modelId: btn.dataset.removeCopilot }),
      );
    });

    dom.copilotList.querySelectorAll('[data-effort-for]').forEach((select) => {
      select.addEventListener('change', () =>
        vscodeApi.postMessage({
          type: 'setReasoningEffort',
          modelId: select.dataset.effortFor,
          effort: select.value,
        }),
      );
    });
  }

  /**
   * Effort picker, shown only for models that accept `reasoning_effort`.
   * It writes the same stored override the Copilot picker's Thinking Effort
   * submenu does, so the two never drift apart.
   */
  function renderEffort(am) {
    const efforts = am.supportedEfforts || [];
    if (efforts.length === 0) {
      return '';
    }
    const current = am.reasoningEffort || efforts[0];
    const options = efforts
      .map(
        (e) =>
          `<option value="${esc(e)}"${e === current ? ' selected' : ''}>${esc(e === 'none' ? 'Off' : e)}</option>`,
      )
      .join('');
    return `
      <div class="effort">
        <label class="effort-label" for="effort-${esc(am.id)}">Thinking effort</label>
        <select id="effort-${esc(am.id)}" data-effort-for="${esc(am.id)}">${options}</select>
      </div>`;
  }

  /** The shared saved-model row used by every agent panel. */
  function renderUnit({ id, name, actions, extra, running }) {
    const full = allModels.find((m) => m.id === id);
    const priced = full && full.pricing;

    return `
      <div class="unit ${running ? 'running' : ''}" data-model-id="${esc(id)}">
        <div class="unit-head">
          <div>
            <div class="unit-name">${esc(full ? full.name : name)}</div>
            <code class="unit-slug">${esc(id)}</code>
          </div>
          <div class="unit-actions">${actions}</div>
        </div>
        ${
          full
            ? `<dl class="telemetry">
                 <div><dt>Input / M</dt><dd class="${priced ? '' : 'free'}">${priced ? `$${full.pricing.input.toFixed(2)}` : 'usage'}</dd></div>
                 <div><dt>Output / M</dt><dd class="${priced ? '' : 'free'}">${priced ? `$${full.pricing.output.toFixed(2)}` : 'usage'}</dd></div>
                 <div><dt>Context</dt><dd>${fmtTokens(full.contextLength)}</dd></div>
                 <div><dt>Max out</dt><dd>${fmtTokens(full.maxOutputTokens)}</dd></div>
               </dl>`
            : ''
        }
        ${extra || ''}
      </div>`;
  }

  // ── Agents ────────────────────────────────────────────────────────────────

  function inRoster(target, modelId) {
    return (agentRosters[target] || []).some((m) => m.id === modelId);
  }

  function activeModelOf(target) {
    const status = integrationStatuses.find((s) => s.target === target);
    return status && status.active ? status.modelId : undefined;
  }

  function updateCounts() {
    dom.countCopilot.textContent = String(activeCopilotModels.length);
    setAgentBadge(dom.countClaude, 'claude-code');
    setAgentBadge(dom.countCodex, 'codex');
  }

  function setAgentBadge(el, target) {
    if (!el) {
      return;
    }
    el.textContent = String((agentRosters[target] || []).length);
    el.classList.toggle('live', !!activeModelOf(target));
  }

  function renderAgents() {
    renderAgent('claude-code');
    renderAgent('codex');
  }

  function renderAgent(target) {
    const meta = AGENTS[target];
    if (!meta || !meta.body) {
      return;
    }

    const status = integrationStatuses.find((s) => s.target === target);
    const activeId = status && status.active ? status.modelId : undefined;
    const roster = agentRosters[target] || [];
    const installed = !status || status.installed !== false;

    let stateBadge;
    let notes;

    if (!status) {
      stateBadge = '<span class="state"><i class="state-dot"></i>Checking</span>';
      notes = '';
    } else if (!status.installed) {
      stateBadge = '<span class="state"><i class="state-dot"></i>Not detected</span>';
      notes = `<div class="note">${
        status.detail
          ? esc(status.detail)
          : `${esc(meta.name)} was not found on this machine. Install it first, then come back here.`
      }</div>`;
    } else if (status.active) {
      stateBadge = '<span class="state ok"><i class="state-dot"></i>Running on OneProvider</span>';
      notes = `
        ${status.detail ? `<div class="note warn">${esc(status.detail)}</div>` : ''}
        ${meta.caveat ? `<div class="note">${meta.caveat}</div>` : ''}
        <div class="note warn">Uninstalling this extension does <b>not</b> undo this — VS Code runs no code on uninstall. Switch back to <b>${esc(meta.defaultLabel)}</b> first if you want ${esc(meta.name)} on its own provider.</div>`;
    } else {
      stateBadge = '<span class="state"><i class="state-dot"></i>On its own model</span>';
      notes = `
        ${status.detail ? `<div class="note warn">${esc(status.detail)}</div>` : ''}
        <div class="note">${meta.how}</div>
        <ol class="steps">${meta.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
        ${meta.caveat ? `<div class="note">${meta.caveat}</div>` : ''}`;
    }

    const restartBanner = pendingRestart[target]
      ? `<div class="restart">
           <div class="restart-text">
             <b>Restart needed.</b> ${esc(meta.name)}'s config on disk is updated, but a session that is
             <b>already running keeps the model it started with</b> — which is why it can still answer as the
             old one. Reload the window, then start a new ${esc(meta.name)} session. A CLI running in a
             terminal has to be restarted on its own.
           </div>
           <button class="btn btn-primary" data-reload>⟳ Reload window</button>
         </div>`
      : '';

    meta.body.innerHTML = `
      ${restartBanner}
      <div class="section-head">
        <h2 class="section-title">[ ${esc(meta.name)} ]</h2>
        <span class="section-meta">${roster.length} saved · one runs at a time</span>
      </div>

      <div class="unit ${activeId ? 'running' : ''}" style="border:var(--hairline);">
        <div class="unit-head">
          <div>
            <div class="unit-name">${esc(meta.name)}</div>
            ${status && status.configPath ? `<code class="unit-slug">${esc(status.configPath)}</code>` : ''}
          </div>
          <div class="unit-actions">${stateBadge}</div>
        </div>
        ${notes}
      </div>

      <div class="stack">
        ${roster.map((entry) => renderRosterRow(target, entry, activeId, installed)).join('')}
        <div class="unit ${activeId ? '' : 'running'}">
          <div class="unit-head">
            <div>
              <div class="unit-name">${esc(meta.defaultLabel)}</div>
              <span class="unit-slug">Default — Maestro's config is removed and the original settings restored</span>
            </div>
            <div class="unit-actions">
              ${
                activeId
                  ? '<button class="btn" data-use-default>Use default</button>'
                  : '<span class="unit-state">✓ In use</span>'
              }
            </div>
          </div>
        </div>
      </div>

      ${
        roster.length === 0
          ? `<div class="note">Nothing saved yet — open <b>Browse</b> and press <b>+ ${esc(meta.name.split(' ')[0])}</b> on a model card.</div>`
          : ''
      }
    `;

    bindAgentEvents(target, meta.body);
  }

  function renderRosterRow(target, entry, activeId, installed) {
    const isActive = entry.id === activeId;
    const id = esc(entry.id);
    const actions = `
      ${
        isActive
          ? '<span class="unit-state">● Active</span>'
          : `<button class="btn btn-primary" data-activate="${id}" ${installed ? '' : 'disabled'}>Activate</button>`
      }
      <button class="btn btn-danger" data-drop="${id}">Remove</button>`;

    return renderUnit({ id: entry.id, name: entry.name, actions, running: isActive });
  }

  function bindAgentEvents(target, container) {
    const reload = container.querySelector('[data-reload]');
    if (reload) {
      reload.addEventListener('click', () => vscodeApi.postMessage({ type: 'reloadWindow' }));
    }

    container.querySelectorAll('[data-activate]').forEach((btn) => {
      btn.addEventListener('click', () =>
        vscodeApi.postMessage({
          type: 'activateAgentModel',
          target,
          modelId: btn.dataset.activate,
        }),
      );
    });

    container.querySelectorAll('[data-drop]').forEach((btn) => {
      btn.addEventListener('click', () =>
        vscodeApi.postMessage({ type: 'removeFromAgent', target, modelId: btn.dataset.drop }),
      );
    });

    const useDefault = container.querySelector('[data-use-default]');
    if (useDefault) {
      useDefault.addEventListener('click', () =>
        vscodeApi.postMessage({ type: 'deactivateAgent', target }),
      );
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function clearFilters() {
    Filters.reset();
    dom.search.value = '';
    dom.searchClear.classList.remove('visible');
    [dom.fVision, dom.fTools, dom.fThinking, dom.fLive].forEach((el) => {
      el.classList.remove('active');
      el.setAttribute('aria-pressed', 'false');
    });
    dom.fBrand.value = '';
    dom.fSort.value = 'default';
    renderModels();
  }

  function toast(message, kind) {
    const el = document.createElement('div');
    el.className = `toast ${kind || 'info'}`;
    el.textContent = message;
    dom.toasts.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(12px)';
      setTimeout(() => el.remove(), 220);
    }, 5000);
  }

  function fmtTokens(count) {
    if (!count) {
      return '—';
    }
    if (count >= 1_000_000) {
      // 1_048_576 is "1M", not "1.0M" — a context window is a round claim.
      return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    }
    if (count >= 1000) {
      return `${Math.round(count / 1000)}K`;
    }
    return String(count);
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
