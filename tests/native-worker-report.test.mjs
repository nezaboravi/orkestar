import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTaskContract } from '../orchestra.mjs';
import { captureNativeWorkerResult, finalizeNativeWorkerReport } from '../native-worker-report.mjs';
import { createWorkerMcpHandler } from '../native-solo-worker-mcp.mjs';

const runId = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture({ capture = true } = {}) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-worker-report-')));
  const contract = createTaskContract({ schemaVersion: 1, goal: 'Fixture application', required: [{ id: 'R1', text: 'Observable behavior' }],
    localDecisions: [], outOfScope: [], discoveryPolicy: 'report-only', changeSurface: { modules: [], fileKinds: [], migrationsAllowed: false, dependenciesAllowed: false, architectureChangesAllowed: false } });
  const directory = path.join(project, '.agent-orchestra/runs', contract.id); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'task-contract.json'), JSON.stringify(contract));
  fs.mkdirSync(path.join(project, '.agent-orchestra/dispatch'));
  const roles = ['product-designer', 'dev-planner', 'dev-builder', 'dev-tester', 'frontend-qa', 'reviewer', 'dev-auditor'];
  const workers = roles.map((role, i) => ({ schemaVersion: 1, project, harness: 'codex', contractId: contract.id, runId: runId(i + 1),
    role, readOnly: role !== 'dev-builder', processId: i + 1, sessionId: `session-${i}`, model: 'requested/model', actualModel: null,
    dispatchedAt: i === 5 ? 3000 : i === 6 ? 5000 : 1000, state: 'stopped', complete: true,
    result: 'Native result', tokens: { input: 2, output: 1, total: 3 }, cost: null }));
  workers[5].result = JSON.stringify({ verdict: 'APPROVED', reviewedRunIds: workers.slice(2, 5).map(w => w.runId),
    security: { status: 'PASS', evidence: ['Authorization test'] }, performance: { status: 'PASS', evidence: ['Query budget test'] } });
  workers[6].result = JSON.stringify({ verdict: 'DONE', reviewRunId: workers[5].runId, reviewedRunIds: workers.slice(0, 6).map(w => w.runId),
    proof: [{ criterionId: 'R1', result: 'passed', method: 'Independent behavior test', evidence: ['Observed expected output'] }] });
  const save = () => workers.forEach(w => fs.writeFileSync(path.join(project, '.agent-orchestra/dispatch', `native-${w.runId}.json`), JSON.stringify(w)));
  save();
  if (capture) workers.forEach((worker, i) => captureNativeWorkerResult({ project, harness: 'codex', worker }, i === 5 ? 4000 : i === 6 ? 6000 : 2000));
  const report = { reportId: runId(99), contract, workerRunIds: workers.map(w => w.runId), status: 'DONE', summary: 'Fixture proof',
    workflow: 'development', designRequired: true, visualProofRequired: true, taskavel: 'not-requested', blockers: [] };
  const execute = () => finalizeNativeWorkerReport({ project, harness: 'codex', report }, { collect: ({ runId }) => workers.find(w => w.runId === runId), now: () => 7000 });
  return { project, workers, report, save, execute };
}
test('native report collects actual workers, enforces gates and persists honest accounting', async () => {
  const f = fixture(), report = await f.execute();
  assert.equal(report.status, 'DONE'); assert.equal(report.agents.length, 7);
  assert.equal(report.totals.tokens, 21); assert.equal(report.totals.cost, null);
  assert.equal(report.agents[0].model, null); assert.equal(report.agents[0].requestedModel, 'requested/model');
  assert.equal(report.latestUpdated, true);
  assert.equal(JSON.parse(fs.readFileSync(report.savedPath)).auditorRunId, f.workers[6].runId);
  assert.notEqual((await f.execute()).savedPath, report.savedPath);
});

test('native report rejects agent proliferation beyond the worker-session budget', async () => {
  const f = fixture();
  f.report.workerRunIds = Array.from({ length: 13 }, (_, index) => runId(index + 1));
  await assert.rejects(f.execute(), /Invalid native report input/);
});

