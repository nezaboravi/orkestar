import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { taskavelProjectNames, assertUniqueTaskavelProject, bindTaskavelAssignment, readTaskavelBinding } from '../native-taskavel-binding.mjs';

test('native project listing parser rejects incomplete and malformed listings', () => {
  const response = 'Your projects (2):\n\n- Laravel RS [owner] | 3 members | Owner plan: Artisan\n- Demo [admin] | 1 members | Owner plan: Free';
  assert.deepEqual(taskavelProjectNames(response), ['Laravel RS', 'Demo']);
  assert.throws(() => taskavelProjectNames(response.replace('(2)', '(3)')));
  assert.throws(() => taskavelProjectNames({ isError: true, content: [{ type: 'text', text: response }] }));
});
test('name lookup requires exact unique result and creation requires absence', () => {
  assertUniqueTaskavelProject(['Laravel RS', 'Demo'], 'Demo');
  assertUniqueTaskavelProject(['Laravel RS'], 'Demo', true);
  for (const names of [['Demo', 'Demo'], ['Demo', 'Demo clone'], ['demo'], ['Laravel RS']]) assert.throws(() => assertUniqueTaskavelProject(names, 'Demo'));
  assert.throws(() => assertUniqueTaskavelProject(['Demo'], 'Demo', true));
});
test('binding pins creation intention to workspace contract and name before writes', () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'taskavel-binding-')));
  fs.mkdirSync(path.join(project, '.agent-orchestra/runtime'), { recursive: true });
  const contract = { id: 'contract-1', hash: 'hash-1' };
  const authorization = { projectId: null, projectName: 'Meetup Picks', operations: ['create-project'] };
  const input = { project, contract, authorization, names: ['Laravel RS'] };
  const created = bindTaskavelAssignment(input);
  assert.equal(created.projectId, 'name:Meetup Picks');
  assert.deepEqual(bindTaskavelAssignment(input), created);
  const taskInput = { ...input, names: ['Laravel RS', 'Meetup Picks'], authorization: { ...authorization, operations: ['create-task'] } };
  assert.deepEqual(bindTaskavelAssignment(taskInput), readTaskavelBinding(project));
  assert.throws(() => bindTaskavelAssignment({ ...taskInput, authorization: { ...taskInput.authorization, projectName: 'Laravel RS' } }), /binding mismatch/);
  assert.deepEqual(bindTaskavelAssignment({ ...taskInput, contract: { id: 'other', hash: 'other' } }), created);
  assert.throws(() => bindTaskavelAssignment({ ...input, names: ['Meetup Picks'] }));
});
