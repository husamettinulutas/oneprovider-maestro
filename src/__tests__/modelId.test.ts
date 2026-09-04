import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeModelId } from '../utils/modelId';

test('accepts real OneProvider ids verbatim', () => {
  for (const id of [
    'claude-opus-5',
    'claude-haiku-4-5-20251001-thinking',
    'gpt-5.4-mini',
    'gemini-3.1-pro-preview-low',
    'grok-imagine-image-2.0',
    'kimi-k2.7-code-highspeed',
    'mimo-v2.5-pro',
  ]) {
    assert.equal(sanitizeModelId(id), id);
  }
});

test('trims surrounding whitespace', () => {
  assert.equal(sanitizeModelId('  claude-sonnet-5 '), 'claude-sonnet-5');
});

test('rejects the vendor/model shape used by other gateways', () => {
  // Writing one of these into an agent config produces a 400 at request time,
  // far away from the click that caused it.
  assert.throws(() => sanitizeModelId('anthropic/claude-opus-5'), /not a valid OneProvider model id/);
  assert.throws(() => sanitizeModelId('~openai/gpt-5-latest'), /not a valid OneProvider model id/);
});

test('rejects ids that could break out of a TOML or JSON value', () => {
  assert.throws(() => sanitizeModelId('claude"-opus'), /not a valid/);
  assert.throws(() => sanitizeModelId('claude opus 5'), /not a valid/);
  assert.throws(() => sanitizeModelId('../../etc/passwd'), /not a valid/);
  assert.throws(() => sanitizeModelId(''), /not a valid/);
});