test('the persisted contract permits conductor planning without a redundant planner worker', async () => {
  const f = fixture({ capture: false });
  const plannerIndex = f.workers.findIndex(worker => worker.role === 'dev-planner');
  const [planner] = f.workers.splice(plannerIndex, 1);
  // This fixture models a planner that was never dispatched, not a hidden result.
  fs.unlinkSync(path.join(f.project, '.agent-orchestra/dispatch', `native-${planner.runId}.json`));
  f.report.workerRunIds = f.workers.map(worker => worker.runId);
  const auditor = f.workers.find(worker => worker.role === 'dev-auditor');
  const verdict = JSON.parse(auditor.result);
  verdict.reviewedRunIds = verdict.reviewedRunIds.filter(id => id !== planner.runId);
  auditor.result = JSON.stringify(verdict);
  f.save();
  for (const worker of f.workers) captureNativeWorkerResult({ project: f.project, harness: 'codex', worker },
    worker.role === 'dev-auditor' ? 6000 : worker.role === 'reviewer' ? 4000 : 2000);
  assert.equal((await f.execute()).status, 'DONE');
  f.report.contract = { ...f.report.contract, hash: 'tampered' };
  await assert.rejects(f.execute(), /contract/i);
});

test('read-only verification and code review may overlap after final builder capture', async () => {
  const f = fixture({ capture: false });
  f.workers[3].dispatchedAt = 3000; f.workers[4].dispatchedAt = 3000;
  const verdict = JSON.parse(f.workers[5].result);
  verdict.reviewedRunIds = [f.workers[2].runId]; f.workers[5].result = JSON.stringify(verdict);
  f.save();
  f.workers.forEach((worker, i) => captureNativeWorkerResult({ project: f.project, harness: 'codex', worker },
    i === 6 ? 6000 : i >= 3 ? 4000 : 2000));
  assert.equal((await f.execute()).status, 'DONE');
  f.workers[6].dispatchedAt = 3500; f.save();
  assert.equal((await f.execute()).status, 'PARTIAL', 'auditor still waits for test, QA and review');
});

