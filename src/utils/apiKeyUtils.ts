/**
 * Shared API key utility functions.
 * Centralizes key normalization and validation so the client, provider and
 * secret store all agree on what a usable key looks like.
 */

/**
 * Strip a leading "Bearer " prefix and whitespace from an API key string.
 * Users routinely paste the whole Authorization header value.
 */
export function normalizeApiKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.toLowerCase().startsWith('bearer ')) {
    return trimmed.slice(7).trim();
  }
  return trimmed;
}

/**
 * Check whether a string looks like a OneProvider API key.
 *
 * OneProvider mints opaque `sk-…` keys with no fixed suffix format, and its own
 * dashboard accepts anything that starts with `sk-` and is at least 20 chars —
 * this mirrors that rule rather than inventing a stricter one that would reject
 * valid keys.
 */
export function isLikelyOneProviderKey(value: string): boolean {
  return /^sk-[A-Za-z0-9_.-]+$/.test(value) && value.length >= 20;
}

/** Mask a key for display: keep the prefix and the last four characters. */
export function maskApiKey(value: string): string {
  const key = normalizeApiKey(value);
  if (key.length <= 11) {
    return 'sk-…';
  }
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
