import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const cli = path.join(repoRoot, 'lenka.mjs');

test('Lenka CLI exposes the portable orchestration commands', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /lenka up \[solo\] \[auto\|cursor\|codex\|claude\|kimi\|opencode\]/);
  assert.match(result.stdout, /lenka setup/);
  assert.match(result.stdout, /lenka connect taskavel/);
  assert.match(result.stdout, /--herdr/);
  assert.match(result.stdout, /--solo/);
  assert.match(result.stdout, /--direct/);
  assert.match(result.stdout, /lenka status/);
  assert.match(result.stdout, /lenka report last/);
  assert.match(result.stdout, /lenka doctor/);
});

test('Lenka report prints the persisted exact run audit', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'lenka-report-'));
  const directory = path.join(project, '.agent-orchestra', 'runs');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'latest.json'), JSON.stringify({
    harness: 'opencode',
    sessionId: 'ses_test',
    status: 'PARTIAL',
    agents: [{ agent: 'lenka', model: 'provider/model', tokens: { total: 42 }, cost: 0.001 }],
    totals: { tokens: 42, cost: 0.001 },
    verification: ['Tests passed'],
    blockers: ['Visual QA unavailable'],
  }));

  const result = spawnSync(process.execPath, [cli, 'report', 'last', '--project', project], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Orkestar run PARTIAL/);
  assert.match(result.stdout, /lenka: provider\/model — 42 tokens — \$0\.001000/);
  assert.match(result.stdout, /Visual QA unavailable/);
});

test('Lenka status reports the exact primary coordination route', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'lenka-status-'));
  const runtime = path.join(project, '.agent-orchestra', 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'codex.json'), JSON.stringify({
    harness: 'codex',
    lifecycle: 'one-run',
    primary: { role: 'coordination', modelClass: 'mid', model: 'gpt-5.6-terra', reasoningEffort: 'medium' },
  }));

  const result = spawnSync(process.execPath, [cli, 'status', '--project', project], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Harness: codex/);
  assert.match(result.stdout, /Model: gpt-5\.6-terra/);
  assert.match(result.stdout, /Reasoning effort: medium/);
  assert.match(result.stdout, /Agents: created on demand/);
});

test('Lenka defaults up to auto and the current project', async () => {
  const { parse } = await import('../lenka.mjs');
  const parsed = parse(['up']);
  assert.equal(parsed.command, 'up');
  assert.equal(parsed.harness, null);
  assert.equal(parsed.project, process.cwd());
  assert.equal(parsed.conflict, 'backup');
  assert.equal(parsed.herdr, true);
  assert.equal(parsed.workspace, 'herdr');
  assert.equal(parsed.workspaceExplicit, false);
});

test('Lenka accepts terminal punctuation and supports direct mode', async () => {
  const { parse } = await import('../lenka.mjs');
  assert.equal(parse(['up.']).command, 'up');
  assert.equal(parse(['UP', '--direct']).herdr, false);
  assert.equal(parse(['up', 'solo', 'codex']).workspace, 'solo');
  assert.equal(parse(['up', 'solo', 'codex']).harness, 'codex');
  assert.equal(parse(['up', 'codex', '--solo']).workspace, 'solo');
  assert.equal(parse(['up', 'cursor']).harness, 'cursor');
});

test('Lenka reuses the current Herdr pane instead of starting nested Herdr', async () => {
  const { shouldOpenHerdr } = await import('../lenka.mjs');
  assert.equal(shouldOpenHerdr({ herdr: true }, { HERDR_ENV: '1' }), false);
  assert.equal(shouldOpenHerdr({ herdr: true }, {}), true);
  assert.equal(shouldOpenHerdr({ herdr: false }, {}), false);
});

test('Lenka reuses a verified global runtime without a project reinstall', async () => {
  const { selectInstalledRuntime } = await import('../lenka.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lenka-global-runtime-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'lenka-project-'));
  const runtime = path.join(home, '.agent-orchestra', 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'codex.json'), JSON.stringify({
    harness: 'codex',
    primary: { model: 'gpt-5.6-terra', reasoningEffort: 'medium' },
  }));

  const selected = selectInstalledRuntime(project, 'auto', home, (command) => `/verified/${command}`);
  assert.equal(selected.harness, 'codex');
  assert.equal(selected.manifest.primary.model, 'gpt-5.6-terra');
  assert.equal(selected.binary, '/verified/codex');
});

test('Lenka stops with the exact login command before probing an unauthenticated harness', async () => {
  const { ensureHarnessAuthentication } = await import('../lenka.mjs');
  await assert.rejects(() => ensureHarnessAuthentication('cursor', '/project', {
    locate: (command) => command === 'agent' ? '/verified/agent' : null,
    capture: () => ({ status: 0, stdout: '{"status":"unauthenticated","isAuthenticated":false}', stderr: '' }),
    input: { isTTY: false },
    output: { isTTY: false },
  }), /cursor is installed but not signed in\. Run: agent login/);
});
