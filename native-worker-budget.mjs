import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_WORKER_SESSIONS } from './orchestra-limits.mjs';

const RECEIPT_PATTERN = /^native-[a-f0-9-]{36}\.json$/;
const CONTRACT_PATTERN = /^tc-[a-f0-9]{12}$/;
const MAX_RECORD_BYTES = 131072;
const MAX_RECORDS = 256;
const DEFAULT_STALE_MS = 30000;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_POLL_MS = 10;

export class NativeWorkerBudgetError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'NativeWorkerBudgetError';
    this.code = code;
  }
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    return true;
  }
}

function safeDirectory(directory, create = false) {
  if (create) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new NativeWorkerBudgetError('Unsafe worker budget directory', 'UNSAFE_BUDGET_PATH');
  }
  return directory;
}

function safeProject(project) {
  if (typeof project !== 'string' || !path.isAbsolute(project)) {
    throw new NativeWorkerBudgetError('Worker budget requires an absolute project path', 'UNSAFE_PROJECT');
  }
  const root = fs.realpathSync(project);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new NativeWorkerBudgetError('Unsafe worker budget project', 'UNSAFE_PROJECT');
  }
  return root;
}

function budgetDirectory(project, contractId) {
  let current = safeDirectory(project);
  for (const segment of ['.agent-orchestra', 'session-budget', contractId]) {
    current = safeDirectory(path.join(current, segment), true);
  }
  return current;
}

