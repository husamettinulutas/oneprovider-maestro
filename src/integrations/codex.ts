import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { AgentApplyOptions, AgentIntegration } from './agentIntegration';
import { IntegrationStatus } from '../types/models';
import {
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  backupOnce,
  expandHome,
  readJsonFile,
  readTextFile,
  sanitizeModelId,
  tomlEscape,
  writeTextFileAtomic,
} from './shared';
import { Logger } from '../utils/logger';
import { getBaseUrl } from '../api/oneProviderClient';

/** Env var Codex reads the OneProvider key from (via env_key in config.toml). */
export const ONEPROVIDER_ENV_KEY = 'ONEPROVIDER_API_KEY';

/** Provider id Maestro manages inside [model_providers.*]. */
const PROVIDER_ID = 'oneprovider';

/** globalState key holding the pre-apply snapshot used by restore(). */
const SNAPSHOT_KEY = 'maestro-codex-snapshot';

interface CodexSnapshot {
  configPath: string;
  /** Previous top-level `model = ...` line (undefined = absent). */
  previousModelLine?: string;
  /** Previous top-level `model_provider = ...` line (undefined = absent). */
  previousProviderLine?: string;
  /** A pre-existing user-owned [model_providers.oneprovider] section, if any. */
  previousProviderSection?: string;
  previousShowRawReasoningLine?: string;
  previousReasoningEffortLine?: string;
  previousReasoningSummaryLine?: string;
  /**
   * Value the ONEPROVIDER_API_KEY user environment variable had before Maestro
   * first set it (null = it did not exist). Only recorded on Windows, where
   * apply() persists the variable.
   */
  previousUserEnvKey?: string | null;
}

/** Top-level keys Maestro owns while active. */
const MANAGED_TOP_LEVEL_KEYS = [
  'model',
  'model_provider',
  'show_raw_agent_reasoning',
  'model_reasoning_effort',
  'model_reasoning_summary',
] as const;

/**
 * OpenAI Codex integration.
 *
 * Manages the user-level ~/.codex/config.toml (shared by the Codex CLI and the
 * Codex IDE extension):
 *  - a `[model_providers.oneprovider]` section with `wire_api = "responses"`,
 *    which is what OneProvider documents for Codex
 *  - top-level `model` / `model_provider` keys, which must live BEFORE any
 *    `[section]` header and are only honored in the user-level config
 *  - the ONEPROVIDER_API_KEY user environment variable (persisted on Windows),
 *    because a GUI-launched extension does not inherit shell exports
 *
 * Codex rewrites config.toml with its own TOML serializer (e.g. when trusting a
 * project), which relocates comments. Management is therefore SEMANTIC —
 * sections and keys are located by name, never by comment markers.
 */
export class CodexIntegration implements AgentIntegration {
  readonly target = 'codex' as const;

  constructor(private readonly globalState: vscode.Memento) {}

  // ── Paths ──────────────────────────────────────────────────────────────────

  private get codexDir(): string {
    return path.join(os.homedir(), '.codex');
  }

  private getConfigPath(): string {
    const custom = vscode.workspace
      .getConfiguration('oneproviderMaestro')
      .get<string>('codex.configPath', '')
      .trim();
    if (custom) {
      return expandHome(custom);
    }
    return path.join(this.codexDir, 'config.toml');
  }

  // ── TOML top-level key helpers ─────────────────────────────────────────────

