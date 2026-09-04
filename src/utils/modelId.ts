/**
 * Model id validation, kept free of any `vscode` import so it can be unit
 * tested outside the extension host — this is the one function whose failure
 * mode is a corrupted agent config file.
 */

/**
 * Validate a model id before writing it into any agent config.
 *
 * OneProvider ids are flat slugs — `claude-opus-5`, `gpt-5.4-mini`,
 * `gemini-3.1-pro-preview-low` — with no vendor prefix and no `:variant`
 * suffix, unlike the `vendor/model` shape other gateways use.
 */
export function sanitizeModelId(raw: string): string {
  const id = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(
      `"${raw}" is not a valid OneProvider model id (expected a flat slug such as "claude-opus-5").`,
    );
  }
  return id;
}
