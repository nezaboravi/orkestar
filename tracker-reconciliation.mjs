/**
 * Pure Taskavel acceptance boundary, not a tracker client or API response parser.
 * Callers must supply actual, normalized readbacks and accepted evidence references.
 * Column membership and completion are independent facts. This gate never updates
 * tasks, verifies the underlying evidence, or grants overall application acceptance.
 * An accepted flag cannot authenticate a reviewer. The runtime must collect this
 * packet through trusted evidence and tracker adapters, not accept model claims.
 * All IDs are nonempty normalized strings; times are epoch milliseconds from the
 * same trusted clock. lastUpdateAttemptAt is the latest attempted tracker update
 * (or the explicit readback baseline when no update was necessary).
 *
 * @typedef {{accepted:boolean,evidenceIds:string[]}} TaskProof
 * @typedef {{taskId:string,doneColumnId:string,claimedComplete:boolean,
 * lastUpdateAttemptAt:number,proof:TaskProof}} RequiredTask
 * @typedef {{projectId:string,taskId:string,columnId:string,completed:boolean,readAt:number}} TaskSnapshot
 */
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const record = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** @param {{projectId:string,checkedAt:number,maxSnapshotAgeMs?:number,requiredTasks:RequiredTask[],snapshots:TaskSnapshot[]}} input */
export function reconcileTracker(input) {
  const reasons = [], tasks = [];
  let validPacket = false;
  const result = () => ({ status: 'PARTIAL', doneEligible: reasons.length === 0,
    trackerStatus: reasons.length === 0 ? 'VERIFIED' : 'PARTIAL', validPacket, tasks, reasons });
  // Even an eligible tracker is only one acceptance gate, never overall DONE.
  if (!(record(input, ['projectId', 'checkedAt', 'requiredTasks', 'snapshots'])
    || record(input, ['projectId', 'checkedAt', 'requiredTasks', 'snapshots', 'maxSnapshotAgeMs']))
    || !text(input.projectId) || !time(input.checkedAt)
    || (Object.hasOwn(input, 'maxSnapshotAgeMs') && (!Number.isSafeInteger(input.maxSnapshotAgeMs)
      || input.maxSnapshotAgeMs < 1 || input.maxSnapshotAgeMs > 300000))
    || !Array.isArray(input.requiredTasks) || !input.requiredTasks.length || input.requiredTasks.length > 10000
    || !Array.isArray(input.snapshots) || input.snapshots.length > 10000) {
    reasons.push('A bounded, nonempty required-task scope and typed tracker readbacks are required.');
    return result();
  }
  const required = new Map(), readbacks = new Map();
  for (const item of input.requiredTasks) {
    if (!record(item, ['taskId', 'doneColumnId', 'claimedComplete', 'lastUpdateAttemptAt', 'proof'])
      || !text(item.taskId) || !text(item.doneColumnId) || typeof item.claimedComplete !== 'boolean'
      || !time(item.lastUpdateAttemptAt) || item.lastUpdateAttemptAt > input.checkedAt
      || !record(item.proof, ['accepted', 'evidenceIds']) || typeof item.proof.accepted !== 'boolean'
      || !Array.isArray(item.proof.evidenceIds) || item.proof.evidenceIds.length > 100
      || !Array.from(item.proof.evidenceIds).every(text) || new Set(item.proof.evidenceIds).size !== item.proof.evidenceIds.length) {
      reasons.push('Invalid required-task identity, timing, completion claim, or proof.');
      continue;
    }
    if (required.has(item.taskId)) { reasons.push(`Duplicate required task: ${item.taskId}.`); continue; }
    required.set(item.taskId, item);
  }
  for (const snapshot of input.snapshots) {
    if (!record(snapshot, ['projectId', 'taskId', 'columnId', 'completed', 'readAt']) || !text(snapshot.taskId)
      || snapshot.projectId !== input.projectId
      || !text(snapshot.columnId) || typeof snapshot.completed !== 'boolean' || !time(snapshot.readAt)
      || snapshot.readAt > input.checkedAt) {
      reasons.push('Invalid tracker snapshot identity, completion flag, column, or readback time.');
      continue;
    }
    if (!required.has(snapshot.taskId)) { reasons.push(`Snapshot is outside the required task scope: ${snapshot.taskId}.`); continue; }
    if (readbacks.has(snapshot.taskId)) { reasons.push(`Duplicate tracker snapshot: ${snapshot.taskId}.`); continue; }
    readbacks.set(snapshot.taskId, snapshot);
  }
  validPacket = reasons.length === 0;
  for (const item of required.values()) {
    const snapshot = readbacks.get(item.taskId), blockers = [];
    const acceptedProof = item.proof.accepted && item.proof.evidenceIds.length > 0;
    const freshReadback = Boolean(snapshot && snapshot.readAt >= item.lastUpdateAttemptAt
      && snapshot.readAt >= input.checkedAt - (input.maxSnapshotAgeMs ?? 60000));
    if (!acceptedProof) blockers.push('Accepted task-specific proof is missing.');
    if (!item.claimedComplete) blockers.push('The task is not claimed complete.');
    if (!snapshot) blockers.push('The required tracker readback is missing.');
    else {
      if (!freshReadback) blockers.push('The tracker readback predates the latest attempted update or exceeds the freshness window.');
      if (!snapshot.completed) blockers.push('The tracker completion flag is false.');
      if (snapshot.columnId !== item.doneColumnId) blockers.push('The tracker task is not in its required Done column.');
    }
    tasks.push({ taskId: item.taskId, acceptedProof, claimedComplete: item.claimedComplete,
      completed: snapshot?.completed ?? null, inDoneColumn: snapshot ? snapshot.columnId === item.doneColumnId : null,
      freshReadback, doneEligible: blockers.length === 0, reasons: blockers });
    for (const reason of blockers) reasons.push(`Task ${item.taskId}: ${reason}`);
  }
  return result();
}
