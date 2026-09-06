import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { reconcileNativeWorkerTracker } from '../native-worker-tracker.mjs';

function fixture(t) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'tracker-read-')));
  const bin = path.join(project, 'bin'); fs.mkdirSync(bin);
  const solo = path.join(bin, process.platform === 'win32' ? 'solo.exe' : 'solo');
  fs.writeFileSync(solo, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const previous = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${previous}`;
  t.after(() => { process.env.PATH = previous; });
  const runtime = path.join(project, '.agent-orchestra/runtime'); fs.mkdirSync(runtime, { recursive: true });
  const binding = { schemaVersion: 1, project, projectId: 8, harness: 'codex', soloBinary: solo };
  fs.writeFileSync(path.join(runtime, 'solo-observer.json'), JSON.stringify(binding));
  fs.writeFileSync(path.join(runtime, 'taskavel-binding.json'), JSON.stringify({ schemaVersion: 1, workspace: project,
    contractId: 'contract-1', contractHash: 'hash-1', projectName: 'Demo', projectId: 'name:Demo' }));
  fs.writeFileSync(path.join(runtime, 'codex.json'), JSON.stringify({ schemaVersion: 1, harness: 'codex',
    profiles: { taskavel: { permissionEnvelope: 'task-manager', model: 'fixture', reasoningEffort: 'low' } } }));
  const state = { now: 10000, calls: [], tool: { id: 3, command: 'codex', toolType: 'codex', enabled: true } };
  const deps = {
    now: () => state.now,
    invoke: (binary, args) => {
      assert.equal(binary, solo);
      return { status: 0, stdout: JSON.stringify({ ok: true, data: args[0] === 'projects'
        ? { id: 8, path: project } : { agentTools: [state.tool] } }) };
    },
    readTask: async ({ launch, taskId, binary }, limits) => {
      state.calls.push({ launch, taskId, binary, limits }); state.now++;
      return { snapshot: { projectId: 'name:Demo', taskId: String(taskId), columnId: 'name:Done', completed: true, readAt: state.now } };
    },
  };
  return { project, runtime, binding, state, deps, options: { project, harness: 'codex', projectId: 'name:Demo', requiredTasks: [{ taskId: '41' }, { taskId: '42' }] } };
}

test('fresh reconciliation binds native tool, narrows immutable read authorization and returns collected snapshots', async t => {
  const f = fixture(t);
  const result = await reconcileNativeWorkerTracker(f.options, f.deps);
  assert.equal(result.projectId, 'name:Demo'); assert.equal(result.checkedAt, 10002);
  assert.deepEqual(result.snapshots.map(item => item.taskId), ['41', '42']);
  const call = f.state.calls[0];
  assert.equal(call.binary, 'codex'); assert.equal(call.limits.timeoutMs, 30000);
  assert.deepEqual(call.launch.authorization, { projectId: null, projectName: 'Demo', taskIds: [41, 42], operations: ['read'], externalWriteAuthorized: false });
  assert.ok(Object.isFrozen(call.launch)); assert.ok(Object.isFrozen(call.launch.authorization.taskIds));
});

test('invalid IDs, duplicate/oversized lists and foreign harnesses fail before discovery', async t => {
  const f = fixture(t);
  for (const override of [{ harness: 'claude' }, { projectId: '025' }, { projectId: '9007199254740993' },
    { requiredTasks: [] }, { requiredTasks: [{ taskId: '41' }, { taskId: '41' }] },
    { requiredTasks: Array.from({ length: 33 }, (_, i) => ({ taskId: String(i + 1) })) }]) {
    await assert.rejects(reconcileNativeWorkerTracker({ ...f.options, ...override }, f.deps));
  }
  assert.equal(f.state.calls.length, 0);
});

test('foreign Solo project and unsafe native command cannot launch a broker', async t => {
  const f = fixture(t);
  await assert.rejects(reconcileNativeWorkerTracker(f.options, { ...f.deps, invoke: () => ({ status: 0,
    stdout: JSON.stringify({ ok: true, data: { id: 8, path: '/foreign' } }) }) }), /project mismatch/);
  f.state.tool.command = 'codex --unsafe';
  await assert.rejects(reconcileNativeWorkerTracker(f.options, f.deps), /Exactly one safe/);
  assert.equal(f.state.calls.length, 0);
});

test('foreign, stale, future and malformed snapshots fail closed', async t => {
  const f = fixture(t);
  for (const override of [{ projectId: '99' }, { taskId: '99' }, { readAt: 9999 }, { readAt: 10001 }, { completed: 'true' }, { columnId: 'Done' }]) {
    await assert.rejects(reconcileNativeWorkerTracker(f.options, { ...f.deps, readTask: async () => ({ snapshot: {
      projectId: 'name:Demo', taskId: '41', readAt: 10000, completed: true, columnId: 'name:Done', ...override,
    } }) }), /Invalid fresh scoped/);
  }
});

test('total reconciliation time budget stops subsequent reads', async t => {
  const f = fixture(t);
  await assert.rejects(reconcileNativeWorkerTracker(f.options, { ...f.deps, timeoutMs: 10,
    readTask: async () => { f.state.now += 11; return {}; } }), /time budget exhausted/);
});

test('project-bound runtime symlinks and wrong role routes are rejected', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.runtime, 'codex.json'), JSON.stringify({ schemaVersion: 1, harness: 'codex', profiles: { taskavel: { permissionEnvelope: 'dev-builder' } } }));
  await assert.rejects(reconcileNativeWorkerTracker(f.options, f.deps), /runtime route/);
  const linked = path.join(f.project, 'linked'); fs.symlinkSync(f.project, linked);
  await assert.rejects(reconcileNativeWorkerTracker({ ...f.options, project: linked }, f.deps), /workspace binding/);
});
