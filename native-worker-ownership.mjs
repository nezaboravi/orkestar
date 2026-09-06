import path from 'node:path';

const MAX_ASSIGNMENTS = 6;
const MAX_PATHS = 32;
const MAX_PATH_LENGTH = 240;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/;
const GLOB_CHARACTERS = /[*?[\]{}]/;
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:/;

export const WORKER_OWNERSHIP_ERRORS = Object.freeze({
  assignments: 'Invalid worker ownership assignments',
  declaration: 'Invalid worker ownership declaration',
  required: 'Writable wave assignment requires bounded ownership paths',
  path: 'Invalid worker ownership path',
  relative: 'Worker ownership path must be project-relative',
  broad: 'Worker ownership path is too broad',
  overlap: 'Concurrent worker ownership overlap',
});

const plainObject = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function normalizeOwnershipPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH
    || value !== value.trim() || CONTROL_CHARACTERS.test(value)) {
    throw new Error(WORKER_OWNERSHIP_ERRORS.path);
  }
  if (value.startsWith('/') || value.startsWith('\\') || WINDOWS_ABSOLUTE.test(value)
    || value.includes('\\')) {
    throw new Error(WORKER_OWNERSHIP_ERRORS.relative);
  }

  const rawSegments = value.split('/');
  if (rawSegments.includes('..')) throw new Error(WORKER_OWNERSHIP_ERRORS.relative);
  if (GLOB_CHARACTERS.test(value)) throw new Error(WORKER_OWNERSHIP_ERRORS.broad);

  const normalized = path.posix.normalize(value.normalize('NFC')).replace(/\/+$/, '');
  if (normalized === '.' || normalized === '' || normalized === '..'
    || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error(WORKER_OWNERSHIP_ERRORS.broad);
  }
  return normalized;
}

function normalizedDeclaration(declaration, required) {
  if (declaration === undefined) {
    if (required) throw new Error(WORKER_OWNERSHIP_ERRORS.required);
    return undefined;
  }
  if (!plainObject(declaration) || Object.keys(declaration).length !== 1
    || !Object.hasOwn(declaration, 'paths') || !Array.isArray(declaration.paths)
    || declaration.paths.length === 0 || declaration.paths.length > MAX_PATHS) {
    throw new Error(WORKER_OWNERSHIP_ERRORS.declaration);
  }
  const paths = [...new Set(declaration.paths.map(normalizeOwnershipPath))];
  if (paths.length === 0) throw new Error(WORKER_OWNERSHIP_ERRORS.declaration);
  return { paths };
}

function overlaps(left, right) {
  const leftKey = left.normalize('NFKC').toLowerCase();
  const rightKey = right.normalize('NFKC').toLowerCase();
  return leftKey === rightKey || leftKey.startsWith(`${rightKey}/`) || rightKey.startsWith(`${leftKey}/`);
}

/**
 * Validate and normalize the file ownership claimed by a concurrent worker wave.
 * The returned assignments are copies; caller-owned input is never mutated.
 */
export function validateWaveOwnership(assignments) {
  if (!Array.isArray(assignments) || assignments.length < 2 || assignments.length > MAX_ASSIGNMENTS) {
    throw new Error(WORKER_OWNERSHIP_ERRORS.assignments);
  }

  const normalized = assignments.map(assignment => {
    if (!plainObject(assignment) || !plainObject(assignment.task)) {
      throw new Error(WORKER_OWNERSHIP_ERRORS.assignments);
    }
    const ownership = normalizedDeclaration(assignment.ownership, assignment.profile === 'project-write');
    return ownership === undefined ? { ...assignment } : { ...assignment, ownership };
  });

  const writers = normalized.filter(assignment => assignment.profile === 'project-write');
  for (let leftIndex = 0; leftIndex < writers.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < writers.length; rightIndex++) {
      if (writers[leftIndex].ownership.paths.some(left => writers[rightIndex].ownership.paths.some(right => overlaps(left, right)))) {
        throw new Error(WORKER_OWNERSHIP_ERRORS.overlap);
      }
    }
  }
  return normalized;
}
