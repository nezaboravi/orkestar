import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskContract } from '../orchestra.mjs';
import { captureNativeWorkerResult, finalizeNativeWorkerReport } from '../native-worker-report.mjs';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-provenance-')));
  const contract = createTaskContract({ schemaVersion: 1, goal: 'Tracker provenance fixture', required: [{ id: 'R1', text: 'Verified behavior' }],
    localDecisions: [], outOfScope: [], discoveryPolicy: 'report-only', changeSurface: { modules: [], fileKinds: [], migrationsAllowed: false, dependenciesAllowed: false, architectureChangesAllowed: false } });
  const runs = path.join(project, '.agent-orchestra/runs', contract.id);
  fs.mkdirSync(runs, { recursive: true }); fs.writeFileSync(path.join(runs, 'task-contract.json'), JSON.stringify(contract));
  const dispatch = path.join(project, '.agent-orchestra/dispatch'); fs.mkdirSync(dispatch);
  const workers = ['dev-planner', 'dev-builder', 'dev-tester', 'reviewer', 'dev-auditor'].map((role, index) => ({
    schemaVersion: 1, project, harness: 'codex', contractId: contract.id, runId: id(index + 1), processId: index + 1,
    sessionId: `tracker-session-${index}`, role, readOnly: role !== 'dev-builder', model: 'requested', actualModel: null,
    dispatchedAt: index === 3 ? 3000 : index === 4 ? 5000 : 1000,
    state: 'exited', complete: true, result: 'Observed behavior', tokens: { input: 2, output: 1, total: 3 }, cost: null,
  }));
  workers[3].result = JSON.stringify({ verdict: 'APPROVED', reviewedRunIds: workers.slice(1, 3).map(w => w.runId),
    security: { status: 'PASS', evidence: ['Authorization checked'] }, performance: { status: 'PASS', evidence: ['Query bounded'] } });
  workers[4].result = JSON.stringify({ verdict: 'DONE', reviewRunId: workers[3].runId, reviewedRunIds: workers.slice(0, 4).map(w => w.runId),
    proof: [{ criterionId: 'R1', result: 'passed', method: 'Independent test', evidence: ['Observed expected result'] }] });
  workers.forEach((worker, index) => {
    fs.writeFileSync(path.join(dispatch, `native-${worker.runId}.json`), JSON.stringify(worker));
    captureNativeWorkerResult({ project, harness: 'codex', worker }, index === 3 ? 4000 : index === 4 ? 6000 : 2000);
  });
  const packet = { projectId: 'tracker-project', checkedAt: 7000,
    requiredTasks: [{ taskId: 'task-one', doneColumnId: 'done', claimedComplete: true, lastUpdateAttemptAt: 6500,
      proof: { accepted: true, evidenceIds: [workers[4].runId] } }],
    snapshots: [{ projectId: 'tracker-project', taskId: 'task-one', columnId: 'done', completed: true, readAt: 7000 }] };
  const report = { reportId: id(99), contract, workerRunIds: workers.map(w => w.runId), status: 'DONE', summary: 'Verified fixture',
    workflow: 'development', designRequired: false, visualProofRequired: false, taskavel: 'synced', trackerReconciliation: packet, blockers: [] };
  const execute = reconcileTracker => finalizeNativeWorkerReport({ project, harness: 'codex', report }, {
    collect: ({ runId }) => workers.find(w => w.runId === runId), now: () => 7000, ...(reconcileTracker ? { reconcileTracker } : {}),
  });
  const readback = () => ({ projectId: packet.projectId, checkedAt: 7000, snapshots: structuredClone(packet.snapshots) });
  return { project, report, packet, execute, readback };
}

test('caller supplied synced snapshots cannot authorize DONE without trusted readback', async () => {
  const f = fixture();
  assert.equal((await f.execute()).status, 'PARTIAL');
  assert.equal((await f.execute(async () => { throw new Error('Readback unavailable'); })).status, 'PARTIAL');
  assert.equal((await f.execute(async () => null)).status, 'PARTIAL');
});

test('fresh adapter readbacks replace caller snapshots and checkedAt while retaining task evidence', async () => {
  const f = fixture(), fresh = f.readback(), expectedIntent = structuredClone(f.packet.requiredTasks);
  f.packet.checkedAt = Number.MAX_SAFE_INTEGER;
  f.packet.snapshots = [{ ...fresh.snapshots[0], completed: false, readAt: 1 }];
  let calls = 0;
  const result = await f.execute(async request => {
    calls++;
    assert.equal(request.projectId, f.packet.projectId);
    assert.deepEqual(request.requiredTasks, expectedIntent);
    return fresh;
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'DONE', result.blockers.join('\n'));
  const saved = JSON.parse(fs.readFileSync(result.savedPath)).trackerReconciliation;
  assert.equal(saved.checkedAt, 7000);
  assert.deepEqual(saved.packet.requiredTasks, expectedIntent);
  assert.deepEqual(saved.packet.snapshots, fresh.snapshots);
});

test('caller complete claims never override incomplete stale foreign or missing adapter readbacks', async () => {
  for (const mutate of [
    data => { data.snapshots[0].completed = false; },
    data => { data.snapshots[0].columnId = 'doing'; },
    data => { data.snapshots[0].readAt = 6400; },
    data => { data.snapshots[0].readAt = 7001; },
    data => { data.snapshots[0].projectId = 'foreign'; },
    data => { data.projectId = 'foreign'; },
    data => { data.snapshots = []; },
    data => { data.snapshots.push({ ...data.snapshots[0] }); },
  ]) {
    const f = fixture(), readback = f.readback(); mutate(readback);
    const result = await f.execute(async () => readback);
    assert.equal(result.status, 'PARTIAL', JSON.stringify(readback));
  }
});

test('trusted tracker completion does not manufacture accepted task proof', async () => {
  const f = fixture(); f.packet.requiredTasks[0].proof = { accepted: false, evidenceIds: [] };
  assert.equal((await f.execute(async () => f.readback())).status, 'PARTIAL');
});
