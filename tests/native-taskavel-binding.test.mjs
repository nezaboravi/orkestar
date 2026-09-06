import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { taskavelProjectNames, assertUniqueTaskavelProject, bindTaskavelAssignment, readTaskavelBinding } from '../native-taskavel-binding.mjs';
import { createTaskContract } from '../orchestra.mjs';

const contract = (trackerAuthorization = undefined) => createTaskContract({ schemaVersion: 1, goal: 'Bind Taskavel', required: [{ id: 'R1', text: 'Close the authorized card' }],
  localDecisions: [], outOfScope: [], discoveryPolicy: 'report-only',
  changeSurface: { modules: [], fileKinds: [], migrationsAllowed: false, dependenciesAllowed: false, architectureChangesAllowed: false },
  ...(trackerAuthorization ? { trackerAuthorization } : {}) });

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
  const taskContract = contract();
  const authorization = { projectId: null, projectName: 'Meetup Picks', operations: ['create-project'] };
  const input = { project, contract: taskContract, authorization, names: ['Laravel RS'] };
  const created = bindTaskavelAssignment(input);
  assert.equal(created.projectId, 'name:Meetup Picks');
  assert.deepEqual(bindTaskavelAssignment(input), created);
  const taskInput = { ...input, names: ['Laravel RS', 'Meetup Picks'], authorization: { ...authorization, operations: ['create-task'] } };
  assert.deepEqual(bindTaskavelAssignment(taskInput), readTaskavelBinding(project));
  assert.throws(() => bindTaskavelAssignment({ ...taskInput, authorization: { ...taskInput.authorization, projectName: 'Laravel RS' } }), /binding mismatch/);
  const laterContract = createTaskContract({ schemaVersion: 1, goal: 'Later Taskavel task', required: [{ id: 'R1', text: 'Keep the existing binding' }],
    localDecisions: [], outOfScope: [], discoveryPolicy: 'report-only',
    changeSurface: { modules: [], fileKinds: [], migrationsAllowed: false, dependenciesAllowed: false, architectureChangesAllowed: false } });
  assert.deepEqual(bindTaskavelAssignment({ ...taskInput, contract: laterContract }), created);
  assert.throws(() => bindTaskavelAssignment({ ...input, names: ['Meetup Picks'] }));
});

test('a fresh existing-project binding requires exact immutable close-out authorization and unique native project proof', () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'taskavel-existing-binding-')));
  fs.mkdirSync(path.join(project, '.agent-orchestra/runtime'), { recursive: true });
  const authorization = { projectId: null, projectName: 'Coding Wisely', taskIds: [9098], operations: ['read', 'update-task', 'move-task'], externalWriteAuthorized: true };
  const immutable = contract({ projectName: 'Coding Wisely', taskIds: [9098], operations: ['read', 'update-task', 'move-task'], externalWriteAuthorized: true });
  const bound = bindTaskavelAssignment({ project, contract: immutable, authorization, names: ['Coding Wisely'] });
  assert.equal(bound.projectId, 'name:Coding Wisely');
  assert.deepEqual(readTaskavelBinding(project), bound);
  for (const override of [
    { contract: contract() },
    { contract: contract({ projectName: 'Coding Wisely', taskIds: [9099], operations: ['read', 'update-task', 'move-task'], externalWriteAuthorized: true }) },
    { authorization: { ...authorization, taskIds: [9099] } },
    { authorization: { ...authorization, operations: ['read', 'update-task'] } },
    { authorization: { ...authorization, externalWriteAuthorized: false } },
    { names: ['Coding Wisely', 'Coding Wisely clone'] },
    { names: ['coding wisely'] },
  ]) assert.throws(() => bindTaskavelAssignment({ project: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'taskavel-existing-binding-fail-'))),
    contract: immutable, authorization, names: ['Coding Wisely'], ...override }));
});
