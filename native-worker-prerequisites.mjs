import fs from 'node:fs';
import path from 'node:path';
import { normalizeWorkerOwnershipPath } from './native-worker-ownership.mjs';

export const WORKER_PREREQUISITE_ERRORS = Object.freeze({
  invalid: 'Invalid worker prerequisites',
  capability: 'Unsupported worker prerequisite capability',
  path: 'Invalid worker prerequisite path',
  missing: 'Worker prerequisite is missing',
  type: 'Worker prerequisite has the wrong type',
  symlink: 'Worker prerequisite path is unsafe',
  readable: 'Worker prerequisite is not host-readable',
  writable: 'Worker prerequisite is not host-writable',
  writeRole: 'Only project-write may declare writable dependencies',
  ownership: 'Writable dependency must be inside declared ownership',
  git: 'Worker metadata writes are not supported',
});

export class WorkerPrerequisiteError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

const fail = (message, details) => { throw new WorkerPrerequisiteError(message, details); };
const plainObject = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const within = (target, parent) => target === parent || target.startsWith(`${parent}/`);

function prerequisitePath(value, details) {
  try { return normalizeWorkerOwnershipPath(value); }
  catch { fail(WORKER_PREREQUISITE_ERRORS.path, details); }
}

function safeTarget(project, relative, details) {
  const target = path.join(project, relative);
  let current = project;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) fail(WORKER_PREREQUISITE_ERRORS.symlink, { ...details, reason: 'symlink' });
    } catch (error) {
      if (error instanceof WorkerPrerequisiteError) throw error;
      if (error?.code === 'ENOENT') fail(WORKER_PREREQUISITE_ERRORS.missing, { ...details, reason: 'missing' });
      fail(WORKER_PREREQUISITE_ERRORS.path, { ...details, reason: 'path' });
    }
  }
  return target;
}

function verifyEntry(project, entry, assignment, assignmentIndex, prerequisiteIndex, type) {
  const details = { assignmentIndex, prerequisiteGroup: type === 'dependency' ? 'dependencies' : 'inputs', prerequisiteIndex, reason: 'path' };
  if (!plainObject(entry) || Object.keys(entry).some(key => !['path', 'kind', 'access'].includes(key))
    || typeof entry.path !== 'string' || !['file', 'directory'].includes(entry.kind)
    || (type === 'dependency' && !['read', 'write'].includes(entry.access))) {
    fail(WORKER_PREREQUISITE_ERRORS.invalid, details);
  }
  const relative = prerequisitePath(entry.path, details);
  if (type === 'dependency' && entry.access === 'write' && relative.split('/').some(segment => segment.toLowerCase() === '.git')) {
    fail(WORKER_PREREQUISITE_ERRORS.git, { ...details, reason: 'git-metadata-write' });
  }
  const target = safeTarget(project, relative, details);
  let stat;
  try { stat = fs.statSync(target); } catch { fail(WORKER_PREREQUISITE_ERRORS.missing, { ...details, reason: 'missing' }); }
  if ((entry.kind === 'file' && !stat.isFile()) || (entry.kind === 'directory' && !stat.isDirectory())) {
    fail(WORKER_PREREQUISITE_ERRORS.type, { ...details, reason: 'kind' });
  }
  try {
    if (entry.kind === 'file') { const fd = fs.openSync(target, 'r'); fs.closeSync(fd); }
    else { const directory = fs.opendirSync(target); directory.closeSync(); }
  } catch { fail(WORKER_PREREQUISITE_ERRORS.readable, { ...details, reason: 'host-readable' }); }
  if (type === 'dependency' && entry.access === 'write') {
    if (assignment.profile !== 'project-write') fail(WORKER_PREREQUISITE_ERRORS.writeRole, { ...details, reason: 'write-role' });
    if (!assignment.ownership?.paths?.some(owner => within(relative, owner))) {
      fail(WORKER_PREREQUISITE_ERRORS.ownership, { ...details, reason: 'ownership' });
    }
    try { fs.accessSync(target, fs.constants.W_OK); }
    catch { fail(WORKER_PREREQUISITE_ERRORS.writable, { ...details, reason: 'host-writable' }); }
  }
}

/**
 * Deterministic host-side prerequisite validation. Host access proves only the
 * stated host condition; it never proves a native worker sandbox can use it.
 */
export function validateWorkerPrerequisites({ project, assignments }) {
  if (!path.isAbsolute(project ?? '') || !Array.isArray(assignments) || assignments.length > 6) {
    fail(WORKER_PREREQUISITE_ERRORS.invalid, { reason: 'declaration' });
  }
  for (const [assignmentIndex, assignment] of assignments.entries()) {
    const prerequisites = assignment.prerequisites;
    if (prerequisites === undefined) continue;
    if (!plainObject(prerequisites) || Object.keys(prerequisites).some(key => !['inputs', 'dependencies', 'capabilities'].includes(key))) {
      fail(WORKER_PREREQUISITE_ERRORS.invalid, { assignmentIndex, reason: 'declaration' });
    }
    for (const [group, entries] of [['inputs', prerequisites.inputs], ['dependencies', prerequisites.dependencies]]) {
      if (entries !== undefined && (!Array.isArray(entries) || entries.length > 32)) {
        fail(WORKER_PREREQUISITE_ERRORS.invalid, { assignmentIndex, prerequisiteGroup: group, reason: 'declaration' });
      }
    }
    if (prerequisites.capabilities !== undefined) {
      if (!Array.isArray(prerequisites.capabilities) || prerequisites.capabilities.length > 3
        || prerequisites.capabilities.some(capability => !['network', 'local-server', 'git-metadata-write'].includes(capability))) {
        fail(WORKER_PREREQUISITE_ERRORS.invalid, { assignmentIndex, reason: 'capability' });
      }
      if (prerequisites.capabilities.length) fail(WORKER_PREREQUISITE_ERRORS.capability, { assignmentIndex, prerequisiteGroup: 'capabilities', prerequisiteIndex: 0, capability: prerequisites.capabilities[0], reason: 'unsupported-capability' });
    }
    for (const [index, input] of (prerequisites.inputs ?? []).entries()) verifyEntry(project, input, assignment, assignmentIndex, index, 'input');
    for (const [index, dependency] of (prerequisites.dependencies ?? []).entries()) verifyEntry(project, dependency, assignment, assignmentIndex, index, 'dependency');
  }
  return assignments;
}
