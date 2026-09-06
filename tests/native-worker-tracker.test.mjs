import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { reconcileNativeWorkerTracker, closeNativeWorkerTracker } from '../native-worker-tracker.mjs';
import { createTaskContract } from '../orchestra.mjs';
import { nativeTaskavelArguments } from '../native-worker-taskavel.mjs';

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

test('close-out receipts persist successful operations and fail closed for ambiguous, corrupt, foreign, or symlinked records', async t => {
  const f = fixture(t); const reportId = '00000000-0000-4000-8000-000000000099'; let calls = 0;
  const contract = createTaskContract({ schemaVersion: 1, goal: 'Close card', required: [{ id: 'R1', text: 'Done' }], localDecisions: [], outOfScope: [], discoveryPolicy: 'report-only',
    changeSurface: { modules: [], fileKinds: [], migrationsAllowed: false, dependenciesAllowed: false, architectureChangesAllowed: false },
    trackerAuthorization: { projectName: 'Demo', taskIds: [41], operations: ['read', 'update-task', 'move-task'], externalWriteAuthorized: true } });
  const closeout = { authorization: { projectId: null, projectName: 'Demo', taskIds: [41], operations: ['read', 'update-task', 'move-task'], externalWriteAuthorized: true }, tasks: [{ taskId: 41, doneColumnName: 'Done' }] };
  const invoke = (binary, args, options = {}) => {
    if (binary === process.execPath) {
      const launch = nativeTaskavelArguments(JSON.parse(options.input).assignment);
      return { status: 0, stdout: JSON.stringify({ name: 'taskavel', status: 'connected', enabledTools: launch.enabledTools, projectNames: ['Demo'] }) };
    }
    return { status: 0, stdout: JSON.stringify({ ok: true, data: { agentTools: [f.state.tool] } }) };
  };
  const base = { project: f.project, harness: 'codex', contract, closeout, reportId };
  const deps = { invoke, now: () => 10000, operate: async () => { calls++; return { isError: false }; } };
  const one = await closeNativeWorkerTracker(base, deps); const two = await closeNativeWorkerTracker(base, deps);
  assert.equal(calls, 2); assert.deepEqual(one, two);
  const receipt = path.join(f.project, '.agent-orchestra', 'tracker-receipts', `${reportId}.json`);
  fs.writeFileSync(receipt, JSON.stringify({ identity: 'other', state: 'complete', operation: one }));
  await assert.rejects(closeNativeWorkerTracker(base, deps), /ambiguous prior/);
  fs.writeFileSync(receipt, '{'); await assert.rejects(closeNativeWorkerTracker(base, deps), /receipt is invalid/);
  fs.unlinkSync(receipt); const outside = path.join(f.project, 'outside'); fs.symlinkSync(outside, receipt);
  await assert.rejects(closeNativeWorkerTracker(base, deps), /receipt is invalid/);
  assert.equal(fs.existsSync(outside), false);

  const createId = '00000000-0000-4000-8000-000000000103';
  const createReceipt = path.join(f.project, '.agent-orchestra', 'tracker-receipts', `${createId}.json`);
  const createOutside = path.join(f.project, 'create-outside');
  await assert.rejects(closeNativeWorkerTracker({ ...base, reportId: createId }, { ...deps, afterReceiptOpen: ({ phase }) => {
    if (phase === 'create') { fs.unlinkSync(createReceipt); fs.symlinkSync(createOutside, createReceipt); }
  } }), /receipt is invalid/);
  assert.equal(fs.existsSync(createOutside), false);

  const removedId = '00000000-0000-4000-8000-000000000105';
  const removedReceipt = path.join(f.project, '.agent-orchestra', 'tracker-receipts', `${removedId}.json`); let removedDescriptor;
  await assert.rejects(closeNativeWorkerTracker({ ...base, reportId: removedId }, { ...deps, afterReceiptOpen: ({ receiptPath, descriptor, phase }) => {
    if (phase === 'create') { removedDescriptor = descriptor; fs.unlinkSync(receiptPath); }
  } }), /receipt is unavailable/);
  assert.equal(fs.existsSync(removedReceipt), false); assert.throws(() => fs.writeSync(removedDescriptor, 'closed'), /bad file descriptor/i);

  const replayId = '00000000-0000-4000-8000-000000000104';
  await closeNativeWorkerTracker({ ...base, reportId: replayId }, deps);
  const replayReceipt = path.join(f.project, '.agent-orchestra', 'tracker-receipts', `${replayId}.json`);
  const replayOutside = path.join(f.project, 'replay-outside');
  await assert.rejects(closeNativeWorkerTracker({ ...base, reportId: replayId }, { ...deps, afterReceiptOpen: ({ phase }) => {
    if (phase === 'replay') { fs.unlinkSync(replayReceipt); fs.symlinkSync(replayOutside, replayReceipt); }
  } }), /receipt is invalid/);
  assert.equal(fs.existsSync(replayOutside), false);
});

