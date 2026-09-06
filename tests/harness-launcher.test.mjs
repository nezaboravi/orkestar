import assert from 'node:assert/strict';
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { launcherArgs } from '../harness-launcher.mjs';

test('Solo Codex loads the installed primary Lenka instructions while preserving Laravel AGENTS', () => {
  const project = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'solo-conductor-')));
  mkdirSync(path.join(project, '.codex', 'agents'), { recursive: true });
  writeFileSync(path.join(project, 'AGENTS.md'), 'Laravel application rules');
  writeFileSync(path.join(project, '.codex', 'agents', 'lenka.toml'), 'name = "lenka"\ndeveloper_instructions = """\nUse orkestar_worker and verify every outcome.\n"""\n');
  const args = launcherArgs('codex', 'terra', project, 'medium', { workspace: 'solo' });
  const instructions = args.find(arg => arg.startsWith('developer_instructions='));
  assert.match(instructions, /ORKESTAR_SOLO_CONDUCTOR_[a-f0-9]{64}/);
  assert.match(instructions, /Use orkestar_worker and verify every outcome/);
  assert.deepEqual(args.slice(-3), ['--disable', 'multi_agent', '--approve-for-me']);
  assert.equal(args.includes('--enable'), false);
  assert.equal(args[args.indexOf('apps') - 1], '--disable');
  assert.equal(readFileSync(path.join(project, 'AGENTS.md'), 'utf8'), 'Laravel application rules');
  writeFileSync(path.join(project, '.codex', 'agents', 'lenka.toml'), 'name = "lenka"\ndeveloper_instructions = """\nUse orkestar_worker and updated report rules.\n"""\n');
  assert.notEqual(launcherArgs('codex', 'terra', project, 'medium', { workspace: 'solo' }).find(arg => arg.startsWith('developer_instructions=')), instructions);
});

test('Solo Codex fails closed for absent or invalid primary instructions', () => {
  const project = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'solo-conductor-invalid-')));
  const launch = () => launcherArgs('codex', 'terra', project, null, { workspace: 'solo' });
  assert.throws(launch);
  mkdirSync(path.join(project, '.codex', 'agents'), { recursive: true });
  writeFileSync(path.join(project, '.codex', 'agents', 'lenka.toml'), 'name = "other"\n');
  assert.throws(launch, /instructions are missing/);
});

test('launcher pins the verified coordination model in Codex', () => {
  const args = launcherArgs('codex', 'gpt-5.6-terra', process.cwd(), 'medium');
  assert.deepEqual(args.slice(0, 2), ['--model', 'gpt-5.6-terra']);
  const configs = args.flatMap((arg, index) => arg === '--config' ? [args[index + 1]] : []);
  assert.deepEqual(configs, [
    `projects={${JSON.stringify(realpathSync(process.cwd()))}={trust_level="trusted"}}`,
    'model_reasoning_effort="medium"',
  ]);
  assert.deepEqual(args.slice(-3), ['--enable', 'multi_agent', '--approve-for-me']);
  assert.equal(args.includes('--sandbox'), false);
  assert.equal(args.some((arg) => arg.startsWith('developer_instructions=')), false);
  assert.equal(args.includes('--agent'), false);
});

test('launcher rejects reasoning above the high ceiling for every harness', () => {
  for (const effort of ['xhigh', 'max', 'ultra', 'unexpected']) {
    assert.throws(() => launcherArgs('codex', 'gpt-5.6-terra', process.cwd(), effort), /high ceiling/);
    assert.throws(() => launcherArgs('claude', 'sonnet', process.cwd(), effort), /high ceiling/);
  }
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

test('launcher opens Cursor Agent with the verified model and automatic MCP approval', () => {
  assert.deepEqual(launcherArgs('cursor', 'composer-2'), [
    '--model', 'composer-2', '--force', '--approve-mcps',
  ]);
});
