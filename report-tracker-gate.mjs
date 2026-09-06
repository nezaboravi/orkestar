import { reconcileTracker } from './tracker-reconciliation.mjs';

/**
 * Report-time validation of an adapter-supplied normalized Taskavel packet.
 * This authenticates neither network reads nor reviewer claims. The collector
 * must supply actual readbacks/evidence; the report does not contact Taskavel.
 * The runtime clock, not the submitted checkedAt, determines final freshness.
 */
export function reportTrackerGate({ status, taskavel, trackerReconciliation }, now = Date.now()) {
  if (!['DONE', 'PARTIAL', 'FAILED'].includes(status)
    || !['synced', 'not-requested', 'unavailable'].includes(taskavel)
    || !Number.isSafeInteger(now) || now < 0) throw new Error('Invalid report tracker gate input');
  if (status === 'DONE' && taskavel === 'unavailable') throw new Error('DONE requires available requested Taskavel coordination');
  if (trackerReconciliation == null) {
    if (status === 'DONE' && taskavel === 'synced') throw new Error('DONE with synced Taskavel requires fresh task-by-task reconciliation');
    return null;
  }
  const submitted = reconcileTracker(trackerReconciliation);
  const reconciled = reconcileTracker({ ...trackerReconciliation, checkedAt: now });
  if (!Number.isSafeInteger(trackerReconciliation.checkedAt) || trackerReconciliation.checkedAt > now) {
    reconciled.doneEligible = false;
    reconciled.trackerStatus = 'PARTIAL';
    reconciled.reasons.push('Submitted reconciliation time is invalid or in the future.');
  }
  // Do not let replacing checkedAt sanitize an invalid input packet.
  if (!submitted.doneEligible) {
    reconciled.doneEligible = false;
    reconciled.trackerStatus = 'PARTIAL';
    reconciled.reasons = [...new Set([...submitted.reasons, ...reconciled.reasons])];
  }
  if (status === 'DONE' && (taskavel !== 'synced' || !reconciled.doneEligible)) {
    throw new Error('DONE requires all requested Taskavel tasks to have accepted proof, fresh completion flags, and the correct Done column');
  }
  return { ...reconciled, checkedAt: now,
    evidenceBoundary: 'Validated supplied adapter packet; network provenance and reviewer authenticity are not independently established here.',
    packet: submitted.validPacket ? structuredClone(trackerReconciliation) : null };
}
