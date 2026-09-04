import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  clearClaudeCodeEnv,
  clearCodexConfig,
  findProviderSection,
  findTopLevelLine,
} from '../integrations/managedConfig';

/*
  These functions run in two places: the restore commands, and the
  vscode:uninstall hook — which executes unattended, after the extension is
  already gone, with nobody to read an error. Getting them wrong silently
  corrupts a config file the user did not ask us to touch.
*/

const APPLIED_CODEX =
  'model = "gpt-5.5"\n' +
  'model_provider = "oneprovider"\n' +
  'show_raw_agent_reasoning = true\n' +
  '\n' +
  '[mcp_servers.thing]\n' +
  'command = "x"\n' +
  '\n' +
  '[model_providers.oneprovider]\n' +
  'name = "OneProvider"\n' +
  'base_url = "https://api.oneprovider.dev/v1"\n' +
  'env_key = "ONEPROVIDER_API_KEY"\n' +
  'wire_api = "responses"\n';

test('codex: clearing removes everything Maestro wrote', () => {
  const out = clearCodexConfig(APPLIED_CODEX);
  assert.ok(!out.includes('[model_providers.oneprovider]'), 'provider section survived');
  assert.ok(!out.includes('model_provider'), 'model_provider survived');
  assert.ok(!out.includes('show_raw_agent_reasoning'), 'reasoning flag survived');
  assert.ok(!/^model = /m.test(out), 'model selection survived');
});

test('codex: unrelated sections are left alone', () => {
  const out = clearCodexConfig(APPLIED_CODEX);
  assert.ok(out.includes('[mcp_servers.thing]'));
  assert.ok(out.includes('command = "x"'));
});

test("codex: the user's own prior selection comes back", () => {
  const before = 'model = "gpt-5-codex"\nmodel_provider = "openai"\n\n[mcp_servers.thing]\ncommand = "x"\n';
  const out = clearCodexConfig(APPLIED_CODEX, before);
  assert.match(out, /^model = "gpt-5-codex"$/m);
  assert.match(out, /^model_provider = "openai"$/m);
  // The blank line before the first section is part of the user's formatting.
  assert.ok(out.includes('model_provider = "openai"\n\n[mcp_servers.thing]'), out);
});

test('codex: a provider section the user wrote themselves is restored', () => {
  const before = '[model_providers.oneprovider]\nname = "Mine"\nbase_url = "http://localhost:1234"\n';
  const out = clearCodexConfig(APPLIED_CODEX, before);
  assert.ok(out.includes('name = "Mine"'), out);
  assert.ok(!out.includes('wire_api = "responses"'), 'Maestro section survived');
});

test('codex: a key inside a triple-quoted string is not mistaken for a top-level one', () => {
  const content =
    'notes = """\nmodel = "not really a key"\n"""\n' +
    'model = "gpt-5.5"\n' +
    'model_provider = "oneprovider"\n' +
    '\n[model_providers.oneprovider]\nwire_api = "responses"\n';
  const out = clearCodexConfig(content);
  assert.ok(out.includes('model = "not really a key"'), 'string content was stripped');
  assert.ok(!out.includes('"gpt-5.5"'), 'real key survived');
});

test('codex: findTopLevelLine ignores assignments after the first section', () => {
  const content = '[a]\nmodel = "inside-a-section"\n';
  assert.equal(findTopLevelLine(content, 'model'), undefined);
});

test('codex: findProviderSection reports absence rather than guessing', () => {
  assert.equal(findProviderSection('model = "x"\n'), undefined);
  assert.equal(findProviderSection('[model_providers.openai]\nname = "x"\n'), undefined);
});

test('claude code: managed keys go, the user\'s own keys stay', () => {
  const settings: any = {
    effortLevel: 'high',
    env: { MY_OWN: 'keep', ANTHROPIC_BASE_URL: 'https://api.oneprovider.dev', ANTHROPIC_AUTH_TOKEN: 'sk-x' },
  };
  assert.equal(clearClaudeCodeEnv(settings), true);
  assert.deepEqual(settings.env, { MY_OWN: 'keep' });
  assert.equal(settings.effortLevel, 'high');
});

test('claude code: a prior value is reinstated, not deleted', () => {
  const settings: any = { env: { ANTHROPIC_MODEL: 'claude-opus-5', ANTHROPIC_AUTH_TOKEN: 'sk-x' } };
  clearClaudeCodeEnv(settings, { ANTHROPIC_MODEL: 'mine' });
  assert.deepEqual(settings.env, { ANTHROPIC_MODEL: 'mine' });
});

test('claude code: an env block left empty is removed entirely', () => {
  const settings: any = { env: { ANTHROPIC_BASE_URL: 'https://api.oneprovider.dev' } };
  clearClaudeCodeEnv(settings);
  assert.ok(!('env' in settings), 'empty env block survived');
});

test('claude code: nothing to do is reported as no change', () => {
  const settings: any = { env: { MY_OWN: 'keep' } };
  assert.equal(clearClaudeCodeEnv(settings), false);
  assert.deepEqual(settings.env, { MY_OWN: 'keep' });
  assert.equal(clearClaudeCodeEnv({}), false);
});
