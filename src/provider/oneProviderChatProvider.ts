import * as vscode from 'vscode';
import * as https from 'https';
import { ModelCache } from '../cache/modelCache';
import { SecretsManager } from '../utils/secrets';
import { Logger } from '../utils/logger';
import { ProcessedModel, SelectedModel } from '../types/models';
import { normalizeApiKey } from '../utils/apiKeyUtils';
import { getAttributionHeaders } from '../utils/branding';
import { getBaseUrl } from '../api/oneProviderClient';
import { SessionUsageTracker } from '../session/sessionUsage';
import {
  buildThinkingEffortSchema,
  compileEffortPattern,
  reasoningForModel,
  resolveReasoningEffort,
} from '../utils/reasoningEffort';

/** Read a configuration value under the `oneproviderMaestro` namespace. */
function getConfig<T>(key: string, defaultValue: T): T {
  return vscode.workspace.getConfiguration('oneproviderMaestro').get<T>(key, defaultValue);
}

/** HTTP status codes that are safe to retry. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/** Node.js network error codes that are safe to retry. */
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'EHOSTUNREACH',
]);

/** True when a 4xx names `stream_options` as the offending field. */
function isStreamOptionsRejection(err: unknown): boolean {
  if (!(err instanceof OneProviderRequestError)) {
    return false;
  }
  if (err.statusCode !== 400 && err.statusCode !== 422) {
    return false;
  }
  return /stream_options/i.test(err.message);
}

/** Error carrying HTTP metadata so the retry loop can make a decision. */
class OneProviderRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly retryAfter?: number,
    readonly errorCode?: string,
  ) {
    super(message);
    this.name = 'OneProviderRequestError';
  }
}

/**
 * Native VS Code LanguageModelChatProvider for OneProvider.
 *
 * Contributes OneProvider models straight into the Copilot Chat picker: agent
 * mode with full tool calling, vision input, streamed reasoning, and per-request
 * usage accounting that feeds the session spend counter.
 *
 * Every model is called over the OpenAI-compatible `/v1/chat/completions`
 * endpoint — OneProvider normalizes Claude, Gemini, Grok and the rest behind it,
 * so one code path covers the whole catalog.
 */
