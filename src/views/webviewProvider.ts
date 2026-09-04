import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { OneProviderClient } from '../api/oneProviderClient';
import { UsageClient, normalizeRange } from '../api/usageClient';
import { OneProviderChatProvider } from '../provider/oneProviderChatProvider';
import { ModelCache } from '../cache/modelCache';
import { SecretsManager } from '../utils/secrets';
import { Logger } from '../utils/logger';
import {
  WebviewMessage,
  ExtensionMessage,
  SelectedModel,
  ExternalAgentTarget,
  AgentModelEntry,
  AgentRoster,
  IntegrationStatus,
  AccountUsage,
} from '../types/models';
import { AgentIntegration } from '../integrations/agentIntegration';
import { SessionUsageTracker } from '../session/sessionUsage';

const SELECTED_MODELS_KEY = 'oneprovider-selected-models';

/** globalState key holding the saved model list of each external agent. */
const AGENT_ROSTERS_KEY = 'maestro-agent-rosters';

/** Agents that keep a saved model list (Copilot uses SELECTED_MODELS_KEY). */
const EXTERNAL_AGENTS: ExternalAgentTarget[] = ['claude-code', 'codex'];

/** Human-readable agent names for user-facing messages. */
const AGENT_LABELS: Record<ExternalAgentTarget, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

/** Result of one usage fetch, cached so tab switches do not re-hit the API. */
interface UsageState {
  usage?: AccountUsage;
  error?: string;
  loading: boolean;
}

/**
 * Hosts the webview and brokers every message between it and the extension.
 * Also owns balance/usage fetching, since the same numbers feed both the Usage
 * tab and the status bar.
 */
