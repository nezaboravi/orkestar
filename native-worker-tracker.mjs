import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifySoloBinary } from './native-solo-mirror.mjs';
import { nativeTaskavelArguments, readNativeCodexTaskavel } from './native-worker-taskavel.mjs';
import { readTaskavelBinding } from './native-taskavel-binding.mjs';

const LIMIT = 262144;
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
