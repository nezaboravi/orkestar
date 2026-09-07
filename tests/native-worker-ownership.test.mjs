import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWaveOwnership, WORKER_OWNERSHIP_ERRORS } from '../native-worker-ownership.mjs';

const assignment = (name, paths, requiresWrite = true) => ({
  name,
  profile: requiresWrite ? 'project-write' : 'project-read',
  task: { goal: `${name} outcome`, requiresWrite },
  ...(paths === undefined ? {} : { ownership: { paths } }),
});

test('ordinary disjoint writers receive normalized project-relative ownership', () => {
  const input = [
    assignment('Backend', ['./app//Models', 'app/Http/Controllers']),
    assignment('Frontend', ['resources/views', 'resources/js']),
    assignment('Reader', undefined, false),
  ];
  const result = validateWaveOwnership(input);
  assert.deepEqual(result[0].ownership.paths, ['app/Models', 'app/Http/Controllers']);
  assert.deepEqual(result[1].ownership.paths, ['resources/views', 'resources/js']);
  assert.equal(Object.hasOwn(result[2], 'ownership'), false);
  assert.notEqual(result, input);
  assert.deepEqual(input[0].ownership.paths, ['./app//Models', 'app/Http/Controllers']);
});

test('duplicate and parent-child ownership across concurrent writers is rejected', () => {
  for (const paths of [
    [['app/Models'], ['app/Models']],
    [['resources/views'], ['resources/views/components']],
    [['database/factories/UserFactory.php'], ['database/factories']],
    [['resources/views'], ['Resources/Views']],
    [['Resources/Views'], ['resources/views/components']],
    [['resources/caf\u00e9'], ['resources/cafe\u0301/components']],
  ]) {
    assert.throws(
      () => validateWaveOwnership([assignment('First', paths[0]), assignment('Second', paths[1])]),
      error => error.message === WORKER_OWNERSHIP_ERRORS.overlap,
    );
  }
});

test('writable assignments require a non-empty bounded declaration while readers may omit it', () => {
  assert.throws(
    () => validateWaveOwnership([assignment('Writer', undefined), assignment('Reader', undefined, false)]),
    error => error.message === WORKER_OWNERSHIP_ERRORS.required,
  );
  for (const ownership of [{ paths: [] }, { paths: ['app'], extra: true }, ['app']]) {
    const writer = assignment('Writer', ['app']); writer.ownership = ownership;
    assert.throws(
      () => validateWaveOwnership([writer, assignment('Reader', undefined, false)]),
      error => error.message === WORKER_OWNERSHIP_ERRORS.declaration,
    );
  }
  assert.doesNotThrow(() => validateWaveOwnership([
    assignment('Reader one', undefined, false), assignment('Reader two', undefined, false),
  ]));
});

test('absolute, traversal, control-character, root and glob paths are rejected safely', () => {
  const unsafe = [
    ['/etc/passwd', WORKER_OWNERSHIP_ERRORS.relative],
    ['C:/Users/example/project', WORKER_OWNERSHIP_ERRORS.relative],
    ['..\\outside', WORKER_OWNERSHIP_ERRORS.relative],
    ['app/../secrets', WORKER_OWNERSHIP_ERRORS.relative],
    ['app\\Models', WORKER_OWNERSHIP_ERRORS.relative],
    ['.', WORKER_OWNERSHIP_ERRORS.broad],
    ['./', WORKER_OWNERSHIP_ERRORS.broad],
    ['**', WORKER_OWNERSHIP_ERRORS.broad],
    ['resources/{views,js}', WORKER_OWNERSHIP_ERRORS.broad],
    ['app/Models\nInjected', WORKER_OWNERSHIP_ERRORS.path],
    [' app/Models', WORKER_OWNERSHIP_ERRORS.path],
  ];
  for (const [value, message] of unsafe) {
    assert.throws(
      () => validateWaveOwnership([assignment('Writer', [value]), assignment('Reader', undefined, false)]),
      error => error.message === message,
      value,
    );
  }
});

test('the wave and each ownership declaration are bounded', () => {
  assert.throws(() => validateWaveOwnership([assignment('Only', ['app'])]),
    error => error.message === WORKER_OWNERSHIP_ERRORS.assignments);
  assert.throws(() => validateWaveOwnership(Array.from({ length: 7 }, (_, index) => assignment(`Writer ${index}`, [`area-${index}`]))),
    error => error.message === WORKER_OWNERSHIP_ERRORS.assignments);
  assert.throws(() => validateWaveOwnership([
    assignment('Writer', Array.from({ length: 33 }, (_, index) => `area-${index}`)),
    assignment('Reader', undefined, false),
  ]), error => error.message === WORKER_OWNERSHIP_ERRORS.declaration);
});

test('read-only ownership may describe Git metadata while writers cannot own it', () => {
  assert.doesNotThrow(() => validateWaveOwnership([
    assignment('Reader', ['.git/HEAD'], false), assignment('Other reader', undefined, false),
  ]));
  for (const path of ['.git', '.GIT/worktrees/pr406', '.agent-orchestra/prepared/.Git/config']) {
    assert.throws(() => validateWaveOwnership([assignment('Writer', [path]), assignment('Reader', undefined, false)]),
      error => error.message === WORKER_OWNERSHIP_ERRORS.git);
  }
  assert.throws(() => validateWaveOwnership([
    assignment('Writer', ['safe/path', 'safe/path', '.GIT/objects']), assignment('Reader', undefined, false),
  ]), error => error.message === WORKER_OWNERSHIP_ERRORS.git && error.details?.pathIndex === 2);
});