test('post-audit scoped tracker closure requires fresh readback and cannot hide late creation', async () => {
  for (const operations of [['read', 'move-task', 'update-task'], ['create-task'], ['read']]) {
    const f = fixture();
    const tracker = { ...f.workers[0], role: 'task-manager', runId: runId(20), processId: 20,
      sessionId: 'tracker-close', dispatchedAt: 6100, taskavelAuthorization: {
        projectName: 'Demo', taskIds: [41], operations, externalWriteAuthorized: true,
      } };
    f.workers.push(tracker); f.report.workerRunIds.push(tracker.runId); f.save();
    captureNativeWorkerResult({ project: f.project, harness: 'codex', worker: tracker }, 6500);
    f.report.taskavel = 'synced';
    f.report.trackerReconciliation = { projectId: 'name:Demo', checkedAt: 7000,
      requiredTasks: [{ taskId: '41', doneColumnId: 'name:Done', claimedComplete: true,
        lastUpdateAttemptAt: 6400, proof: { accepted: true, evidenceIds: ['audit-proof'] } }], snapshots: [] };
    const execute = completed => finalizeNativeWorkerReport({ project: f.project, harness: 'codex', report: f.report }, {
      collect: ({ runId }) => f.workers.find(worker => worker.runId === runId), now: () => 7000,
      reconcileTracker: async () => ({ projectId: 'name:Demo', checkedAt: 7000, snapshots: [{
        projectId: 'name:Demo', taskId: '41', columnId: 'name:Done', completed, readAt: 6900,
      }] }),
    });
    assert.equal((await execute(true)).status, operations.includes('create-task') ? 'PARTIAL' : 'DONE');
    assert.equal((await execute(false)).status, 'PARTIAL');
    assert.equal((await f.execute()).status, 'PARTIAL', 'caller cannot replace authenticated readback');
  }
});
test('legacy chronology, missing required roles and incomplete workers cannot claim DONE', async () => {
  const legacy = fixture({ capture: false }); assert.equal((await legacy.execute()).status, 'PARTIAL');
  for (const index of [0, 1, 2, 3, 4, 5, 6]) {
    const f = fixture(); f.report.workerRunIds.splice(index, 1);
    assert.equal((await f.execute()).status, 'PARTIAL');
  }
  const incomplete = fixture(); incomplete.workers[2].complete = false;
  assert.equal((await incomplete.execute()).status, 'PARTIAL');
});
test('changed evidence, foreign identity and duplicate native sessions are rejected', async () => {
  const changed = fixture(); changed.workers[5].result = JSON.stringify({ verdict: 'APPROVED' });
  await assert.rejects(changed.execute(), /changed after capture/);
  const foreign = fixture(); foreign.workers[0].project = '/foreign';
  await assert.rejects(foreign.execute(), /identity/);
  const duplicate = fixture(); duplicate.workers[1].sessionId = duplicate.workers[0].sessionId;
  await assert.rejects(duplicate.execute(), /identity/);
});
test('tracker claim must reconcile and unrelated latest report remains untouched', async () => {
  const f = fixture(); f.report.taskavel = 'synced';
  const latest = path.join(f.project, '.agent-orchestra/runs/latest.json');
  fs.writeFileSync(latest, '{"user":"keep"}');
  const result = await f.execute();
  assert.equal(result.status, 'PARTIAL'); assert.equal(result.latestUpdated, false);
  assert.equal(fs.readFileSync(latest, 'utf8'), '{"user":"keep"}');
});
test('negative and overflow native counts never manufacture totals', async () => {
  const f = fixture(); f.workers[0].tokens = { input: -1, output: 2, total: 1 };
  const result = await f.execute(); assert.equal(result.totals.tokens, null);
  assert.equal(result.agents[0].tokens, null);
  const overflow = fixture();
  overflow.workers.forEach(worker => { worker.tokens = { input: Number.MAX_SAFE_INTEGER, output: 0, total: Number.MAX_SAFE_INTEGER }; });
  assert.equal((await overflow.execute()).totals.tokens, null);
});

test('final audit preserves validated optional Codex cache detail without changing totals or cost', async () => {
  const f = fixture(); f.workers[0].tokens = { input: 903323, output: 9280, total: 912603, cachedInput: 780544, uncachedInput: 122779 };
  const result = await f.execute(); assert.deepEqual(result.agents[0].tokens, f.workers[0].tokens);
  assert.equal(result.agents[0].cost, null); assert.match(result.accounting, /not unique prompt size or a full-price charge/);
  for (const detail of [{ cachedInput: -1, uncachedInput: 2 }, { cachedInput: 2, uncachedInput: 0 },
    { cachedInput: 0, uncachedInput: 99 }, { cachedInput: Number.MAX_SAFE_INTEGER + 1, uncachedInput: 0 }, {}]) {
    const invalid = fixture(); invalid.workers[0].tokens = { input: 1, output: 2, total: 3, ...detail };
    assert.deepEqual((await invalid.execute()).agents[0].tokens, { input: 1, output: 2, total: 3 });
  }
});
test('review categories, chronology, omitted repairs and acceptance proof fail closed', async () => {
  const captureAll = f => f.workers.forEach((worker, i) => captureNativeWorkerResult({ project: f.project, harness: 'codex', worker }, i === 5 ? 4000 : i === 6 ? 6000 : 2000));
  for (const category of ['security', 'performance']) {
    const f = fixture({ capture: false }), verdict = JSON.parse(f.workers[5].result);
    verdict[category].status = 'FAIL'; f.workers[5].result = JSON.stringify(verdict); captureAll(f);
    assert.equal((await f.execute()).status, 'PARTIAL');
  }
  const proof = fixture({ capture: false });
  const verdict = JSON.parse(proof.workers[6].result); verdict.proof = [];
  proof.workers[6].result = JSON.stringify(verdict); captureAll(proof);
  assert.equal((await proof.execute()).status, 'PARTIAL');
  for (const index of [5, 6]) {
    const f = fixture(); f.workers[index].dispatchedAt = 1000; f.save();
    assert.equal((await f.execute()).status, 'PARTIAL');
    delete f.workers[index].dispatchedAt; f.save();
    assert.equal((await f.execute()).status, 'PARTIAL');
  }
  const repair = fixture();
  const late = { ...repair.workers[2], runId: runId(20), processId: 20, sessionId: 'repair', dispatchedAt: 6500 };
  fs.writeFileSync(path.join(repair.project, '.agent-orchestra/dispatch', `native-${late.runId}.json`), JSON.stringify(late));
  const result = await repair.execute();
  assert.equal(result.status, 'PARTIAL'); assert.match(result.blockers.join(' '), /omitted/);
});
test('MCP finalization uses the real report helper and rejects arbitrary metrics', async () => {
  const f = fixture();
  const handle = createWorkerMcpHandler({ project: f.project, harness: 'codex' }, { api: {
    collectNativeSoloWorkerResult: ({ runId }) => f.workers.find(w => w.runId === runId),
  } });
  await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const request = args => handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'worker_report', arguments: args } });
  assert.equal((await request({ ...f.report, tokens: 0 })).error.code, -32602);
  const response = await request(f.report);
  assert.equal(response.result.isError, false);
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.status, 'DONE'); assert.equal(result.totals.cost, null);
  assert.equal(fs.existsSync(result.savedPath), true);
});

