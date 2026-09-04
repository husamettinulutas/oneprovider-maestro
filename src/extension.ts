import * as vscode from 'vscode';
import { OneProviderClient } from './api/oneProviderClient';
import { UsageClient } from './api/usageClient';
import { ModelCache } from './cache/modelCache';
import { ModelBrowserProvider } from './views/webviewProvider';
import { OneProviderChatProvider } from './provider/oneProviderChatProvider';
import { SecretsManager } from './utils/secrets';
import { Logger } from './utils/logger';
import { AgentIntegration } from './integrations/agentIntegration';
import { ClaudeCodeIntegration } from './integrations/claudeCode';
import { CodexIntegration } from './integrations/codex';
import { AgentTarget } from './types/models';
import { SessionUsageTracker } from './session/sessionUsage';
import { UsageStatusBar } from './session/statusBar';
import { catalogModels } from './catalog/modelCatalog';
import { compileEffortPattern } from './utils/reasoningEffort';

const PROVIDER_VENDOR_ID = 'oneprovider-maestro';

/**
 * Make sure Copilot can run its own utility tasks on the BYOK model.
 * Without this, Copilot throws "No utility model is configured for
 * 'copilot-utility-small'" the first time it needs one. Only set when the user
 * has not configured it themselves.
 */
async function ensureByokUtilityDefault(): Promise<void> {
  try {
    const config = vscode.workspace.getConfiguration();
    const inspected = config.inspect<string>('chat.byokUtilityModelDefault');
    const alreadySet =
      inspected?.globalValue !== undefined ||
      inspected?.workspaceValue !== undefined ||
      inspected?.workspaceFolderValue !== undefined;

    if (!alreadySet) {
      await config.update(
        'chat.byokUtilityModelDefault',
        'mainAgent',
        vscode.ConfigurationTarget.Global,
      );
      Logger.info("Set 'chat.byokUtilityModelDefault' to 'mainAgent'");
    }
  } catch (error) {
    Logger.warn('Failed to set chat.byokUtilityModelDefault', error);
  }
}

