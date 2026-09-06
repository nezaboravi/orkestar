import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTracker } from '../tracker-reconciliation.mjs';

const input = () => ({ projectId: 'project-7', checkedAt: 300,
  requiredTasks: [{ taskId: '42', doneColumnId: 'done-7', claimedComplete: true, lastUpdateAttemptAt: 200,
    proof: { accepted: true, evidenceIds: ['review-42'] } }],
  snapshots: [{ projectId: 'project-7', taskId: '42', columnId: 'done-7', completed: true, readAt: 250 }] });

test('fresh accepted tasks are tracker-DONE eligible but never overall acceptance', () => {
  const data = input(), before = structuredClone(data), result = reconcileTracker(data);
  assert.equal(result.doneEligible, true); assert.equal(result.trackerStatus, 'VERIFIED');
  assert.equal(result.status, 'PARTIAL'); assert.deepEqual(result.reasons, []);
  assert.deepEqual(data, before); assert.deepEqual(reconcileTracker(data), result);
});

test('completion flag and Done column must both independently pass', () => {
  for (const update of [{ completed: false }, { columnId: 'doing' }, { completed: 'true' }]) {
    const data = input(); Object.assign(data.snapshots[0], update);
    assert.equal(reconcileTracker(data).doneEligible, false);
  }
});

test('freshness rejects stale, future and invalid readbacks and attempt timestamps', () => {
  for (const readAt of [199, 301, null, '250', NaN, Infinity, -1]) {
    const data = input(); data.snapshots[0].readAt = readAt;
    assert.equal(reconcileTracker(data).doneEligible, false);
  }
  const exact = input(); exact.snapshots[0].readAt = 200;
  assert.equal(reconcileTracker(exact).doneEligible, true);
  const future = input(); future.requiredTasks[0].lastUpdateAttemptAt = 301;
  assert.equal(reconcileTracker(future).doneEligible, false);
});

test('proof is per task and remains accepted when another task or tracker check fails', () => {
  const data = input(); data.requiredTasks.push({ ...structuredClone(data.requiredTasks[0]), taskId: '43', proof: { accepted: false, evidenceIds: [] } });
  data.snapshots.push({ ...data.snapshots[0], taskId: '43' });
  const result = reconcileTracker(data);
  assert.equal(result.doneEligible, false); assert.equal(result.tasks[0].acceptedProof, true);
  assert.equal(result.tasks[0].doneEligible, true); assert.equal(result.tasks[1].acceptedProof, false);
  for (const proof of [{ accepted: true, evidenceIds: [] }, { accepted: false, evidenceIds: ['proof'] }, { accepted: true, evidenceIds: Array(1) }]) {
    const invalid = input(); invalid.requiredTasks[0].proof = proof;
    assert.equal(reconcileTracker(invalid).doneEligible, false);
  }
});

test('missing, duplicate and foreign identities never permit acceptance', () => {
  const variants = [data => { data.snapshots = []; }, data => { data.requiredTasks.push(data.requiredTasks[0]); },
    data => { data.snapshots.push(data.snapshots[0]); }, data => { data.snapshots[0].taskId = 'foreign'; },
    data => { delete data.requiredTasks[0].taskId; }, data => { data.requiredTasks[0].taskId = 42; },
    data => { data.requiredTasks = []; }, data => { data.requiredTasks[0].claimedComplete = false; }];
  for (const change of variants) { const data = input(); change(data); assert.equal(reconcileTracker(data).doneEligible, false); }
  assert.equal(reconcileTracker(null).doneEligible, false);
  assert.equal(reconcileTracker({ ...input(), overallResult: 'DONE' }).doneEligible, false);
});

test('project identity and bounded maximum snapshot age are enforced', () => {
  const foreign = input(); foreign.snapshots[0].projectId = 'other-project';
  assert.equal(reconcileTracker(foreign).doneEligible, false);
  const stale = input(); stale.checkedAt = 100000;
  assert.equal(reconcileTracker(stale).doneEligible, false);
  const fresh = input(); fresh.maxSnapshotAgeMs = 50;
  assert.equal(reconcileTracker(fresh).doneEligible, true);
  fresh.maxSnapshotAgeMs = 49;
  assert.equal(reconcileTracker(fresh).doneEligible, false);
  for (const maxSnapshotAgeMs of [0, -1, 300001, null, '60', Infinity]) {
    assert.equal(reconcileTracker({ ...input(), maxSnapshotAgeMs }).doneEligible, false);
  }
});