export class ModelBrowserProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'oneprovider-maestro-browse';

  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;

  private usageState: UsageState = { loading: false };
  private usageRange: number;
  private refreshTimer?: ReturnType<typeof setInterval>;

  /** Notifies the status bar whenever account usage changes. */
  onUsageChanged?: (usage: AccountUsage | undefined, error?: string) => void;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly apiClient: OneProviderClient,
    private readonly usageClient: UsageClient,
    private readonly cache: ModelCache,
    private readonly secrets: SecretsManager,
    private readonly globalState: vscode.Memento,
    private readonly sessionUsage: SessionUsageTracker,
    private readonly chatProvider?: OneProviderChatProvider,
    private readonly integrations: AgentIntegration[] = [],
  ) {
    this.usageRange = normalizeRange(
      vscode.workspace
        .getConfiguration('oneproviderMaestro')
        .get<number>('usage.defaultRangeDays', 1),
    );

    // A finished request changes session spend, which both surfaces show.
    this.sessionUsage.onDidChange(() => this.broadcastUsage());
  }

  // ── View plumbing ──────────────────────────────────────────────────────────

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'resources'),
      ],
    };
    webviewView.webview.html = this.getWebviewContent(webviewView.webview);
    this.setupMessageHandler(webviewView.webview);
  }

  /** Open the browser as a full editor panel. */
  openAsPanel(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'oneprovider-maestro-browser',
      'OneProvider Maestro',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'webview'),
          vscode.Uri.joinPath(this.extensionUri, 'resources'),
        ],
      },
    );

    this.panel.iconPath = new vscode.ThemeIcon('sparkle');
    this.panel.webview.html = this.getWebviewContent(this.panel.webview);
    this.setupMessageHandler(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  dispose(): void {
    this.stopAutoRefresh();
  }

  /** Every live webview surface — sidebar view and editor panel can coexist. */
  private webviews(): vscode.Webview[] {
    const list: vscode.Webview[] = [];
    if (this.view) {
      list.push(this.view.webview);
    }
    if (this.panel) {
      list.push(this.panel.webview);
    }
    return list;
  }

  private broadcast(message: ExtensionMessage): void {
    for (const webview of this.webviews()) {
      webview.postMessage(message);
    }
  }

  private setupMessageHandler(webview: vscode.Webview): void {
    webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      try {
        switch (message.type) {
          case 'ready':
            await this.handleReady(webview);
            break;
          case 'toggleCopilot':
            await this.handleToggleCopilot(webview, message.modelId);
            break;
          case 'removeActiveModel':
            await this.handleRemoveActiveModel(webview, message.modelId);
            break;
          case 'setReasoningEffort':
            await this.handleSetReasoningEffort(webview, message.modelId, message.effort);
            break;
          case 'addToAgent':
            await this.handleAddToAgent(webview, message.target, message.modelId);
            break;
          case 'removeFromAgent':
            await this.handleRemoveFromAgent(webview, message.target, message.modelId);
            break;
          case 'activateAgentModel':
            await this.handleActivateAgentModel(webview, message.target, message.modelId);
            break;
          case 'deactivateAgent':
          case 'restoreIntegration':
            await this.handleRestoreIntegration(webview, message.target);
            break;
          case 'getAgentRosters':
            await this.sendAgentRosters(webview);
            break;
          case 'reloadWindow':
            // Claude Code and Codex read their config at launch. A running
            // session keeps whatever it loaded, so switching models only takes
            // effect after the agent restarts.
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
            break;
          case 'getIntegrationStatus':
            await this.sendIntegrationStatus(webview);
            break;
          case 'setApiKey':
            await this.handleSetApiKey(webview);
            break;
          case 'syncModels':
            await this.handleSyncModels();
            break;
          case 'getSelectedModels':
            await this.sendSelectedModels(webview);
            await this.sendActiveModels(webview);
            break;
          case 'getApiKeyStatus':
            await this.sendApiKeyStatus(webview);
            break;
          case 'getUsage':
            await this.refreshUsage({ days: message.days, force: message.force });
            break;
          case 'resetSessionUsage':
            this.sessionUsage.reset();
            break;
          case 'openExternal':
            await vscode.env.openExternal(vscode.Uri.parse(message.url));
            break;
        }
      } catch (error) {
        Logger.error('Webview message handler error', error);
        webview.postMessage({
          type: 'error',
          message: error instanceof Error ? error.message : 'Unknown error occurred',
        } satisfies ExtensionMessage);
      }
    });
  }

  private async handleReady(webview: vscode.Webview): Promise<void> {
    await this.sendApiKeyStatus(webview);

    if (this.cache.hasModels()) {
      this.sendModels(webview);
    }

    await this.sendSelectedModels(webview);
    await this.sendActiveModels(webview);
    await this.sendAgentRosters(webview);
    await this.sendIntegrationStatus(webview);
    this.broadcastUsage();

    if (this.cache.isStale()) {
      await this.handleSyncModels();
    }
    await this.refreshUsage({});
  }

  // ── Usage & balance ────────────────────────────────────────────────────────

  /**
   * Fetch balance and usage for the stored key.
   *
   * Results are cached in `usageState` so switching tabs is free; `force` (the
   * refresh button) and a range change always re-fetch.
   */
  async refreshUsage(options: { days?: number; force?: boolean } = {}): Promise<void> {
    const nextRange = normalizeRange(options.days ?? this.usageRange);
    const rangeChanged = nextRange !== this.usageRange;
    this.usageRange = nextRange;

    if (!UsageClient.isEnabled()) {
      this.usageState = {
        loading: false,
        error: 'Live balance and usage are turned off in settings (oneproviderMaestro.usage.enabled).',
      };
      this.broadcastUsage();
      return;
    }

    const apiKey = await this.secrets.getApiKey();
    if (!apiKey) {
      this.usageState = { loading: false, error: 'Set your OneProvider API key to see balance and usage.' };
      this.broadcastUsage();
      return;
    }

    const isFresh =
      !options.force &&
      !rangeChanged &&
      this.usageState.usage &&
      Date.now() - this.usageState.usage.fetchedAt < 30_000;
    if (isFresh) {
      this.broadcastUsage();
      return;
    }

    this.usageState = { ...this.usageState, loading: true, error: undefined };
    this.broadcastUsage();

    try {
      const usage = await this.usageClient.fetch(apiKey, this.usageRange);
      this.usageState = { usage, loading: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Balance lookup failed';
      Logger.warn(`Usage lookup failed: ${message}`);
      // Keep the last good reading on screen — a transient lookup failure
      // should not blank out the balance the user was just looking at.
      this.usageState = { usage: this.usageState.usage, loading: false, error: message };
    }

    this.broadcastUsage();
  }

  /** Push session + account usage to every webview and the status bar. */
  private broadcastUsage(): void {
    const session = this.sessionUsage.summary();
    this.broadcast({
      type: 'usageUpdated',
      usage: this.usageState.usage,
      session,
      error: this.usageState.error,
      loading: this.usageState.loading,
    });
    this.onUsageChanged?.(this.usageState.usage, this.usageState.error);
  }

  /** Start (or restart) the background balance refresh timer. */
  startAutoRefresh(): void {
    this.stopAutoRefresh();
    const minutes = vscode.workspace
      .getConfiguration('oneproviderMaestro')
      .get<number>('usage.autoRefreshMinutes', 5);
    if (!minutes || minutes <= 0) {
      return;
    }
    this.refreshTimer = setInterval(() => {
      void this.refreshUsage({ force: true });
    }, minutes * 60 * 1000);
  }

  private stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  // ── Copilot ────────────────────────────────────────────────────────────────

  /**
   * One-click toggle of a model in Copilot Chat: adds it enabled, or removes it
   * entirely.
   */
  private async handleToggleCopilot(webview: vscode.Webview, modelId: string): Promise<void> {
    const selected = this.getSelectedModels();
    const existing = selected.find((m) => m.id === modelId);
    const model = this.cache.getModel(modelId);
    const name = model?.name || existing?.name || modelId;

    let enabled: boolean;
    if (existing?.enabled) {
      await this.saveSelectedModels(selected.filter((m) => m.id !== modelId));
      enabled = false;
    } else {
      // Adding a model: make sure requests can actually authenticate.
      if (!(await this.secrets.hasApiKey())) {
        const didSet = await this.secrets.promptForApiKey();
        if (!didSet) {
          webview.postMessage({
            type: 'copilotToggled',
            modelId,
            enabled: false,
            message: 'A OneProvider API key is required to use models in Copilot.',
          } satisfies ExtensionMessage);
          return;
        }
      }
      if (existing) {
        existing.enabled = true;
      } else {
        selected.push({ id: modelId, name, addedAt: Date.now(), enabled: true });
      }
      await this.saveSelectedModels(selected);
      enabled = true;
    }

    this.chatProvider?.refresh();
    await this.sendSelectedModels(webview);
    await this.sendActiveModels(webview);
    webview.postMessage({
      type: 'copilotToggled',
      modelId,
      enabled,
      message: enabled
        ? `✅ ${name} is now available in Copilot Chat`
        : `${name} removed from Copilot Chat`,
    } satisfies ExtensionMessage);
  }

  private async handleRemoveActiveModel(webview: vscode.Webview, modelId: string): Promise<void> {
    await this.saveSelectedModels(this.getSelectedModels().filter((m) => m.id !== modelId));
    this.chatProvider?.refresh();
    await this.sendSelectedModels(webview);
    await this.sendActiveModels(webview);
  }

  /** Persist a per-model thinking-effort override and refresh the picker. */
  private async handleSetReasoningEffort(
    webview: vscode.Webview,
    modelId: string,
    effort: string,
  ): Promise<void> {
    const selected = this.getSelectedModels();
    const model = selected.find((m) => m.id === modelId);
    if (!model) {
      return;
    }
    model.reasoningEffort = effort;
    await this.saveSelectedModels(selected);
    this.chatProvider?.refresh();
    await this.sendSelectedModels(webview);
    await this.sendActiveModels(webview);
  }

  // ── Agent model lists (Claude Code / Codex) ────────────────────────────────

  private getAgentRoster(target: ExternalAgentTarget): AgentModelEntry[] {
    const all =
      this.globalState.get<Partial<Record<ExternalAgentTarget, AgentModelEntry[]>>>(
        AGENT_ROSTERS_KEY,
      ) || {};
    return [...(all[target] || [])];
  }

  private async saveAgentRoster(
    target: ExternalAgentTarget,
    entries: AgentModelEntry[],
  ): Promise<void> {
    const all =
      this.globalState.get<Partial<Record<ExternalAgentTarget, AgentModelEntry[]>>>(
        AGENT_ROSTERS_KEY,
      ) || {};
    await this.globalState.update(AGENT_ROSTERS_KEY, { ...all, [target]: entries });
  }

  /**
   * Put a model in an agent's list. Membership alone writes nothing to the
   * agent's config — only activation does.
   */
  private async addToRoster(target: ExternalAgentTarget, modelId: string): Promise<boolean> {
    const roster = this.getAgentRoster(target);
    if (roster.some((m) => m.id === modelId)) {
      return false;
    }
    const meta = this.cache.getModel(modelId);
    roster.push({ id: modelId, name: meta?.name || modelId, addedAt: Date.now() });
    await this.saveAgentRoster(target, roster);
    return true;
  }

  private async sendAgentRosters(webview: vscode.Webview): Promise<void> {
    const rosters: AgentRoster[] = EXTERNAL_AGENTS.map((target) => ({
      target,
      models: this.getAgentRoster(target),
    }));
    webview.postMessage({ type: 'agentRostersUpdated', rosters } satisfies ExtensionMessage);
  }

  /**
   * Add a model to an agent's list. If that agent is still on its own provider,
   * activate it too, so a single click keeps working; once something is active,
   * further additions only join the list.
   */
  private async handleAddToAgent(
    webview: vscode.Webview,
    target: ExternalAgentTarget,
    modelId: string,
  ): Promise<void> {
    const model = this.cache.getModel(modelId);
    if (target === 'claude-code' && model && model.platform !== 'anthropic') {
      webview.postMessage({
        type: 'integrationApplied',
        target,
        success: false,
        message: `${model.name} runs over OneProvider's OpenAI-compatible wire, which Claude Code cannot speak. Use it in Codex or Copilot instead.`,
      } satisfies ExtensionMessage);
      return;
    }

    const isNew = await this.addToRoster(target, modelId);
    await this.sendAgentRosters(webview);

    const label = AGENT_LABELS[target];
    const name = model?.name || modelId;
    const integration = this.integrations.find((i) => i.target === target);

    let status: IntegrationStatus | undefined;
    if (integration) {
      try {
        status = await integration.getStatus();
      } catch (error) {
        Logger.warn(`Failed to read ${target} status before add`, error);
      }
    }

    if (integration && status?.installed && !status.active) {
      await this.handleActivateAgentModel(webview, target, modelId);
      return;
    }

    webview.postMessage({
      type: 'integrationApplied',
      target,
      success: true,
      message: isNew
        ? `${name} added to the ${label} list — activate it in the ${label} tab.`
        : `${name} is already in the ${label} list.`,
    } satisfies ExtensionMessage);
  }

  /**
   * Drop a model from an agent's list. If it is the active one, the agent goes
   * back to its own provider first.
   */
  private async handleRemoveFromAgent(
    webview: vscode.Webview,
    target: ExternalAgentTarget,
    modelId: string,
  ): Promise<void> {
    const integration = this.integrations.find((i) => i.target === target);
    let wasActive = false;

    if (integration) {
      try {
        const status = await integration.getStatus();
        wasActive = !!status.active && status.modelId === modelId;
      } catch (error) {
        Logger.warn(`Failed to read ${target} status before remove`, error);
      }
    }

    if (wasActive) {
      await this.handleRestoreIntegration(webview, target);
    }

    await this.saveAgentRoster(
      target,
      this.getAgentRoster(target).filter((m) => m.id !== modelId),
    );
    await this.sendAgentRosters(webview);

    if (!wasActive) {
      const name = this.cache.getModel(modelId)?.name || modelId;
      webview.postMessage({
        type: 'integrationApplied',
        target,
        success: true,
        message: `${name} removed from the ${AGENT_LABELS[target]} list.`,
      } satisfies ExtensionMessage);
    }
  }

  /** Make one of the listed models the agent's active model. */
  private async handleActivateAgentModel(
    webview: vscode.Webview,
    target: ExternalAgentTarget,
    modelId: string,
  ): Promise<void> {
    const integration = this.integrations.find((i) => i.target === target);
    if (!integration) {
      webview.postMessage({
        type: 'integrationApplied',
        target,
        success: false,
        message: `No integration registered for ${target}.`,
      } satisfies ExtensionMessage);
      return;
    }

    let apiKey = await this.secrets.getApiKey();
    if (!apiKey) {
      if (await this.secrets.promptForApiKey()) {
        apiKey = await this.secrets.getApiKey();
      }
    }
    if (!apiKey) {
      webview.postMessage({
        type: 'integrationApplied',
        target,
        success: false,
        message: 'A OneProvider API key is required to wire a model into an agent.',
      } satisfies ExtensionMessage);
      return;
    }

    try {
      const meta = this.cache.getModel(modelId);
      const status = await integration.apply(modelId, apiKey, {
        contextLength: meta?.contextLength,
        maxOutputTokens: meta?.maxOutputTokens,
        supportsReasoning: meta?.capabilities?.reasoning,
        platform: meta?.platform,
      });
      await this.addToRoster(target, modelId);
      await this.sendAgentRosters(webview);
      webview.postMessage({
        type: 'integrationApplied',
        target,
        success: true,
        message: `${modelId} is now active in ${AGENT_LABELS[target]}. ${status.detail || ''}`.trim(),
      } satisfies ExtensionMessage);
    } catch (error) {
      Logger.error(`Failed to apply model to ${target}`, error);
      webview.postMessage({
        type: 'integrationApplied',
        target,
        success: false,
        message: `Failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      } satisfies ExtensionMessage);
    }

    await this.sendIntegrationStatus(webview);
  }

  /**
   * Put an agent back on its own model. The saved list is kept — this only
   * un-wires the config, so any entry can be re-activated later.
   */
  private async handleRestoreIntegration(
    webview: vscode.Webview,
    target: ExternalAgentTarget,
  ): Promise<void> {
    const integration = this.integrations.find((i) => i.target === target);
    if (!integration) {
      return;
    }

    try {
      await integration.restore();
      webview.postMessage({
        type: 'integrationApplied',
        target,
        success: true,
        message: `${AGENT_LABELS[target]} is back on its own model. Your saved list is kept.`,
      } satisfies ExtensionMessage);
    } catch (error) {
      Logger.error(`Failed to restore ${target}`, error);
      webview.postMessage({
        type: 'integrationApplied',
        target,
        success: false,
        message: `Restore failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      } satisfies ExtensionMessage);
    }

    await this.sendIntegrationStatus(webview);
  }

  private async sendIntegrationStatus(webview: vscode.Webview): Promise<void> {
    const statuses: IntegrationStatus[] = [];
    let rostersChanged = false;

    for (const integration of this.integrations) {
      try {
        const status = await integration.getStatus();
        statuses.push(status);

        // A model can become active without passing through the list — an apply
        // from the command palette, or a config written by an older version.
        // Adopt it so the list always shows what is really wired in.
        const target = status.target as ExternalAgentTarget;
        if (status.active && status.modelId && EXTERNAL_AGENTS.includes(target)) {
          rostersChanged = (await this.addToRoster(target, status.modelId)) || rostersChanged;
        }
      } catch (error) {
        Logger.warn(`Failed to get status for ${integration.target}`, error);
        statuses.push({
          target: integration.target,
          installed: false,
          active: false,
          detail: `Status check failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        });
      }
    }

    if (rostersChanged) {
      await this.sendAgentRosters(webview);
    }
    webview.postMessage({ type: 'integrationStatus', statuses } satisfies ExtensionMessage);
  }

  // ── Models ─────────────────────────────────────────────────────────────────

  private sendModels(target?: vscode.Webview): void {
    const models = this.cache.getModels();
    const message: ExtensionMessage = {
      type: 'modelsLoaded',
      models,
      total: models.length,
      lastSync: this.cache.getMetadata()?.lastUpdated,
    };
    if (target) {
      target.postMessage(message);
    } else {
      this.broadcast(message);
    }
  }

  async handleSyncModels(): Promise<void> {
    this.broadcast({ type: 'loading', isLoading: true });

    try {
      const key = await this.secrets.getApiKey();
      if (key) {
        this.apiClient.setApiKey(key);
      } else {
        this.apiClient.clearApiKey();
      }

      const previousLive = new Set(this.cache.getModels().filter((m) => m.live).map((m) => m.id));
      const models = await this.apiClient.fetchModels();
      await this.cache.saveModels(models);

      const newCount = models.filter((m) => m.live && !previousLive.has(m.id)).length;
      this.chatProvider?.refresh();
      this.sendModels();
      this.broadcast({ type: 'syncComplete', newModelsCount: newCount });
    } catch (error) {
      this.broadcast({
        type: 'error',
        message: `Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    } finally {
      this.broadcast({ type: 'loading', isLoading: false });
    }
  }

  private async handleSetApiKey(webview: vscode.Webview): Promise<void> {
    if (await this.secrets.promptForApiKey()) {
      const key = await this.secrets.getApiKey();
      if (key) {
        this.apiClient.setApiKey(key);
      }
      this.chatProvider?.refresh();
      await this.handleSyncModels();
      await this.refreshUsage({ force: true });
    }
    await this.sendApiKeyStatus(webview);
  }

  private async sendSelectedModels(webview: vscode.Webview): Promise<void> {
    webview.postMessage({
      type: 'selectedModelsUpdated',
      models: this.getSelectedModels(),
    } satisfies ExtensionMessage);
  }

  private async sendActiveModels(webview: vscode.Webview): Promise<void> {
    const selected = this.getSelectedModels();
    const allModels = this.cache.getModels();

    const activeModels = selected
      .filter((s) => s.enabled)
      .map((s) => {
        const full = allModels.find((m) => m.id === s.id);
        return {
          id: s.id,
          name: full ? full.name : s.name,
          url: 'https://api.oneprovider.dev/v1/chat/completions',
          toolCalling: full ? full.capabilities.toolCalling : true,
          vision: full ? full.capabilities.vision : false,
          maxInputTokens: full ? full.contextLength : 128_000,
          maxOutputTokens: full ? full.maxOutputTokens : 4096,
          reasoningEffort: s.reasoningEffort || full?.reasoning?.defaultEffort,
          supportedEfforts: full?.reasoning?.supportedEfforts,
        };
      });

    webview.postMessage({
      type: 'activeModelsUpdated',
      models: activeModels,
    } satisfies ExtensionMessage);
  }

  private async sendApiKeyStatus(webview: vscode.Webview): Promise<void> {
    webview.postMessage({
      type: 'apiKeyStatus',
      hasKey: await this.secrets.hasApiKey(),
    } satisfies ExtensionMessage);
  }

  getSelectedModels(): SelectedModel[] {
    return this.globalState.get<SelectedModel[]>(SELECTED_MODELS_KEY) || [];
  }

  private async saveSelectedModels(models: SelectedModel[]): Promise<void> {
    await this.globalState.update(SELECTED_MODELS_KEY, models);
  }

  // ── HTML ───────────────────────────────────────────────────────────────────

  private getWebviewContent(webview: vscode.Webview): string {
    const getUri = (...segments: string[]) =>
      webview
        .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', ...segments))
        .toString();

    const htmlPath = path.join(this.extensionUri.fsPath, 'webview', 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');

    html = html
      .split('{{cspSource}}')
      .join(webview.cspSource)
      .split('{{variablesCssUri}}')
      .join(getUri('styles', 'variables.css'))
      .split('{{mainCssUri}}')
      .join(getUri('styles', 'main.css'))
      .split('{{cardsCssUri}}')
      .join(getUri('styles', 'cards.css'))
      .split('{{usageCssUri}}')
      .join(getUri('styles', 'usage.css'))
      .split('{{vscodeApiJsUri}}')
      .join(getUri('scripts', 'vscode-api.js'))
      .split('{{filtersJsUri}}')
      .join(getUri('scripts', 'filters.js'))
      .split('{{chartsJsUri}}')
      .join(getUri('scripts', 'charts.js'))
      .split('{{usageJsUri}}')
      .join(getUri('scripts', 'usage.js'))
      .split('{{appJsUri}}')
      .join(getUri('scripts', 'app.js'));

    return html;
  }
}
