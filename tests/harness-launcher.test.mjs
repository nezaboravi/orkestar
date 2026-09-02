import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { launcherArgs } from '../harness-launcher.mjs';

test('launcher pins the verified coordination model in Codex', () => {
  const args = launcherArgs('codex', 'gpt-5.6-terra', process.cwd(), 'medium');
  assert.deepEqual(args.slice(0, 2), ['--model', 'gpt-5.6-terra']);
  const configs = args.flatMap((arg, index) => arg === '--config' ? [args[index + 1]] : []);
  assert.match(configs[0], /^developer_instructions=.*Lenka — the orchestrator/s);
  assert.equal(configs[1], 'model_reasoning_effort="medium"');
  assert.deepEqual(args.slice(-5), ['--enable', 'multi_agent', '--sandbox', 'workspace-write', '--approve-for-me']);
  assert.equal(args.includes('--agent'), false);
});

test('launcher does not invent a reasoning setting for non-Codex harnesses', () => {
  assert.deepEqual(launcherArgs('opencode', 'opencode-go/kimi-k2.7-code', process.cwd(), 'medium'), [
    '--model', 'opencode-go/kimi-k2.7-code', '--agent', 'lenka', '--auto',
  ]);
});

test('launcher opens Claude with Lenka and Claude native automatic permissions', () => {
  assert.deepEqual(launcherArgs('claude', 'sonnet', process.cwd(), 'medium'), [
    '--model', 'sonnet', '--agent', 'lenka', '--permission-mode', 'auto', '--effort', 'medium',
  ]);
});

test('launcher opens OpenCode with Lenka and OpenCode native automatic permissions', () => {
  assert.deepEqual(launcherArgs('opencode', 'opencode-go/kimi-k2.7-code'), [
    '--model', 'opencode-go/kimi-k2.7-code', '--agent', 'lenka', '--auto',
  ]);
});

test('launcher opens Kimi directly with the generated Lenka agent in autonomous mode', () => {
  const root = path.resolve('portable-project');
  assert.deepEqual(launcherArgs('kimi', 'kimi-code/k3', root), [
    '--model', 'kimi-code/k3',
    '--agent-file', path.join(root, '.kimi-code', 'agents', 'lenka.md'),
    '--auto',
  ]);
});