test('membership rejection preserves the ambiguous receipt and requires fresh state before retry', async t => {
  const f = fixture(t); const reportId = '00000000-0000-4000-8000-000000000102';
  const contract = createTaskContract({ schemaVersion: 1, goal: 'Close card', required: [{ id: 'R1', text: 'Done' }], localDecisions: [], outOfScope: [], discoveryPolicy: 'report-only',
    changeSurface: { modules: [], fileKinds: [], migrationsAllowed: false, dependenciesAllowed: false, architectureChangesAllowed: false },
    trackerAuthorization: { projectName: 'Demo', taskIds: [41], operations: ['read', 'update-task', 'move-task'], externalWriteAuthorized: true } });
  const closeout = { authorization: { projectId: null, projectName: 'Demo', taskIds: [41], operations: ['read', 'update-task', 'move-task'], externalWriteAuthorized: true }, tasks: [{ taskId: 41, doneColumnName: 'Done' }] };
  const invoke = (binary, args, options = {}) => binary === process.execPath
    ? { status: 0, stdout: JSON.stringify({ name: 'taskavel', status: 'connected', enabledTools: nativeTaskavelArguments(JSON.parse(options.input).assignment).enabledTools, projectNames: ['Demo'] }) }
    : { status: 0, stdout: JSON.stringify({ ok: true, data: { agentTools: [f.state.tool] } }) };
  await assert.rejects(closeNativeWorkerTracker({ project: f.project, harness: 'codex', contract, closeout, reportId }, {
    invoke, now: () => 10000, operate: async () => { throw new Error('Native Taskavel membership listing rejected'); },
  }), /membership listing was rejected; fresh authenticated state is required/);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.project, '.agent-orchestra', 'tracker-receipts', `${reportId}.json`), 'utf8'));
  assert.equal(receipt.state, 'ambiguous');
});

test('a later fixed operation membership rejection remains ambiguous after an earlier mutation', async t => {
  const f = fixture(t); const reportId = '00000000-0000-4000-8000-000000000103'; let calls = 0;
  const contract = createTaskContract({ schemaVersion: 1, goal: 'Close card', required: [{ id: 'R1', text: 'Done' }], localDecisions: [], outOfScope: [], discoveryPolicy: 'report-only',
    changeSurface: { modules: [], fileKinds: [], migrationsAllowed: false, dependenciesAllowed: false, architectureChangesAllowed: false },
    trackerAuthorization: { projectName: 'Demo', taskIds: [41], operations: ['read', 'update-task', 'move-task'], externalWriteAuthorized: true } });
  const closeout = { authorization: { projectId: null, projectName: 'Demo', taskIds: [41], operations: ['read', 'update-task', 'move-task'], externalWriteAuthorized: true }, tasks: [{ taskId: 41, doneColumnName: 'Done' }] };
  const invoke = (binary, args, options = {}) => binary === process.execPath
    ? { status: 0, stdout: JSON.stringify({ name: 'taskavel', status: 'connected', enabledTools: nativeTaskavelArguments(JSON.parse(options.input).assignment).enabledTools, projectNames: ['Demo'] }) }
    : { status: 0, stdout: JSON.stringify({ ok: true, data: { agentTools: [f.state.tool] } }) };
  await assert.rejects(closeNativeWorkerTracker({ project: f.project, harness: 'codex', contract, closeout, reportId }, {
    invoke, now: () => 10000, operate: async () => { calls++; if (calls === 2) throw new Error('Native Taskavel membership listing rejected'); return { isError: false }; },
  }), /membership listing was rejected; fresh authenticated state is required/);
  assert.equal(calls, 2);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.project, '.agent-orchestra', 'tracker-receipts', `${reportId}.json`), 'utf8'));
  assert.equal(receipt.state, 'ambiguous');
});

test('close-out creates a fresh binding only from exact immutable existing-card authorization and native project proof', async t => {
  const f = fixture(t); const reportId = '00000000-0000-4000-8000-000000000100';
  fs.unlinkSync(path.join(f.runtime, 'taskavel-binding.json'));
  const contract = createTaskContract({ schemaVersion: 1, goal: 'Close card', required: [{ id: 'R1', text: 'Done' }], localDecisions: [], outOfScope: [], discoveryPolicy: 'report-only',
    changeSurface: { modules: [], fileKinds: [], migrationsAllowed: false, dependenciesAllowed: false, architectureChangesAllowed: false },
    trackerAuthorization: { projectName: 'Demo', taskIds: [41], operations: ['read', 'update-task', 'move-task'], externalWriteAuthorized: true } });
  const closeout = { authorization: { projectId: null, projectName: 'Demo', taskIds: [41], operations: ['read', 'update-task', 'move-task'], externalWriteAuthorized: true }, tasks: [{ taskId: 41, doneColumnName: 'Done' }] };
  const invoke = (binary, args, options = {}) => binary === process.execPath
    ? { status: 0, stdout: JSON.stringify({ name: 'taskavel', status: 'connected', enabledTools: nativeTaskavelArguments(JSON.parse(options.input).assignment).enabledTools, projectNames: ['Demo'] }) }
    : { status: 0, stdout: JSON.stringify({ ok: true, data: { agentTools: [f.state.tool] } }) };
  await closeNativeWorkerTracker({ project: f.project, harness: 'codex', contract, closeout, reportId }, { invoke, now: () => 10000, operate: async () => ({ isError: false }) });
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.runtime, 'taskavel-binding.json'), 'utf8')).projectId, 'name:Demo');
});

test('invalid immutable close-out input fails before native preflight', async t => {
  const f = fixture(t); let invoked = false;
  const contract = { id: 'tc-invalid', hash: 'sha256:' + '0'.repeat(64) };
  const closeout = { authorization: { projectId: null, projectName: 'Demo', taskIds: [41], operations: ['read', 'update-task', 'move-task'], externalWriteAuthorized: true }, tasks: [{ taskId: 41, doneColumnName: 'Done' }] };
  await assert.rejects(closeNativeWorkerTracker({ project: f.project, harness: 'codex', contract, closeout, reportId: '00000000-0000-4000-8000-000000000101' }, {
    invoke: () => { invoked = true; throw new Error('must not run'); },
  }));
  assert.equal(invoked, false);
});
