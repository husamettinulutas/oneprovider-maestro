import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileEffortPattern,
  isThinkingVariant,
  reasoningForModel,
  resolveReasoningEffort,
  buildThinkingEffortSchema,
} from '../utils/reasoningEffort';

const DEFAULT_PATTERN = compileEffortPattern(undefined);

test('compileEffortPattern falls back when the user typed an invalid regex', () => {
  const pattern = compileEffortPattern('gpt-5(');
  assert.ok(pattern.test('gpt-5.5'));
  assert.equal(pattern.test('claude-opus-5'), false);
});

test('compileEffortPattern honors a widened pattern', () => {
  const pattern = compileEffortPattern('^(gpt-5|grok-4)');
  assert.ok(pattern.test('grok-4.6'));
  assert.ok(pattern.test('gpt-5.4-mini'));
});

test('only ids matching the pattern get an effort control', () => {
  assert.ok(reasoningForModel('gpt-5.5', DEFAULT_PATTERN));
  // OneProvider ships Claude thinking as its own model id, so sending
  // reasoning_effort to a Claude id is a 400, not a no-op.
  assert.equal(reasoningForModel('claude-opus-5', DEFAULT_PATTERN), undefined);
  assert.equal(reasoningForModel('claude-opus-5-thinking', DEFAULT_PATTERN), undefined);
  assert.equal(reasoningForModel('gemini-3.1-pro-high', DEFAULT_PATTERN), undefined);
});

test('the default effort is "none" unless settings say otherwise', () => {
  assert.equal(reasoningForModel('gpt-5.5', DEFAULT_PATTERN)!.defaultEffort, 'none');
  assert.equal(reasoningForModel('gpt-5.5', DEFAULT_PATTERN, 'high')!.defaultEffort, 'high');
  // An unsupported configured value must not be passed through.
  assert.equal(reasoningForModel('gpt-5.5', DEFAULT_PATTERN, 'ultra')!.defaultEffort, 'none');
});

test('isThinkingVariant detects the dedicated thinking ids', () => {
  assert.ok(isThinkingVariant('claude-opus-5-thinking'));
  assert.ok(isThinkingVariant('claude-haiku-4-5-20251001-thinking'));
  assert.equal(isThinkingVariant('claude-opus-5'), false);
  assert.equal(isThinkingVariant('thinking-model'), false);
});

test('resolveReasoningEffort omits the field for models without a control', () => {
  assert.equal(resolveReasoningEffort(undefined, { modelConfiguration: { reasoningEffort: 'high' } }), undefined);
});

test('resolveReasoningEffort prefers the Copilot picker over stored defaults', () => {
  const reasoning = reasoningForModel('gpt-5.5', DEFAULT_PATTERN, 'low')!;
  assert.equal(
    resolveReasoningEffort(reasoning, { modelConfiguration: { reasoningEffort: 'high' } }, 'medium'),
    'high',
  );
});

test('resolveReasoningEffort falls back through modelOptions then the override', () => {
  const reasoning = reasoningForModel('gpt-5.5', DEFAULT_PATTERN, 'low')!;
  assert.equal(resolveReasoningEffort(reasoning, { modelOptions: { reasoningEffort: 'minimal' } }), 'minimal');
  assert.equal(resolveReasoningEffort(reasoning, {}, 'medium'), 'medium');
  assert.equal(resolveReasoningEffort(reasoning, {}), 'low');
});

test('"none" means omit the field, not send the string "none"', () => {
  const reasoning = reasoningForModel('gpt-5.5', DEFAULT_PATTERN)!;
  assert.equal(resolveReasoningEffort(reasoning, { modelConfiguration: { reasoningEffort: 'none' } }), undefined);
  assert.equal(resolveReasoningEffort(reasoning, {}), undefined);
});

test('an unsupported picker value is ignored rather than forwarded', () => {
  const reasoning = reasoningForModel('gpt-5.5', DEFAULT_PATTERN, 'high')!;
  assert.equal(resolveReasoningEffort(reasoning, { modelConfiguration: { reasoningEffort: 'xhigh' } }), 'high');
});

test('buildThinkingEffortSchema renders the Copilot submenu contract', () => {
  const reasoning = reasoningForModel('gpt-5.5', DEFAULT_PATTERN)!;
  const schema = buildThinkingEffortSchema(reasoning, 'medium');
  const field = schema.properties.reasoningEffort;
  assert.equal(field.group, 'navigation');
  assert.equal(field.default, 'medium');
  assert.equal(field.enum.length, field.enumItemLabels.length);
  assert.equal(field.enum.length, field.enumDescriptions.length);
  assert.equal(field.enumItemLabels[0], 'Off');
});

test('a selected effort outside the supported list does not become the default', () => {
  const reasoning = reasoningForModel('gpt-5.5', DEFAULT_PATTERN, 'high')!;
  assert.equal(buildThinkingEffortSchema(reasoning, 'nonsense').properties.reasoningEffort.default, 'high');
});
