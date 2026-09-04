import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeModels,
  catalogModels,
  catalogSize,
  estimateCost,
  pricingFor,
} from '../catalog/modelCatalog';
import { compileEffortPattern } from '../utils/reasoningEffort';

const PATTERN = compileEffortPattern(undefined);

test('the bundled catalog is populated', () => {
  assert.ok(catalogSize() >= 60, `expected a full catalog, got ${catalogSize()}`);
  assert.equal(catalogModels(PATTERN).length, catalogSize());
});

test('live ids are enriched with catalog metadata', () => {
  const models = mergeModels({
    liveModels: [{ id: 'claude-opus-5' }],
    includeCatalogOnly: false,
    effortPattern: PATTERN,
  });
  assert.equal(models.length, 1);
  const opus = models[0];
  assert.equal(opus.name, 'Claude Opus 5');
  assert.equal(opus.platform, 'anthropic');
  assert.equal(opus.live, true);
  assert.equal(opus.catalogOnly, false);
  assert.ok(opus.contextLength >= 200_000);
  assert.ok(opus.pricing && opus.pricing.input > 0);
});

test('a live id the catalog does not know still produces a usable model', () => {
  const models = mergeModels({
    liveModels: [{ id: 'brand-new-model-9' }],
    includeCatalogOnly: false,
    effortPattern: PATTERN,
  });
  const model = models[0];
  assert.equal(model.id, 'brand-new-model-9');
  assert.equal(model.name, 'brand-new-model-9');
  assert.ok(model.contextLength > 0, 'must not report a zero context window');
  assert.ok(model.maxOutputTokens > 0);
  // An unknown text model must not lose tool calling, or agent mode silently dies.
  assert.equal(model.capabilities.toolCalling, true);
});

test('catalog-only entries are included but flagged', () => {
  const models = mergeModels({
    liveModels: [{ id: 'claude-opus-5' }],
    includeCatalogOnly: true,
    effortPattern: PATTERN,
  });
  assert.ok(models.length > 1);
  const sonnet = models.find((m) => m.id === 'claude-sonnet-5')!;
  assert.equal(sonnet.live, false);
  assert.equal(sonnet.catalogOnly, true);
  // Live models sort ahead of catalog-only ones.
  assert.equal(models[0].id, 'claude-opus-5');
});

test('includeCatalogOnly false hides everything the key did not return', () => {
  const models = mergeModels({
    liveModels: [{ id: 'claude-opus-5' }],
    includeCatalogOnly: false,
    effortPattern: PATTERN,
  });
  assert.equal(models.length, 1);
});

test('a live entry wins over the catalog entry for the same id', () => {
  const models = mergeModels({
    liveModels: [{ id: 'gpt-5.5' }],
    includeCatalogOnly: true,
    effortPattern: PATTERN,
  });
  const gpt = models.filter((m) => m.id === 'gpt-5.5');
  assert.equal(gpt.length, 1, 'the id must not be listed twice');
  assert.equal(gpt[0].live, true);
});

test('thinking variants and effort models are marked as reasoning', () => {
  const models = catalogModels(PATTERN);
  const thinking = models.find((m) => m.id === 'claude-opus-5-thinking')!;
  assert.equal(thinking.thinkingVariant, true);
  assert.equal(thinking.capabilities.reasoning, true);
  assert.equal(thinking.reasoning, undefined, 'thinking ids take no effort parameter');

  const gpt = models.find((m) => m.id === 'gpt-5.5')!;
  assert.equal(gpt.thinkingVariant, false);
  assert.ok(gpt.reasoning, 'gpt-5 ids expose an effort control');
});

test('image and video models are not offered as chat models', () => {
  const models = catalogModels(PATTERN);
  const video = models.find((m) => m.id === 'grok-imagine-video')!;
  assert.equal(video.capabilities.videoOutput, true);
  assert.equal(video.capabilities.toolCalling, false);
  assert.equal(video.capabilities.text, false);
  assert.ok(video.generation && video.generation.components.length > 0);
});

test('estimateCost prices a request from the per-million rates', () => {
  const rates = pricingFor('claude-opus-5')!;
  const cost = estimateCost('claude-opus-5', {
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.ok(Math.abs(cost - rates.input) < 1e-9);
});

test('estimateCost bills cache reads at the cache rate, not the input rate', () => {
  const rates = pricingFor('claude-opus-5')!;
  assert.ok(rates.cacheRead < rates.input, 'precondition: cache reads are cheaper');
  const cached = estimateCost('claude-opus-5', {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 0,
  });
  assert.ok(Math.abs(cached - rates.cacheRead) < 1e-9);
});

test('estimateCost switches to long-context rates past the threshold', () => {
  // Gemini bills a second, higher rate card above 200K prompt tokens; charging
  // the base rate would understate a long agent turn by roughly half.
  const short = estimateCost('gemini-3.1-pro', {
    inputTokens: 100_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  const long = estimateCost('gemini-3.1-pro', {
    inputTokens: 300_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.ok(long / 3 > short, 'the per-token rate must rise above the threshold');
});

test('estimateCost returns zero for models with no token pricing', () => {
  assert.equal(
    estimateCost('grok-imagine-video', {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
    0,
  );
  assert.equal(
    estimateCost('not-a-real-model', {
      inputTokens: 1000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
    0,
  );
});
