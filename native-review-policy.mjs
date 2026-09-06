const id = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const evidence = value => Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every(item => typeof item === 'string' && item.trim().length > 0 && item.length <= 1000 && !/[\u0000-\u001f\u007f-\u009f]/.test(item));
export function assessNativeReview(worker, requiredBuilderRunIds, chronology) {
  let verdict = null;
  if (worker?.complete === true && ['stopped', 'exited'].includes(worker.state) && typeof worker.result === 'string' && Buffer.byteLength(worker.result) <= 262144) {
    try { verdict = JSON.parse(worker.result); } catch { /* Invalid verdict is not approval. */ }
  }
  const ids = verdict?.reviewedRunIds;
  const validIds = Array.isArray(ids) && ids.length <= 32 && ids.every(id) && new Set(ids).size === ids.length;
  const missingBuilderRunIds = requiredBuilderRunIds.filter(runId => !validIds || !ids.includes(runId));
  const blockers = [];
  if (worker?.readOnly !== true || worker?.role !== 'reviewer' || verdict?.verdict !== 'APPROVED') blockers.push('A completed read-only reviewer APPROVED verdict is required.');
  if (!validIds || missingBuilderRunIds.length) blockers.push('The review must cover every builder run for this contract, including earlier writes and repairs.');
  if (!chronology) blockers.push('Collect every builder result before launching review, then collect that review before auditing.');
  if (!['security', 'performance'].every(category => ['PASS', 'NOT_APPLICABLE'].includes(verdict?.[category]?.status) && evidence(verdict[category].evidence))) blockers.push('Security and performance each require an accepted status and evidence.');
  return { ready: blockers.length === 0, requiredBuilderRunIds, missingBuilderRunIds, blockers,
    nextAction: blockers.length ? 'Collect all builder results, dispatch one independent review covering every requiredBuilderRunId, collect its result, then dispatch the auditor.' : 'Review coverage is complete; auditor dispatch may proceed.' };
}
