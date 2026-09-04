/**
 * Uninstall hook — `"vscode:uninstall": "node ./dist/uninstall.js"`.
 *
 * VS Code runs this as a plain Node process the next time it starts after the
 * extension has been removed. There is no `vscode` module here: no settings
 * API, no SecretStorage, no output channel. So this file may only touch things
 * that live outside VS Code, and it must never throw — a crashing uninstall
 * hook is worse than an unclean one.
 *
 * What it undoes:
 *   - the ANTHROPIC_* / CLAUDE_CODE_* block in Claude Code's settings.json
 *   - the [model_providers.oneprovider] section and top-level model selection
 *     in Codex's config.toml
 *   - the ONEPROVIDER_API_KEY user environment variable on Windows
 *   - its own .maestro-backup files, once their contents have been reinstated
 *
 * What it deliberately leaves alone:
 *   - the API key in SecretStorage. VS Code owns that store and it is not
 *     reachable from here; leaving it means reinstalling does not mean typing
 *     the key in again. Nothing outside the extension can read it.
 *   - VS Code's own settings.json. VS Code may be holding it in memory and
 *     would write our edit straight back out. `restoreAll` cleans those keys
 *     while the extension is still running instead.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BACKUP_SUFFIX,
  readJsonFile,
  readTextFile,
  writeJsonFileAtomic,
  writeTextFileAtomic,
} from './utils/fsUtils';
import {
  ONEPROVIDER_ENV_KEY,
  clearClaudeCodeEnv,
  clearCodexConfig,
  findProviderSection,
} from './integrations/managedConfig';

const log = (msg: string) => process.stdout.write(`[oneprovider-maestro] ${msg}\n`);

/** Read a `.maestro-backup` sibling, if one was ever taken. */
function readBackup(configPath: string): string | undefined {
  return readTextFile(configPath + BACKUP_SUFFIX);
}

/** Drop the backup once its contents have been folded back into the config. */
function dropBackup(configPath: string): void {
  try {
    fs.rmSync(configPath + BACKUP_SUFFIX, { force: true });
  } catch {
    /* A leftover backup is harmless; failing the uninstall over it is not. */
  }
}

// ── Claude Code ──────────────────────────────────────────────────────────────

function cleanClaudeCode(): void {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const settings = readJsonFile<{ env?: Record<string, string> }>(settingsPath);
  if (!settings) {
    return;
  }

  const backupRaw = readBackup(settingsPath);
  let previousEnv: Record<string, string> | undefined;
  if (backupRaw) {
    try {
      previousEnv = JSON.parse(backupRaw)?.env;
    } catch {
      /* An unparseable backup just means "no prior values to reinstate". */
    }
  }

  if (clearClaudeCodeEnv(settings, previousEnv)) {
    writeJsonFileAtomic(settingsPath, settings);
    log(`Claude Code settings cleaned: ${settingsPath}`);
  }
  dropBackup(settingsPath);
}

// ── Codex ────────────────────────────────────────────────────────────────────

function cleanCodex(): void {
  // The configPath setting lived in VS Code's settings, which is unreadable
  // from here, so only the default location can be cleaned automatically.
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  const current = readTextFile(configPath);
  if (current === undefined) {
    return;
  }

  // Without our provider section there is nothing of ours in this file, and any
  // top-level model lines belong to the user. Leave it untouched.
  if (findProviderSection(current) === undefined) {
    dropBackup(configPath);
    return;
  }

  const cleaned = clearCodexConfig(current, readBackup(configPath));
  if (cleaned !== current) {
    writeTextFileAtomic(configPath, cleaned);
    log(`Codex config cleaned: ${configPath}`);
  }
  dropBackup(configPath);
}

// ── Windows user environment variable ────────────────────────────────────────

function removeUserEnvVar(): Promise<void> {
  if (process.platform !== 'win32') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Environment]::SetEnvironmentVariable('${ONEPROVIDER_ENV_KEY}', $null, 'User')`,
      ],
      (err) => {
        if (err) {
          log(`Could not remove the ${ONEPROVIDER_ENV_KEY} user variable: ${err.message}`);
        } else {
          log(`Removed the ${ONEPROVIDER_ENV_KEY} user variable`);
        }
        resolve();
      },
    );
  });
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Each step is isolated: a Codex config this hook cannot parse must not stop
  // Claude Code from being cleaned up.
  for (const step of [cleanClaudeCode, cleanCodex]) {
    try {
      step();
    } catch (err) {
      log(`${step.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await removeUserEnvVar();
}

main().catch(() => {
  /* Never fail an uninstall. */
});
