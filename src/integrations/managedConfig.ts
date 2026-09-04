/**
 * What this extension owns inside each agent's own config file, and the pure
 * functions that put it there or take it back out.
 *
 * This module is deliberately free of `vscode` imports. Two callers need it:
 * the integrations, running inside the extension host, and the
 * `vscode:uninstall` hook, which runs as a bare Node process once the extension
 * is already gone. Keeping one definition of "what Maestro owns" means an
 * uninstall cannot miss a key that apply() writes.
 */

/** Provider id Maestro manages inside Codex's [model_providers.*]. */
export const PROVIDER_ID = 'oneprovider';

/** Env var Codex reads the OneProvider key from (via env_key in config.toml). */
export const ONEPROVIDER_ENV_KEY = 'ONEPROVIDER_API_KEY';

/** Markers delimiting the config block managed by older versions. */
export const MANAGED_BLOCK_BEGIN =
  '# --- BEGIN ONEPROVIDER MAESTRO (auto-generated, do not edit) ---';
export const MANAGED_BLOCK_END = '# --- END ONEPROVIDER MAESTRO ---';

/** The env vars Maestro manages inside Claude Code's settings "env" block. */
export const MANAGED_ENV_KEYS = [
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

/** Top-level Codex keys Maestro writes when a model is activated. */
export const MANAGED_TOP_LEVEL_KEYS = [
  'model',
  'model_provider',
  'show_raw_agent_reasoning',
  'model_reasoning_effort',
  'model_reasoning_summary',
] as const;

/**
 * VS Code settings Maestro writes on the user's behalf. The uninstall hook
 * cannot touch these — VS Code owns that file and may hold it in memory — so
 * they are cleaned up by the in-process "restore" paths instead.
 */
export const MANAGED_VSCODE_SETTINGS = [
  'claudeCode.environmentVariables',
  'claudeCode.disableLoginPrompt',
] as const;

// ── Codex: TOML top-level region ─────────────────────────────────────────────

/**
 * Scan the top-level region of a TOML file (everything before the first
 * `[section]` header). Tracks triple-quoted multi-line strings so a line that
 * merely *looks* like a header or assignment inside a string is not
 * misinterpreted. Top-level keys are only valid in this region.
 */
export function scanTopLevel(content: string): {
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
export function findTopLevelLine(content: string, key: string): string | undefined {
  const { lines } = scanTopLevel(content);
  const re = new RegExp(`^\\s*${key}\\s*=`);
  return lines.find((l) => !l.inString && re.test(l.text))?.text;
}

/** Remove all Maestro-managed top-level assignments. */
export function stripTopLevelSelection(content: string): string {
  const { lines, restStart } = scanTopLevel(content);
  const re = new RegExp(`^\\s*(${MANAGED_TOP_LEVEL_KEYS.join('|')})\\s*=`);
  const kept = lines.filter((l) => l.inString || !re.test(l.text)).map((l) => l.text);
  const rest = content.slice(restStart);
  const top = kept.join('\n');
  if (rest === '') {
    return top;
  }
  return top === '' ? rest : `${top}\n${rest}`;
}

/** Remove leftover Maestro marker comment lines written by older versions. */
export function stripMarkerLines(content: string): string {
  return content
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t !== MANAGED_BLOCK_BEGIN && t !== MANAGED_BLOCK_END;
    })
    .join('\n');
}

// ── Codex: provider section ──────────────────────────────────────────────────

/**
 * Locate the [model_providers.oneprovider] section: from its header line to
 * the next header that is not a subtable of it (or EOF).
 */
export function findProviderSection(
  content: string,
): { start: number; end: number } | undefined {
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

/** Extract the [model_providers.oneprovider] section verbatim, if present. */
export function extractProviderSection(content: string): string | undefined {
  const range = findProviderSection(content);
  return range ? content.slice(range.start, range.end) : undefined;
}

/** Remove the [model_providers.oneprovider] section, splicing cleanly. */
export function removeProviderSection(content: string): string {
  const range = findProviderSection(content);
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

/**
 * Strip everything Maestro owns from a Codex config, then reinstate whatever
 * the user had under those same names beforehand.
 *
 * `previous` is the pre-Maestro content — the snapshot while the extension is
 * running, the `.maestro-backup` file once it is gone. Both describe the same
 * thing, so both go through this one function.
 */
export function clearCodexConfig(current: string, previous?: string): string {
  let content = stripMarkerLines(current);
  content = removeProviderSection(content);
  content = stripTopLevelSelection(content);

  if (previous === undefined) {
    return content;
  }

  // A [model_providers.oneprovider] section the user wrote themselves.
  const priorSection = extractProviderSection(previous);
  if (priorSection) {
    content = `${content.replace(/\n*$/, '\n')}\n${priorSection.replace(/\n*$/, '\n')}`;
  }

  const priorLines = MANAGED_TOP_LEVEL_KEYS.map((key) => findTopLevelLine(previous, key)).filter(
    (l): l is string => l !== undefined,
  );
  if (priorLines.length > 0) {
    const rest = content.replace(/^\n+/, '');
    // Keep the blank line the user had between their top-level keys and the
    // first [section]; splicing lines back in should not reflow their file.
    const gap = rest.startsWith('[') ? '\n\n' : '\n';
    content = priorLines.join('\n') + (rest === '' ? '\n' : gap + rest);
  }

  return content;
}

// ── Claude Code: settings env block ──────────────────────────────────────────

type EnvBlock = Record<string, string | undefined>;

/**
 * Remove Maestro's env vars from a parsed Claude Code settings object,
 * reinstating any value the user had under the same name beforehand.
 *
 * Mutates `settings` and reports whether anything actually changed, so a caller
 * can skip an unnecessary write.
 */
export function clearClaudeCodeEnv(
  settings: { env?: EnvBlock; [k: string]: unknown },
  previousEnv?: EnvBlock,
): boolean {
  const env = settings.env;
  if (!env || typeof env !== 'object') {
    return false;
  }

  let changed = false;
  for (const key of MANAGED_ENV_KEYS) {
    const prior = previousEnv?.[key];
    if (prior !== undefined) {
      if (env[key] !== prior) {
        env[key] = prior;
        changed = true;
      }
    } else if (key in env) {
      delete env[key];
      changed = true;
    }
  }

  // An env block that only ever held Maestro's keys is noise once they are
  // gone; leave it only if the user has something of their own in it.
  if (Object.keys(env).length === 0) {
    delete settings.env;
    changed = true;
  }

  return changed;
}
