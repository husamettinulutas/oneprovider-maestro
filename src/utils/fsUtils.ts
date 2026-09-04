/**
 * File helpers shared by the extension and by the uninstall hook.
 *
 * Nothing here may import `vscode`. The uninstall hook (`vscode:uninstall`)
 * runs as a plain Node process after VS Code has already removed the
 * extension, so anything it touches has to work without the extension host.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Suffix of the one-time copy taken before the first write to a config. */
export const BACKUP_SUFFIX = '.maestro-backup';

/** Expand a leading ~ to the user's home directory. */
export function expandHome(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/** Read a file. Undefined if it does not exist; other errors propagate. */
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

/** Escape a string for embedding inside a double-quoted TOML string. */
export function tomlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
