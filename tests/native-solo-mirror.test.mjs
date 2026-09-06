import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { bindSoloObserver, mirrorNativeAudit } from '../native-solo-mirror.mjs';
import { assembleNativeAudit } from '../native-audit.mjs';

function installPresentationFixture(project, harness) {
  const target = path.join(project, '.agent-orchestra/worker'); fs.mkdirSync(target);
  const files = {};
  for (const name of ['native-solo-worker-mcp.mjs', 'native-worker-summary.mjs']) {
    fs.writeFileSync(path.join(target, name), 'fixture');
    files[name] = createHash('sha256').update('fixture').digest('hex');
  }
  const server = { command: process.execPath, args: [path.join(target, 'native-solo-worker-mcp.mjs'), '--project', project, '--harness', harness] };
  const settings = {};
  if (harness === 'codex') {
    fs.mkdirSync(path.join(project, '.codex'));
    settings.codex = `# BEGIN ORKESTAR WORKER MCP\n[mcp_servers.orkestar_worker]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n# END ORKESTAR WORKER MCP\n`;
    fs.writeFileSync(path.join(project, '.codex/config.toml'), settings.codex);
  } else {
    settings.claude = JSON.stringify(server);
    fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { orkestar_worker: server } }));
  }
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files, settings }));
}

for (const harness of ['codex', 'claude']) test(`${harness} managed bridge suppresses duplicate native activity UI and preserves historical pads`, async t => {
  const f = fixture(t);
  bindSoloObserver({ ...f.binding, harness });
  f.binding.harnesses = ['codex', 'claude']; f.audit.harness = harness;
  installPresentationFixture(f.project, harness);
  const before = JSON.stringify(f.state);
  const result = await mirrorNativeAudit(f.audit, f);
  assert.equal(result.skipped, true); assert.match(result.reason, /Managed visible workers/);
  assert.equal(JSON.stringify(f.state), before, 'No external calls or historical changes');
});

test('a foreign or changed bridge configuration does not suppress native observation', async t => {
  const f = fixture(t);
  installPresentationFixture(f.project, 'codex');
  fs.writeFileSync(path.join(f.project, '.codex/config.toml'), '# config replaced by the user\n');
  const result = await mirrorNativeAudit(f.audit, f);
  assert.equal(result.mirrored, true);
  assert.equal(f.state.scratchpads.length, 2);
});

test('a modified or symlinked bridge cannot claim presentation ownership', async t => {
  const f = fixture(t);
  installPresentationFixture(f.project, 'codex');
  fs.writeFileSync(path.join(f.project, '.agent-orchestra/worker/native-worker-summary.mjs'), 'changed');
  assert.equal((await mirrorNativeAudit(f.audit, f)).mirrored, true);
});

