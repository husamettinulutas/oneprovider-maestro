import { AgentTarget, IntegrationStatus } from '../types/models';

/**
 * Model metadata forwarded to integrations so agent configs can be tuned to the
 * model's real limits — agents otherwise assume their own vendor's defaults.
 */
export interface AgentApplyOptions {
  /** The model's context window in tokens. */
  contextLength?: number;
  /** The model's max completion tokens. */
  maxOutputTokens?: number;
  /** Whether the model reasons before answering. */
  supportsReasoning?: boolean;
  /** Wire protocol OneProvider routes this model over. */
  platform?: 'anthropic' | 'openai';
}

/**
 * Common contract for external agent integrations (Claude Code, Codex).
 * Implementations edit the agent's own config files, with backups, so the agent
 * uses a OneProvider model instead of its built-in provider.
 */
export interface AgentIntegration {
  readonly target: AgentTarget;

  /** Detect installation plus whether Maestro's config is currently applied. */
  getStatus(): Promise<IntegrationStatus>;

  /**
   * Wire the given OneProvider model into the agent.
   * @param modelId OneProvider model id (e.g. "claude-opus-5")
   * @param apiKey  OneProvider API key to authenticate with
   * @param options Model metadata used to tune the agent's config
   */
  apply(modelId: string, apiKey: string, options?: AgentApplyOptions): Promise<IntegrationStatus>;

  /** Remove Maestro-managed config so the agent falls back to its defaults. */
  restore(): Promise<IntegrationStatus>;
}
