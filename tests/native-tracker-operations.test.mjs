import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskContract } from '../orchestra.mjs';
import { executeTrackerCloseout, validateTrackerCloseout } from '../native-tracker-operations.mjs';

const contract = () => createTaskContract({ schemaVersion: 1, goal: 'Bounded feature', required: [{ id: 'R1', text: 'Works' }],
  localDecisions: [], outOfScope: [], discoveryPolicy: 'report-only',
  changeSurface: { modules: [], fileKinds: [], migrationsAllowed: false, dependenciesAllowed: false, architectureChangesAllowed: false },
  trackerAuthorization: { projectName: 'Demo', taskIds: [41], operations: ['read', 'move-task', 'update-task', 'add-comment'], externalWriteAuthorized: true } });
const input = (overrides = {}) => ({ contract: contract(), auditor: { verdict: 'DONE' },
  reconciliation: { projectId: 'name:Demo', checkedAt: 100, snapshots: [], requiredTasks: [{ taskId: '41', doneColumnId: 'name:Done', claimedComplete: true, lastUpdateAttemptAt: 99,
    proof: { accepted: true, evidenceIds: ['audit-proof'] } }] },
  closeout: { authorization: { projectId: null, projectName: 'Demo', taskIds: [41], operations: ['read', 'move-task', 'update-task'], externalWriteAuthorized: true },
    tasks: [{ taskId: 41, doneColumnName: 'Done' }] }, ...overrides });

test('close-out uses only fixed move and complete calls after immutable authorization', async () => {
  const calls = [], result = await executeTrackerCloseout(input(), { now: (() => { let value = 100; return () => value++; })(),
    call: async (tool, args) => { calls.push({ tool, args }); return { content: [{ type: 'text', text: 'ok' }] }; } });
  assert.deepEqual(calls, [
    { tool: 'update-task-tool', args: { task_id: 41, mark_complete: 'true' } },
    { tool: 'move-task-to-column-tool', args: { task_id: 41, column_name: 'Done' } },
  ]);
  assert.equal(result.projectId, 'name:Demo');
  assert.deepEqual(result.receipts, [{ taskId: '41', completedAt: 101, movedAt: 102 }]);
});

test('close-out fails closed for missing authorization, foreign tasks, early audit, and failed transport', async () => {
  for (const value of [
    input({ auditor: { verdict: 'PARTIAL' } }),
    input({ closeout: { authorization: { projectId: null, projectName: 'Demo', taskIds: [41], operations: ['read', 'move-task', 'update-task'], externalWriteAuthorized: false }, tasks: [{ taskId: 41, doneColumnName: 'Done' }] } }),
    input({ closeout: { authorization: { projectId: null, projectName: 'Demo', taskIds: [42], operations: ['read', 'move-task', 'update-task'], externalWriteAuthorized: true }, tasks: [{ taskId: 42, doneColumnName: 'Done' }] } }),
    input({ closeout: { authorization: { projectId: null, projectName: 'Other', taskIds: [41], operations: ['read', 'move-task', 'update-task'], externalWriteAuthorized: true }, tasks: [{ taskId: 41, doneColumnName: 'Done' }] } }),
  ]) assert.throws(() => validateTrackerCloseout(value));
  const calls = [];
  await assert.rejects(executeTrackerCloseout(input(), { now: () => 100, call: async tool => { calls.push(tool); return { isError: true }; } }), /completion failed/);
  assert.deepEqual(calls, ['update-task-tool']);
});

test('malformed, duplicate, false, future, or stale reconciliation proof makes zero calls', async () => {
  for (const override of [
    { requiredTasks: [input().reconciliation.requiredTasks[0], input().reconciliation.requiredTasks[0]] },
    { requiredTasks: [{ ...input().reconciliation.requiredTasks[0], claimedComplete: false }] },
    { requiredTasks: [{ ...input().reconciliation.requiredTasks[0], proof: { accepted: false, evidenceIds: [] } }] },
    { requiredTasks: [{ ...input().reconciliation.requiredTasks[0], lastUpdateAttemptAt: 101 }] },
    { checkedAt: 1, requiredTasks: [{ ...input().reconciliation.requiredTasks[0], lastUpdateAttemptAt: 1 }] },
  ]) {
    const calls = [];
    await assert.rejects(executeTrackerCloseout(input({ reconciliation: { ...input().reconciliation, ...override } }), {
      now: () => 400000, call: async tool => { calls.push(tool); return {}; },
    }), /Invalid tracker reconciliation|Duplicate/);
    assert.deepEqual(calls, []);
  }
});

test('a move failure follows completion but stops the mutation chain', async () => {
  const calls = [];
  await assert.rejects(executeTrackerCloseout(input(), { now: () => 100,
    call: async tool => { calls.push(tool); return tool === 'move-task-to-column-tool' ? { isError: true } : {}; },
  }), /move failed/);
  assert.deepEqual(calls, ['update-task-tool', 'move-task-to-column-tool']);
});