function repairedFixture({ lateWrite = false } = {}) {
  const f = fixture({ capture: false });
  const initialReview = f.workers[5], auditor = f.workers[6];
  initialReview.result = JSON.stringify({ verdict: 'CHANGES_REQUIRED',
    reviewedRunIds: f.workers.slice(2, 5).map(worker => worker.runId),
    security: { status: 'FAIL', evidence: ['Missing authorization on update'] },
    performance: { status: 'FAIL', evidence: ['Unbounded list query'] } });
  const add = (source, n, dispatchedAt) => {
    const worker = { ...source, runId: runId(n), processId: n, sessionId: `repair-session-${n}`, dispatchedAt };
    f.workers.push(worker); return worker;
  };
  const builder = add(f.workers[2], 8, 5000);
  builder.result = 'Added authorization and bounded query after initial review';
  const tester = add(f.workers[3], 9, 6500);
  tester.result = 'Repair regression tests passed';
  const qa = add(f.workers[4], 10, 6500);
  qa.result = 'Rechecked the repaired desktop and mobile journeys';
  const approvedReview = add(initialReview, 11, 8000);
  const late = lateWrite ? add(builder, 12, 9500) : null;
  // Include the late write in the claimed coverage: chronology, not omission,
  // must still invalidate an approval made before that write existed.
  approvedReview.result = JSON.stringify({ verdict: 'APPROVED',
    reviewedRunIds: f.workers.filter(worker => ['dev-builder', 'dev-tester', 'frontend-qa'].includes(worker.role)).map(worker => worker.runId),
    security: { status: 'PASS', evidence: ['Unauthorized update rejected after repair'] },
    performance: { status: 'PASS', evidence: ['Bounded query verified after repair'] } });
  auditor.dispatchedAt = 11000;
  auditor.result = JSON.stringify({ verdict: 'DONE', reviewRunId: approvedReview.runId,
    reviewedRunIds: f.workers.filter(worker => worker !== auditor).map(worker => worker.runId),
    proof: [{ criterionId: 'R1', result: 'passed', method: 'Independent repaired behavior check', evidence: ['Observed expected authorized behavior and bounded query'] }] });
  f.save();
  f.report.workerRunIds = f.workers.map(worker => worker.runId);
  const observed = new Map([[initialReview.runId, 4000], [builder.runId, 6000], [tester.runId, 7500],
    [qa.runId, 7500], [approvedReview.runId, 9000], [auditor.runId, 12000], ...(late ? [[late.runId, 10000]] : [])]);
  for (const worker of f.workers) captureNativeWorkerResult({ project: f.project, harness: 'codex', worker }, observed.get(worker.runId) ?? 2000);
  const execute = () => finalizeNativeWorkerReport({ project: f.project, harness: 'codex', report: f.report }, {
    collect: ({ runId }) => f.workers.find(worker => worker.runId === runId), now: () => 13000,
  });
  return { ...f, execute, initialReview, approvedReview, auditor, late };
}

