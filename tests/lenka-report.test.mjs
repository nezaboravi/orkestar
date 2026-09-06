import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const cli = path.resolve(import.meta.dirname, '../lenka.mjs');
function fixture(audit, rows) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lenka-report-safe-')));
  const runs = path.join(project, '.agent-orchestra/runs'); fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'latest.json'), JSON.stringify(audit));
  const bin = path.join(project, 'bin'); fs.mkdirSync(bin);
  if (rows !== undefined) {
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    fs.writeFileSync(path.join(bin, 'opencode'), `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(rows))});\n`, { mode: 0o700 });
  }
  return () => spawnSync(process.execPath, [cli, 'report', 'last', '--project', project], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: bin },
  });
}
const audit = () => ({ harness: 'opencode', sessionId: 'root', status: 'DONE', agents: [], totals: {},
  proof: [{ result: 'passed', criterion: 'Behavior', method: 'Observed', evidence: ['Proof-1'] }],
  trackerReconciliation: { doneEligible: true, tasks: [{ taskId: '42', acceptedProof: true, doneEligible: true }] } });
const row = () => ({ id: 'root', parent_id: null, agent: 'lenka', model: '{"providerID":"fixture","id":"model"}',
  tokens_input: 1, tokens_output: 1, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0, cost: 0.1 });

test('actual CLI renders proof without verification/blockers and labels tracker as saved packet', () => {
  const result = fixture(audit())();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Behavior proof:/); assert.match(result.stdout, /Proof-1/);
  assert.match(result.stdout, /saved snapshot; not a live tracker read/);
  assert.match(result.stdout, /Task 42: accepted proof yes/);
  for (const invalid of [null, { ...audit(), agents: null }, { ...audit(), agents: [null] }]) {
    const bad = fixture(invalid)(); assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Invalid orchestra audit report structure/);
    assert.doesNotMatch(bad.stderr, /TypeError/);
  }
});

test('actual OpenCode refresh never converts missing or invalid telemetry to zero', { skip: process.platform === 'win32' && 'POSIX executable fixture' }, () => {
  const updates = [{ tokens_input: null, cost: null }, { tokens_output: -1 }, { tokens_reasoning: 0.5 },
    { tokens_cache_read: -2 }, { tokens_cache_write: '0' }, { tokens_input: Number.MAX_SAFE_INTEGER }, { cost: -1 }];
  for (const update of updates) {
    const result = fixture(audit(), [{ ...row(), ...update }])();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Orkestar run PARTIAL/);
    assert.match(result.stdout, /unavailable/);
    assert.doesNotMatch(result.stdout, /\$0\.000000/);
  }
  const valid = fixture(audit(), [row()])();
  assert.match(valid.stdout, /2 tokens — \$0\.100000/);
});

test('actual refresh aggregate overflow stays unavailable and malformed DB rows do not crash', { skip: process.platform === 'win32' && 'POSIX executable fixture' }, () => {
  const rows = [{ ...row(), tokens_input: Number.MAX_SAFE_INTEGER - 1, cost: Number.MAX_VALUE },
    { ...row(), id: 'child', parent_id: 'root', cost: Number.MAX_VALUE }];
  const result = fixture(audit(), rows)();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Total: unavailable tokens — unavailable/);
  assert.match(result.stdout, /Orkestar run PARTIAL/);
  const malformed = fixture(audit(), [null])();
  assert.equal(malformed.status, 0, malformed.stderr);
  assert.match(malformed.stdout, /Behavior proof/);
});

test('DB refresh rejects unproven ancestry and retains the saved audit', { skip: process.platform === 'win32' && 'POSIX executable fixture' }, () => {
  const saved = { ...audit(), agents: [{ agent: 'saved-reviewer', model: 'saved/model', tokens: { total: 17 }, cost: 0.2 }], totals: { tokens: 17, cost: 0.2 } };
  const child = { ...row(), id: 'child', parent_id: 'root', agent: 'UNTRUSTED' };
  const invalidTrees = [
    [{ ...row(), id: 'wrong-root', agent: 'UNTRUSTED' }],
    [{ ...row(), parent_id: 'foreign', agent: 'UNTRUSTED' }],
    [row(), { ...child, parent_id: 'foreign' }],
    [row(), child, child],
    [row(), { ...child, parent_id: 'cycle' }, { ...child, id: 'cycle', parent_id: 'child' }],
    [row(), { ...child, parent_id: null }],
    Array.from({ length: 10001 }, (_, i) => ({ ...child, id: `child-${i}` })),
  ];
  for (const rows of invalidTrees) {
    const result = fixture(saved, rows)();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /saved-reviewer: saved\/model — 17 tokens — \$0\.200000/);
    assert.doesNotMatch(result.stdout, /UNTRUSTED/);
  }
  const valid = fixture(saved, [child, { ...row(), agent: null }])();
  assert.match(valid.stdout, /lenka: fixture\/model/);
  assert.match(valid.stdout, /Total: 4 tokens — \$0\.200000/);
});
