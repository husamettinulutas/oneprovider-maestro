import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../utils/logger';
import { sanitizeModelId } from '../utils/modelId';

export { sanitizeModelId };

/** Markers delimiting the config block managed by this extension. */
export const MANAGED_BLOCK_BEGIN = '# --- BEGIN ONEPROVIDER MAESTRO (auto-generated, do not edit) ---';
export const MANAGED_BLOCK_END = '# --- END ONEPROVIDER MAESTRO ---';

/** Expand a leading ~ to the user's home directory. */
export function expandHome(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/** Read a UTF-8 text file, returning undefined if it does not exist. */
export function readTextFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

/** Read and parse a JSON file. Undefined if missing; throws on invalid JSON. */
export function readJsonFile<T = any>(filePath: string): T | undefined {
  const raw = readTextFile(filePath);
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  return JSON.parse(raw) as T;
}

/**
 * Write a file atomically: write a temp sibling then rename over the target, so
 * a crash mid-write cannot leave an agent with a half-written config.
 */
export function writeTextFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.maestro-tmp`);
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

/** Serialize and write JSON with stable 2-space indentation. */
export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  writeTextFileAtomic(filePath, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Create a one-time backup before the first Maestro write. Only written when it
 * does not already exist, so the pristine pre-Maestro state stays recoverable
 * no matter how many times the model is switched.
 */
export function backupOnce(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const backupPath = `${filePath}.maestro-backup`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
    Logger.info(`Created backup: ${backupPath}`);
  }
  return backupPath;
}

/** Escape a string for embedding inside a double-quoted TOML string. */
export function tomlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