/** Quick-pick a model from the cache (tool-calling models first). */
async function pickModel(
  cache: ModelCache,
  placeholder: string,
  filter?: (id: string) => boolean,
): Promise<string | undefined> {
  const models = cache.getModels().filter((m) => !filter || filter(m.id));
  if (models.length === 0) {
    vscode.window.showWarningMessage(
      'No OneProvider models available. Run "OneProvider Maestro: Sync Models from API" first.',
    );
    return undefined;
  }

  const sorted = [...models].sort((a, b) => {
    if (a.capabilities.toolCalling !== b.capabilities.toolCalling) {
      return a.capabilities.toolCalling ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  const picked = await vscode.window.showQuickPick(
    sorted.map((m) => ({
      label: m.name,
      description: m.id,
      detail: [
        m.pricing
          ? `$${m.pricing.input.toFixed(2)}/M in · $${m.pricing.output.toFixed(2)}/M out`
          : 'usage-priced',
        `${Math.round(m.contextLength / 1000)}K context`,
        m.capabilities.toolCalling ? '🔧 tools' : undefined,
        m.catalogOnly ? '⚠ catalog only' : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
    })),
    { placeHolder: placeholder, matchOnDescription: true },
  );
  return picked?.description;
}

/** Apply a model to an external agent from the command palette. */
async function applyToAgentCommand(
  integration: AgentIntegration,
  cache: ModelCache,
  secrets: SecretsManager,
  agentLabel: string,
  filter?: (id: string) => boolean,
): Promise<void> {
  const modelId = await pickModel(cache, `Select the OneProvider model to use in ${agentLabel}`, filter);
  if (!modelId) {
    return;
  }

  let apiKey = await secrets.getApiKey();
  if (!apiKey) {
    if (await secrets.promptForApiKey()) {
      apiKey = await secrets.getApiKey();
    }
  }
  if (!apiKey) {
    return;
  }

  const meta = cache.getModel(modelId);
  try {
    const status = await integration.apply(modelId, apiKey, {
      contextLength: meta?.contextLength,
      maxOutputTokens: meta?.maxOutputTokens,
      supportsReasoning: meta?.capabilities.reasoning,
      platform: meta?.platform,
    });
    vscode.window.showInformationMessage(
      `✅ ${agentLabel} now uses ${modelId} via OneProvider. ${status.detail || ''}`.trim(),
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to configure ${agentLabel}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/** Restore an external agent's default provider from the command palette. */
async function restoreAgentCommand(
  integration: AgentIntegration,
  agentLabel: string,
): Promise<void> {
  try {
    await integration.restore();
    vscode.window.showInformationMessage(`✅ ${agentLabel} restored to its default provider.`);
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to restore ${agentLabel}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

export function activate(context: vscode.ExtensionContext) {
  Logger.init();
  Logger.info('OneProvider Maestro activating...');

  ensureByokUtilityDefault();

  const secrets = new SecretsManager(context.secrets);
  const apiClient = new OneProviderClient();
  const usageClient = new UsageClient();
  const cache = new ModelCache(context.globalState);
  const sessionUsage = new SessionUsageTracker();

  const claudeCode = new ClaudeCodeIntegration(context.globalState);
  const codex = new CodexIntegration(context.globalState);
  const integrations: AgentIntegration[] = [claudeCode, codex];

  const chatProvider = new OneProviderChatProvider(
    cache,
    secrets,
    context.globalState,
    sessionUsage,
  );

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(PROVIDER_VENDOR_ID, chatProvider),
  );

  const statusBar = new UsageStatusBar();
  context.subscriptions.push(statusBar);
  context.subscriptions.push({ dispose: sessionUsage.onDidChange((s) => statusBar.setSession(s)) });
  statusBar.setSession(sessionUsage.summary());

  const browserProvider = new ModelBrowserProvider(
    context.extensionUri,
    apiClient,
    usageClient,
    cache,
    secrets,
    context.globalState,
    sessionUsage,
    chatProvider,
    integrations,
  );
  browserProvider.onUsageChanged = (usage, error) => statusBar.setAccount(usage, error);
  context.subscriptions.push(browserProvider);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ModelBrowserProvider.viewType, browserProvider),
  );

  // ── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('oneproviderMaestro.openBrowser', () => {
      browserProvider.openAsPanel();
    }),

    vscode.commands.registerCommand('oneproviderMaestro.setApiKey', async () => {
      if (await secrets.promptForApiKey()) {
        const key = await secrets.getApiKey();
        if (key) {
          apiClient.setApiKey(key);
        }
        chatProvider.refresh();
        await browserProvider.handleSyncModels();
        await browserProvider.refreshUsage({ force: true });
      }
    }),

    vscode.commands.registerCommand('oneproviderMaestro.syncModels', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Syncing OneProvider models...',
          cancellable: false,
        },
        async () => {
          await browserProvider.handleSyncModels();
          const live = cache.liveCount();
          vscode.window.showInformationMessage(
            `✅ ${live} model(s) available for your key (${cache.getModels().length} listed).`,
          );
        },
      );
    }),

    vscode.commands.registerCommand('oneproviderMaestro.refreshUsage', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: 'Refreshing OneProvider balance...',
        },
        () => browserProvider.refreshUsage({ force: true }),
      );
    }),

    vscode.commands.registerCommand('oneproviderMaestro.resetSessionUsage', () => {
      sessionUsage.reset();
      vscode.window.showInformationMessage('Session spend counter reset.');
    }),

    vscode.commands.registerCommand('oneproviderMaestro.claudeCode.apply', () =>
      applyToAgentCommand(claudeCode, cache, secrets, 'Claude Code', (id) => {
        // Claude Code speaks the Anthropic wire; OneProvider only routes Claude
        // ids over it, so the picker should not offer the rest.
        return cache.getModel(id)?.platform === 'anthropic';
      }),
    ),
    vscode.commands.registerCommand('oneproviderMaestro.claudeCode.restore', () =>
      restoreAgentCommand(claudeCode, 'Claude Code'),
    ),
    vscode.commands.registerCommand('oneproviderMaestro.codex.apply', () =>
      applyToAgentCommand(codex, cache, secrets, 'Codex'),
    ),
    vscode.commands.registerCommand('oneproviderMaestro.codex.restore', () =>
      restoreAgentCommand(codex, 'Codex'),
    ),

    vscode.commands.registerCommand('oneproviderMaestro.showStatus', async () => {
      const label: Record<AgentTarget, string> = {
        copilot: 'Copilot',
        'claude-code': 'Claude Code',
        codex: 'Codex',
      };
      const lines: string[] = [];
      for (const integration of integrations) {
        try {
          const s = await integration.getStatus();
          const state = !s.installed
            ? 'not detected'
            : s.active
              ? `using OneProvider (${s.modelId || 'model unknown'})`
              : 'installed, using its own defaults';
          lines.push(`${label[integration.target]}: ${state}`);
        } catch {
          lines.push(`${label[integration.target]}: status check failed`);
        }
      }
      vscode.window.showInformationMessage(`OneProvider Maestro — ${lines.join(' · ')}`);
    }),
  );

  // Re-render the status bar and restart the timer when the relevant settings
  // change, so toggling them does not need a window reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('oneproviderMaestro.statusBar.mode')) {
        statusBar.render();
      }
      if (
        event.affectsConfiguration('oneproviderMaestro.usage.autoRefreshMinutes') ||
        event.affectsConfiguration('oneproviderMaestro.usage.enabled')
      ) {
        browserProvider.startAutoRefresh();
        void browserProvider.refreshUsage({ force: true });
      }
    }),
  );

  // A key change invalidates both the model list and the balance.
  context.subscriptions.push(
    secrets.onDidChange(async () => {
      const key = await secrets.getApiKey();
      if (key) {
        apiClient.setApiKey(key);
      } else {
        apiClient.clearApiKey();
      }
      await browserProvider.refreshUsage({ force: true });
    }),
  );

  // Paint from the persisted cache first, then fall back to the bundled catalog
  // so the browser is never empty before the first sync.
  cache.loadFromDisk().then(async (models) => {
    if (models.length > 0) {
      Logger.info(`Loaded ${models.length} cached models on startup`);
      chatProvider.refresh();
      return;
    }
    const config = vscode.workspace.getConfiguration('oneproviderMaestro');
    cache.seed(
      catalogModels(
        compileEffortPattern(config.get<string>('reasoningEffortModelPattern', '^gpt-5')),
        config.get<string | null>('defaultReasoningEffort', null),
      ),
    );
  });

  browserProvider.startAutoRefresh();
  void browserProvider.refreshUsage({});

  Logger.info('OneProvider Maestro activated ✅');
}

export function deactivate() {
  Logger.info('OneProvider Maestro deactivating...');
  Logger.dispose();
}
