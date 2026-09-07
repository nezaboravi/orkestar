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
  git: 'Worker metadata writes are not supported',
});

export class WorkerOwnershipError extends Error {
  constructor(message, details) { super(message); this.details = details; }
}
const fail = (message, details) => { throw new WorkerOwnershipError(message, details); };

const plainObject = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

export function normalizeWorkerOwnershipPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH
    || value !== value.trim() || CONTROL_CHARACTERS.test(value)) {
    fail(WORKER_OWNERSHIP_ERRORS.path, { reason: 'path' });
  }
  if (value.startsWith('/') || value.startsWith('\\') || WINDOWS_ABSOLUTE.test(value)
    || value.includes('\\')) {
    fail(WORKER_OWNERSHIP_ERRORS.relative, { reason: 'project-relative' });
  }

  const rawSegments = value.split('/');
  if (rawSegments.includes('..')) fail(WORKER_OWNERSHIP_ERRORS.relative, { reason: 'project-relative' });
  if (GLOB_CHARACTERS.test(value)) fail(WORKER_OWNERSHIP_ERRORS.broad, { reason: 'broad' });

  const normalized = path.posix.normalize(value.normalize('NFC')).replace(/\/+$/, '');
  if (normalized === '.' || normalized === '' || normalized === '..'
    || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    fail(WORKER_OWNERSHIP_ERRORS.broad, { reason: 'broad' });
  }
  return normalized;
}

function normalizedDeclaration(declaration, required, writer) {
  if (declaration === undefined) {
    if (required) fail(WORKER_OWNERSHIP_ERRORS.required, { reason: 'required' });
    return undefined;
  }
  if (!plainObject(declaration) || Object.keys(declaration).length !== 1
    || !Object.hasOwn(declaration, 'paths') || !Array.isArray(declaration.paths)
    || declaration.paths.length === 0 || declaration.paths.length > MAX_PATHS) {
    fail(WORKER_OWNERSHIP_ERRORS.declaration, { reason: 'declaration' });
  }
  const originalIndexes = new Map();
  const paths = [...new Set(declaration.paths.map((value, pathIndex) => {
    try { return normalizeWorkerOwnershipPath(value); }
    catch (error) {
      if (error instanceof WorkerOwnershipError) error.details = { pathIndex, ...error.details };
      throw error;
    }
  }).map((value, pathIndex) => {
    if (!originalIndexes.has(value)) originalIndexes.set(value, pathIndex);
    return value;
  }))];
  if (paths.length === 0) fail(WORKER_OWNERSHIP_ERRORS.declaration, { reason: 'declaration' });
  const metadataPathIndex = writer ? paths.findIndex(value => value.split('/').some(segment => segment.toLowerCase() === '.git')) : -1;
  if (metadataPathIndex !== -1) fail(WORKER_OWNERSHIP_ERRORS.git, { pathIndex: originalIndexes.get(paths[metadataPathIndex]), reason: 'git-metadata-write' });
  const ownership = { paths };
  Object.defineProperty(ownership, 'pathIndexes', { value: paths.map(value => originalIndexes.get(value)), enumerable: false });
  return ownership;
}

/** Normalize one assignment; single dispatches may omit ownership. */
export function normalizeWorkerOwnership(assignment, required = false) {
  if (!plainObject(assignment) || !plainObject(assignment.task)) fail(WORKER_OWNERSHIP_ERRORS.assignments, { reason: 'assignment' });
  const ownership = normalizedDeclaration(assignment.ownership, required, assignment.profile === 'project-write');
  return ownership === undefined ? { ...assignment } : { ...assignment, ownership };
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
    fail(WORKER_OWNERSHIP_ERRORS.assignments, { reason: 'assignments' });
  }

  const normalized = assignments.map((assignment, assignmentIndex) => {
    try { return normalizeWorkerOwnership(assignment, assignment.profile === 'project-write'); }
    catch (error) {
      if (error instanceof WorkerOwnershipError) {
        error.details = { assignmentIndex, ...error.details };
      }
      throw error;
    }
  });

  const writers = normalized.map((assignment, assignmentIndex) => ({ assignment, assignmentIndex }))
    .filter(({ assignment }) => assignment.profile === 'project-write');
  for (let leftIndex = 0; leftIndex < writers.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < writers.length; rightIndex++) {
      const left = writers[leftIndex].assignment, right = writers[rightIndex].assignment;
      if (left.ownership.paths.some(leftPath => right.ownership.paths.some(rightPath => overlaps(leftPath, rightPath)))) {
        const normalizedPathIndex = right.ownership.paths.findIndex(rightPath => left.ownership.paths.some(leftPath => overlaps(leftPath, rightPath)));
        fail(WORKER_OWNERSHIP_ERRORS.overlap, { assignmentIndex: writers[rightIndex].assignmentIndex, pathIndex: right.ownership.pathIndexes[normalizedPathIndex], reason: 'overlap' });
      }
    }
  }
  return normalized;
}