export class OneProviderChatProvider implements vscode.LanguageModelChatProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  /** Whether the proposed `LanguageModelThinkingPart` API exists at runtime. */
  private readonly _thinkingPartAvailable =
    typeof (vscode as any).LanguageModelThinkingPart === 'function';

  constructor(
    private readonly cache: ModelCache,
    private readonly secrets: SecretsManager,
    private readonly globalState: vscode.Memento,
    private readonly sessionUsage: SessionUsageTracker,
  ) {}

  /** Notify VS Code that available language models have changed. */
  refresh(): void {
    this._onDidChange.fire();
  }

  // ── Model enumeration ──────────────────────────────────────────────────────

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const selected = this.globalState.get<SelectedModel[]>('oneprovider-selected-models') || [];
    const activeModels = this.cache
      .getModels()
      .filter((m) => selected.some((s) => s.id === m.id && s.enabled));

    const effortPattern = compileEffortPattern(getConfig<string>('reasoningEffortModelPattern', '^gpt-5'));
    const globalDefault = getConfig<string | null>('defaultReasoningEffort', null);

    return activeModels.map((m) => {
      const reasoning = reasoningForModel(m.id, effortPattern, globalDefault);
      const effortDefault =
        selected.find((s) => s.id === m.id)?.reasoningEffort || reasoning?.defaultEffort;

      return {
        id: m.id,
        name: m.name,
        family: 'OneProvider Maestro',
        version: '1.0.0',
        maxInputTokens: this.calculateMaxInputTokens(m.contextLength, m.maxOutputTokens),
        maxOutputTokens: m.maxOutputTokens || 4096,
        tooltip: this.buildModelTooltip(m),
        detail: this.buildModelDetail(m, effortDefault),
        capabilities: {
          imageInput: m.capabilities.vision,
          toolCalling: m.capabilities.toolCalling,
        },
        isUserSelectable: true,
        isBYOK: true,
        // Renders the "Thinking Effort" submenu in the Copilot model picker.
        ...(reasoning
          ? { configurationSchema: buildThinkingEffortSchema(reasoning, effortDefault) }
          : {}),
      };
    });
  }

  // ── Chat response ──────────────────────────────────────────────────────────

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const rawKey = await this.secrets.getApiKey();
    const apiKey = rawKey ? normalizeApiKey(rawKey) : undefined;
    if (!apiKey) {
      progress.report(
        new vscode.LanguageModelTextPart(
          '❌ OneProvider API key not set. Click the 🔑 icon in the OneProvider Maestro panel to set it.',
        ),
      );
      return;
    }

    const formattedMessages = this.formatMessages(messages);
    const { tools, toolChoice } = this.buildToolDefinitions(options);

    // Effort resolution: Copilot picker → per-model override → global setting.
    const selectedModels = this.globalState.get<SelectedModel[]>('oneprovider-selected-models') || [];
    const effortPattern = compileEffortPattern(getConfig<string>('reasoningEffortModelPattern', '^gpt-5'));
    const globalDefaultEffort = getConfig<string | null>('defaultReasoningEffort', null);
    const reasoningEffort = resolveReasoningEffort(
      reasoningForModel(model.id, effortPattern, globalDefaultEffort),
      { modelConfiguration: options.modelConfiguration, modelOptions: options.modelOptions },
      selectedModels.find((s) => s.id === model.id)?.reasoningEffort || undefined,
    );

    const requestBody = this.buildRequestBody(
      model.id,
      formattedMessages,
      tools,
      toolChoice,
      reasoningEffort,
    );

    const bodySize = JSON.stringify(requestBody).length;
    if (bodySize > 1_000_000) {
      Logger.warn(
        `Request body is very large: ${(bodySize / 1_000_000).toFixed(1)}MB — consider starting a new chat`,
      );
    }

    const maxRetries = getConfig<number>('maxRetries', 3);
    const timeoutSeconds = getConfig<number>('requestTimeoutSeconds', 60);

    Logger.info(
      `→ OneProvider: model=${model.id} messages=${formattedMessages.length} tools=${tools?.length || 0} body=${(bodySize / 1024).toFixed(0)}KB effort=${reasoningEffort ?? 'off'}`,
    );

    try {
      await this.makeRequestWithRetry(
        requestBody,
        apiKey,
        progress,
        token,
        maxRetries,
        timeoutSeconds,
      );
    } catch (err: any) {
      if (token.isCancellationRequested) {
        return;
      }

      // `stream_options` is standard OpenAI, but it is only asked for so the
      // session counter can price the turn — it is not worth failing a whole
      // request over. If the gateway rejects the field, drop it and retry once;
      // the turn then succeeds with no local cost estimate for it.
      if (isStreamOptionsRejection(err)) {
        Logger.warn('OneProvider rejected stream_options; retrying once without usage accounting');
        const { stream_options: _dropped, ...withoutUsage } = requestBody;
        try {
          await this.makeRequestWithRetry(
            withoutUsage,
            apiKey,
            progress,
            token,
            maxRetries,
            timeoutSeconds,
          );
          return;
        } catch (retryErr: any) {
          if (token.isCancellationRequested) {
            return;
          }
          err = retryErr;
        }
      }

      // OneProviderRequestError messages were already reported to progress.
      if (!(err instanceof OneProviderRequestError)) {
        const msg = `❌ Unexpected error: ${err?.message || err}`;
        progress.report(new vscode.LanguageModelTextPart(msg));
        Logger.error(msg, err);
      }
      throw err;
    }
  }

  // ── Content part type guards ───────────────────────────────────────────────

  /**
   * Duck-typed because `vscode.LanguageModelDataPart` may not exist in older VS
   * Code versions, where `instanceof` throws. VS Code also sends cache_control
   * parts carrying data+mimeType, so the mime type must be checked.
   */
  private isImageDataPart(part: any): part is { data: Uint8Array; mimeType: string } {
    if (part && typeof part === 'object' && 'data' in part && 'mimeType' in part) {
      const mime = typeof part.mimeType === 'string' ? part.mimeType : '';
      return mime.startsWith('image/');
    }
    return false;
  }

  private isToolCallPart(part: any): part is vscode.LanguageModelToolCallPart {
    return part && typeof part === 'object' && 'callId' in part && 'name' in part && 'input' in part;
  }

  private isToolResultPart(part: any): part is vscode.LanguageModelToolResultPart {
    return (
      part && typeof part === 'object' && 'callId' in part && 'content' in part && !('name' in part)
    );
  }

  // ── Message formatting ─────────────────────────────────────────────────────

  /** Format VS Code messages for the OpenAI-compatible endpoint. */
  private formatMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): any[] {
    const formattedMessages: any[] = [];

    for (const msg of messages) {
      let role = 'user';
      if (
        msg.role === vscode.LanguageModelChatMessageRole.Assistant ||
        (msg.role as any) === 'assistant' ||
        (msg.role as any) === 2
      ) {
        role = 'assistant';
      }

      // VS Code may send system-level prompts (workspace instructions,
      // copilot-instructions.md). Check enum, string and numeric forms.
      const systemEnum = (vscode.LanguageModelChatMessageRole as any).System;
      if (
        (systemEnum !== undefined && msg.role === systemEnum) ||
        (msg.role as any) === 'system' ||
        (msg.role as any) === 0
      ) {
        role = 'system';
      }

      let hasImageParts = false;
      let hasToolCallParts = false;
      let hasToolResultParts = false;

      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (this.isImageDataPart(part)) {
            hasImageParts = true;
          }
          if (this.isToolCallPart(part)) {
            hasToolCallParts = true;
          }
          if (this.isToolResultPart(part)) {
            hasToolResultParts = true;
          }
        }
      }

      // VS Code sends tool results as User messages carrying tool-result parts;
      // the API expects standalone { role: 'tool' } messages.
      if (hasToolResultParts && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (this.isToolResultPart(part)) {
            formattedMessages.push({
              role: 'tool',
              tool_call_id: part.callId,
              content: this.extractTextFromParts(part.content) || '(no output)',
            });
          }
        }
        continue;
      }

      // Previous tool calls arrive as Assistant messages with tool-call parts.
      if (hasToolCallParts && role === 'assistant' && Array.isArray(msg.content)) {
        let textContent = '';
        const toolCalls: any[] = [];

        for (const part of msg.content) {
          if (this.isToolCallPart(part)) {
            toolCalls.push({
              id: part.callId,
              type: 'function',
              function: {
                name: part.name,
                arguments:
                  typeof part.input === 'string' ? part.input : JSON.stringify(part.input),
              },
            });
          } else {
            textContent += this.extractTextFromPart(part);
          }
        }

        formattedMessages.push({
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolCalls,
        });
        continue;
      }

      if (hasImageParts && Array.isArray(msg.content)) {
        const contentParts: Array<
          { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
        > = [];

        for (const part of msg.content) {
          if (this.isImageDataPart(part)) {
            const base64Data = Buffer.from(part.data).toString('base64');
            const mimeType = part.mimeType || 'image/png';
            contentParts.push({
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64Data}` },
            });
          } else {
            const text = this.extractTextFromPart(part);
            if (text) {
              contentParts.push({ type: 'text', text });
            }
          }
        }

        formattedMessages.push({ role, content: contentParts });
        continue;
      }

      let textContent = '';
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          textContent += this.extractTextFromPart(part);
        }
      } else if (typeof msg.content === 'string') {
        textContent = msg.content;
      }

      formattedMessages.push({ role, content: textContent });
    }

    return formattedMessages;
  }

  private extractTextFromPart(part: any): string {
    if (part instanceof vscode.LanguageModelTextPart) {
      return part.value;
    }
    if (typeof part === 'string') {
      return part;
    }
    if (part && typeof part === 'object' && 'value' in part) {
      return (part as any).value || '';
    }
    return '';
  }

  private extractTextFromParts(content: any): string {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content.map((p) => this.extractTextFromPart(p)).join('');
    }
    return '';
  }

  // ── Tool definitions ───────────────────────────────────────────────────────

  private buildToolDefinitions(options: vscode.ProvideLanguageModelChatResponseOptions): {
    tools: any[] | undefined;
    toolChoice: string | undefined;
  } {
    let tools: any[] | undefined;
    if (options.tools && options.tools.length > 0) {
      tools = options.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.inputSchema || { type: 'object', properties: {} },
        },
      }));
    }

    let toolChoice: string | undefined;
    if (tools && tools.length > 0) {
      toolChoice =
        options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
    }

    return { tools, toolChoice };
  }

  // ── Request body ───────────────────────────────────────────────────────────

  private buildRequestBody(
    modelId: string,
    messages: any[],
    tools: any[] | undefined,
    toolChoice: string | undefined,
    reasoningEffort?: string,
  ): any {
    const body: any = {
      model: modelId,
      messages,
      stream: true,
      // Ask for the usage block on the final chunk — it drives session costing.
      stream_options: { include_usage: true },
    };

    // Only sent for models matched by reasoningEffortModelPattern; OneProvider
    // exposes Claude thinking as separate `-thinking` ids instead, and an
    // unsupported field is a 400 rather than a silently ignored one.
    if (reasoningEffort) {
      body.reasoning_effort = reasoningEffort;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = toolChoice;
    }

    const temperature = getConfig<number | null>('defaultTemperature', null);
    const maxTokens = getConfig<number | null>('defaultMaxTokens', null);
    if (temperature !== null && temperature !== undefined) {
      body.temperature = temperature;
    }
    if (maxTokens !== null && maxTokens !== undefined) {
      body.max_tokens = maxTokens;
    }

    return body;
  }

  // ── Retry logic ────────────────────────────────────────────────────────────

  private async makeRequestWithRetry(
    requestBody: any,
    apiKey: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    maxRetries: number,
    timeoutSeconds: number,
  ): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (token.isCancellationRequested) {
        return;
      }

      try {
        return await this.makeStreamingRequest(
          requestBody,
          apiKey,
          progress,
          token,
          timeoutSeconds,
        );
      } catch (err: any) {
        lastError = err;

        const isRetryable =
          (err instanceof OneProviderRequestError &&
            err.statusCode !== undefined &&
            RETRYABLE_STATUS_CODES.has(err.statusCode)) ||
          (err.errorCode && RETRYABLE_ERROR_CODES.has(err.errorCode)) ||
          (err.code && RETRYABLE_ERROR_CODES.has(err.code));

        if (!isRetryable || attempt >= maxRetries || token.isCancellationRequested) {
          throw lastError;
        }

        const delay = this.getRetryDelay(err, attempt);
        Logger.warn(
          `Request failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${err.message}`,
        );
        progress.report(
          new vscode.LanguageModelTextPart(`\n⏳ Retrying (${attempt + 1}/${maxRetries})...\n`),
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw lastError!;
  }

  /** Retry delay, respecting Retry-After on 429 responses. */
  private getRetryDelay(err: any, attempt: number): number {
    if (err instanceof OneProviderRequestError && err.retryAfter) {
      return Math.min(err.retryAfter * 1000, 30_000);
    }
    return Math.pow(2, attempt) * 1000;
  }

  // ── Streaming HTTP request ─────────────────────────────────────────────────

  private makeStreamingRequest(
    requestBody: any,
    apiKey: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    timeoutSeconds: number,
  ): Promise<void> {
    const bodyData = JSON.stringify(requestBody);

    let url: URL;
    try {
      url = new URL(`${getBaseUrl()}/chat/completions`);
    } catch {
      url = new URL('https://api.oneprovider.dev/v1/chat/completions');
    }

    const startedAt = Date.now();

    return new Promise<void>((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port ? parseInt(url.port, 10) : undefined,
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...getAttributionHeaders(),
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            let errBody = '';
            res.on('data', (chunk) => (errBody += chunk));
            res.on('end', () => {
              Logger.error(`OneProvider API error ${res.statusCode}: ${errBody}`);

              const friendly = this.buildFriendlyError(res.statusCode, errBody);
              progress.report(
                new vscode.LanguageModelTextPart(`${friendly}\n\nDetails: ${errBody}`),
              );

              let retryAfter: number | undefined;
              if (res.statusCode === 429) {
                const header = res.headers['retry-after'];
                if (header) {
                  retryAfter = parseInt(header as string, 10) || 5;
                }
              }

              reject(new OneProviderRequestError(friendly, res.statusCode, retryAfter));
            });
            return;
          }

          let buffer = '';
          const pendingToolCalls = new Map<
            number,
            { id: string; name: string; arguments: string }
          >();
          let usageData: any = null;

          res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data: ')) {
                continue;
              }

              const dataStr = trimmed.slice(6).trim();
              if (dataStr === '[DONE]') {
                this.emitPendingToolCalls(pendingToolCalls, progress);
                continue;
              }

              try {
                const json = JSON.parse(dataStr);
                const delta = json.choices?.[0]?.delta;
                const finishReason = json.choices?.[0]?.finish_reason;

                if (json.usage) {
                  usageData = json.usage;
                }

                // Reasoning models stream thinking under either name depending
                // on which upstream OneProvider is normalizing.
                const reasoning = delta?.reasoning || delta?.reasoning_content;
                if (reasoning) {
                  this.reportReasoning(reasoning, progress);
                }

                if (delta?.content) {
                  progress.report(new vscode.LanguageModelTextPart(delta.content));
                }

                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!pendingToolCalls.has(idx)) {
                      pendingToolCalls.set(idx, { id: '', name: '', arguments: '' });
                    }
                    const pending = pendingToolCalls.get(idx)!;
                    if (tc.id) {
                      pending.id = tc.id;
                    }
                    if (tc.function?.name) {
                      pending.name += tc.function.name;
                    }
                    if (tc.function?.arguments) {
                      pending.arguments += tc.function.arguments;
                    }
                  }
                }

                if (finishReason === 'tool_calls') {
                  this.emitPendingToolCalls(pendingToolCalls, progress);
                }
              } catch {
                // Partial SSE chunks are expected; ignore parse failures.
              }
            }
          });

          res.on('end', () => {
            this.emitPendingToolCalls(pendingToolCalls, progress);
            if (usageData) {
              this.sessionUsage.record(requestBody.model, usageData, Date.now() - startedAt);
            }
            resolve();
          });

          res.on('error', (err) => {
            reject(
              new OneProviderRequestError(
                `Stream error: ${err.message}`,
                undefined,
                undefined,
                (err as any).code,
              ),
            );
          });
        },
      );

      req.setTimeout(timeoutSeconds * 1000, () => {
        req.destroy();
        reject(
          new OneProviderRequestError(
            `⏱️ Request timed out after ${timeoutSeconds}s. The model may be overloaded — try again or choose a different model.`,
            undefined,
            undefined,
            'ETIMEDOUT',
          ),
        );
      });

      token.onCancellationRequested(() => {
        req.destroy();
        resolve(); // Cancellation is not an error.
      });

      req.on('error', (err) => {
        Logger.error('Request error', err);
        reject(
          new OneProviderRequestError(
            `❌ Network error: ${err.message}`,
            undefined,
            undefined,
            (err as any).code,
          ),
        );
      });

      req.write(bodyData);
      req.end();
    });
  }

  // ── Response parts ─────────────────────────────────────────────────────────

  /**
   * Report reasoning content. Uses the native `LanguageModelThinkingPart`
   * (proposed API) when available so VS Code renders a collapsible section, and
   * falls back to plain text where that proposal is not enabled.
   */
  private reportReasoning(
    reasoning: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    if (this._thinkingPartAvailable) {
      progress.report(
        new vscode.LanguageModelThinkingPart(
          reasoning,
        ) as unknown as vscode.LanguageModelResponsePart,
      );
    } else {
      progress.report(new vscode.LanguageModelTextPart(reasoning));
    }
  }

  private emitPendingToolCalls(
    pendingToolCalls: Map<number, { id: string; name: string; arguments: string }>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    if (pendingToolCalls.size === 0) {
      return;
    }

    for (const [, tc] of pendingToolCalls) {
      if (!tc.name) {
        continue;
      }
      try {
        const args = tc.arguments ? JSON.parse(tc.arguments) : {};
        Logger.debug(`Emitting tool call: ${tc.name} (${tc.id})`);
        progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, args));
      } catch (e) {
        Logger.error(`Failed to parse tool call arguments for ${tc.name}: ${tc.arguments}`, e);
        try {
          progress.report(
            new vscode.LanguageModelToolCallPart(tc.id, tc.name, { _raw: tc.arguments }),
          );
        } catch {
          // Give up on this one tool call rather than failing the whole turn.
        }
      }
    }
    pendingToolCalls.clear();
  }

  // ── Errors & presentation ──────────────────────────────────────────────────

  private buildFriendlyError(statusCode: number | undefined, body: string): string {
    let message = body;
    try {
      message = JSON.parse(body)?.error?.message || body;
    } catch {
      // keep the raw body
    }

    if (statusCode === 401 || statusCode === 403) {
      return (
        '❌ OneProvider: authorization failed (invalid or missing API key).\n\n' +
        '➡️ Fix: click the 🔑 icon in the OneProvider Maestro panel and re-enter your sk-… key.'
      );
    }
    if (statusCode === 402) {
      return (
        '❌ OneProvider: this key has no balance left.\n\n' +
        '➡️ Fix: top the key up, then check the Usage tab for the new balance.'
      );
    }
    if (statusCode === 404) {
      return (
        `❌ OneProvider: model not found (404): ${message}\n\n` +
        '➡️ Fix: run "Sync Models from API" — the id may be catalog-only and not enabled for your key.'
      );
    }
    if (statusCode === 429) {
      return '❌ OneProvider: rate limited (429). The extension retries automatically with backoff.';
    }
    return `❌ OneProvider error (${statusCode}): ${message}`;
  }

  /** Model-picker hover text: id plus the capabilities the model actually has. */
  private buildModelTooltip(m: ProcessedModel): string {
    const caps: string[] = [];
    if (m.capabilities.toolCalling) {
      caps.push('tools');
    }
    if (m.capabilities.vision) {
      caps.push('vision');
    }
    if (m.thinkingVariant) {
      caps.push('thinking');
    }
    if (m.reasoning) {
      caps.push(`effort (${m.reasoning.supportedEfforts.join('/')})`);
    }
    return `${m.name} (${m.id})${caps.length ? ' — ' + caps.join(', ') : ''}`;
  }

  /** One line of price/context context under the model name in the picker. */
  private buildModelDetail(m: ProcessedModel, effort?: string): string | undefined {
    const bits: string[] = [];
    if (m.pricing) {
      bits.push(`$${m.pricing.input.toFixed(2)}/$${m.pricing.output.toFixed(2)} per M`);
    }
    if (m.contextLength) {
      bits.push(`${Math.round(m.contextLength / 1000)}K ctx`);
    }
    if (effort && effort !== 'none') {
      bits.push(`thinking ${effort}`);
    } else if (m.thinkingVariant) {
      bits.push('thinking');
    }
    return bits.length ? bits.join(' · ') : undefined;
  }

  // ── Token accounting ───────────────────────────────────────────────────────

  /**
   * Report a maxInputTokens below the raw context window.
   *
   * Reporting the full window makes VS Code believe compaction is never needed,
   * which ends in request bodies the API rejects. Subtracting the output
   * reservation plus a 10% margin keeps compaction firing in time.
   */
  private calculateMaxInputTokens(
    contextLength: number | undefined,
    maxOutputTokens: number | undefined,
  ): number {
    const override = getConfig<number | null>('maxInputTokensOverride', null);
    if (override !== null && override !== undefined && override > 0) {
      return override;
    }

    const ctx = contextLength || 128_000;
    const output = maxOutputTokens || 4096;
    const netInput = ctx - output;
    return Math.max(netInput - Math.floor(netInput * 0.1), 8192);
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    if (typeof text === 'string') {
      return this.estimateTokens(text);
    }

    let totalTokens = 4; // Message overhead (role, delimiters).

    if (Array.isArray(text.content)) {
      for (const part of text.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          totalTokens += this.estimateTokens(part.value);
        } else if (this.isToolCallPart(part)) {
          totalTokens += this.estimateTokens(part.name);
          totalTokens += this.estimateTokens(
            typeof part.input === 'string' ? part.input : JSON.stringify(part.input),
          );
          totalTokens += 10; // Tool call JSON structure.
        } else if (this.isToolResultPart(part)) {
          totalTokens += this.estimateTokens(this.extractTextFromParts(part.content));
          totalTokens += 5;
        } else if (this.isImageDataPart(part)) {
          // Vision models spend roughly 85 (low-res) to 765 (high-res) tokens.
          totalTokens += 765;
        } else if (typeof part === 'string') {
          totalTokens += this.estimateTokens(part);
        } else if (part && typeof part === 'object' && 'value' in (part as any)) {
          totalTokens += this.estimateTokens((part as any).value || '');
        }
      }
    }

    // Underestimating makes VS Code skip compaction, which ends in rejected
    // request bodies; a 20% buffer errs on the safe side.
    return Math.ceil(totalTokens * 1.2);
  }

  /**
   * Estimate tokens from character classes rather than a real tokenizer:
   * ~4 chars/token for Latin, ~2 for CJK and other non-Latin scripts, ~5 for
   * whitespace. Good enough to drive compaction, and it costs nothing.
   */
  private estimateTokens(text: string): number {
    if (!text) {
      return 0;
    }

    let latinChars = 0;
    let nonLatinChars = 0;
    let whitespace = 0;

    for (const char of text) {
      const code = char.codePointAt(0) || 0;
      if (code <= 0x7f) {
        if (/\s/.test(char)) {
          whitespace++;
        } else {
          latinChars++;
        }
      } else if (code <= 0x024f) {
        // Extended Latin — covers Turkish İ, ş, ç, ğ, ü, ö and friends.
        latinChars++;
      } else {
        nonLatinChars++;
      }
    }

    return Math.max(
      1,
      Math.ceil(latinChars / 4) + Math.ceil(nonLatinChars / 2) + Math.ceil(whitespace / 5),
    );
  }
}
