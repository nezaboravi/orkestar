import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bindSoloObserver } from '../native-solo-mirror.mjs';
import { coordinateNativeSolo, coordinationToolDefinitions } from '../native-worker-coordination.mjs';

function fixture(t) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'solo-coordination-')));
  const bin = path.join(project, 'bin'); fs.mkdirSync(bin);
  const binary = path.join(bin, process.platform === 'win32' ? 'solo.exe' : 'solo');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const original = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${original}`;
  t.after(() => { process.env.PATH = original; });
  bindSoloObserver({ project, projectId: 29, soloBinary: binary, harness: 'codex' });
  const state = { todos: [], scratchpads: [], calls: [], wrongReadback: false };
  const invoke = (file, args, options) => {
    assert.equal(file, binary); assert.equal(options.cwd, project); assert.ok(options.timeout <= 2000);
    state.calls.push(args); const [kind, action] = args;
    const respond = data => ({ status: 0, stdout: JSON.stringify({ ok: true, data }) });
    if (kind === 'projects') return respond({ id: 29, path: project });
    const flag = name => args[args.indexOf(name) + 1]; assert.equal(flag('--project-id'), '29');
    const records = state[kind];
    if (action === 'create') {
      const record = { id: records.length + 1, projectId: 29, ...(kind === 'todos'
        ? { title: flag('--title'), body: options.input, status: 'open' }
        : { name: flag('--name'), content: options.input, revision: 1 }) };
      records.push(record);
      if (state.failCreation) return { status: 1, stdout: '' };
      return respond({ [kind === 'todos' ? 'todo' : 'scratchpad']: record });
    }
    const record = records.find(item => item.id === Number(args[2])); assert.ok(record);
    if (action === 'update' && !state.wrongReadback) Object.assign(record, { title: flag('--title'), body: options.input, status: flag('--status') });
    if (action === 'append') { assert.equal(flag('--expected-revision'), String(record.revision)); record.content += options.input; record.revision++; }
    return respond({ [kind === 'todos' ? 'todo' : 'scratchpad']: record });
  };
  const run = (name, args = {}) => coordinateNativeSolo({ project, harness: 'codex', name, args }, { invoke });
  return { project, state, run };
}
test('seven closed project coordination tools create idempotently and verify readbacks', async t => {
  const f = fixture(t);
  assert.equal(coordinationToolDefinitions.length, 7);
  const draft = { key: 'home', title: 'Landing page', body: 'Visible outcome and acceptance link' };
  const todo = await f.run('coord_todo_create', draft);
  assert.equal((await f.run('coord_todo_create', draft)).id, todo.id); assert.equal(f.state.todos.length, 1);
  await assert.rejects(f.run('coord_todo_create', { ...draft, title: 'Different' }), /key conflict/);
  assert.equal((await f.run('coord_todo_update', { id: todo.id, title: draft.title, body: draft.body, status: 'in_progress' })).status, 'in_progress');
  assert.equal((await f.run('coord_todo_list')).todos.length, 1);
  f.state.wrongReadback = true;
  await assert.rejects(f.run('coord_todo_update', { id: todo.id, title: draft.title, body: draft.body, status: 'completed' }), /readback/);
});
test('scratchpad appends require ownership and exact revision', async t => {
  const f = fixture(t), pad = await f.run('coord_scratchpad_create', { key: 'plan', name: 'Outcome plan', content: 'Plan' });
  assert.equal((await f.run('coord_scratchpad_append', { id: pad.id, expectedRevision: 1, content: ' accepted' })).content, 'Plan accepted');
  await assert.rejects(f.run('coord_scratchpad_append', { id: pad.id, expectedRevision: 1, content: ' stale' }), /revision/);
  assert.equal((await f.run('coord_scratchpad_read', { id: pad.id })).revision, 2);
  assert.equal((await f.run('coord_scratchpad_list')).scratchpads.length, 1);
  await assert.rejects(f.run('coord_scratchpad_read', { id: 999 }), /Unowned/);
});
test('unknown inputs, control bytes, foreign scope and symlinks reject without mutation', async t => {
  const f = fixture(t);
  await assert.rejects(f.run('coord_todo_delete', { id: 1 }), /input/);
  await assert.rejects(f.run('coord_todo_list', { projectId: 99 }), /input/);
  await assert.rejects(f.run('coord_todo_create', { key: 'x', title: '\u001b[31m', body: 'x' }), /input/);
  await assert.rejects(f.run('coord_todo_update', { id: 999, title: 'x', body: 'x', status: 'open' }), /Unowned/);
  const manifest = path.join(f.project, '.agent-orchestra/runtime/solo-coordination.json');
  const outside = path.join(f.project, 'preserve.json'); fs.writeFileSync(outside, '{"user":true}'); fs.symlinkSync(outside, manifest);
  await assert.rejects(f.run('coord_todo_list'), /file/);
  assert.equal(fs.readFileSync(outside, 'utf8'), '{"user":true}'); assert.equal(f.state.todos.length, 0);
});
test('concurrent create keys share one owned record', async t => {
  const f = fixture(t), args = { key: 'same', title: 'Outcome', body: 'Proof pending' };
  const values = await Promise.all([f.run('coord_todo_create', args), f.run('coord_todo_create', args)]);
  assert.equal(values[0].id, values[1].id); assert.equal(f.state.todos.length, 1);
});
test('ambiguous creation leaves a pending key and cannot duplicate on retry', async t => {
  const f = fixture(t); f.state.failCreation = true;
  const args = { key: 'uncertain', title: 'Outcome', body: 'Pending' };
  await assert.rejects(f.run('coord_todo_create', args), /request failed/);
  f.state.failCreation = false;
  await assert.rejects(f.run('coord_todo_create', args), /needs inspection/);
  assert.equal(f.state.todos.length, 1);
});
