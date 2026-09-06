import test from 'node:test';
import assert from 'node:assert/strict';
import { reportTrackerGate } from '../report-tracker-gate.mjs';
const packet = () => ({ projectId: 'p', checkedAt: 200000,
  requiredTasks: [{ taskId: 't', doneColumnId: 'd', claimedComplete: true, lastUpdateAttemptAt: 199900,
    proof: { accepted: true, evidenceIds: ['proof'] } }],
  snapshots: [{ projectId: 'p', taskId: 't', columnId: 'd', completed: true, readAt: 199950 }] });
test('final gate requires fresh typed packet for synced DONE and uses runtime time', () => {
  assert.throws(() => reportTrackerGate({ status: 'DONE', taskavel: 'synced' }, 200000));
  const args = { status: 'DONE', taskavel: 'synced', trackerReconciliation: packet() };
  assert.equal(reportTrackerGate(args, 200000).doneEligible, true);
  assert.throws(() => reportTrackerGate(args, 400000));
  assert.throws(() => reportTrackerGate(args, 100000));
  assert.equal(reportTrackerGate({ status: 'DONE', taskavel: 'not-requested' }, 200000), null);
});
test('partial reports retain accepted individual evidence without overall approval', () => {
  const p = packet(); p.snapshots[0].completed = false;
  const result = reportTrackerGate({ status: 'PARTIAL', taskavel: 'synced', trackerReconciliation: p }, 200000);
  assert.equal(result.doneEligible, false); assert.equal(result.tasks[0].acceptedProof, true);
  assert.deepEqual(result.packet, p);
  const invalid = reportTrackerGate({ status: 'PARTIAL', taskavel: 'synced', trackerReconciliation: { ...p, arbitrary: 'PRIVATE' } }, 200000);
  assert.equal(invalid.packet, null); assert.equal(JSON.stringify(invalid).includes('PRIVATE'), false);
});
