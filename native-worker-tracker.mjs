import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifySoloBinary } from './native-solo-mirror.mjs';
import { nativeTaskavelArguments, preflightNativeTaskavelSync, readNativeCodexTaskavel, operateNativeCodexTaskavel } from './native-worker-taskavel.mjs';
import { bindTaskavelAssignment, readTaskavelBinding } from './native-taskavel-binding.mjs';
import { executeTrackerCloseout } from './native-tracker-operations.mjs';
import { validateTaskContract } from './orchestra.mjs';

const LIMIT = 262144;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
function numericId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Tracker requires canonical positive numeric IDs');
  return Number(value);
}
function readProjectJson(project, relative) {
  let target = project;
  for (const segment of relative.split('/')) {
    target = path.join(target, segment);
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Unsafe tracker runtime path');
  }
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size > LIMIT) throw new Error('Invalid bounded tracker runtime');
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}
function safeTool(command) {
  if (command === 'codex') return command;
  if (!path.isAbsolute(command ?? '') || !['codex', 'codex.exe'].includes(path.basename(command))) throw new Error('Unsafe native tracker command');
  fs.accessSync(command, fs.constants.X_OK);
  return command;
}
function privateDirectory(project, parts) {
  let current = project;
  for (const part of parts) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) throw new Error('Unsafe tracker receipt path');
  }
  return current;
}
function receiptValue(fd) {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.size > LIMIT) throw new Error('Invalid tracker receipt');
  const value = fs.readFileSync(fd, 'utf8');
  if (Buffer.byteLength(value) > LIMIT) throw new Error('Invalid tracker receipt');
  return JSON.parse(value);
}
function writeReceipt(fd, value) {
  const content = JSON.stringify(value);
  if (Buffer.byteLength(content) > LIMIT || !fs.fstatSync(fd).isFile()) throw new Error('Invalid tracker receipt');
  fs.ftruncateSync(fd, 0); fs.writeSync(fd, content, 0, 'utf8'); fs.fsyncSync(fd);
}
function assertSafeReceiptPath(receiptPath) {
  try {
    const stat = fs.lstatSync(receiptPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid tracker receipt');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
}
function assertOpenedReceiptPath(receiptPath, descriptor) {
  const current = fs.lstatSync(receiptPath, { bigint: true });
  const opened = fs.fstatSync(descriptor, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink() || !opened.isFile()
    || ![current.dev, current.ino, opened.dev, opened.ino].every(value => typeof value === 'bigint' && value > 0n)
    || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('Invalid tracker receipt');
}

/** Fresh, no-model readback. Only the installed project-bound native route is used. */
export async function reconcileNativeWorkerTracker({ project, harness, projectId, requiredTasks }, {
  invoke = spawnSync, readTask = readNativeCodexTaskavel, now = Date.now, timeoutMs = 90000,
} = {}) {
  if (harness !== 'codex') throw new Error('Fresh native Taskavel reconciliation is unavailable for this harness');
  const taskavelBinding = readTaskavelBinding(project);
  if (projectId !== taskavelBinding.projectId) throw new Error('Taskavel project binding mismatch');
  if (!Array.isArray(requiredTasks) || !requiredTasks.length || requiredTasks.length > 32) throw new Error('Tracker requires 1 to 32 tasks');
  const ids = requiredTasks.map(task => numericId(task?.taskId));
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate tracker task');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90000) throw new Error('Invalid tracker time budget');
  if (!path.isAbsolute(project ?? '') || fs.realpathSync(project) !== project || !fs.statSync(project).isDirectory()) throw new Error('Tracker project must be canonical');
  const startedAt = now();
  const remaining = () => {
    const value = timeoutMs - (now() - startedAt);
    if (value <= 0) throw new Error('Tracker reconciliation time budget exhausted');
    return value;
  };
  const binding = readProjectJson(project, '.agent-orchestra/runtime/solo-observer.json');
  if (binding.schemaVersion !== 1 || binding.project !== project || !Number.isSafeInteger(binding.projectId) || binding.projectId < 1
    || !(binding.harnesses ?? [binding.harness]).includes(harness)) throw new Error('Invalid tracker Solo binding');
  const runtime = readProjectJson(project, '.agent-orchestra/runtime/codex.json');
  const route = runtime.profiles?.taskavel;
  if (runtime.schemaVersion !== 1 || runtime.harness !== harness || route?.permissionEnvelope !== 'task-manager') throw new Error('Missing installed Taskavel runtime route');
  const soloBinary = verifySoloBinary(binding.soloBinary);
  const solo = args => {
    const result = invoke(soloBinary, [...args, '--json'], { cwd: project, encoding: 'utf8', timeout: Math.min(15000, remaining()), maxBuffer: LIMIT });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > LIMIT) throw new Error('Tracker Solo lookup failed');
    const value = JSON.parse(result.stdout);
    if (value.ok !== true || !value.data) throw new Error('Tracker Solo lookup failed');
    return value.data;
  };
  const actual = solo(['projects', 'get', String(binding.projectId)]);
  if (actual.id !== binding.projectId || actual.path !== project) throw new Error('Tracker Solo project mismatch');
  const matches = (solo(['agents', 'list']).agentTools ?? []).filter(tool => tool.enabled === true && tool.toolType === harness).filter(tool => {
    try { safeTool(tool.command); return true; } catch { return false; }
  });
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].id < 1) throw new Error('Exactly one safe native tracker tool is required');
  const binary = safeTool(matches[0].command);
  const launch = nativeTaskavelArguments({ harness, model: route.model, effort: route.reasoningEffort,
    roleBody: 'Read only the explicitly assigned Taskavel tasks. Never mutate external state.',
    task: { goal: 'Independently reconcile current Taskavel task status.', taskavel: {
      projectId: null, projectName: taskavelBinding.projectName, taskIds: ids, operations: ['read'], externalWriteAuthorized: false,
    } } });
  const snapshots = [];
  for (const taskId of ids) {
    const readStarted = now();
    const value = await readTask({ binary, project, launch, taskId }, { timeoutMs: Math.min(30000, remaining()) });
    remaining();
    const snapshot = value?.snapshot;
    if (snapshot?.projectId !== projectId || snapshot.taskId !== String(taskId) || typeof snapshot.completed !== 'boolean'
      || typeof snapshot.columnId !== 'string' || !/^name:[^\x00-\x1f\x7f]{1,200}$/.test(snapshot.columnId)
      || !Number.isSafeInteger(snapshot.readAt) || snapshot.readAt < readStarted || snapshot.readAt > now()) throw new Error('Invalid fresh scoped tracker snapshot');
    snapshots.push({ projectId, taskId: String(taskId), columnId: snapshot.columnId, completed: snapshot.completed, readAt: snapshot.readAt });
  }
  return { projectId, checkedAt: now(), snapshots };
}

