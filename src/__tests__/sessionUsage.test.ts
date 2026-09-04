import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionUsageTracker, extractTokens } from '../session/sessionUsage';

test('extractTokens reads the OpenAI usage shape', () => {
  const tokens = extractTokens({ prompt_tokens: 1000, completion_tokens: 250 })!;
  assert.deepEqual(tokens, {
    inputTokens: 1000,
    outputTokens: 250,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

test('extractTokens reads the Anthropic usage shape', () => {
  const tokens = extractTokens({
    input_tokens: 800,
    output_tokens: 120,
    cache_read_input_tokens: 5000,
    cache_creation_input_tokens: 300,
  })!;
  assert.deepEqual(tokens, {
    inputTokens: 800,
    outputTokens: 120,
    cacheReadTokens: 5000,
    cacheWriteTokens: 300,
  });
});

test('OpenAI cached tokens are subtracted out of prompt_tokens', () => {
  // OpenAI counts cached tokens inside prompt_tokens; Anthropic reports them
  // alongside input_tokens. Without the subtraction the same tokens would be
  // billed at both the input rate and the cache rate.
  const tokens = extractTokens({
    prompt_tokens: 10_000,
    completion_tokens: 100,
    prompt_tokens_details: { cached_tokens: 9000 },
  })!;
  assert.equal(tokens.inputTokens, 1000);
  assert.equal(tokens.cacheReadTokens, 9000);
});

test('extractTokens rejects empty or malformed usage blocks', () => {
  assert.equal(extractTokens(undefined), undefined);
  assert.equal(extractTokens(null), undefined);
  assert.equal(extractTokens('usage'), undefined);
  assert.equal(extractTokens({}), undefined);
  assert.equal(extractTokens({ prompt_tokens: 0, completion_tokens: 0 }), undefined);
  assert.equal(extractTokens({ prompt_tokens: -5 }), undefined);
});

test('a tracked request accumulates into the summary', () => {
  const tracker = new SessionUsageTracker();
  tracker.record('claude-opus-5', { prompt_tokens: 1_000_000, completion_tokens: 0 }, 1200);

  const summary = tracker.summary();
  assert.equal(summary.requests, 1);
  assert.equal(summary.inputTokens, 1_000_000);
  assert.ok(summary.estimatedCost > 0);
  assert.equal(summary.perModel.length, 1);
  assert.equal(summary.perModel[0].modelId, 'claude-opus-5');
  assert.equal(summary.recent[0].durationMs, 1200);
});

test('requests are grouped per model, newest first in the log', () => {
  const tracker = new SessionUsageTracker();
  tracker.record('claude-opus-5', { prompt_tokens: 100, completion_tokens: 10 }, 100);
  tracker.record('gpt-5.5', { prompt_tokens: 100, completion_tokens: 10 }, 100);
  tracker.record('gpt-5.5', { prompt_tokens: 100, completion_tokens: 10 }, 100);

  const summary = tracker.summary();
  assert.equal(summary.requests, 3);
  assert.equal(summary.perModel[0].modelId, 'gpt-5.5', 'busiest model sorts first');
  assert.equal(summary.perModel[0].requests, 2);
  assert.equal(summary.recent[0].modelId, 'gpt-5.5');
});

test('a usage block with no tokens is not recorded', () => {
  const tracker = new SessionUsageTracker();
  assert.equal(tracker.record('claude-opus-5', {}, 50), undefined);
  assert.equal(tracker.summary().requests, 0);
});

test('listeners fire on record and on reset', () => {
  const tracker = new SessionUsageTracker();
  const seen: number[] = [];
  const unsubscribe = tracker.onDidChange((s) => seen.push(s.requests));

  tracker.record('gpt-5.5', { prompt_tokens: 10, completion_tokens: 1 }, 10);
  tracker.reset();
  unsubscribe();
  tracker.record('gpt-5.5', { prompt_tokens: 10, completion_tokens: 1 }, 10);

  assert.deepEqual(seen, [1, 0], 'no events after unsubscribe');
});

test('reset zeroes the totals but keeps the session start time', () => {
  const tracker = new SessionUsageTracker();
  const startedAt = tracker.summary().startedAt;
  tracker.record('gpt-5.5', { prompt_tokens: 500, completion_tokens: 50 }, 10);
  tracker.reset();

  const summary = tracker.summary();
  assert.equal(summary.requests, 0);
  assert.equal(summary.estimatedCost, 0);
  assert.equal(summary.recent.length, 0);
  assert.equal(summary.startedAt, startedAt);
});
