import catalogData from './catalog.json';
import {
  GenerationComponent,
  OneProviderApiModel,
  ProcessedModel,
  TokenPricing,
} from '../types/models';
import { isThinkingVariant, reasoningForModel } from '../utils/reasoningEffort';

/**
 * The bundled OneProvider catalog.
 *
 * `GET /v1/models` returns ids and nothing else — no pricing, no context
 * window, no capability flags — and OneProvider publishes no endpoint that
 * carries them. Without this table a model card could show a name and nothing
 * an actual decision needs, so the public catalog is shipped with the extension
 * and refreshed on release. Live ids always win on *existence*; this file only
 * supplies the metadata around them.
 */
interface CatalogEntry {
  name: string;
  summary: string;
  family: string;
  productFamily: string;
  brand: string;
  brandLabel: string;
  platform: string;
  tier: string;
  modality: string;
  lifecycle: string;
  contextTokens: number | null;
  maxOutputTokens: number | null;
  capabilities: {
    streaming: boolean | null;
    tools: boolean | null;
    vision: boolean | null;
    imageGeneration?: boolean | null;
    videoGeneration?: boolean | null;
  };
  pricing: TokenPricing | null;
  longContext?: { thresholdTokens: number | null; pricing: TokenPricing };
  generation?: { modality: string; components: GenerationComponent[] };
}

const CATALOG = (catalogData as { models: Record<string, CatalogEntry> }).models;

/** Context window assumed for a live id the catalog does not know. */
const FALLBACK_CONTEXT = 200_000;
/** Output cap assumed for a live id the catalog does not know. */
const FALLBACK_MAX_OUTPUT = 8_192;

export interface MergeOptions {
  /** Ids returned by `GET /v1/models` for the current key. */
  liveModels: OneProviderApiModel[];
  /** Include catalog entries the live endpoint did not return. */
  includeCatalogOnly: boolean;
  /** Ids matching this pattern get a `reasoning_effort` control. */
  effortPattern: RegExp;
  /** Default effort from settings, applied to matching models. */
  defaultEffort?: string | null;
}

/**
 * Merge the live id list with the bundled catalog into the model list the rest
 * of the extension works with.
 *
 * Catalog-only entries are included (when asked for) but flagged, because a key
 * that is scoped to one family would otherwise make the browser look broken —
 * and because the live list has been observed to return a small default set.
 */
export function mergeModels(options: MergeOptions): ProcessedModel[] {
  const { liveModels, includeCatalogOnly, effortPattern, defaultEffort } = options;
  const byId = new Map<string, ProcessedModel>();

  for (const live of liveModels) {
    if (!live?.id) {
      continue;
    }
    byId.set(live.id, buildModel(live.id, CATALOG[live.id], live, true, effortPattern, defaultEffort));
  }

  if (includeCatalogOnly) {
    for (const [id, entry] of Object.entries(CATALOG)) {
      if (byId.has(id)) {
        continue;
      }
      byId.set(id, buildModel(id, entry, undefined, false, effortPattern, defaultEffort));
    }
  }

  return [...byId.values()].sort(compareModels);
}

/** The bundled catalog on its own — used before the first successful sync. */
export function catalogModels(
  effortPattern: RegExp,
  defaultEffort?: string | null,
): ProcessedModel[] {
  return Object.entries(CATALOG)
    .map(([id, entry]) => buildModel(id, entry, undefined, false, effortPattern, defaultEffort))
    .sort(compareModels);
}

/** Catalog metadata for one id, if the bundled table knows it. */
export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG[id];
}

/** Per-million rates for a model id, or undefined when it is not token-priced. */
export function pricingFor(id: string): TokenPricing | undefined {
  return CATALOG[id]?.pricing ?? undefined;
}

/** Number of models in the bundled catalog. */
export function catalogSize(): number {
  return Object.keys(CATALOG).length;
}