function fixture(t) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'solo-mirror-')));
  const bin = path.join(project, 'bin'); fs.mkdirSync(bin);
  const soloBinary = path.join(bin, process.platform === 'win32' ? 'solo.exe' : 'solo');
  fs.writeFileSync(soloBinary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
  t.after(() => { process.env.PATH = originalPath; });
  const binding = { schemaVersion: 1, project, projectId: 26, harness: 'codex', soloBinary };
  bindSoloObserver(binding);
  const root = { sessionId: 'root', parentSessionId: null, project, model: 'fixture', role: 'lenka', tokens: null,
    plan: [{ step: 'Verify behavior', status: 'inProgress' }] };
  const audit = assembleNativeAudit({ harness: 'codex', project, root,
    children: [{ ...root, sessionId: 'review', parentSessionId: 'root', role: 'reviewer', plan: [] }] });
  audit.agents[1].state = 'running';
  // Read-only installed Solo projects get / lists prove these envelopes.
  const state = { todos: [{ id: 99, title: 'User work', body: 'Unrelated', status: 'open', tags: ['user'] }],
    scratchpads: [{ id: 88, name: 'User notes', content: 'Unrelated', revision: 1, tags: ['user'] }], calls: [] };
  const invoke = (binary, args, options) => {
    assert.equal(binary, soloBinary);
    assert.equal(options.cwd, project);
    assert.equal(args.at(-1), '--json');
    state.calls.push({ args, input: options.input });
    const value = flag => args[args.indexOf(flag) + 1];
    const [kind, operation] = args;
    const respond = data => ({ status: 0, stdout: JSON.stringify({ ok: true, data }) });
    if (kind === 'projects') return respond({ id: 26, workspaceId: 1, name: 'fixture', path: project });
    assert.equal(value('--project-id'), '26');
    const records = state[kind];
    if (operation === 'list') {
      const listed = records.filter(record => record.tags.includes(value('--tag')));
      return respond({ scope: { type: 'project', projectId: 26 }, [kind]: listed,
        totalCount: listed.length, offset: 0, limit: 500, limitClamped: false, hasMore: false, nextOffset: null });
    }
    if (operation === 'create') {
      const record = kind === 'todos' ? { id: 100 + records.length, title: value('--title'), body: value('--body'), status: 'open' }
        : { id: 200 + records.length, name: value('--name'), content: options.input, revision: 1 };
      record.tags = [value('--tag')]; records.push(record);
      return respond(kind === 'todos' ? { todo: record } : { scratchpad: record });
    }
    const record = records.find(item => item.id === Number(args[2]));
    assert.ok(record, 'Only a known ID can be read or updated');
    if (operation === 'read') return respond({ scratchpad: record });
    assert.equal(operation, 'update');
    if (kind === 'scratchpads') {
      assert.equal(value('--expected-revision'), String(record.revision));
      record.content = options.input; record.revision += 1;
    } else {
      for (const key of ['title', 'body', 'status']) if (args.includes(`--${key}`)) record[key] = value(`--${key}`);
    }
    return respond(kind === 'todos' ? { todo: record } : { scratchpad: record });
  };
  return { project, binding, audit, state, invoke };
}

test('binding a second native client preserves the first client on the same Solo project', async t => {
  const { project, binding } = fixture(t);
  bindSoloObserver({ ...binding, harness: 'claude' });
  const saved = JSON.parse(fs.readFileSync(path.join(project, '.agent-orchestra/runtime/solo-observer.json'), 'utf8'));
  assert.deepEqual(saved.harnesses, ['codex', 'claude']);
  assert.throws(() => bindSoloObserver({ ...binding, projectId: 99 }), /identity changed/);
});

test('native Solo mirror is idempotent and preserves unrelated todos and scratchpads', async t => {
  const f = fixture(t);
  await mirrorNativeAudit(f.audit, f);
  const mutations = () => f.state.calls.filter(call => ['create', 'update'].includes(call.args[1]));
  const count = mutations().length;
  await mirrorNativeAudit(f.audit, f);
  assert.equal(mutations().length, count);
  assert.equal(f.state.todos.length, 2);
  assert.equal(f.state.scratchpads.length, 2);
  assert.deepEqual(f.state.todos[0], { id: 99, title: 'User work', body: 'Unrelated', status: 'open', tags: ['user'] });
  assert.equal(f.state.scratchpads[0].content, 'Unrelated');
  assert.match(f.state.scratchpads[1].content, /Cost[\s\S]*unavailable/);
  assert.equal(f.state.calls.some(call => ['processes', 'agents'].includes(call.args[0])), false, 'No fake Solo workers');
});

test('deleted Solo project can rebind an unused installation with a preserved backup', t => {
  const f = fixture(t);
  const file = path.join(f.project, '.agent-orchestra/runtime/solo-observer.json');
  const before = fs.readFileSync(file, 'utf8');
  let calls = 0;
  const invoke = (binary, args, options) => {
    calls++; assert.equal(binary, f.binding.soloBinary); assert.equal(options.timeout, 10000);
    assert.deepEqual(args.slice(0, 2), ['projects', 'get']);
    return args[2] === '26'
      ? { status: 65, stdout: '', stderr: JSON.stringify({ ok: false, error: { code: 'not_found' } }) }
      : { status: 0, stdout: JSON.stringify({ ok: true, data: { id: 34, path: f.project } }), stderr: '' };
  };
  bindSoloObserver({ ...f.binding, projectId: 34 }, { invoke });
  assert.equal(calls, 2);
  assert.equal(JSON.parse(fs.readFileSync(file)).projectId, 34);
  const backups = fs.readdirSync(path.join(f.project, '.agent-orchestra/backups'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(f.project, '.agent-orchestra/backups', backups[0]), 'utf8'), before);
  bindSoloObserver({ ...f.binding, projectId: 34 }, { invoke });
  assert.equal(calls, 2, 'retry is idempotent');
});