/** Runtime-owned Taskavel close-out. It has no model turn and can invoke only
 * the two fixed tools validated by native-tracker-operations. */
export async function closeNativeWorkerTracker({ project, harness, contract, closeout, reportId }, {
  invoke = spawnSync, operate = operateNativeCodexTaskavel, now = Date.now, afterReceiptOpen = () => {},
} = {}) {
  if (harness !== 'codex' || !path.isAbsolute(project ?? '') || fs.realpathSync(project) !== project) throw new Error('Native tracker close-out is unavailable');
  if (typeof reportId !== 'string' || !/^[a-f0-9-]{36}$/.test(reportId)) throw new Error('Native tracker close-out receipt is invalid');
  const immutableContract = validateTaskContract(contract);
  const observer = readProjectJson(project, '.agent-orchestra/runtime/solo-observer.json');
  const runtime = readProjectJson(project, '.agent-orchestra/runtime/codex.json');
  if (observer.schemaVersion !== 1 || observer.project !== project || !Number.isSafeInteger(observer.projectId) || observer.projectId < 1
    || !(observer.harnesses ?? [observer.harness]).includes(harness) || runtime.schemaVersion !== 1 || runtime.harness !== harness
    || runtime.profiles?.taskavel?.permissionEnvelope !== 'task-manager') throw new Error('Native tracker close-out binding is invalid');
  const soloBinary = verifySoloBinary(observer.soloBinary);
  const tools = (() => {
    const result = invoke(soloBinary, ['agents', 'list', '--json'], { cwd: project, encoding: 'utf8', timeout: 15000, maxBuffer: LIMIT });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > LIMIT) throw new Error('Native tracker close-out tool lookup failed');
    const value = JSON.parse(result.stdout); if (value.ok !== true || !Array.isArray(value.data?.agentTools)) throw new Error('Native tracker close-out tool lookup failed');
    return value.data.agentTools;
  })();
  const matches = tools.filter(tool => tool.enabled === true && tool.toolType === 'codex').filter(tool => {
    try { safeTool(tool.command); return true; } catch { return false; }
  });
  if (matches.length !== 1) throw new Error('Exactly one safe native tracker tool is required');
  const binary = safeTool(matches[0].command);
  const authorization = closeout?.authorization;
  const launch = nativeTaskavelArguments({ harness, model: runtime.profiles.taskavel.model, effort: runtime.profiles.taskavel.reasoningEffort,
    roleBody: 'Perform only a runtime-owned fixed Taskavel close-out. Never use model turns or arbitrary tools.',
    task: { goal: 'Close accepted existing Taskavel cards.', taskavel: authorization } });
  // Prove isolated native OAuth before the first mutation. The sync preflight
  // uses no model turn and only projects connection/tool names.
  const preflight = preflightNativeTaskavelSync({ project, binary, launch }, { invoke });
  const binding = bindTaskavelAssignment({ project, contract: immutableContract, authorization: launch.authorization, names: preflight.projectNames });
  const directory = privateDirectory(project, ['.agent-orchestra', 'tracker-receipts']);
  const receiptPath = path.join(directory, `${reportId}.json`);
  const identity = JSON.stringify({ reportId, contractHash: immutableContract.hash, projectId: binding.projectId, closeout });
  let descriptor;
  try {
    // O_NOFOLLOW is unavailable on Windows. Reject an existing link before
    // attempting either creation or replay so it cannot redirect the receipt.
    assertSafeReceiptPath(receiptPath);
    descriptor = fs.openSync(receiptPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    afterReceiptOpen({ receiptPath, descriptor, phase: 'create' });
    assertOpenedReceiptPath(receiptPath, descriptor);
    writeReceipt(descriptor, { identity, state: 'ambiguous' });
  } catch (error) {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
    if (error?.message === 'Invalid tracker receipt') throw new Error('Native tracker close-out receipt is invalid');
    if (error?.code !== 'EEXIST') throw new Error('Native tracker close-out receipt is unavailable');
    let prior; let existing;
    try { assertSafeReceiptPath(receiptPath); existing = fs.openSync(receiptPath, fs.constants.O_RDONLY | NOFOLLOW); afterReceiptOpen({ receiptPath, descriptor: existing, phase: 'replay' }); assertOpenedReceiptPath(receiptPath, existing); prior = receiptValue(existing); fs.closeSync(existing); } catch { if (existing !== undefined) fs.closeSync(existing); throw new Error('Native tracker close-out receipt is invalid'); }
    if (prior?.identity !== identity || prior.state !== 'complete' || !prior.operation) {
      throw new Error('Native tracker close-out has an ambiguous prior mutation');
    }
    return prior.operation;
  }
  try {
    const checkedAt = now();
    const operation = await executeTrackerCloseout({ contract: immutableContract, auditor: { verdict: 'DONE' }, reconciliation: { projectId: binding.projectId,
      checkedAt, snapshots: [], requiredTasks: closeout.tasks.map(task => ({ taskId: String(task.taskId), doneColumnId: `name:${task.doneColumnName}`,
        claimedComplete: true, lastUpdateAttemptAt: checkedAt, proof: { accepted: true, evidenceIds: ['runtime-closeout'] } })) }, closeout }, {
      now,
      call: (tool, arguments_) => operate({ binary, project, launch, operation: { tool, taskId: arguments_.task_id, arguments: arguments_ } }),
    });
    writeReceipt(descriptor, { identity, state: 'complete', operation });
    return operation;
  } catch (error) {
    // Keep the durable receipt ambiguous: this can be a later fixed operation
    // after an earlier card mutation. Expose only the bounded cause and require
    // a fresh readback before any separately authorized retry.
    if (error?.message === 'Native Taskavel membership listing rejected') {
      throw new Error('Native tracker close-out membership listing was rejected; fresh authenticated state is required before a separately authorized retry');
    }
    throw new Error('Native tracker close-out mutation acknowledgement is ambiguous');
  }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
