import * as fs from 'fs';
import { Logger } from '../utils/logger';
import { sanitizeModelId } from '../utils/modelId';
import { BACKUP_SUFFIX } from '../utils/fsUtils';

export { sanitizeModelId };
export { MANAGED_BLOCK_BEGIN, MANAGED_BLOCK_END } from './managedConfig';

/*
  The file helpers live in ../utils/fsUtils so the uninstall hook, which runs
  as a bare Node process with no extension host, can use them too. Re-exported
  here because the integrations already import them from this module.
*/
export {
  expandHome,
  readTextFile,
  readJsonFile,
  writeTextFileAtomic,
  writeJsonFileAtomic,
  tomlEscape,
} from '../utils/fsUtils';

/**
 * Create a one-time backup before the first Maestro write. Only written when it
 * does not already exist, so the pristine pre-Maestro state stays recoverable
 * no matter how many times the model is switched.
 */
export function backupOnce(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const backupPath = filePath + BACKUP_SUFFIX;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
    Logger.info(`Created backup: ${backupPath}`);
  }
  return backupPath;
}

