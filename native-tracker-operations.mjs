import { validateTaskavelAuthorization } from './native-worker-taskavel.mjs';

const text = (value, max = 200) => typeof value === 'string' && value === value.trim()
  && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const numeric = value => Number.isSafeInteger(value) && value > 0;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const MAX_RECONCILIATION_AGE = 5 * 60 * 1000;

function validatedRequiredTasks(reconciliation, now) {
  if (!exact(reconciliation, ['projectId', 'checkedAt', 'requiredTasks', 'snapshots'])
    || !text(reconciliation.projectId, 256) || !numeric(reconciliation.checkedAt)
    || reconciliation.checkedAt > now || now - reconciliation.checkedAt > MAX_RECONCILIATION_AGE
    || !Array.isArray(reconciliation.requiredTasks) || !reconciliation.requiredTasks.length
    || reconciliation.requiredTasks.length > 32 || !Array.isArray(reconciliation.snapshots)) throw new Error('Invalid tracker reconciliation');
  const tasks = reconciliation.requiredTasks.map(task => {
    if (!exact(task, ['taskId', 'doneColumnId', 'claimedComplete', 'lastUpdateAttemptAt', 'proof'])
      || !text(String(task.taskId), 32) || !text(task.doneColumnId, 256) || task.claimedComplete !== true
      || !numeric(task.lastUpdateAttemptAt) || task.lastUpdateAttemptAt > reconciliation.checkedAt
      || reconciliation.checkedAt - task.lastUpdateAttemptAt > MAX_RECONCILIATION_AGE
      || !exact(task.proof, ['accepted', 'evidenceIds']) || task.proof.accepted !== true
      || !Array.isArray(task.proof.evidenceIds) || !task.proof.evidenceIds.length || task.proof.evidenceIds.length > 100
      || task.proof.evidenceIds.some(value => !text(value, 256)) || new Set(task.proof.evidenceIds).size !== task.proof.evidenceIds.length) {
      throw new Error('Invalid tracker reconciliation');
    }
    return task;
  });
  if (new Set(tasks.map(task => String(task.taskId))).size !== tasks.length) throw new Error('Duplicate tracker reconciliation task');
  return tasks;
}

/**
 * Validate a deliberately small post-audit tracker close-out request. This is
 * a runtime operation, not an agent assignment: callers provide a fixed MCP
 * transport and this module never accepts model prose, arbitrary tool names,
 * task creation, or a project chosen by the model.
 */
export function validateTrackerCloseout({ contract, auditor, checker, reconciliation, closeout }, { now = Date.now() } = {}) {
  if (!contract?.id || !Array.isArray(contract.required) || (auditor?.verdict !== 'DONE' && !(checker?.verdict === 'APPROVED'
      && ['security', 'performance'].every(category => ['PASS', 'NOT_APPLICABLE'].includes(checker[category]?.status)
        && Array.isArray(checker[category]?.evidence) && checker[category].evidence.length > 0)
      && Array.isArray(checker.proof) && checker.proof.length === contract.required.length
      && contract.required.every(required => checker.proof.some(proof => proof.criterionId === required.id
        && proof.result === 'passed' && text(proof.method, 4000) && Array.isArray(proof.evidence) && proof.evidence.length > 0))))
    || !reconciliation || !exact(closeout, ['authorization', 'tasks'])) throw new Error('Invalid tracker close-out');
  const authorization = validateTaskavelAuthorization(closeout.authorization);
  const bound = contract.trackerAuthorization;
  if (!authorization.externalWriteAuthorized || authorization.projectId !== null
    || authorization.projectName === undefined || reconciliation.projectId !== `name:${authorization.projectName}`
    || !authorization.operations.includes('move-task') || !authorization.operations.includes('update-task')
    || authorization.operations.some(operation => !['read', 'move-task', 'update-task'].includes(operation))) {
    throw new Error('Tracker close-out is not explicitly authorized');
  }
  if (!bound || bound.projectName !== authorization.projectName || bound.externalWriteAuthorized !== true
    || JSON.stringify([...bound.taskIds].sort((a, b) => a - b)) !== JSON.stringify([...authorization.taskIds].sort((a, b) => a - b))
    || authorization.operations.some(operation => !bound.operations.includes(operation))) {
    throw new Error('Tracker close-out does not match immutable contract authorization');
  }
  if (!Array.isArray(closeout.tasks) || !closeout.tasks.length || closeout.tasks.length > 32) throw new Error('Invalid tracker close-out');
  const requiredTasks = validatedRequiredTasks(reconciliation, now);
  const required = new Map(requiredTasks.map(task => [String(task.taskId), task]));
  if (required.size !== closeout.tasks.length || authorization.taskIds.length !== closeout.tasks.length) throw new Error('Tracker close-out scope mismatch');
  const tasks = closeout.tasks.map(task => {
    if (!exact(task, ['taskId', 'doneColumnName']) || !numeric(task.taskId) || !text(task.doneColumnName)) throw new Error('Invalid tracker close-out task');
    const id = String(task.taskId), requiredTask = required.get(id);
    if (!requiredTask || requiredTask.doneColumnId !== `name:${task.doneColumnName}` || !authorization.taskIds.includes(task.taskId)) {
      throw new Error('Tracker close-out scope mismatch');
    }
    return Object.freeze({ taskId: task.taskId, doneColumnName: task.doneColumnName });
  });
  if (new Set(tasks.map(task => task.taskId)).size !== tasks.length) throw new Error('Duplicate tracker close-out task');
  return Object.freeze({ authorization, tasks: Object.freeze(tasks) });
}

/**
 * Execute only the two fixed Taskavel mutations needed to close an already
 * accepted card. `call` must be a runtime-owned, authenticated MCP call. A
 * fresh independent readback remains mandatory after this function returns.
 */
export async function executeTrackerCloseout(input, { call, now = Date.now } = {}) {
  if (typeof call !== 'function') throw new Error('Missing authenticated tracker operation transport');
  const closeout = validateTrackerCloseout(input, { now: now() });
  const receipts = [];
  for (const task of closeout.tasks) {
    // Completion enforces Taskavel's own dependency guards. A rejection must
    // not leave a card visually moved to Done.
    const completedAt = now();
    const completed = await call('update-task-tool', { task_id: task.taskId, mark_complete: 'true' });
    if (completed?.isError === true) throw new Error('Tracker close-out completion failed');
    const movedAt = now();
    const moved = await call('move-task-to-column-tool', { task_id: task.taskId, column_name: task.doneColumnName });
    if (moved?.isError === true) throw new Error('Tracker close-out move failed');
    if (!Number.isSafeInteger(movedAt) || !Number.isSafeInteger(completedAt) || completedAt > movedAt) throw new Error('Invalid tracker operation clock');
    receipts.push(Object.freeze({ taskId: String(task.taskId), movedAt, completedAt }));
  }
  return Object.freeze({ projectId: `name:${closeout.authorization.projectName}`, receipts: Object.freeze(receipts) });
}
