import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentApplyOptions, AgentIntegration } from './agentIntegration';
import { IntegrationStatus } from '../types/models';
import { backupOnce, readJsonFile, sanitizeModelId, writeJsonFileAtomic } from './shared';
import { Logger } from '../utils/logger';

/**
 * OneProvider's Anthropic-native endpoint.
 * Claude Code appends `/v1/messages` itself, so there is no `/v1` suffix here.
 * Ref: https://oneprovider.dev/docs/clients/claude-code
 */
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.oneprovider.dev';

/** Host that identifies a base URL as pointing at OneProvider. */
const ONEPROVIDER_HOST = 'oneprovider.dev';

/** globalState key holding the pre-apply snapshot used by restore(). */
const SNAPSHOT_KEY = 'maestro-claude-code-snapshot';

/** The env vars Maestro manages inside Claude Code's settings "env" block. */
const MANAGED_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
] as const;

interface ClaudeSnapshot {
  /** Settings file the env block was written to. */
  settingsPath: string;
  /** Previous values of managed keys (undefined = key was absent). */
  previousEnv: Record<string, string | undefined>;
  /** Previous global value of VS Code claudeCode.environmentVariables. */
  previousVsCodeEnvVars: unknown;
  /** Previous global value of VS Code claudeCode.disableLoginPrompt. */
  previousDisableLoginPrompt?: unknown;
  /**
   * Previous top-level "model" key — it shadows ANTHROPIC_MODEL, so apply()
   * removes it and restore() puts it back.
   */
  previousTopLevelModel?: unknown;
}

interface ClaudeSettingsFile {
  env?: Record<string, string>;
  [key: string]: unknown;
}

/** Resolve the Anthropic-native base URL from settings, without a trailing slash. */
function anthropicBaseUrl(): string {
  const configured = vscode.workspace
    .getConfiguration('oneproviderMaestro')
    .get<string>('anthropicBaseUrl', DEFAULT_ANTHROPIC_BASE_URL);
  return (configured || DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '');
}

/**
 * Claude Code integration.
 *
 * Writes the ANTHROPIC_* env vars into Claude Code's settings file so both the
 * CLI and the VS Code extension talk to OneProvider's Anthropic-native
 * endpoint, and mirrors the credential into VS Code's
 * `claudeCode.environmentVariables`, which the Claude Code extension checks
 * before launching.
 */
export class ClaudeCodeIntegration implements AgentIntegration {
  readonly target = 'claude-code' as const;

  constructor(private readonly globalState: vscode.Memento) {}

  // ── Paths ──────────────────────────────────────────────────────────────────

  private get claudeDir(): string {
    return path.join(os.homedir(), '.claude');
  }

