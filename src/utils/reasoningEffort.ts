/**
 * Thinking-effort helpers.
 *
 * OneProvider handles reasoning two different ways depending on the model:
 *
 *  1. **Separate model ids.** Claude thinking is published as its own id
 *     (`claude-opus-5-thinking`), and Gemini bakes the budget into the id
 *     (`gemini-3-pro-high` / `-low`). Those models take no extra parameter —
 *     picking the id *is* picking the effort.
 *  2. **`reasoning_effort` on the request.** OpenAI-family models accept the
 *     OpenAI field through the compatible endpoint.
 *
 * Sending `reasoning_effort` to a model that does not take it is a 400, so the
 * effort control is gated behind a configurable id pattern (default `^gpt-5`)
 * rather than offered everywhere and hoped for.
 *
 * Copilot renders the model-picker "Thinking Effort" submenu when a
 * LanguageModelChatInformation includes `configurationSchema.reasoningEffort`
 * with `group: 'navigation'`; the chosen value comes back on
 * `ProvideLanguageModelChatResponseOptions.modelConfiguration`.
 */

/** Efforts offered for models that accept the OpenAI `reasoning_effort` field. */
export const OPENAI_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;

export type ReasoningEffort = (typeof OPENAI_EFFORTS)[number];

export interface ModelReasoning {
  /** Effort values this model accepts, cheapest-first. */
  supportedEfforts: string[];
  defaultEffort?: string;
}

const EFFORT_LABELS: Record<string, string> = {
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const EFFORT_DESCRIPTIONS: Record<string, string> = {
  none: 'Send no reasoning_effort field at all — fastest, cheapest',
  minimal: 'Light reasoning for simple tasks',
  low: 'Faster responses with less reasoning',
  medium: 'Balanced reasoning and speed',
  high: 'Greater reasoning depth, slower and more tokens',
};

export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function effortDescription(effort: string): string {
  return EFFORT_DESCRIPTIONS[effort] ?? effort;
}

function isEffort(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Compile the configured id pattern, falling back to the default when the user
 * typed something that is not a valid regular expression.
 */
export function compileEffortPattern(pattern: string | undefined): RegExp {
  const source = (pattern ?? '').trim() || '^gpt-5';
  try {
    return new RegExp(source);
  } catch {
    return /^gpt-5/;
  }
}

/**
 * Effort metadata for a model id, or undefined when the model has no
 * `reasoning_effort` control (which is most of them — see the file header).
 */
export function reasoningForModel(
  modelId: string,
  effortPattern: RegExp,
  configuredDefault?: string | null,
): ModelReasoning | undefined {
  if (!effortPattern.test(modelId)) {
    return undefined;
  }
  const supportedEfforts = [...OPENAI_EFFORTS];
  const defaultEffort =
    isEffort(configuredDefault) && supportedEfforts.includes(configuredDefault as ReasoningEffort)
      ? configuredDefault
      : 'none';
  return { supportedEfforts, defaultEffort };
}

/** True when the id is one of OneProvider's dedicated thinking variants. */
export function isThinkingVariant(modelId: string): boolean {
  return /-thinking$/.test(modelId);
}

export interface ReasoningRequestOptions {
  modelConfiguration?: { readonly [key: string]: unknown };
  modelOptions?: { readonly [key: string]: unknown };
}

/**
 * Resolve the effort to send on this request.
 * Priority: Copilot picker → modelOptions → per-model override → catalog default.
 * Returns undefined when the field must be omitted (no control, or "none").
 */
export function resolveReasoningEffort(
  reasoning: ModelReasoning | undefined,
  options: ReasoningRequestOptions,
  perModelOverride?: string,
): string | undefined {
  if (!reasoning) {
    return undefined;
  }

  const candidates = [
    options.modelConfiguration?.reasoningEffort,
    options.modelOptions?.reasoningEffort,
    perModelOverride,
    reasoning.defaultEffort,
  ];

  for (const candidate of candidates) {
    if (!isEffort(candidate) || !reasoning.supportedEfforts.includes(candidate)) {
      continue;
    }
    return candidate === 'none' ? undefined : candidate;
  }

  return undefined;
}

/** JSON schema that makes Copilot render the Thinking Effort submenu. */
export function buildThinkingEffortSchema(
  reasoning: ModelReasoning,
  selectedEffort?: string,
): {
  properties: {
    reasoningEffort: {
      type: 'string';
      title: string;
      enum: string[];
      enumItemLabels: string[];
      enumDescriptions: string[];
      default: string;
      group: 'navigation';
    };
  };
} {
  const defaultEffort =
    (selectedEffort && reasoning.supportedEfforts.includes(selectedEffort)
      ? selectedEffort
      : undefined) ??
    reasoning.defaultEffort ??
    reasoning.supportedEfforts[0];

  return {
    properties: {
      reasoningEffort: {
        type: 'string',
        title: 'Thinking Effort',
        enum: reasoning.supportedEfforts,
        enumItemLabels: reasoning.supportedEfforts.map(effortLabel),
        enumDescriptions: reasoning.supportedEfforts.map(effortDescription),
        default: defaultEffort,
        group: 'navigation',
      },
    },
  };
}
