import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installNativeObserver } from '../native-observer-install.mjs';

async function fixture(harness) {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'native-install-')));
  const sourceRoot = join(project, 'source'); await mkdir(sourceRoot);
  for (const file of ['native-observer.mjs', 'native-audit.mjs', 'native-codex-evidence.mjs', 'native-claude-evidence.mjs', 'native-solo-mirror.mjs']) await writeFile(join(sourceRoot, file), `// ${file}\n`);
  return { project, sourceRoot, harness, nodeBinary: process.execPath };
}

test('both installers preserve native settings and foreign hooks, and reinstall once', async () => {
  for (const harness of ['codex', 'claude']) {
    const f = await fixture(harness);
    const dir = join(f.project, harness === 'codex' ? '.codex' : '.claude'); await mkdir(dir);
    const path = join(dir, harness === 'codex' ? 'hooks.json' : 'settings.json');
    const foreign = { hooks: [{ type: 'command', command: 'existing-user-hook' }] };
    await writeFile(path, JSON.stringify({ custom: 'preserve', hooks: { Stop: [foreign] } }));
    const result = await installNativeObserver(f);
    const again = await installNativeObserver(f);
    assert.equal(result.changed, true);
    assert.equal(again.changed, false);
    const config = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(config.custom, 'preserve');
    assert.deepEqual(config.hooks.Stop[0], foreign);
    assert.equal(config.hooks.Stop.length, 2);
    assert.equal(config.hooks.SessionStart.length, 1);
    assert.equal(result.trustRequired, harness === 'codex');
    const handler = config.hooks.SessionStart[0].hooks[0];
    if (harness === 'claude') assert.deepEqual(handler.args.slice(-2), ['--project', f.project]);
    else assert.match(result.trustInstruction, /\/hooks/);
    assert.equal(await readFile(join(f.project, '.agent-orchestra', 'observer', 'native-audit.mjs'), 'utf8'), '// native-audit.mjs\n');
  }
});

test('updated owned dependency reports changed without duplicating hooks', async () => {
  const f = await fixture('codex');
  await installNativeObserver(f);
  await writeFile(join(f.sourceRoot, 'native-audit.mjs'), '// updated source');
  assert.equal((await installNativeObserver(f)).changed, true);
  assert.equal((await installNativeObserver(f)).changed, false);
});

test('modified owned scripts or hooks and malformed settings are preserved', async () => {
  const f = await fixture('claude');
  const result = await installNativeObserver(f);
  await writeFile(result.observerPath, '// user customization');
  await assert.rejects(installNativeObserver(f), /Preserved modified/);
  assert.equal(await readFile(result.observerPath, 'utf8'), '// user customization');
  const g = await fixture('codex'); const installed = await installNativeObserver(g);
  const config = JSON.parse(await readFile(installed.settingsPath, 'utf8'));
  config.hooks.Stop[0].hooks[0].command = 'user-edited';
  await writeFile(installed.settingsPath, JSON.stringify(config));
  await assert.rejects(installNativeObserver(g), /modified or removed/);
  const h = await fixture('claude'); await mkdir(join(h.project, '.claude'));
  await writeFile(join(h.project, '.claude', 'settings.json'), '{malformed');
  await assert.rejects(installNativeObserver(h));
  assert.equal(await readFile(join(h.project, '.claude', 'settings.json'), 'utf8'), '{malformed');
});

test('dependency missing or symlinked destination fails closed', async () => {
  const f = await fixture('codex');
  const empty = join(f.project, 'empty'); await mkdir(empty);
  await assert.rejects(installNativeObserver({ ...f, sourceRoot: empty }), /Missing observer dependency/);
  const target = join(f.project, 'linked'); await mkdir(target);
  try { await symlink(target, join(f.project, '.codex'), 'dir'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  await assert.rejects(installNativeObserver(f), /Unsafe/);
});

test('standalone copied observer executes both harness hooks without source imports or Solo binding', async () => {
  for (const harness of ['codex', 'claude']) {
    const f = await fixture(harness);
    f.sourceRoot = fileURLToPath(new URL('..', import.meta.url));
    const installed = await installNativeObserver(f);
    const transcript = join(f.project, 'transcript.jsonl');
    const row = harness === 'codex' ? { type: 'session_meta', payload: { id: 'root', cwd: f.project, source: 'cli' } }
      : { type: 'user', sessionId: 'root', cwd: f.project };
    await writeFile(transcript, JSON.stringify(row) + '\n');
    const result = spawnSync(process.execPath, [installed.observerPath, '--harness', harness, '--project', f.project], {
      encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'root',
        cwd: f.project, transcript_path: transcript }), timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    const audit = JSON.parse(await readFile(join(f.project, '.agent-orchestra', 'runs', 'native-latest.json'), 'utf8'));
    assert.equal(audit.harness, harness);
    assert.equal(audit.status, 'PARTIAL');
    assert.equal(audit.state, 'running');
  }
});
