import { SessionRequest, SessionUsageSummary } from '../types/models';
import { estimateCost } from '../catalog/modelCatalog';

/** How many individual requests the session keeps for the activity list. */
const MAX_RECENT = 50;

/**
 * Tracks what this VS Code session burned through the Copilot provider.
 *
 * The account dashboard is authoritative but lags: OneProvider settles charges
 * in the background, so a request you just sent shows up minutes later. This
 * counter reads the `usage` block of each streaming response and prices it from
 * the bundled rate card, so the status bar reacts the moment a turn finishes.
 * It only ever sees traffic that went through this extension's Copilot
 * provider — Claude Code and Codex talk to OneProvider directly.
 */
export class SessionUsageTracker {
  private readonly startedAt = Date.now();
  private requests: SessionRequest[] = [];
  private totals = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0,
  };

  private readonly listeners = new Set<(summary: SessionUsageSummary) => void>();

  /** Subscribe to totals changes. Returns an unsubscribe function. */
  onDidChange(listener: (summary: SessionUsageSummary) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Record one completed request.
   *
   * `usage` is the raw object from the provider response; field names differ
   * between the OpenAI-compatible and Anthropic-native shapes, so both are read.
   */
  record(modelId: string, usage: unknown, durationMs: number): SessionRequest | undefined {
    const tokens = extractTokens(usage);
    if (!tokens) {
      return undefined;
    }

    const entry: SessionRequest = {
      at: Date.now(),
      modelId,
      ...tokens,
      estimatedCost: estimateCost(modelId, tokens),
      durationMs: Math.max(0, Math.round(durationMs)),
    };

    this.requests.unshift(entry);
    if (this.requests.length > MAX_RECENT) {
      this.requests.length = MAX_RECENT;
    }

    this.totals.requests += 1;
    this.totals.inputTokens += entry.inputTokens;
    this.totals.outputTokens += entry.outputTokens;
    this.totals.cacheReadTokens += entry.cacheReadTokens;
    this.totals.cacheWriteTokens += entry.cacheWriteTokens;
    this.totals.estimatedCost += entry.estimatedCost;

    this.emit();
    return entry;
  }

  /** Zero the counter without restarting VS Code. */
  reset(): void {
    this.requests = [];
    this.totals = {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: 0,
    };
    this.emit();
  }

  summary(): SessionUsageSummary {
    const perModel = new Map<string, { requests: number; tokens: number; estimatedCost: number }>();
    for (const request of this.requests) {
      const bucket = perModel.get(request.modelId) ?? { requests: 0, tokens: 0, estimatedCost: 0 };
      bucket.requests += 1;
      bucket.tokens +=
        request.inputTokens +
        request.outputTokens +
        request.cacheReadTokens +
        request.cacheWriteTokens;
      bucket.estimatedCost += request.estimatedCost;
      perModel.set(request.modelId, bucket);
    }

    return {
      startedAt: this.startedAt,
      ...this.totals,
      perModel: [...perModel.entries()]
        .map(([modelId, value]) => ({ modelId, ...value }))
        .sort((a, b) => b.requests - a.requests),
      recent: [...this.requests],
    };
  }

  private emit(): void {
    const summary = this.summary();
    for (const listener of this.listeners) {
      listener(summary);
    }
  }
}

/**
 * Pull token counts out of a provider usage object.
 *
 * OneProvider mirrors whichever upstream shape the model speaks, so both the
 * OpenAI (`prompt_tokens`, `prompt_tokens_details.cached_tokens`) and Anthropic
 * (`input_tokens`, `cache_read_input_tokens`) namings show up in practice.
 */
export function extractTokens(usage: unknown): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} | undefined {
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }
  const u = usage as Record<string, any>;

  const cacheRead = num(u.cache_read_input_tokens) || num(u.prompt_tokens_details?.cached_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens) || num(u.prompt_tokens_details?.cache_write_tokens);

  // OpenAI counts cached tokens inside prompt_tokens; Anthropic reports them
  // beside input_tokens. Subtracting keeps the buckets from being billed twice.
  const rawPrompt = num(u.prompt_tokens) || num(u.input_tokens);
  const inputTokens = num(u.prompt_tokens)
    ? Math.max(0, rawPrompt - cacheRead - cacheWrite)
    : rawPrompt;

  const outputTokens = num(u.completion_tokens) || num(u.output_tokens);

  if (inputTokens === 0 && outputTokens === 0 && cacheRead === 0 && cacheWrite === 0) {
    return undefined;
  }

  return { inputTokens, outputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
