/**
 * OneProvider model + usage type definitions.
 *
 * OneProvider serves two catalogs that have to be reconciled:
 *  - `GET /v1/models` returns the ids your key can actually call, and nothing
 *    else — no pricing, no context window, no capability flags.
 *  - The public site ships a rich catalog (pricing per Mtok, context, tiers,
 *    capabilities) that has no HTTP endpoint of its own.
 *
 * `ProcessedModel` is the merge of the two: live ids enriched with catalog
 * metadata, plus catalog entries the live endpoint did not return (marked
 * `catalogOnly` so the UI can be honest about them).
 */

/** One entry of the `GET /v1/models` response. */
export interface OneProviderApiModel {
  id: string;
  object?: string;
  type?: string;
  display_name?: string;
  owned_by?: string;
  created?: number;
  created_at?: string;
  /** Not currently returned, but accepted if OneProvider starts sending it. */
  context_window?: number;
  max_output_tokens?: number;
}

/** `GET /v1/models` envelope. */
export interface OneProviderModelsResponse {
  object?: string;
  data: OneProviderApiModel[];
  has_more?: boolean;
}

/** Per-million-token rates for one billing mode. */
export interface TokenPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One billing component of an image/video generation model. */
export interface GenerationComponent {
  key: string;
  price: number;
  unit: string;
  condition?: string | null;
}

/** A model as the rest of the extension sees it. */
export interface ProcessedModel {
  id: string;
  name: string;
  summary: string;
  /** Model line inside the brand, e.g. "opus", "gemini". */
  family: string;
  /** Brand grouping used by the catalog, e.g. "claude", "chatgpt", "gemini". */
  productFamily: string;
  /** Vendor behind the model, e.g. "anthropic", "openai", "google". */
  brand: string;
  brandLabel: string;
  /** Wire protocol OneProvider routes this model over. */
  platform: 'anthropic' | 'openai';
  /** Marketing tier: frontier / flagship / balanced / speed / image / video. */
  tier: string;
  /** text | multimodal | image | video */
  modality: string;
  lifecycle: string;
  contextLength: number;
  maxOutputTokens: number;
  pricing: TokenPricing | null;
  /** Second rate card applied above `longContext.thresholdTokens` (Gemini). */
  longContext?: { thresholdTokens: number | null; pricing: TokenPricing };
  /** Non-token billing for image/video models. */
  generation?: { modality: string; components: GenerationComponent[] };
  capabilities: {
    text: boolean;
    vision: boolean;
    toolCalling: boolean;
    streaming: boolean;
    imageOutput: boolean;
    videoOutput: boolean;
    /** Model reasons before answering (a `-thinking` id, or an effort-taking model). */
    reasoning: boolean;
  };
  /** Effort-selection metadata; only for models that accept `reasoning_effort`. */
  reasoning?: {
    supportedEfforts: string[];
    defaultEffort?: string;
  };
  /** OneProvider exposes Claude thinking as a separate model id. */
  thinkingVariant: boolean;
  /** True when `GET /v1/models` listed this id for the current key. */
  live: boolean;
  /** True when the id only exists in the bundled catalog. */
  catalogOnly: boolean;
  /** No token pricing at all (generation models are priced per second/image). */
  isFree: boolean;
}

/** A model the user enabled in Copilot Chat. */
export interface SelectedModel {
  id: string;
  name: string;
  addedAt: number;
  enabled: boolean;
  /** Per-model thinking-effort override. */
  reasoningEffort?: string;
}

/** Copilot-facing summary of an enabled model, sent to the webview. */
export interface ActiveCopilotModel {
  id: string;
  name: string;
  url: string;
  toolCalling: boolean;
  vision: boolean;
  maxInputTokens: number;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  supportedEfforts?: string[];
}

/** Targets Maestro can wire a model into. */
export type AgentTarget = 'copilot' | 'claude-code' | 'codex';

/** Agents that keep a saved model list of their own (Copilot has its own). */
export type ExternalAgentTarget = 'claude-code' | 'codex';

/**
 * One model saved in an external agent's list. Being in the list costs
 * nothing — no config file is touched until the model is activated.
 */
export interface AgentModelEntry {
  id: string;
  name: string;
  addedAt: number;
}

/** A single agent's saved model list, sent to the webview. */
export interface AgentRoster {
  target: ExternalAgentTarget;
  models: AgentModelEntry[];
}

