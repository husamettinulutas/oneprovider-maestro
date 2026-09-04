import * as https from 'https';
import * as vscode from 'vscode';
import {
  OneProviderApiModel,
  OneProviderModelsResponse,
  ProcessedModel,
} from '../types/models';
import { Logger } from '../utils/logger';
import { normalizeApiKey } from '../utils/apiKeyUtils';
import { getAttributionHeaders } from '../utils/branding';
import { mergeModels } from '../catalog/modelCatalog';
import { compileEffortPattern } from '../utils/reasoningEffort';

const DEFAULT_BASE_URL = 'https://api.oneprovider.dev/v1';

/** Resolve the API base URL from settings (proxy support), without a trailing slash. */
export function getBaseUrl(): string {
  const configured = vscode.workspace
    .getConfiguration('oneproviderMaestro')
    .get<string>('apiEndpoint', DEFAULT_BASE_URL);
  return (configured || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * Client for the OneProvider REST API.
 *
 * Only `/v1/models` is fetched here — chat traffic goes through the language
 * model provider, which streams and needs its own error handling.
 */
export class OneProviderClient {
  private lastRequestTime = 0;
  private readonly minRequestInterval = 1000;

  constructor(private apiKey?: string) {}

  setApiKey(key: string): void {
    this.apiKey = normalizeApiKey(key);
  }

  clearApiKey(): void {
    this.apiKey = undefined;
  }

  /**
   * Fetch the models this key can call and merge them with the bundled catalog.
   *
   * The endpoint answers without a key too, but then returns only OneProvider's
   * default set — so an unauthenticated sync is a preview, not the real list.
   */
  async fetchModels(): Promise<ProcessedModel[]> {
    await this.rateLimit();

    const config = vscode.workspace.getConfiguration('oneproviderMaestro');
    const effortPattern = compileEffortPattern(
      config.get<string>('reasoningEffortModelPattern', '^gpt-5'),
    );
    const defaultEffort = config.get<string | null>('defaultReasoningEffort', null);
    const includeCatalogOnly = config.get<boolean>('showCatalogOnlyModels', true);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...getAttributionHeaders(),
    };
    if (this.apiKey) {
      const key = normalizeApiKey(this.apiKey);
      headers['Authorization'] = `Bearer ${key}`;
      // OneProvider accepts either header; sending both keeps the request
      // working whichever wire the gateway routes it over.
      headers['x-api-key'] = key;
    }

    Logger.info('Fetching models from OneProvider...');
    const data = await this.getJson<OneProviderModelsResponse>(`${getBaseUrl()}/models`, headers);

    if (!data || !Array.isArray(data.data)) {
      throw new Error('Unexpected response from OneProvider /v1/models');
    }

    const liveModels: OneProviderApiModel[] = data.data.filter((m) => !!m?.id);
    Logger.info(`OneProvider returned ${liveModels.length} model ids`);

    return mergeModels({ liveModels, includeCatalogOnly, effortPattern, defaultEffort });
  }

  /** GET JSON via global fetch when available, falling back to the https module. */
  private async getJson<T>(urlStr: string, headers: Record<string, string>): Promise<T> {
    if (typeof fetch === 'function') {
      const response = await fetch(urlStr, { headers });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(describeHttpError(response.status, errorText));
      }
      return (await response.json()) as T;
    }
    return this.httpGetJson<T>(urlStr, headers);
  }

  /** HTTPS GET fallback for hosts where global fetch is unavailable. */
  private httpGetJson<T>(urlStr: string, headers: Record<string, string>): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const req = https.get(
        { hostname: url.hostname, path: url.pathname + url.search, headers },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(body));
              } catch {
                reject(new Error('Failed to parse the OneProvider JSON response'));
              }
            } else {
              reject(new Error(describeHttpError(res.statusCode, body)));
            }
          });
        },
      );
      req.on('error', (err) => reject(err));
      req.end();
    });
  }

  private async rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < this.minRequestInterval) {
      await new Promise((resolve) => setTimeout(resolve, this.minRequestInterval - elapsed));
    }
    this.lastRequestTime = Date.now();
  }
}

/** Turn an API error body into something a user can act on. */
function describeHttpError(status: number | undefined, body: string): string {
  let message = body;
  try {
    message = JSON.parse(body)?.error?.message || body;
  } catch {
    // keep the raw body
  }

  if (status === 401 || status === 403) {
    return 'OneProvider rejected the API key (401/403). Set a valid sk-… key and try again.';
  }
  if (status === 429) {
    return 'OneProvider rate limited the model list request (429). Try again in a minute.';
  }
  return `OneProvider API error ${status ?? '(no status)'}: ${message}`;
}
