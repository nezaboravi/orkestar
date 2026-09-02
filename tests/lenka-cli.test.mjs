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
  assert.match(result.stdout, /lenka up \[auto\|codex\|claude\|kimi\|opencode\]/);
  assert.match(result.stdout, /--herdr/);
  assert.match(result.stdout, /lenka status/);
  assert.match(result.stdout, /lenka doctor/);
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
  assert.equal(parsed.herdr, false);
});
