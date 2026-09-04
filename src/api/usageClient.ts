import * as https from 'https';
import * as vscode from 'vscode';
import { AccountUsage, UsageReport, UsageSnapshot, UsageKeyInfo } from '../types/models';
import { Logger } from '../utils/logger';
import { normalizeApiKey } from '../utils/apiKeyUtils';
import { getAttributionHeaders } from '../utils/branding';

const DEFAULT_ENDPOINT = 'https://dashboard.oneprovider.dev/api/dashboard/lookup';

/** Ranges the dashboard backend accepts; anything else is rejected server-side. */
export const USAGE_RANGES = [1, 3, 7, 30] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

/** Snap an arbitrary number of days onto a range the backend supports. */
export function normalizeRange(days: number | undefined): UsageRange {
  const value = Number(days);
  return (USAGE_RANGES as readonly number[]).includes(value) ? (value as UsageRange) : 1;
}

interface LookupResponse {
  status?: string;
  code?: string;
  message?: string;
  key?: UsageKeyInfo;
  snapshot?: UsageSnapshot;
  usage?: UsageReport;
  usage_sync?: { partial?: boolean };
}

/** Error carrying the machine-readable code the dashboard returns. */
export class UsageLookupError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'UsageLookupError';
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  target_key_invalid: 'OneProvider does not recognise this API key. Check the sk-… value.',
  rate_limited: 'Too many balance lookups — wait a minute and try again.',
  upstream_unavailable:
    'OneProvider is slow or rate-limited right now; the figures shown may be cached.',
  internal: 'OneProvider had an internal error while looking up this key.',
};

/**
 * Reads balance and usage for an API key.
 *
 * OneProvider's documentation advertises `GET /v1/dashboard/balance`, but that
 * route answers 404 on the live API — the figures the web dashboard itself
 * renders come from `POST /api/dashboard/lookup` on the dashboard host, which
 * takes the key in the body rather than an Authorization header. That is the
 * endpoint used here; the URL stays configurable so a documented API route can
 * be pointed at without an extension update.
 *
 * The key leaves the machine for `dashboard.oneprovider.dev` — the vendor's own
 * host, the same one the browser dashboard posts it to — and the whole feature
 * can be switched off with `oneproviderMaestro.usage.enabled`.
 */
export class UsageClient {
  private inFlight?: Promise<AccountUsage>;
  private inFlightKey?: string;

  /** Whether the user has left live balance/usage lookups enabled. */
  static isEnabled(): boolean {
    return vscode.workspace.getConfiguration('oneproviderMaestro').get<boolean>('usage.enabled', true);
  }

  private static endpoint(): string {
    const configured = vscode.workspace
      .getConfiguration('oneproviderMaestro')
      .get<string>('usage.endpoint', DEFAULT_ENDPOINT);
    return configured?.trim() || DEFAULT_ENDPOINT;
  }

  /**
   * Fetch balance and usage for a key.
   *
   * Concurrent callers for the same key+range share one request: the webview,
   * the status bar and the auto-refresh timer all ask at once on startup.
   */
  async fetch(apiKey: string, days: number): Promise<AccountUsage> {
    if (!UsageClient.isEnabled()) {
      throw new UsageLookupError(
        'Live balance and usage are disabled (oneproviderMaestro.usage.enabled).',
        'disabled',
      );
    }

    const key = normalizeApiKey(apiKey);
    const range = normalizeRange(days);
    const dedupeKey = `${key}:${range}`;

    if (this.inFlight && this.inFlightKey === dedupeKey) {
      return this.inFlight;
    }

    this.inFlightKey = dedupeKey;
    this.inFlight = this.request(key, range).finally(() => {
      this.inFlight = undefined;
      this.inFlightKey = undefined;
    });
    return this.inFlight;
  }

  private async request(key: string, days: UsageRange): Promise<AccountUsage> {
    // `live: true` asks the backend to refresh from the upstream provider
    // rather than answering from its own cache.
    const payload = JSON.stringify({ key_value: key, days, live: true });
    const raw = await postJson<LookupResponse>(UsageClient.endpoint(), payload);

    if (raw?.status !== 'ok' || !raw.key || !raw.snapshot) {
      const code = raw?.code || 'internal';
      throw new UsageLookupError(ERROR_MESSAGES[code] || raw?.message || ERROR_MESSAGES.internal, code);
    }

    Logger.debug(
      `Usage lookup ok: balance=${raw.snapshot.balance_usd} requests=${raw.usage?.aggregated?.total_requests ?? 0}`,
    );

    return {
      key: raw.key,
      snapshot: raw.snapshot,
      usage: raw.usage ? normalizeUsage(raw.usage) : undefined,
      status: deriveStatus(raw.key, raw.snapshot),
      days,
      fetchedAt: Date.now(),
    };
  }
}

/**
 * Derive the key's state the same way the OneProvider dashboard does, so the
 * badge here and the badge on the website never disagree.
 */
function deriveStatus(key: UsageKeyInfo, snapshot: UsageSnapshot): AccountUsage['status'] {
  if (key.provider_reported_active === false) {
    return 'disabled';
  }
  if (key.is_active === false) {
    return 'paused';
  }
  if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) {
    return 'expired';
  }
  if (snapshot.balance_usd <= 0) {
    return 'depleted';
  }
  return 'active';
}

/** Fill in the shapes the webview indexes into so it never guards every field. */
function normalizeUsage(usage: UsageReport): UsageReport {
  const aggregated = usage.aggregated ?? ({} as UsageReport['aggregated']);
  return {
    row_count: usage.row_count ?? 0,
    recent_rows: usage.recent_rows ?? [],
    aggregated: {
      total_cost: aggregated.total_cost ?? 0,
      total_requests: aggregated.total_requests ?? 0,
      tokens: {
        input: aggregated.tokens?.input ?? 0,
        output: aggregated.tokens?.output ?? 0,
        cache_read: aggregated.tokens?.cache_read ?? 0,
        cache_creation: aggregated.tokens?.cache_creation ?? 0,
      },
      per_hour: aggregated.per_hour ?? [],
      per_day: aggregated.per_day ?? [],
      per_model: aggregated.per_model ?? [],
    },
  };
}

/** POST JSON via global fetch when available, falling back to the https module. */
async function postJson<T>(urlStr: string, body: string): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...getAttributionHeaders(),
  };

  if (typeof fetch === 'function') {
    const response = await fetch(urlStr, { method: 'POST', headers, body });
    const text = await response.text();
    const parsed = parseJson<T>(text);
    if (parsed) {
      return parsed;
    }
    throw new UsageLookupError(
      `OneProvider dashboard returned ${response.status}`,
      response.status === 429 ? 'rate_limited' : 'internal',
    );
  }

  return new Promise<T>((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          const parsed = parseJson<T>(text);
          if (parsed) {
            resolve(parsed);
            return;
          }
          reject(
            new UsageLookupError(
              `OneProvider dashboard returned ${res.statusCode}`,
              res.statusCode === 429 ? 'rate_limited' : 'internal',
            ),
          );
        });
      },
    );
    req.on('error', (err) => reject(err));
    req.write(body);
    req.end();
  });
}

/**
 * The lookup endpoint returns a JSON error envelope with a 4xx status, so the
 * body is worth more than the status code — parse first, judge afterwards.
 */
function parseJson<T>(text: string): T | undefined {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}
