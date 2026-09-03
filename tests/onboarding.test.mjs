import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  commandForHarness,
  configureCursorTaskavel,
  inspectHarnesses,
  loadPreferences,
  recommendHarness,
  savePreferences,
  workspaceChoices,
} from '../onboarding.mjs';

test('detection uses the real Cursor Agent command and records honest login state', () => {
  const locate = (command) => command === 'agent' || command === 'codex' ? `/bin/${command}` : null;
  const capture = (binary) => binary.endsWith('/agent')
    ? { status: 0, stdout: '{"authenticated":false}', stderr: 'Not logged in' }
    : { status: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
  const statuses = inspectHarnesses(locate, capture, '/project');
  assert.equal(commandForHarness('cursor'), 'agent');
  assert.equal(statuses.find((item) => item.harness === 'cursor').authenticated, false);
  assert.equal(statuses.find((item) => item.harness === 'codex').authenticated, true);
});

test('Cursor detection reads the current isAuthenticated field exactly', () => {
  const statuses = inspectHarnesses(
    (command) => command === 'agent' ? '/bin/agent' : null,
    () => ({ status: 0, stdout: '{"status":"authenticated","isAuthenticated":true}', stderr: '' }),
    '/project',
  );
  assert.equal(statuses.find((item) => item.harness === 'cursor').authenticated, true);
});

test('automatic recommendation never guesses between multiple valid subscriptions', () => {
  const statuses = [
    { harness: 'codex', authenticated: true },
    { harness: 'claude', authenticated: true },
  ];
  assert.equal(recommendHarness(statuses), null);
  assert.equal(recommendHarness(statuses, { harness: 'claude' }), 'claude');
  assert.equal(recommendHarness([{ harness: 'codex', authenticated: true }]), 'codex');
});

test('preferences persist harness and workspace without credentials', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lenka-preferences-'));
  const target = savePreferences({ harness: 'cursor', workspace: 'direct', taskavel: 'later' }, home);
  assert.equal(loadPreferences(home).harness, 'cursor');
  assert.equal(loadPreferences(home).workspace, 'direct');
  assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /token|secret|password/i);
});

test('workspace detection keeps Solo optional and direct always available', () => {
  const linux = workspaceChoices({ platform: 'linux', soloInstalled: false, herdrInstalled: false });
  assert.equal(linux.find((item) => item.id === 'solo').available, false);
  assert.equal(linux.find((item) => item.id === 'solo').reason, 'not installed');
  assert.equal(linux.find((item) => item.id === 'direct').available, true);
});

test('Cursor Taskavel setup preserves existing MCP servers', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-taskavel-'));
  const directory = path.join(home, '.cursor');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'mcp.json'), JSON.stringify({ mcpServers: { existing: { url: 'https://example.test/mcp' } } }));
  configureCursorTaskavel(home);
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'mcp.json'), 'utf8'));
  assert.equal(config.mcpServers.existing.url, 'https://example.test/mcp');
  assert.equal(config.mcpServers.taskavel.url, 'https://taskavel.com/mcp/taskavel');
});