  /**
   * Scan the top-level region of a TOML file (everything before the first
   * `[section]` header). Tracks triple-quoted multi-line strings so a line that
   * merely *looks* like a header or assignment inside a string is not
   * misinterpreted. Top-level keys are only valid in this region.
   */
  private scanTopLevel(content: string): {
    lines: { text: string; inString: boolean }[];
    /** Offset where the first real [section] header starts (content.length if none). */
    restStart: number;
  } {
    const rawLines = content.split('\n');
    const lines: { text: string; inString: boolean }[] = [];
    let inTriple: '"""' | "'''" | null = null;
    let offset = 0;

    for (const line of rawLines) {
      const startedInString = inTriple !== null;
      if (inTriple) {
        if (line.includes(inTriple)) {
          inTriple = null;
        }
      } else {
        if (/^\s*\[[^\[\]]*\]\s*(#.*)?$/.test(line)) {
          return { lines, restStart: offset };
        }
        for (const q of ['"""', "'''"] as const) {
          const first = line.indexOf(q);
          if (first !== -1 && line.indexOf(q, first + q.length) === -1) {
            inTriple = q;
            break;
          }
        }
      }
      lines.push({ text: line, inString: startedInString || inTriple !== null });
      offset += line.length + 1;
    }
    return { lines, restStart: content.length };
  }

  /** Find a top-level `key = ...` assignment line (ignoring string content). */
  private findTopLevelLine(content: string, key: string): string | undefined {
    const { lines } = this.scanTopLevel(content);
    const re = new RegExp(`^\\s*${key}\\s*=`);
    return lines.find((l) => !l.inString && re.test(l.text))?.text;
  }

  /** Remove all Maestro-managed top-level assignments. */
  private stripTopLevelSelection(content: string): string {
    const { lines, restStart } = this.scanTopLevel(content);
    const re = new RegExp(`^\\s*(${MANAGED_TOP_LEVEL_KEYS.join('|')})\\s*=`);
    const kept = lines.filter((l) => l.inString || !re.test(l.text)).map((l) => l.text);
    const rest = content.slice(restStart);
    const top = kept.join('\n');
    if (rest === '') {
      return top;
    }
    return top === '' ? rest : `${top}\n${rest}`;
  }

  // ── Provider section helpers ───────────────────────────────────────────────

  /** Remove leftover Maestro marker comment lines written by older versions. */
  private stripMarkerLines(content: string): string {
    return content
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return t !== MANAGED_BLOCK_BEGIN && t !== MANAGED_BLOCK_END;
      })
      .join('\n');
  }

  /**
   * Locate the [model_providers.oneprovider] section: from its header line to
   * the next header that is not a subtable of it (or EOF).
   */
  private findProviderSection(content: string): { start: number; end: number } | undefined {
    const lines = content.split('\n');
    let offset = 0;
    let start = -1;
    let end = content.length;

    for (const line of lines) {
      const header = line.match(/^\s*\[([^\]]+)\]\s*(#.*)?$/)?.[1]?.trim();
      if (start === -1) {
        if (
          header === `model_providers.${PROVIDER_ID}` ||
          header === `model_providers."${PROVIDER_ID}"`
        ) {
          start = offset;
        }
      } else if (header !== undefined && !header.startsWith(`model_providers.${PROVIDER_ID}.`)) {
        end = offset;
        break;
      }
      offset += line.length + 1;
    }

    if (start === -1) {
      return undefined;
    }
    return { start, end: Math.min(end, content.length) };
  }

  /** Remove the [model_providers.oneprovider] section, splicing cleanly. */
  private removeProviderSection(content: string): string {
    const range = this.findProviderSection(content);
    if (!range) {
      return content;
    }
    let before = content.slice(0, range.start).replace(/\n+$/, '\n');
    if (before === '\n') {
      before = '';
    }
    let after = content.slice(range.end).replace(/^\n+/, '');
    if (after !== '') {
      after = (before === '' ? '' : '\n') + after;
    }
    return before + after;
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  async getStatus(): Promise<IntegrationStatus> {
    const configPath = this.getConfigPath();
    const installed = fs.existsSync(this.codexDir);
    const content = readTextFile(configPath);

    let active = false;
    let modelId: string | undefined;
    let detail: string | undefined;

    if (content !== undefined) {
      const providerLine = this.findTopLevelLine(content, 'model_provider');
      active =
        this.findProviderSection(content) !== undefined &&
        !!providerLine?.includes(`"${PROVIDER_ID}"`);
      if (active) {
        modelId = this.findTopLevelLine(content, 'model')?.match(/=\s*"([^"]+)"/)?.[1];
        detail =
          'Codex\'s own model picker labels custom models as "Custom" — requests still use the model shown here.';
        if (process.platform === 'win32' && !process.env[ONEPROVIDER_ENV_KEY]) {
          detail += ` If Codex reports a missing ${ONEPROVIDER_ENV_KEY}, restart VS Code.`;
        }
      }
    }

    // Common trap: pasting a OneProvider key into Codex's own "Use API Key"
    // dialog stores it as an OpenAI key, so Codex sends it to api.openai.com.
    if (!active && installed) {
      try {
        const auth = readJsonFile<{ OPENAI_API_KEY?: string }>(
          path.join(this.codexDir, 'auth.json'),
        );
        if (auth?.OPENAI_API_KEY?.startsWith('sk-') && !auth.OPENAI_API_KEY.startsWith('sk-proj-')) {
          detail =
            '⚠️ A key is saved as Codex\'s own OpenAI API key. If that is your OneProvider key, Codex is sending it to api.openai.com and getting 401 — activate a model here instead, then restart VS Code.';
        }
      } catch {
        // An unreadable auth.json is irrelevant to status reporting.
      }
    }

    return { target: this.target, installed, active, modelId, configPath, detail };
  }

  // ── Apply ──────────────────────────────────────────────────────────────────

  async apply(
    modelId: string,
    apiKey: string,
    options?: AgentApplyOptions,
  ): Promise<IntegrationStatus> {
    modelId = sanitizeModelId(modelId);
    const configPath = this.getConfigPath();

    // If a previous apply targeted a different config file (the configPath
    // setting changed), un-wire that file first.
    const existingSnapshot = this.globalState.get<CodexSnapshot>(SNAPSHOT_KEY);
    if (existingSnapshot && existingSnapshot.configPath !== configPath) {
      await this.restore();
    }

    backupOnce(configPath);

    const existing = readTextFile(configPath);

    // Snapshot the pre-Maestro state once (first apply wins). If the user had
    // their own [model_providers.oneprovider] section, keep its text so
    // restore() can put it back verbatim.
    if (!this.globalState.get<CodexSnapshot>(SNAPSHOT_KEY)) {
      const priorSection = existing ? this.findProviderSection(existing) : undefined;
      const snapshot: CodexSnapshot = {
        configPath,
        previousModelLine: existing ? this.findTopLevelLine(existing, 'model') : undefined,
        previousProviderLine: existing
          ? this.findTopLevelLine(existing, 'model_provider')
          : undefined,
        previousProviderSection:
          existing && priorSection
            ? existing.slice(priorSection.start, priorSection.end)
            : undefined,
        previousShowRawReasoningLine: existing
          ? this.findTopLevelLine(existing, 'show_raw_agent_reasoning')
          : undefined,
        previousReasoningEffortLine: existing
          ? this.findTopLevelLine(existing, 'model_reasoning_effort')
          : undefined,
        previousReasoningSummaryLine: existing
          ? this.findTopLevelLine(existing, 'model_reasoning_summary')
          : undefined,
        previousUserEnvKey:
          process.platform === 'win32' ? await this.readUserEnv(ONEPROVIDER_ENV_KEY) : undefined,
      };
      await this.globalState.update(SNAPSHOT_KEY, snapshot);
    }

    // 1) Clean up: legacy marker comments, any existing oneprovider section,
    //    and the current top-level model selection.
    let content = this.stripMarkerLines(existing ?? '');
    content = this.removeProviderSection(content);
    content = this.stripTopLevelSelection(content);

    // 2) Append a fresh provider section at the end of the file.
    const section = [
      `[model_providers.${PROVIDER_ID}]`,
      `name = "OneProvider"`,
      `base_url = "${tomlEscape(getBaseUrl())}"`,
      `env_key = "${ONEPROVIDER_ENV_KEY}"`,
      `wire_api = "responses"`,
    ].join('\n');
    content =
      content.trim() === '' ? `${section}\n` : `${content.replace(/\n*$/, '\n')}\n${section}\n`;

    // 3) Top-level model selection must come BEFORE any [section] header.
    //    The reasoning keys cost nothing on models that ignore them and are
    //    what displays thinking on models that emit reasoning summaries.
    const reasoningLines =
      options?.supportsReasoning === false
        ? ''
        : 'show_raw_agent_reasoning = true\n' +
          'model_reasoning_effort = "high"\n' +
          'model_reasoning_summary = "auto"\n';
    content =
      `model = "${tomlEscape(modelId)}"\n` +
      `model_provider = "${PROVIDER_ID}"\n` +
      reasoningLines +
      (content.startsWith('\n') ? '' : '\n') +
      content;

    writeTextFileAtomic(configPath, content);
    Logger.info(`Codex wired to OneProvider (${modelId}) via ${configPath}`);

    // 4) Make the API key available as a persistent user env var so both the
    //    CLI and the GUI-launched IDE extension can resolve env_key.
    let detail: string;
    if (process.platform === 'win32') {
      await this.persistUserEnv(ONEPROVIDER_ENV_KEY, apiKey);
      detail = `Restart VS Code once so Codex sees ${ONEPROVIDER_ENV_KEY}. Codex's own picker will label this model "Custom" — that is a Codex UI limitation.`;
    } else {
      detail = `Add to your shell profile: export ${ONEPROVIDER_ENV_KEY}="<your-key>" (Codex resolves the key from that variable).`;
    }

    return {
      target: this.target,
      installed: true,
      active: true,
      modelId,
      configPath,
      detail,
    };
  }

  /**
   * Persist a user-level environment variable on Windows.
   * Uses PowerShell's SetEnvironmentVariable instead of setx, which silently
   * fails in some shells and truncates values over 1024 chars.
   */
  private persistUserEnv(name: string, value: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const psValue = value.replace(/'/g, "''");
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `[Environment]::SetEnvironmentVariable('${name}', '${psValue}', 'User')`,
        ],
        { windowsHide: true },
        (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(`Failed to persist ${name}: ${stderr || err.message}`));
          } else {
            // Also expose it to processes spawned from this extension host.
            process.env[name] = value;
            resolve();
          }
        },
      );
    });
  }

  /** Read a user-scope environment variable (null when it does not exist). */
  private readUserEnv(name: string): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `[Environment]::GetEnvironmentVariable('${name}', 'User')`,
        ],
        { windowsHide: true },
        (err, stdout) => {
          if (err) {
            Logger.warn(`Could not read user env ${name}; assuming it was unset`);
            resolve(null);
            return;
          }
          const value = stdout.trim();
          resolve(value === '' ? null : value);
        },
      );
    });
  }

  /**
   * Put the ONEPROVIDER_API_KEY user variable back the way it was before the
   * first apply — deleted if Maestro created it. Leaving a live API key in the
   * user environment after a restore would be a credential leak.
   */
  private async restoreUserEnv(previous: string | null | undefined): Promise<void> {
    if (process.platform !== 'win32' || previous === undefined) {
      return;
    }

    try {
      if (previous === null) {
        await new Promise<void>((resolve, reject) => {
          execFile(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `[Environment]::SetEnvironmentVariable('${ONEPROVIDER_ENV_KEY}', $null, 'User')`,
            ],
            { windowsHide: true },
            (err, _stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()),
          );
        });
        delete process.env[ONEPROVIDER_ENV_KEY];
        Logger.info(`Removed the ${ONEPROVIDER_ENV_KEY} user environment variable`);
      } else {
        await this.persistUserEnv(ONEPROVIDER_ENV_KEY, previous);
      }
    } catch (error) {
      // A leftover variable is not worth failing the restore over — the config
      // file is what routes Codex, and it has already been cleaned.
      Logger.warn(`Failed to restore the ${ONEPROVIDER_ENV_KEY} user variable`, error);
    }
  }

  // ── Restore ────────────────────────────────────────────────────────────────

  async restore(): Promise<IntegrationStatus> {
    const snapshot = this.globalState.get<CodexSnapshot>(SNAPSHOT_KEY);
    const configPath = snapshot?.configPath ?? this.getConfigPath();
    const existing = readTextFile(configPath);

    // Without a snapshot AND without our provider section, any top-level
    // model/model_provider lines belong to the user — leave the file alone.
    if (!snapshot && (existing === undefined || this.findProviderSection(existing) === undefined)) {
      return this.getStatus();
    }

    if (existing !== undefined) {
      let content = this.stripMarkerLines(existing);
      content = this.removeProviderSection(content);
      content = this.stripTopLevelSelection(content);

      // Put back the user's own pre-Maestro oneprovider provider section, if any.
      if (snapshot?.previousProviderSection) {
        content = `${content.replace(/\n*$/, '\n')}\n${snapshot.previousProviderSection.replace(/\n*$/, '\n')}`;
      }

      const restoredLines = [
        snapshot?.previousModelLine,
        snapshot?.previousProviderLine,
        snapshot?.previousShowRawReasoningLine,
        snapshot?.previousReasoningEffortLine,
        snapshot?.previousReasoningSummaryLine,
      ].filter((l): l is string => l !== undefined);
      if (restoredLines.length > 0) {
        content =
          restoredLines.join('\n') +
          '\n' +
          (content.startsWith('\n') ? content.slice(1) : content);
      }

      writeTextFileAtomic(configPath, content);
      Logger.info(`Codex config restored in ${configPath}`);
    }

    await this.restoreUserEnv(snapshot?.previousUserEnvKey);
    await this.globalState.update(SNAPSHOT_KEY, undefined);
    return this.getStatus();
  }
}