/** Status of an external agent integration. */
export interface IntegrationStatus {
  target: AgentTarget;
  installed: boolean;
  active: boolean;
  modelId?: string;
  configPath?: string;
  detail?: string;
}

/** Model-list cache metadata. */
export interface CacheMetadata {
  lastUpdated: number;
  modelCount: number;
  version: string;
}

// ─── Usage & billing ─────────────────────────────────────────────────────────

/** Key metadata returned by the dashboard lookup. */
export interface UsageKeyInfo {
  masked: string;
  name?: string | null;
  expires_at?: string | null;
  last_check?: string | null;
  provider_reported_active?: boolean;
  is_active?: boolean;
  marketplace_name?: string | null;
}

/** Balance snapshot returned by the dashboard lookup. */
export interface UsageSnapshot {
  balance_usd: number;
  quota_usd: number;
  quota_used_usd: number;
  live_known?: boolean;
}

export interface UsageTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

export interface UsageRow {
  created_at?: string | null;
  model?: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  duration_ms: number;
  total_cost: number;
}

export interface UsageAggregate {
  total_cost: number;
  total_requests: number;
  tokens: UsageTokens;
  per_hour: { hour: string; cost: number; requests: number }[];
  per_day: { date: string; cost: number; requests: number; tokens?: UsageTokens }[];
  per_model: { model: string; requests: number }[];
}

export interface UsageReport {
  row_count: number;
  aggregated: UsageAggregate;
  recent_rows: UsageRow[];
}

/** Normalized result of one dashboard lookup. */
export interface AccountUsage {
  key: UsageKeyInfo;
  snapshot: UsageSnapshot;
  usage?: UsageReport;
  /** active | paused | disabled | expired | depleted */
  status: 'active' | 'paused' | 'disabled' | 'expired' | 'depleted';
  /** Range in days this report covers. */
  days: number;
  /** When this extension fetched it. */
  fetchedAt: number;
}

/** One request this VS Code session sent through the Copilot provider. */
export interface SessionRequest {
  at: number;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Estimated from bundled catalog rates — OneProvider bills authoritatively. */
  estimatedCost: number;
  durationMs: number;
}

/** Rolling total of everything this session spent. */
export interface SessionUsageSummary {
  startedAt: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
  perModel: {
    modelId: string;
    requests: number;
    tokens: number;
    estimatedCost: number;
  }[];
  recent: SessionRequest[];
}

// ─── Webview messaging ───────────────────────────────────────────────────────

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'toggleCopilot'; modelId: string }
  | { type: 'removeActiveModel'; modelId: string }
  | { type: 'setReasoningEffort'; modelId: string; effort: string }
  | { type: 'addToAgent'; target: ExternalAgentTarget; modelId: string }
  | { type: 'removeFromAgent'; target: ExternalAgentTarget; modelId: string }
  | { type: 'activateAgentModel'; target: ExternalAgentTarget; modelId: string }
  | { type: 'deactivateAgent'; target: ExternalAgentTarget }
  | { type: 'getAgentRosters' }
  | { type: 'reloadWindow' }
  | { type: 'restoreIntegration'; target: ExternalAgentTarget }
  | { type: 'getIntegrationStatus' }
  | { type: 'setApiKey' }
  | { type: 'syncModels' }
  | { type: 'getSelectedModels' }
  | { type: 'getApiKeyStatus' }
  | { type: 'getUsage'; days?: number; force?: boolean }
  | { type: 'resetSessionUsage' }
  | { type: 'openExternal'; url: string };

export type ExtensionMessage =
  | { type: 'modelsLoaded'; models: ProcessedModel[]; total: number; lastSync?: number }
  | { type: 'selectedModelsUpdated'; models: SelectedModel[] }
  | { type: 'activeModelsUpdated'; models: ActiveCopilotModel[] }
  | { type: 'copilotToggled'; modelId: string; enabled: boolean; message: string }
  | { type: 'integrationApplied'; target: AgentTarget; success: boolean; message: string }
  | { type: 'integrationStatus'; statuses: IntegrationStatus[] }
  | { type: 'agentRostersUpdated'; rosters: AgentRoster[] }
  | { type: 'usageUpdated'; usage?: AccountUsage; session: SessionUsageSummary; error?: string; loading?: boolean }
  | { type: 'error'; message: string }
  | { type: 'loading'; isLoading: boolean }
  | { type: 'apiKeyStatus'; hasKey: boolean }
  | { type: 'syncComplete'; newModelsCount: number };
