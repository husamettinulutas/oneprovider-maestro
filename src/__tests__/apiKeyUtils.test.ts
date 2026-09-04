import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApiKey, isLikelyOneProviderKey, maskApiKey } from '../utils/apiKeyUtils';

test('normalizeApiKey trims whitespace', () => {
  assert.equal(normalizeApiKey('  sk-abc123  '), 'sk-abc123');
});

test('normalizeApiKey strips a pasted Authorization header prefix', () => {
  assert.equal(normalizeApiKey('Bearer sk-abc123'), 'sk-abc123');
  assert.equal(normalizeApiKey('bearer  sk-abc123 '), 'sk-abc123');
});

test('isLikelyOneProviderKey accepts a realistic key', () => {
  assert.ok(isLikelyOneProviderKey('sk-' + 'a'.repeat(40)));
  assert.ok(isLikelyOneProviderKey('sk-Op_9.tEst-KEY-0123456789'));
});

test('isLikelyOneProviderKey rejects short or malformed values', () => {
  assert.equal(isLikelyOneProviderKey('sk-short'), false, 'under 20 chars');
  assert.equal(isLikelyOneProviderKey('pk-' + 'a'.repeat(40)), false, 'wrong prefix');
  assert.equal(isLikelyOneProviderKey('sk-has spaces in it here'), false, 'whitespace');
  assert.equal(isLikelyOneProviderKey(''), false);
});

test('isLikelyOneProviderKey does not require the OpenRouter sk-or-v1 shape', () => {
  // OneProvider mints opaque keys; a validator ported from another gateway
  // would reject every real one.
  assert.ok(isLikelyOneProviderKey('sk-' + 'z'.repeat(48)));
});

test('maskApiKey keeps a recognizable prefix and suffix', () => {
  const masked = maskApiKey('sk-abcdefghijklmnopqrstuvwxyz9876');
  assert.equal(masked, 'sk-abc…9876');
  assert.ok(!masked.includes('mnopqrst'));
});

test('maskApiKey does not leak short values', () => {
  assert.equal(maskApiKey('sk-abc'), 'sk-…');
});