function buildModel(
  id: string,
  entry: CatalogEntry | undefined,
  live: OneProviderApiModel | undefined,
  isLive: boolean,
  effortPattern: RegExp,
  defaultEffort?: string | null,
): ProcessedModel {
  const thinkingVariant = isThinkingVariant(id);
  const reasoning = reasoningForModel(id, effortPattern, defaultEffort);
  const modality = entry?.modality ?? 'text';
  const caps = entry?.capabilities;

  // The catalog leaves capability flags null for entries it has not verified.
  // Treating null as "no" would hide tool calling on models that have it, so
  // an unverified text/multimodal model is assumed to stream and call tools —
  // the same assumption VS Code makes for any BYOK model.
  const streaming = caps?.streaming ?? true;
  const tools = caps?.tools ?? (modality === 'image' || modality === 'video' ? false : true);
  const vision = caps?.vision ?? modality === 'multimodal';

  return {
    id,
    name: entry?.name ?? live?.display_name ?? id,
    summary: entry?.summary ?? '',
    family: entry?.family ?? id.split('-')[0] ?? 'other',
    productFamily: entry?.productFamily ?? entry?.family ?? 'other',
    brand: entry?.brand ?? live?.owned_by ?? 'oneprovider',
    brandLabel: entry?.brandLabel ?? entry?.brand ?? 'OneProvider',
    platform: entry?.platform === 'anthropic' ? 'anthropic' : 'openai',
    tier: entry?.tier ?? 'standard',
    modality,
    lifecycle: entry?.lifecycle ?? 'active',
    contextLength: entry?.contextTokens ?? live?.context_window ?? FALLBACK_CONTEXT,
    maxOutputTokens: entry?.maxOutputTokens ?? live?.max_output_tokens ?? FALLBACK_MAX_OUTPUT,
    pricing: entry?.pricing ?? null,
    ...(entry?.longContext ? { longContext: entry.longContext } : {}),
    ...(entry?.generation ? { generation: entry.generation } : {}),
    capabilities: {
      text: modality !== 'image' && modality !== 'video',
      vision,
      toolCalling: tools,
      streaming,
      imageOutput: modality === 'image' || caps?.imageGeneration === true,
      videoOutput: modality === 'video' || caps?.videoGeneration === true,
      reasoning: thinkingVariant || !!reasoning,
    },
    ...(reasoning ? { reasoning } : {}),
    thinkingVariant,
    live: isLive,
    catalogOnly: !isLive,
    isFree: !entry?.pricing,
  };
}

/** Brand order the browser lists families in — Claude first, matching the site. */
const BRAND_ORDER = ['claude', 'chatgpt', 'gemini', 'grok', 'deepseek', 'glm', 'kimi', 'mimo'];

/** Cheapest-looking tiers last so the strongest model of each brand leads. */
const TIER_ORDER = ['frontier', 'flagship', 'balanced', 'speed', 'image', 'video'];

function compareModels(a: ProcessedModel, b: ProcessedModel): number {
  // Live models first: a catalog-only entry may not be callable with this key.
  if (a.live !== b.live) {
    return a.live ? -1 : 1;
  }
  const brandDelta = orderIndex(BRAND_ORDER, a.productFamily) - orderIndex(BRAND_ORDER, b.productFamily);
  if (brandDelta !== 0) {
    return brandDelta;
  }
  const tierDelta = orderIndex(TIER_ORDER, a.tier) - orderIndex(TIER_ORDER, b.tier);
  if (tierDelta !== 0) {
    return tierDelta;
  }
  return a.name.localeCompare(b.name);
}

function orderIndex(order: string[], value: string): number {
  const index = order.indexOf(value);
  return index === -1 ? order.length : index;
}

/**
 * Estimate the dollar cost of one request from the bundled rate card.
 *
 * This is an estimate by construction: OneProvider bills server-side, applies
 * long-context tiers, and settles asynchronously. It exists so the status bar
 * can move immediately instead of waiting for the dashboard to catch up — the
 * Usage tab always shows the provider's own figure alongside it.
 */
export function estimateCost(
  modelId: string,
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  },
): number {
  const entry = CATALOG[modelId];
  if (!entry?.pricing) {
    return 0;
  }

  const promptTokens = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;
  const useLongContext =
    !!entry.longContext &&
    entry.longContext.thresholdTokens !== null &&
    promptTokens > entry.longContext.thresholdTokens;
  const rates = useLongContext ? entry.longContext!.pricing : entry.pricing;

  const perToken = (rate: number) => rate / 1_000_000;
  return (
    tokens.inputTokens * perToken(rates.input) +
    tokens.outputTokens * perToken(rates.output) +
    tokens.cacheReadTokens * perToken(rates.cacheRead) +
    tokens.cacheWriteTokens * perToken(rates.cacheWrite)
  );
}