test('rebind preserves history and rejects ambiguous identity or unavailable Solo', t => {
  const f = fixture(t), file = path.join(f.project, '.agent-orchestra/runtime/solo-observer.json');
  const before = fs.readFileSync(file, 'utf8');
  for (const value of [
    { ok: true, data: { id: 26, path: f.project } },
    { ok: false, error: { code: 'unavailable' } },
  ]) {
    assert.throws(() => bindSoloObserver({ ...f.binding, projectId: 34 }, { invoke: () => ({ status: 0, stdout: JSON.stringify(value) }) }), /identity changed/);
  }
  assert.throws(() => bindSoloObserver({ ...f.binding, projectId: 34 }, { invoke: (_b, args) => ({ status: 0,
    stdout: JSON.stringify(args[2] === '26' ? { ok: false, error: { code: 'not_found' } } : { ok: true, data: { id: 34, path: '/foreign' } }) }) }), /identity changed/);
  fs.mkdirSync(path.join(f.project, '.agent-orchestra/dispatch'));
  assert.throws(() => bindSoloObserver({ ...f.binding, projectId: 34 }, { invoke: () => { throw Error('Must not call Solo'); } }), /identity changed/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('recreated project archives obsolete Solo ownership while retaining delivery and tracker history', t => {
  const f = fixture(t), base = path.join(f.project, '.agent-orchestra');
  fs.mkdirSync(path.join(base, 'runs'));
  fs.writeFileSync(path.join(base, 'runs', 'history.json'), 'historical evidence');
  const coordination = JSON.stringify({ schemaVersion: 1, project: f.project, projectId: 26, todos: [{ id: 57 }], scratchpads: [{ id: 91 }] });
  fs.writeFileSync(path.join(base, 'runtime/solo-coordination.json'), coordination);
  fs.writeFileSync(path.join(base, 'runtime/taskavel-binding.json'), 'preserved tracker');
  const invoke = (_binary, args) => args[2] === '26'
    ? { status: 65, stderr: JSON.stringify({ ok: false, error: { code: 'not_found' } }) }
    : { status: 0, stdout: JSON.stringify({ ok: true, data: { id: 34, path: f.project } }) };
  bindSoloObserver({ ...f.binding, projectId: 34 }, { invoke });
  assert.equal(JSON.parse(fs.readFileSync(path.join(base, 'runtime/solo-observer.json'))).projectId, 34);
  assert.equal(fs.existsSync(path.join(base, 'runtime/solo-coordination.json')), false);
  const archived = fs.readdirSync(path.join(base, 'backups')).find(name => name.startsWith('solo-coordination-26-'));
  assert.equal(fs.readFileSync(path.join(base, 'backups', archived), 'utf8'), coordination);
  assert.equal(fs.readFileSync(path.join(base, 'runs/history.json'), 'utf8'), 'historical evidence');
  assert.equal(fs.readFileSync(path.join(base, 'runtime/taskavel-binding.json'), 'utf8'), 'preserved tracker');
  bindSoloObserver({ ...f.binding, projectId: 34 }, { invoke });
  assert.equal(fs.readdirSync(path.join(base, 'backups')).length, 2);
});

test('concurrent mirrors serialize creates and revisions', async t => {
  const f = fixture(t);
  await Promise.all([mirrorNativeAudit(f.audit, f), mirrorNativeAudit(f.audit, f)]);
  assert.equal(f.state.scratchpads.length, 2);
  assert.equal(f.state.todos.length, 2);
  f.audit.agents[1].state = 'idle';
  await mirrorNativeAudit(f.audit, f);
  assert.equal(f.state.scratchpads[1].revision, 2);
  assert.equal(f.state.todos.some(todo => todo.title.startsWith('[Native agent]')), false);
  assert.match(f.state.scratchpads[1].content, /Response returned; review pending/);
});

test('legacy activity todos are preserved but new work todos use meaningful titles', async t => {
  const f = fixture(t);
  f.state.todos.push({ id: 500, title: '[Native agent] reviewer', body: 'Legacy record', status: 'open', tags: [] });
  await mirrorNativeAudit(f.audit, f);
  assert.equal(f.state.todos.filter(todo => todo.title.startsWith('[Native agent]')).length, 1);
  assert.ok(f.state.todos.some(todo => todo.title === 'Verify behavior'));
  const content = f.state.scratchpads[1].content;
  assert.match(content, /## Technical details/);
  assert.doesNotMatch(content.split('## Technical details')[0], /Root session:|parent:/);
  assert.match(content, /repeated and cached input/);
});

test('invalid project, harness and undiscovered binary never call Solo', async t => {
  const f = fixture(t);
  for (const binding of [{ ...f.binding, project: '/foreign' }, { ...f.binding, harness: 'claude' },
    { ...f.binding, projectId: 0 }, { ...f.binding, soloBinary: process.execPath }]) {
    await assert.rejects(mirrorNativeAudit(f.audit, { ...f, binding }));
  }
  assert.equal(f.state.calls.length, 0);
  assert.throws(() => bindSoloObserver({ ...f.binding, soloBinary: process.execPath }), /discovery/);
  assert.throws(() => bindSoloObserver({ ...f.binding, projectId: -1 }), /scope/);
});

test('changed Solo project identity is rejected before writes', async t => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(mirrorNativeAudit(f.audit, { ...f, invoke: () => {
    calls += 1; return { status: 0, stdout: JSON.stringify({ ok: true, data: { id: 27, path: f.project } }) };
  } }), /identity changed/);
  assert.equal(calls, 1);
});

test('unmanaged binding and symlinked runtime directories are preserved', t => {
  const f = fixture(t);
  const bindingFile = path.join(f.project, '.agent-orchestra', 'runtime', 'solo-observer.json');
  fs.writeFileSync(bindingFile, JSON.stringify({ owner: 'user' }));
  assert.throws(() => bindSoloObserver(f.binding), /Preserved unmanaged/);
  assert.equal(JSON.parse(fs.readFileSync(bindingFile, 'utf8')).owner, 'user');
  const project = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'solo-mirror-link-')));
  fs.mkdirSync(path.join(project, '.agent-orchestra'));
  const other = path.join(project, 'other'); fs.mkdirSync(other);
  try { fs.symlinkSync(other, path.join(project, '.agent-orchestra', 'runtime'), 'dir'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  assert.throws(() => bindSoloObserver({ ...f.binding, project }), /Unsafe/);
});

test('dangling binding symlink is preserved rather than silently replaced', t => {
  const f = fixture(t);
  const project = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'solo-binding-link-')));
  const runtime = path.join(project, '.agent-orchestra', 'runtime'); fs.mkdirSync(runtime, { recursive: true });
  const file = path.join(runtime, 'solo-observer.json');
  try { fs.symlinkSync(path.join(project, 'missing-target'), file, 'file'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  assert.throws(() => bindSoloObserver({ ...f.binding, project }), /Unsafe/);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
});

test('ambiguous inventory and duplicate owned scratchpads stop instead of creating more records', async t => {
  const f = fixture(t);
  await mirrorNativeAudit(f.audit, f);
  f.state.scratchpads.push({ ...f.state.scratchpads[1], id: 999 });
  const count = f.state.calls.length;
  await assert.rejects(mirrorNativeAudit(f.audit, f), /Duplicate native Solo scratchpads/);
  assert.equal(f.state.calls.slice(count).some(call => ['create', 'update'].includes(call.args[1])), false);
  await assert.rejects(mirrorNativeAudit(f.audit, { ...f, invoke: (binary, args, options) => {
    if (args[1] === 'list') return { status: 0, stdout: JSON.stringify({ ok: true, data: { scratchpads: [], hasMore: true } }) };
    return f.invoke(binary, args, options);
  } }), /Ambiguous Solo observation inventory/);
});
