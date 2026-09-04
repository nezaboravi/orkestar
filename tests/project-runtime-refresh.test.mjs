import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runtimeManifest } from '../orchestra.mjs';
import { refreshProjectRuntime } from '../project-runtime-refresh.mjs';

const fixture = harness => ({ harness, project: fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'runtime-refresh-'))),
  manifest: JSON.parse(runtimeManifest(harness, { economy: 'cheap', mid: 'mid', strongest: 'strong' })) });

test('fresh cached project routes install once while AGENTS and globals remain untouched', () => {
  for (const harness of ['codex', 'claude']) {
    const f = fixture(harness);
    fs.writeFileSync(path.join(f.project, 'AGENTS.md'), 'Existing Laravel project instructions');
    const originalHome = process.env.HOME;
    const fakeHome = fs.mkdtempSync(path.join(tmpdir(), 'refresh-global-'));
    process.env.HOME = fakeHome;
    try {
      assert.ok(refreshProjectRuntime(f).changed > 0);
      assert.equal(refreshProjectRuntime(f).changed, 0);
      assert.deepEqual(fs.readdirSync(fakeHome), []);
    } finally { process.env.HOME = originalHome; }
    assert.equal(fs.readFileSync(path.join(f.project, 'AGENTS.md'), 'utf8'), 'Existing Laravel project instructions');
    const current = JSON.parse(fs.readFileSync(path.join(f.project, '.agent-orchestra', 'runtime', `${harness}.json`)));
    assert.deepEqual(current.profiles, f.manifest.profiles);
    assert.deepEqual(current.primary, f.manifest.primary);
  }
});

test('profile-specific same-class routes remain exact; unsafe cached profiles fail closed', () => {
  const f = fixture('codex'); f.manifest.profiles['product-design'].model = 'designer-specific';
  refreshProjectRuntime(f);
  assert.match(fs.readFileSync(path.join(f.project, '.codex', 'agents', 'product-designer.toml'), 'utf8'), /model = "designer-specific"/);
  assert.match(fs.readFileSync(path.join(f.project, '.codex', 'agents', 'dev-auditor.toml'), 'utf8'), /model = "strong"/);
  const bad = fixture('codex'); bad.manifest.profiles['project-audit'].writes = true;
  assert.throws(() => refreshProjectRuntime(bad), /revalidation/);
  assert.deepEqual(fs.readdirSync(bad.project), []);
});

test('conflicting project files are backed up and symlink parents reject before writes', () => {
  const f = fixture('claude');
  fs.mkdirSync(path.join(f.project, '.claude', 'agents'), { recursive: true });
  const file = path.join(f.project, '.claude', 'agents', 'lenka.md'); fs.writeFileSync(file, 'old custom agent');
  const result = refreshProjectRuntime(f);
  const recovery = JSON.parse(fs.readFileSync(result.recoveryManifest));
  const old = recovery.files.find(item => item.target === file);
  assert.equal(fs.readFileSync(old.backup, 'utf8'), 'old custom agent');
  const linked = fixture('codex'); const outside = fs.mkdtempSync(path.join(tmpdir(), 'refresh-outside-'));
  try { fs.symlinkSync(outside, path.join(linked.project, '.codex'), 'dir'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  assert.throws(() => refreshProjectRuntime(linked), /Unsafe/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
