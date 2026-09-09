import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  interactiveArgs,
  interactiveSpec,
  parseInteractiveArgs,
  runInteractive,
} from '../native-interactive-launcher.mjs';

function projectFixture() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'orkestar-interactive-'));
  fs.mkdirSync(path.join(project, '.codex', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(project, '.codex', 'agents', 'lenka.toml'),
    'name = "lenka"\n\ndeveloper_instructions = """\nUse orkestar_worker for Solo dispatch.\n"""\n');
  return project;
}

const project = projectFixture();
const routes = [
  ['codex', '/usr/local/bin/codex'],
  ['claude', '/usr/local/bin/claude'],
  ['opencode', '/usr/local/bin/opencode'],
  ['kimi', '/usr/local/bin/kimi'],
  ['cursor', '/usr/local/bin/cursor'],
];

test('interactiveSpec builds verified arguments for all five harnesses', () => {
  for (const [harness, binary] of routes) {
    const spec = interactiveSpec({ harness, binary, project, model: 'fixture-model', effort: 'medium' });
    assert.equal(spec.project, fs.realpathSync(project));
    assert.equal(spec.binary, binary);
    assert.ok(spec.args.includes('--model') && spec.args.includes('fixture-model'));
    assert.equal(spec.args.some((arg) => /print|headless|app-server|dangerously|skip-hook/i.test(arg)), false);
    assert.match(spec.marker, /^ORKESTAR_NATIVE_UI_[a-f0-9]{64}$/);
  }
});

test('interactiveArgs preserves project, harness, binary, model and effort in launcher argv', () => {
  const runtime = { harness: 'codex', binary: '/usr/local/bin/codex', manifest: { primary: { model: 'm', reasoningEffort: 'high' } } };
  const args = interactiveArgs(runtime, project);
  assert.equal(path.basename(args[0]), 'native-interactive-launcher.mjs');
  assert.deepEqual(args.slice(1, 11), ['--project', fs.realpathSync(project), '--harness', 'codex', '--binary', runtime.binary, '--model', 'm', '--effort', 'high']);
  assert.equal(args[11], '--marker');
});

test('parseInteractiveArgs rejects missing, duplicate, unknown and stale settings', () => {
  const good = interactiveArgs({ harness: 'claude', binary: '/usr/local/bin/claude', manifest: { primary: { model: 'm', reasoningEffort: null } } }, project).slice(1);
  for (const bad of [good.slice(0, -2), [...good, '--model', 'duplicate'], [...good.slice(0, -2), '--bogus', 'x', '--marker', 'x'], [...good.slice(0, -2), '--marker', 'stale']]) {
    assert.throws(() => parseInteractiveArgs(bad), /Invalid interactive launcher arguments|Lenka launch settings changed/);
  }
});

test('marker changes when harness, binary, model, effort, project or Codex instructions change', () => {
  const base = { harness: 'codex', binary: '/usr/local/bin/codex', project, model: 'm', effort: 'low' };
  const marker = interactiveSpec(base).marker;
  for (const change of [{ harness: 'claude' }, { binary: '/tmp/other' }, { model: 'other' }, { effort: 'high' }]) assert.notEqual(interactiveSpec({ ...base, ...change }).marker, marker);
  const other = projectFixture();
  assert.notEqual(interactiveSpec({ ...base, project: other }).marker, marker);
  const instructions = path.join(project, '.codex', 'agents', 'lenka.toml');
  fs.writeFileSync(instructions, fs.readFileSync(instructions, 'utf8').replace('Use orkestar_worker for Solo dispatch.', 'Use orkestar_worker with changed instructions.'));
  assert.notEqual(interactiveSpec(base).marker, marker);
});

test('identical launcher bytes installed at different absolute paths produce different markers', async () => {
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const launcherSource = path.resolve(sourceDir, '..', 'native-interactive-launcher.mjs');
  const helperSource = path.resolve(sourceDir, '..', 'harness-launcher.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkestar-relocated-'));
  const copies = [];
  for (const name of ['one', 'two']) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.copyFileSync(launcherSource, path.join(dir, 'native-interactive-launcher.mjs'));
    fs.copyFileSync(helperSource, path.join(dir, 'harness-launcher.mjs'));
    copies.push(await import(`${pathToFileURL(path.join(dir, 'native-interactive-launcher.mjs')).href}?copy=${name}`));
  }
  const options = { harness: 'claude', binary: '/usr/local/bin/claude', project, model: 'fixture-model', effort: 'medium' };
  assert.notEqual(copies[0].interactiveSpec(options).marker, copies[1].interactiveSpec(options).marker);
});

function fakeHost() { const host = new EventEmitter(); host.env = { FIXTURE: 'yes' }; return host; }
function fakeChild() { const child = new EventEmitter(); child.exitCode = null; child.kill = (...args) => { child.killed = args; }; return child; }

test('runInteractive inherits stdio/env, forwards termination, preserves exit and cleans listeners', async () => {
  const host = fakeHost(); const child = fakeChild(); let spawnCall;
  const promise = runInteractive({ binary: '/bin/fixture', args: ['--x'], project }, { host, spawn: (...args) => { spawnCall = args; return child; } });
  assert.deepEqual(spawnCall[2], { cwd: project, stdio: 'inherit', env: host.env });
  host.emit('SIGTERM'); assert.deepEqual(child.killed, ['SIGTERM']);
  child.exitCode = 7; child.emit('exit', 7, null); assert.equal(await promise, 7);
  assert.equal(host.listenerCount('SIGTERM'), 0); assert.equal(host.listenerCount('SIGHUP'), 0); assert.equal(host.listenerCount('SIGINT'), 0);
});

test('runInteractive maps signal exits and startup errors to useful lifecycle results', async () => {
  for (const [signal, expected] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129], ['OTHER', 1]]) {
    const host = fakeHost(); const child = fakeChild(); const result = runInteractive({ binary: 'x', args: [], project }, { host, spawn: () => child });
    child.emit('exit', null, signal === 'OTHER' ? 'SIGUSR1' : signal); assert.equal(await result, expected);
  }
  const host = fakeHost(); const child = fakeChild(); const errors = []; const original = console.error; console.error = (message) => errors.push(message);
  try { const result = runInteractive({ binary: 'x', args: [], project }, { host, spawn: () => child }); child.emit('error', new Error('fixture failure')); assert.equal(await result, 1); }
  finally { console.error = original; }
  assert.deepEqual(errors, ['ERROR: Could not start the selected CLI: fixture failure']);
});

test('real subprocess inherits multiline stdin and stdout bytes through the interactive launcher', () => {
  const input = 'first line\nsecond line\n最后一行\n';
  const launcher = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'native-interactive-launcher.mjs');
  const code = `import { runInteractive } from ${JSON.stringify(pathToFileURL(launcher).href)}; await runInteractive({ binary: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], project: process.cwd() });`;
  const result = spawnSync(process.execPath, ['-e', code], { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, input);
});

test('Solo conductor identity and arguments bind the selected team snapshot',()=>{
 const project=projectFixture();
 const runtime={harness:'codex',binary:process.execPath,teamRun:'a'.repeat(64),manifest:{primary:{model:'fixture-model',reasoningEffort:'low'}}};
 const args=interactiveArgs(runtime,project),spec=parseInteractiveArgs(args.slice(1));
 assert.equal(spec.teamRun,runtime.teamRun);
 assert.notEqual(spec.marker,interactiveSpec({harness:'codex',binary:process.execPath,project,model:'fixture-model',effort:'low',teamRun:'b'.repeat(64)}).marker);
});