  /** Resolve the settings file to manage based on the configured scope. */
  private getSettingsPath(): string {
    const scope = vscode.workspace
      .getConfiguration('oneproviderMaestro')
      .get<string>('claudeCode.settingsScope', 'user');

    if (scope === 'project') {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (ws) {
        // settings.local.json is gitignored by Claude Code — safe for credentials.
        return path.join(ws.uri.fsPath, '.claude', 'settings.local.json');
      }
      Logger.warn(
        'claudeCode.settingsScope is "project" but no workspace is open; falling back to user scope',
      );
    }
    return path.join(this.claudeDir, 'settings.json');
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  async getStatus(): Promise<IntegrationStatus> {
    const settingsPath = this.getSettingsPath();
    const installed =
      fs.existsSync(this.claudeDir) || fs.existsSync(path.join(os.homedir(), '.claude.json'));

    let active = false;
    let modelId: string | undefined;
    let detail: string | undefined;

    try {
      const settings = readJsonFile<ClaudeSettingsFile>(settingsPath);
      const env = settings?.env;
      if (env?.ANTHROPIC_BASE_URL?.includes(ONEPROVIDER_HOST)) {
        active = true;
        modelId = env.ANTHROPIC_MODEL;
      }
      // A top-level "model" shadows ANTHROPIC_MODEL. Claude Code's /model picker
      // writes it, and the pick can go stale — surface what is really live.
      if (active && typeof settings?.model === 'string' && settings.model.trim() !== '') {
        detail = `⚠️ Claude Code's own "model" setting ("${settings.model}") overrides the model shown here. Re-activate a model in Maestro to clear it.`;
        modelId = settings.model;
      }
    } catch (err) {
      detail = `Could not parse ${settingsPath}: ${err instanceof Error ? err.message : err}`;
    }

    return { target: this.target, installed, active, modelId, configPath: settingsPath, detail };
  }

  // ── Apply ──────────────────────────────────────────────────────────────────

  async apply(
    modelId: string,
    apiKey: string,
    options?: AgentApplyOptions,
  ): Promise<IntegrationStatus> {
    modelId = sanitizeModelId(modelId);

    if (options?.platform === 'openai') {
      throw new Error(
        `${modelId} is routed over OneProvider's OpenAI-compatible wire, which Claude Code cannot speak. Pick a Claude model (or use it in Codex/Copilot instead).`,
      );
    }

    const settingsPath = this.getSettingsPath();

    // If a previous apply targeted a different settings file (the scope setting
    // changed), un-wire that file first so two files never stay wired at once.
    const existingSnapshot = this.globalState.get<ClaudeSnapshot>(SNAPSHOT_KEY);
    if (existingSnapshot && existingSnapshot.settingsPath !== settingsPath) {
      await this.restore();
    }

    backupOnce(settingsPath);

    let settings: ClaudeSettingsFile;
    try {
      settings = readJsonFile<ClaudeSettingsFile>(settingsPath) ?? {};
    } catch (err) {
      throw new Error(
        `${settingsPath} contains invalid JSON — fix or delete it first (${err instanceof Error ? err.message : err})`,
      );
    }

    const env: Record<string, string> = { ...(settings.env ?? {}) };

    // Snapshot previous values once (first apply wins) so restore() returns to
    // the true pre-Maestro state even after switching models repeatedly.
    if (!this.globalState.get<ClaudeSnapshot>(SNAPSHOT_KEY)) {
      const previousEnv: Record<string, string | undefined> = {};
      for (const key of MANAGED_ENV_KEYS) {
        previousEnv[key] = env[key];
      }
      const snapshot: ClaudeSnapshot = {
        settingsPath,
        previousEnv,
        previousVsCodeEnvVars: vscode.workspace
          .getConfiguration()
          .inspect('claudeCode.environmentVariables')?.globalValue,
        previousDisableLoginPrompt: vscode.workspace
          .getConfiguration()
          .inspect('claudeCode.disableLoginPrompt')?.globalValue,
        previousTopLevelModel: settings.model,
      };
      await this.globalState.update(SNAPSHOT_KEY, snapshot);
    }

    const baseUrl = anthropicBaseUrl();
    const smallFast = vscode.workspace
      .getConfiguration('oneproviderMaestro')
      .get<string>('claudeCode.smallFastModel', '')
      .trim();

    env.ANTHROPIC_BASE_URL = baseUrl;
    // OneProvider's own guide uses ANTHROPIC_API_KEY (x-api-key auth). Clear
    // ANTHROPIC_AUTH_TOKEN explicitly — an inherited bearer token from another
    // gateway would otherwise take precedence and be sent to OneProvider.
    env.ANTHROPIC_API_KEY = apiKey;
    env.ANTHROPIC_AUTH_TOKEN = '';
    env.ANTHROPIC_MODEL = modelId;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = modelId;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = modelId;
    // Background/utility tasks (haiku-class): a cheaper model when configured.
    const backgroundModel = smallFast ? sanitizeModelId(smallFast) : modelId;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = backgroundModel;
    env.ANTHROPIC_SMALL_FAST_MODEL = backgroundModel;
    env.CLAUDE_CODE_SUBAGENT_MODEL = modelId;
    // Recommended by OneProvider's own setup guide: keeps Claude Code from
    // calling Anthropic-only telemetry endpoints that the gateway does not proxy.
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    // Claude Code's beta diagnostics attach Anthropic-issued message ids that a
    // gateway cannot resolve, which 400s the request.
    env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
    // Claude Code assumes a Claude-sized (200k) window; declare the model's real
    // one so auto-compaction fires before "prompt is too long".
    if (options?.contextLength && options.contextLength > 0) {
      env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(options.contextLength);
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(
        Math.min(Math.max(Math.floor(options.contextLength * 0.8), 100_000), 1_000_000),
      );
    } else {
      delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
      delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    }
    // Claude Code reserves its default 64k max_tokens on every request. A
    // prepaid gateway can refuse the reservation outright when the remaining
    // balance would not cover it, so cap it to what the model can actually emit.
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(
      options?.maxOutputTokens && options.maxOutputTokens > 0
        ? Math.min(options.maxOutputTokens, 32_000)
        : 32_000,
    );

    settings.env = env;
    // A top-level "model" setting would shadow ANTHROPIC_MODEL — remove it (the
    // snapshot keeps the original value for restore()).
    delete settings.model;
    writeJsonFileAtomic(settingsPath, settings);
    Logger.info(`Claude Code wired to OneProvider (${modelId}) via ${settingsPath}`);

    // The Claude Code VS Code extension validates credentials from its own
    // setting before launching the CLI, so mirror the credential there too.
    let detail = 'Start a new Claude Code session to pick up the change.';
    try {
      await vscode.workspace.getConfiguration().update(
        'claudeCode.environmentVariables',
        [
          { name: 'ANTHROPIC_BASE_URL', value: baseUrl },
          { name: 'ANTHROPIC_API_KEY', value: apiKey },
          { name: 'ANTHROPIC_AUTH_TOKEN', value: '' },
        ],
        vscode.ConfigurationTarget.Global,
      );
      // Without this the extension shows its Anthropic login screen instead of
      // using the gateway credentials.
      await vscode.workspace
        .getConfiguration()
        .update('claudeCode.disableLoginPrompt', true, vscode.ConfigurationTarget.Global);
    } catch (err) {
      // These settings only exist when the Claude Code extension is installed.
      Logger.warn('Could not update claudeCode.* settings (extension not installed?)', err);
      detail =
        'Claude Code VS Code extension not detected — CLI sessions will use OneProvider; install the extension for IDE support.';
    }

    return {
      target: this.target,
      installed: true,
      active: true,
      modelId,
      configPath: settingsPath,
      detail,
    };
  }

  // ── Restore ────────────────────────────────────────────────────────────────

  async restore(): Promise<IntegrationStatus> {
    const snapshot = this.globalState.get<ClaudeSnapshot>(SNAPSHOT_KEY);
    if (!snapshot) {
      // Maestro never applied anything (or already restored) — touching the
      // settings file here could delete the user's own ANTHROPIC_* keys.
      return this.getStatus();
    }
    const settingsPath = snapshot.settingsPath;

    let settings: ClaudeSettingsFile | undefined;
    try {
      settings = readJsonFile<ClaudeSettingsFile>(settingsPath);
    } catch {
      throw new Error(
        `${settingsPath} contains invalid JSON — restore it manually from ${settingsPath}.maestro-backup`,
      );
    }

    if (settings) {
      if (settings.env) {
        for (const key of MANAGED_ENV_KEYS) {
          const previous = snapshot.previousEnv?.[key];
          if (previous !== undefined) {
            settings.env[key] = previous;
          } else {
            delete settings.env[key];
          }
        }
        if (Object.keys(settings.env).length === 0) {
          delete settings.env;
        }
      }
      if (snapshot.previousTopLevelModel !== undefined) {
        settings.model = snapshot.previousTopLevelModel;
      } else {
        delete settings.model;
      }
      writeJsonFileAtomic(settingsPath, settings);
      Logger.info(`Claude Code settings restored in ${settingsPath}`);
    }

    try {
      await vscode.workspace
        .getConfiguration()
        .update(
          'claudeCode.environmentVariables',
          snapshot.previousVsCodeEnvVars,
          vscode.ConfigurationTarget.Global,
        );
      await vscode.workspace
        .getConfiguration()
        .update(
          'claudeCode.disableLoginPrompt',
          snapshot.previousDisableLoginPrompt,
          vscode.ConfigurationTarget.Global,
        );
    } catch (err) {
      Logger.warn('Could not restore claudeCode.* settings', err);
    }

    await this.globalState.update(SNAPSHOT_KEY, undefined);
    return this.getStatus();
  }
}