test('complete repair and independent re-review can finish without discarding rejected review history or usage', async () => {
  const f = repairedFixture();
  const capturePath = path.join(f.project, '.agent-orchestra/runs/native-results', `${f.initialReview.runId}.json`);
  const originalCapture = fs.readFileSync(capturePath, 'utf8');
  const result = await f.execute();
  assert.equal(result.status, 'DONE', result.blockers.join('\n'));
  assert.deepEqual(result.blockers, []);
  assert.equal(result.review.runId, f.approvedReview.runId);
  assert.equal(result.auditorRunId, f.auditor.runId);
  assert.equal(result.agents.length, 11);
  assert.equal(result.totals.tokens, 33);
  assert.equal(result.totals.cost, null);
  assert.deepEqual(result.agents.find(agent => agent.runId === f.initialReview.runId).tokens, { input: 2, output: 1, total: 3 });
  assert.equal(fs.readFileSync(capturePath, 'utf8'), originalCapture);
  const initialReceipt = JSON.parse(fs.readFileSync(path.join(f.project, '.agent-orchestra/dispatch', `native-${f.initialReview.runId}.json`)));
  assert.equal(JSON.parse(initialReceipt.result).verdict, 'CHANGES_REQUIRED');
  const persisted = JSON.parse(fs.readFileSync(result.savedPath));
  assert.equal(persisted.agents.length, 11);
  assert.equal(persisted.totals.tokens, 33);
  assert.ok(persisted.review.reviewedRunIds.includes(runId(8)));
});

test('write after approved re-review remains PARTIAL even when review and auditor claim full run coverage', async () => {
  const f = repairedFixture({ lateWrite: true }), result = await f.execute();
  assert.equal(result.status, 'PARTIAL');
  assert.match(result.blockers.join(' '), /review with evidence after all builder writes is missing/);
  assert.equal(result.review, null);
  assert.equal(result.auditorRunId, null);
  assert.equal(result.agents.length, 12);
  assert.equal(result.totals.tokens, 36);
  assert.ok(result.agents.some(agent => agent.runId === f.initialReview.runId));
  assert.ok(result.agents.some(agent => agent.runId === f.late.runId));
});

test('successful exited workers are terminal evidence but incomplete or running workers are not', async () => {
  const exited = fixture({ capture: false });
  exited.workers.forEach((worker, i) => {
    worker.state = 'exited';
    captureNativeWorkerResult({ project: exited.project, harness: 'codex', worker }, i === 5 ? 4000 : i === 6 ? 6000 : 2000);
  });
  exited.save();
  assert.equal((await exited.execute()).status, 'DONE');
  exited.workers[2].complete = false;
  assert.equal((await exited.execute()).status, 'PARTIAL');
  const running = fixture(); running.workers[2].state = 'running';
  assert.equal((await running.execute()).status, 'PARTIAL');
});

test('reported costs aggregate only complete finite nonnegative accounting without fabricated zero', async () => {
  const priced = fixture(); priced.workers.forEach(worker => { worker.cost = 0.125; });
  const result = await priced.execute();
  assert.equal(result.status, 'DONE');
  assert.equal(result.totals.cost, 0.875);
  assert.ok(result.agents.every(agent => agent.cost === 0.125));
  for (const unavailable of [undefined, null, -1, Infinity, NaN, '0.125']) {
    const f = fixture(); f.workers.forEach(worker => { worker.cost = 0.125; });
    f.workers[0].cost = unavailable;
    const audit = await f.execute();
    assert.equal(audit.status, 'DONE');
    assert.equal(audit.agents[0].cost, null);
    assert.equal(audit.totals.cost, null);
  }
  const overflow = fixture(); overflow.workers.forEach(worker => { worker.cost = Number.MAX_VALUE; });
  assert.equal((await overflow.execute()).totals.cost, null);
});
