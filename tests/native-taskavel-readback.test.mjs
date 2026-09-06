import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTaskavelReadback, taskavelMembershipContains } from '../native-taskavel-readback.mjs';

// Synthetic project and task identifiers; no customer tracker data.
const input = () => ({ projectId: 100, taskId: 900000003, readAt: 10000,
  membership: 'Filtered tasks (1):\n\n#9 Audit synthetic sample — Example Project / In Progress [open]\n  id: 900000003 | https://taskavel.com/tasks/900000003',
  details: '# Audit synthetic sample\nProject: Example Project #9\nStatus: Open\nColumn: In Progress\n\n## Description\nPrivate body is not returned\n\nLink: https://taskavel.com/tasks/900000003' });

test('name-bound details verify the exact project label without guessing its numeric ID', () => {
  const f = { ...input(), projectId: null, projectName: 'Example Project' };
  assert.equal(normalizeTaskavelReadback(f).snapshot.projectId, 'name:Example Project');
  assert.equal(normalizeTaskavelReadback({ ...f, projectName: 'Example' }).snapshot, null);
  assert.equal(normalizeTaskavelReadback({ ...f, projectName: 'Other Example' }).snapshot, null);
});

test('verified text produces namespaced columns and separate completion without guessing project suffix', () => {
  const actual = normalizeTaskavelReadback(input());
  assert.deepEqual(actual.snapshot, { projectId: '100', taskId: '900000003', columnId: 'name:In Progress', completed: false, readAt: 10000 });
  assert.deepEqual(actual.blockers, []);
  assert.equal(actual.observed.projectLabel, 'Example Project #9');
  assert.equal(JSON.stringify(actual).includes('Private body'), false);
  const completed = input(); completed.details = completed.details.replace('Status: Open', 'Status: Completed').replace('Column: In Progress', 'Column: Done');
  assert.equal(normalizeTaskavelReadback(completed).snapshot.completed, true);
  // Completion is read from task details, never inferred from the column name.
  completed.details = completed.details.replace('Status: Completed', 'Status: Open');
  assert.equal(normalizeTaskavelReadback(completed).snapshot.completed, false);
});

test('raw MCP result is accepted only as one successful text block', () => {
  const f = input();
  for (const key of ['details', 'membership']) f[key] = { content: [{ type: 'text', text: f[key] }], isError: false };
  assert.ok(normalizeTaskavelReadback(f).snapshot);
  f.details.isError = true; assert.equal(normalizeTaskavelReadback(f).snapshot, null);
  f.details.isError = false; f.details.content.push(f.details.content[0]);
  assert.equal(normalizeTaskavelReadback(f).snapshot, null);
});

test('multi-task membership uses the verified contiguous two-line record format before details are fetched', () => {
  const membership = 'Filtered tasks (2):\n\n#10 Plan synthetic delivery — Example Project / Review & QA [open]\n  id: 900000004 | https://taskavel.com/tasks/900000004\n#8 Review synthetic repair — Example Project / Review & QA [open]\n  id: 900000002 | https://taskavel.com/tasks/900000002';
  assert.equal(taskavelMembershipContains(membership, 900000002), true);
  assert.equal(taskavelMembershipContains(membership, 900000004), true);
  assert.equal(taskavelMembershipContains(membership, 900000003), false);
  assert.equal(taskavelMembershipContains(membership.replace('delivery', 'delivery\n  id: 900000003 | https://taskavel.com/tasks/900000003'), 900000003), false);
  assert.equal(taskavelMembershipContains(membership.replaceAll('900000002', '900000004'), 900000004), false);
});

test('membership accepts bounded bracket display labels only after the canonical status marker', () => {
  const membership = 'Filtered tasks (2):\n\n#10 Plan synthetic delivery — Example Project / Review & QA [open] [Low Priority]\n  id: 900000004 | https://taskavel.com/tasks/900000004\n#8 Review synthetic repair — Example Project / Review & QA [completed] [codex]\n  id: 900000002 | https://taskavel.com/tasks/900000002';
  assert.equal(taskavelMembershipContains(membership, 900000004), true);
  assert.equal(taskavelMembershipContains(membership, 900000002), true);
  for (const malformed of [
    membership.replace('[open] [Low Priority]', '[Low Priority]'),
    membership.replace('[open] [Low Priority]', '[open] Low Priority'),
    membership.replace('[completed] [codex]', '[completed] []'),
    membership.replace('[completed] [codex]', '[completed] [codex] trailing'),
  ]) assert.equal(taskavelMembershipContains(malformed, 900000004), false);
});

test('missing, mismatched, duplicate and malformed membership never manufacture project identity', () => {
  for (const mutate of [
    f => { f.membership = f.membership.replaceAll('900000003', '900000004'); },
    f => { f.membership = f.membership.replace('id: 900000003', 'id: 900000004'); },
    f => { f.membership = f.membership.replace('Filtered tasks (1)', 'Filtered tasks (2)'); },
    f => { f.membership = f.membership.replace('(1)', '(2)') + '\n\n' + f.membership.split('\n\n')[1]; },
    f => { f.membership += '\n  id: 900000003 | https://taskavel.com/tasks/900000003'; },
    f => { f.membership = 'No tasks found.'; },
    f => { f.projectId = '100'; }, f => { f.taskId = 0; }, f => { f.readAt = Infinity; },
  ]) { const f = input(); mutate(f); assert.equal(normalizeTaskavelReadback(f).snapshot, null); }
});

test('unknown statuses, body-spoofed metadata, wrong links and oversized/control text fail closed', () => {
  for (const mutate of [
    f => { f.details = f.details.replace('Status: Open', 'Status: Done'); },
    f => { f.details = f.details.replace('Status: Open', 'Status: Open\nStatus: Completed'); },
    f => { f.details = f.details.replace('Column: In Progress', '').replace('Private body', 'Column: Done\nPrivate body'); },
    f => { f.details = f.details.replace('/tasks/900000003', '/tasks/900000004'); },
    f => { f.details += '\nextra'; }, f => { f.details += '\u001b'; },
    f => { f.details = 'x'.repeat(262145); },
  ]) { const f = input(); mutate(f); assert.equal(normalizeTaskavelReadback(f).snapshot, null); }
});