function readRecord(file, expectedDirectory) {
  if (path.dirname(file) !== expectedDirectory) {
    throw new NativeWorkerBudgetError('Unsafe worker budget record scope', 'UNSAFE_BUDGET_PATH');
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_RECORD_BYTES) {
    throw new NativeWorkerBudgetError('Unsafe worker budget record', 'UNSAFE_BUDGET_RECORD');
  }
  return { stat, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function writeCompleteTemporary(directory, prefix, value) {
  const file = path.join(directory, `${prefix}-${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new NativeWorkerBudgetError('Unsafe worker budget temporary record', 'UNSAFE_BUDGET_RECORD');
  }
  return file;
}

function tryAtomicRecord(directory, target, value) {
  const temporary = writeCompleteTemporary(directory, '.owner', value);
  try {
    fs.linkSync(temporary, target);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

function safeUnlinkOwned(file, directory, token) {
  let record;
  try { record = readRecord(file, directory); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (record.value?.token !== token) return false;
  fs.unlinkSync(file);
  return true;
}

function deadAndStale(record, now, staleMs) {
  return Number.isSafeInteger(record.value?.createdAt)
    && now - record.value.createdAt >= staleMs
    && !processIsAlive(record.value?.pid);
}

function durableReceiptCount(project, contractId) {
  const directory = path.join(project, '.agent-orchestra', 'dispatch');
  let directoryStat;
  try { directoryStat = fs.lstatSync(directory); }
  catch (error) { if (error?.code === 'ENOENT') return 0; throw error; }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new NativeWorkerBudgetError('Unsafe worker receipt directory', 'UNSAFE_RECEIPT_PATH');
  }
  const names = fs.readdirSync(directory).filter(name => RECEIPT_PATTERN.test(name));
  if (names.length > MAX_RECORDS) {
    throw new NativeWorkerBudgetError('Worker receipt limit exceeded', 'UNSAFE_RECEIPT_PATH');
  }
  let count = 0;
  for (const name of names) {
    const { value } = readRecord(path.join(directory, name), directory);
    if (value?.project === project && value?.contractId === contractId) count++;
  }
  return count;
}

function activeReservationCount(directory, project, contractId, now, staleMs) {
  const names = fs.readdirSync(directory).filter(name => /^reservation-[a-f0-9-]{36}\.json$/.test(name));
  if (names.length > MAX_RECORDS) {
    throw new NativeWorkerBudgetError('Worker reservation limit exceeded', 'UNSAFE_BUDGET_RECORD');
  }
  let count = 0;
  for (const name of names) {
    const file = path.join(directory, name);
    let record;
    try { record = readRecord(file, directory); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    if (record.value?.project !== project || record.value?.contractId !== contractId
      || !Number.isSafeInteger(record.value?.count) || record.value.count < 1 || record.value.count > MAX_WORKER_SESSIONS) {
      throw new NativeWorkerBudgetError('Invalid worker reservation record', 'UNSAFE_BUDGET_RECORD');
    }
    if (deadAndStale(record, now, staleMs)) {
      try { fs.unlinkSync(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      continue;
    }
    count += record.value.count;
  }
  return count;
}

export function createWorkerSessionBudget({
  project,
  contractId,
  staleMs = DEFAULT_STALE_MS,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  pid = process.pid,
  now = () => Date.now(),
} = {}) {
  if (!CONTRACT_PATTERN.test(contractId ?? '')) {
    throw new NativeWorkerBudgetError('Invalid worker budget contract', 'INVALID_CONTRACT');
  }
  if (![staleMs, lockTimeoutMs, pollMs].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new NativeWorkerBudgetError('Invalid worker budget timing', 'INVALID_BUDGET_OPTIONS');
  }
  const root = safeProject(project);
  const directory = budgetDirectory(root, contractId);
  const lockFile = path.join(directory, 'reserve.lock');
  const reclaimFile = path.join(directory, 'reserve.reclaim');

  async function acquireLock() {
    const deadline = now() + lockTimeoutMs;
    while (now() <= deadline) {
      const token = randomUUID();
      const owner = { schemaVersion: 1, token, pid, createdAt: now(), project: root, contractId };
      if (tryAtomicRecord(directory, lockFile, owner)) return { token, release: () => safeUnlinkOwned(lockFile, directory, token) };

      let existing;
      try { existing = readRecord(lockFile, directory); }
      catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
      if (deadAndStale(existing, now(), staleMs)) {
        const reclaimToken = randomUUID();
        const reclaimOwner = { schemaVersion: 1, token: reclaimToken, pid, createdAt: now(), project: root, contractId };
        if (tryAtomicRecord(directory, reclaimFile, reclaimOwner)) {
          try {
            let confirmed;
            try { confirmed = readRecord(lockFile, directory); }
            catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
            if (confirmed.value?.token === existing.value?.token && deadAndStale(confirmed, now(), staleMs)) {
              fs.unlinkSync(lockFile);
            }
          } finally {
            safeUnlinkOwned(reclaimFile, directory, reclaimToken);
          }
          continue;
        }
      }
      await delay(pollMs);
    }
    throw new NativeWorkerBudgetError('Worker session budget lock timed out', 'BUDGET_LOCK_TIMEOUT');
  }

  const manager = {
    project: root,
    contractId,
    maximum: MAX_WORKER_SESSIONS,
    async reserve(count = 1) {
      if (!Number.isSafeInteger(count) || count < 1 || count > MAX_WORKER_SESSIONS) {
        throw new NativeWorkerBudgetError('Invalid worker session reservation size', 'INVALID_RESERVATION');
      }
      const lock = await acquireLock();
      try {
        const current = durableReceiptCount(root, contractId)
          + activeReservationCount(directory, root, contractId, now(), staleMs);
        if (current + count > MAX_WORKER_SESSIONS) {
          throw new NativeWorkerBudgetError('Native worker session budget exceeded', 'SESSION_BUDGET_EXCEEDED');
        }
        const token = randomUUID();
        const file = path.join(directory, `reservation-${token}.json`);
        fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, token, pid, createdAt: now(), project: root, contractId, count }), { flag: 'wx', mode: 0o600 });
        readRecord(file, directory);
        let released = false;
        return {
          token,
          count,
          release() {
            if (released) return false;
            released = true;
            return safeUnlinkOwned(file, directory, token);
          },
        };
      } finally {
        lock.release();
      }
    },
    async withReservation(count, launch) {
      if (typeof launch !== 'function') {
        throw new NativeWorkerBudgetError('Worker launch callback required', 'INVALID_RESERVATION');
      }
      const reservation = await manager.reserve(count);
      try { return await launch(); }
      finally { reservation.release(); }
    },
  };
  return manager;
}
