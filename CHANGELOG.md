# Changelog

All notable changes to **OneProvider Maestro** are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-09-04

First release.

### Copilot Chat
- Native `LanguageModelChatProvider` (`oneprovider-maestro` vendor) contributing OneProvider models straight into the model picker.
- Streaming, tool calling (agent mode), vision input, and reasoning rendered through `LanguageModelThinkingPart` where the proposed API is available.
- Automatic retry with exponential backoff on 429/5xx and transient network errors, honoring `Retry-After`.
- Thinking Effort submenu for models that accept OpenAI-style `reasoning_effort`, gated by a configurable id pattern (default `^gpt-5`) — OneProvider exposes Claude thinking as separate `-thinking` model ids, which take no parameter.
- Sets `chat.byokUtilityModelDefault` to `mainAgent` on first run unless the user configured it, avoiding Copilot's "No utility model is configured" failure.

### Claude Code
- Wires `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` and the model env vars into `~/.claude/settings.json` (or the project-scoped `settings.local.json`).
- The credential goes in `ANTHROPIC_AUTH_TOKEN` rather than `ANTHROPIC_API_KEY`. Both authenticate against OneProvider, but Claude Code gates `ANTHROPIC_API_KEY` behind an approval prompt it cannot show from an IDE panel, and falls back to its stored OAuth session instead — surfacing as "OAuth session expired and could not be refreshed" rather than any gateway error.
- Mirrors the credential into VS Code's `claudeCode.environmentVariables` and sets `claudeCode.disableLoginPrompt`, which the Claude Code extension checks before launching.
- Declares the model's real context window and output cap so auto-compaction fires correctly and a prepaid balance is not blocked by an oversized reservation.
- Only Claude models are offered — OneProvider routes everything else over its OpenAI-compatible wire, which Claude Code cannot speak.

### Codex
- Writes a `[model_providers.oneprovider]` section with `wire_api = "responses"` into `~/.codex/config.toml`, plus the top-level model selection.
- Persists `ONEPROVIDER_API_KEY` as a Windows user environment variable so the GUI-launched extension can resolve `env_key`.
- Config management is semantic — sections and keys are located by name, never by comment markers, because Codex rewrites the file with its own TOML serializer.

### Usage & billing
- **Usage tab** with the account balance, lifetime top-ups, spend, expiry and key status; cost and request charts; token breakdown by day; per-model usage; and the recent request log.
- **Session spend counter** priced locally from the bundled rate card the moment a Copilot turn ends, so the figure moves while you work.
- Status bar showing session spend and remaining balance, turning amber below 10% of lifetime top-ups.
- Balance is read from `POST /api/dashboard/lookup` on the OneProvider dashboard host. The documented `GET /v1/dashboard/balance` route answers 404 on the live API; the endpoint is configurable, and the whole feature can be switched off with `oneproviderMaestro.usage.enabled`.

### Model catalog
- 64-model catalog bundled with the extension (Claude, ChatGPT, Gemini, Grok, DeepSeek, GLM, Kimi, MiMo) with per-million rates, context windows, tiers and capability flags — `GET /v1/models` returns ids only, and OneProvider publishes no endpoint carrying the rest.
- Live ids are merged over the catalog; entries the key did not return are listed as `CATALOG ONLY` rather than hidden, so a scoped key does not look like a broken extension.
- Long-context rate cards (Gemini) are applied when a prompt crosses the threshold.

### Panel
- Five-tab panel (Browse / Copilot / Claude Code / Codex / Usage) on the Tactical Telemetry dark surface, laid out to stay legible from a full editor tab down to a 320px docked sidebar.
- One affordance channel: every pressable control carries a resting keyline and answers the pointer in hazard red, and nothing else in the panel does — so "what can I press" has a single answer at a glance.
- The wordmark is never abbreviated. Narrow widths give up the action labels and the revision tag before they give up "OneProvider".

### Safety
- API key stored in VS Code SecretStorage, never in `settings.json`.
- Every agent config file is backed up to `.maestro-backup` before the first write.
- The pre-Maestro state is snapshotted on the first apply, so switching models repeatedly never loses the original.
- Restore removes the `ONEPROVIDER_API_KEY` user variable if Maestro created it.
