import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { bindSoloObserver, mirrorNativeAudit } from '../native-solo-mirror.mjs';
import { assembleNativeAudit } from '../native-audit.mjs';

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
  assert.equal(f.state.todos.length, 3);
  assert.equal(f.state.scratchpads.length, 2);
  assert.deepEqual(f.state.todos[0], { id: 99, title: 'User work', body: 'Unrelated', status: 'open', tags: ['user'] });
  assert.equal(f.state.scratchpads[0].content, 'Unrelated');
  assert.match(f.state.scratchpads[1].content, /Cost[\s\S]*unavailable/);
  assert.equal(f.state.calls.some(call => ['processes', 'agents'].includes(call.args[0])), false, 'No fake Solo workers');
});

test('concurrent mirrors serialize creates and revisions', async t => {
  const f = fixture(t);
  await Promise.all([mirrorNativeAudit(f.audit, f), mirrorNativeAudit(f.audit, f)]);
  assert.equal(f.state.scratchpads.length, 2);
  assert.equal(f.state.todos.length, 3);
  f.audit.agents[1].state = 'idle';
  await mirrorNativeAudit(f.audit, f);
  assert.equal(f.state.scratchpads[1].revision, 2);
  assert.equal(f.state.todos.find(todo => todo.title === '[Native agent] reviewer').status, 'open', 'Idle is not acceptance');
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
