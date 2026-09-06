import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateTaskContract } from './orchestra.mjs';
import { collectNativeSoloWorkerResult } from './native-solo-worker.mjs';
import { reportTrackerGate } from './report-tracker-gate.mjs';
import { assessNativeReview } from './native-review-policy.mjs';
import { MAX_WORKER_SESSIONS } from './orchestra-limits.mjs';
import { validateTrackerCloseout } from './native-tracker-operations.mjs';

const LIMIT = 262144;
const id = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
// A report ID is an immutable operation identity. Keep both successful and
// ambiguous attempts: retrying an unknown remote write is less safe than an
// explicit PARTIAL result. The native closeout adapter also persists its own
// receipt for process-bound recovery.
const closeoutReceipts = new Map();
const MAX_CLOSEOUT_RECEIPTS = 64;
const text = (value, max = 1000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const strings = value => Array.isArray(value) && value.length > 0 && value.length <= 100 && Array.from(value).every(item => text(item));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const count = value => Number.isSafeInteger(value) && value >= 0;
const finished = worker => worker?.complete === true && ['stopped', 'exited'].includes(worker.state);
function directory(project, parts) {
  if (!path.isAbsolute(project) || fs.realpathSync(project) !== project) throw new Error('Invalid native report scope');
  let current = project;
  for (const part of parts) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe native report path');
  }
  return current;
}
function read(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT) throw new Error('Invalid bounded native report file');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function encode(value) {
  const content = JSON.stringify(value);
  if (Buffer.byteLength(content) > LIMIT) throw new Error('Native report exceeds limit');
  return content;
}
function selectedEvidence(worker) {
  return { runId: worker.runId, sessionId: worker.sessionId, harness: worker.harness, project: worker.project,
    contractId: worker.contractId, role: worker.role, processId: worker.processId, result: worker.result };
}
export function verifyNativeWorkerCapture({ project, harness, worker }, now = Date.now()) {
  const folder = directory(project, ['.agent-orchestra', 'runs', 'native-results']);
  if (!finished(worker) || worker.project !== project || worker.harness !== harness || !id(worker.runId)) return null;
  try {
    const saved = read(path.join(folder, `${worker.runId}.json`));
    return saved.schemaVersion === 1 && saved.project === project && saved.harness === harness && saved.runId === worker.runId
      && count(saved.observedAt) && saved.observedAt <= now && saved.evidenceHash === hash(selectedEvidence(worker)) ? saved : null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
/** Record successful stopped output before launching its reviewer. No transcript storage. */
export function captureNativeWorkerResult({ project, harness, worker }, now = Date.now(), retry = 0) {
  if (!worker || worker.project !== project || worker.harness !== harness || !id(worker.runId)
    || !count(now)) throw new Error('Invalid native report evidence');
  if (!finished(worker)) return null;
  if (!text(worker.sessionId, 256)) throw new Error('Invalid native report evidence');
  const folder = directory(project, ['.agent-orchestra', 'runs', 'native-results']);
  const file = path.join(folder, `${worker.runId}.json`), evidenceHash = hash(selectedEvidence(worker));
  try {
    const saved = read(file);
    if (saved.schemaVersion !== 1 || saved.project !== project || saved.harness !== harness || saved.runId !== worker.runId
      || !count(saved.observedAt) || saved.observedAt > now || saved.evidenceHash !== evidenceHash) throw new Error('Native worker evidence changed after capture');
    return saved;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const saved = { schemaVersion: 1, project, harness, runId: worker.runId, observedAt: now, evidenceHash };
  try { fs.writeFileSync(file, encode(saved), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST' || retry >= 2) throw error; return captureNativeWorkerResult({ project, harness, worker }, now, retry + 1); }
  return saved;
}

function parseVerdict(worker) {
  if (!finished(worker) || typeof worker.result !== 'string' || Buffer.byteLength(worker.result) > LIMIT) return null;
  try { const value = JSON.parse(worker.result); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
  catch { return null; }
}
const covers = (value, required) => Array.isArray(value) && value.length <= MAX_WORKER_SESSIONS && value.every(id)
  && new Set(value).size === value.length && required.every(runId => value.includes(runId));

/** Recollect real worker output. Supplied tracker packet is validated, not network-authenticated. */
export async function finalizeNativeWorkerReport({ project, harness, report }, { collect = collectNativeSoloWorkerResult, reconcileTracker, applyTrackerCloseout, now = Date.now } = {}) {
  if (!['codex', 'claude'].includes(harness) || !report || !id(report.reportId) || !Array.isArray(report.workerRunIds)
    || Object.keys(report).some(key => !['reportId', 'contract', 'workerRunIds', 'status', 'summary', 'workflow', 'designRequired', 'visualProofRequired', 'taskavel', 'trackerReconciliation', 'trackerCloseout', 'blockers'].includes(key))
    || report.workerRunIds.length > MAX_WORKER_SESSIONS || !report.workerRunIds.every(id) || new Set(report.workerRunIds).size !== report.workerRunIds.length
    || !['DONE', 'PARTIAL', 'FAILED'].includes(report.status) || !['development', 'other'].includes(report.workflow)
    || !text(report.summary, 4000) || typeof report.designRequired !== 'boolean' || typeof report.visualProofRequired !== 'boolean'
    || !Array.isArray(report.blockers) || report.blockers.length > 100 || !Array.from(report.blockers).every(item => text(item))
    || (report.workerRunIds.length === 0 && (report.status === 'DONE' || report.blockers.length === 0))) throw new Error('Invalid native report input');
  const contract = validateTaskContract(report.contract);
  const runs = directory(project, ['.agent-orchestra', 'runs']);
  const contractDirectory = directory(project, ['.agent-orchestra', 'runs', contract.id]);
  const stored = read(path.join(contractDirectory, 'task-contract.json'));
  if (hash(stored) !== hash(contract)) throw new Error('Invalid native report contract');
  const workers = [], captures = new Map(), launches = new Map(), trackerClosures = new Set(), blockers = [...report.blockers];
  const seenSessions = new Set(), seenProcesses = new Set();
  const dispatchDirectory = directory(project, ['.agent-orchestra', 'dispatch']);
  const dispatchFiles = fs.readdirSync(dispatchDirectory).filter(name => /^native-[a-f0-9-]{36}\.json$/.test(name));
  if (dispatchFiles.length > 256) throw new Error('Native report receipt inventory exceeds limit');
  for (const name of dispatchFiles) {
    const receipt = read(path.join(dispatchDirectory, name));
    if (receipt.project === project && receipt.harness === harness && receipt.contractId === contract.id
      && !report.workerRunIds.includes(receipt.runId)) blockers.push('A dispatched worker for this contract is omitted from the report.');
  }
  for (const runId of report.workerRunIds) {
    const receiptFile = path.join(dispatchDirectory, `native-${runId}.json`);
    const receipt = read(receiptFile);
    const launchedAt = count(receipt.dispatchedAt) && receipt.dispatchedAt <= now() ? receipt.dispatchedAt : null;
    const worker = await collect({ project, runId });
    if (receipt.project !== project || receipt.harness !== harness || receipt.contractId !== contract.id || receipt.runId !== runId
      || worker.project !== project || worker.harness !== harness || worker.contractId !== contract.id || worker.runId !== runId
      || worker.role !== receipt.role || worker.processId !== receipt.processId || worker.readOnly !== receipt.readOnly
      || !Number.isSafeInteger(worker.processId) || worker.processId < 1 || seenProcesses.has(worker.processId)
      || (worker.sessionId && seenSessions.has(worker.sessionId))) throw new Error('Invalid native report worker identity');
    seenProcesses.add(worker.processId); if (worker.sessionId) seenSessions.add(worker.sessionId);
    workers.push(worker); launches.set(runId, launchedAt);
    const authorization = receipt.taskavelAuthorization;
    const tracker = report.trackerReconciliation;
    if (receipt.role === 'task-manager' && receipt.readOnly === true && report.taskavel === 'synced'
      && authorization && tracker && tracker.projectId === `name:${authorization.projectName}`
      && Array.isArray(authorization.operations) && authorization.operations.length > 0
      && authorization.operations.every(operation => ['read', 'update-task', 'move-task', 'add-comment'].includes(operation))
      && Array.isArray(authorization.taskIds) && authorization.taskIds.length > 0
      && Array.isArray(tracker.requiredTasks)
      && authorization.taskIds.every(taskId => tracker.requiredTasks.some(task => String(task.taskId) === String(taskId)))) {
      trackerClosures.add(runId);
    }
    if (!finished(worker)) blockers.push(`Worker ${runId} has no successful stopped result.`);
    else captures.set(runId, captureNativeWorkerResult({ project, harness, worker }, now()));
  }
  const role = name => workers.filter(worker => worker.role === name);
  if (report.workflow === 'development') {
    // The validated, persisted immutable contract is the plan. A separate
    // planning specialist is optional; execution and independent proof are not.
    for (const name of ['dev-builder', 'dev-tester', 'reviewer', 'dev-auditor',
      ...(report.designRequired ? ['product-designer'] : []), ...(report.visualProofRequired ? ['frontend-qa'] : [])]) {
      if (!role(name).length) blockers.push(`Missing required ${name} worker.`);
    }
  }
  const builders = role('dev-builder'), reviews = role('reviewer').filter(worker => worker.readOnly === true);
  // Code review follows every write. Independent read-only test and browser
  // checks may run alongside it; the auditor joins all three evidence streams.
  const checkedRuns = builders.map(worker => worker.runId);
  const after = (worker, runIds) => launches.get(worker.runId) !== null
    && runIds.every(runId => captures.has(runId) && launches.get(worker.runId) >= captures.get(runId).observedAt);
  const review = reviews.find(worker => assessNativeReview(worker, checkedRuns, after(worker, checkedRuns)).ready);
  if (report.workflow === 'development' && !review) blockers.push('Independent security/performance review with evidence after all builder writes is missing.');
  const auditor = role('dev-auditor').filter(worker => worker.readOnly === true).find(worker => {
    const verdict = parseVerdict(worker);
    // Tracker closure follows independent acceptance. Its separate trusted
    // readback gate below prevents an audit -> closure -> audit cycle.
    const auditedRuns = workers.filter(other => other.runId !== worker.runId
      && other.role !== 'dev-auditor' && !trackerClosures.has(other.runId)).map(other => other.runId);
    // An auditor may only decide the immutable contract requirements. Operational
    // tracker closure is a later runtime-owned reconciliation, never LD-style
    // acceptance criterion that can create an audit/closure/audit cycle.
    return verdict?.verdict === 'DONE' && review && verdict.reviewRunId === review.runId
      && covers(verdict.reviewedRunIds, auditedRuns) && after(worker, auditedRuns)
      && Array.isArray(verdict.proof) && verdict.proof.length <= 100
      && verdict.proof.every(proof => contract.required.some(requirement => requirement.id === proof?.criterionId))
      && contract.required.every(requirement => verdict.proof.some(proof => proof?.criterionId === requirement.id
        && proof.result === 'passed' && text(proof.method) && strings(proof.evidence)));
  });
  if (!auditor) blockers.push('Independent auditor acceptance covering every contract requirement is missing.');
  if (builders.some(worker => worker.readOnly !== false)) blockers.push('Builder write envelope is not verified.');
  let trackerReconciliation = null;
  let trackerReport = report;
  if (report.trackerCloseout !== undefined) {
    try {
      // Closing an existing card is a bounded runtime action after acceptance,
      // never a model worker or an additional auditor. The adapter owns OAuth
      // and must still provide a fresh readback below.
      if (!auditor || report.status !== 'DONE' || blockers.length || report.taskavel !== 'synced' || !report.trackerReconciliation || typeof applyTrackerCloseout !== 'function') throw new Error();
      const closeout = validateTrackerCloseout({ contract, auditor: parseVerdict(auditor), reconciliation: report.trackerReconciliation,
        closeout: report.trackerCloseout }, { now: now() });
      const identity = `${project}\u0000${harness}\u0000${report.reportId}\u0000${contract.hash}\u0000${JSON.stringify(closeout)}`;
      let pending = closeoutReceipts.get(identity);
      if (!pending) {
        pending = Promise.resolve().then(() => applyTrackerCloseout({ project, harness, contract, closeout, reportId: report.reportId }));
        closeoutReceipts.set(identity, pending);
        pending.then(() => {
          // Durable native receipts are the replay authority. This tiny map
          // only coalesces simultaneous reports in one process.
          while (closeoutReceipts.size > MAX_CLOSEOUT_RECEIPTS) closeoutReceipts.delete(closeoutReceipts.keys().next().value);
        }, () => closeoutReceipts.delete(identity));
      }
      const operation = await pending;
      if (!operation || operation.projectId !== report.trackerReconciliation.projectId || !Array.isArray(operation.receipts)
        || operation.receipts.length !== closeout.tasks.length) throw new Error();
      const attempted = new Map(operation.receipts.map(receipt => [String(receipt?.taskId), receipt?.completedAt]));
      if (attempted.size !== closeout.tasks.length || [...attempted.values()].some(value => !count(value))) throw new Error();
      trackerReport = { ...trackerReport, trackerReconciliation: { ...trackerReport.trackerReconciliation,
        requiredTasks: trackerReport.trackerReconciliation.requiredTasks.map(task => ({ ...task,
          lastUpdateAttemptAt: attempted.get(String(task.taskId)) ?? task.lastUpdateAttemptAt })) } };
    } catch (error) {
      blockers.push('Authorized Taskavel close-out could not be completed with a bounded runtime operation.');
      if (error?.message === 'Native tracker close-out membership listing was rejected; fresh authenticated state is required before a separately authorized retry') {
        blockers.push('Authenticated Taskavel membership listing was rejected; fresh authenticated state is required before any separately authorized retry.');
      }
    }
  }
  if (report.taskavel === 'synced') {
    // Never accept model-supplied snapshots as authenticated server observations.
    // Only a runtime-owned collector can replace this packet's observations.
    try {
      if (typeof reconcileTracker !== 'function' || !report.trackerReconciliation) throw new Error('Missing authenticated collector');
      const { projectId, requiredTasks } = report.trackerReconciliation;
      const observed = await reconcileTracker({ projectId, requiredTasks: structuredClone(requiredTasks) });
      if (!observed || observed.projectId !== projectId) throw new Error('Tracker scope mismatch');
      trackerReport = { ...trackerReport, trackerReconciliation: { ...trackerReport.trackerReconciliation,
        checkedAt: observed.checkedAt, snapshots: observed.snapshots } };
    } catch {
      blockers.push('Authenticated Taskavel readback is unavailable; supplied snapshots cannot establish synchronization.');
      trackerReport = { ...trackerReport, trackerReconciliation: undefined };
    }
  }
  try { trackerReconciliation = reportTrackerGate({ ...trackerReport, status: 'DONE' }, now()); }
  catch { blockers.push('Requested Taskavel reconciliation is missing, stale, invalid, or incomplete.');
    trackerReconciliation = reportTrackerGate({ ...trackerReport, status: 'PARTIAL' }, now()); }
  const uniqueBlockers = [...new Set(blockers)];
  const agents = workers.map(worker => {
    const tokens = worker.tokens && count(worker.tokens.input) && count(worker.tokens.output) && count(worker.tokens.total)
      && worker.tokens.total === worker.tokens.input + worker.tokens.output
      ? { input: worker.tokens.input, output: worker.tokens.output, total: worker.tokens.total } : null;
    if (tokens && harness === 'codex' && count(worker.tokens.cachedInput)
      && worker.tokens.cachedInput <= tokens.input && count(worker.tokens.uncachedInput)
      && worker.tokens.uncachedInput === tokens.input - worker.tokens.cachedInput) {
      tokens.cachedInput = worker.tokens.cachedInput;
      tokens.uncachedInput = worker.tokens.uncachedInput;
    }
    return { sessionId: worker.sessionId ?? null, parentSessionId: null, runId: worker.runId, processId: worker.processId,
      agent: worker.role, requestedModel: worker.model ?? null, model: worker.actualModel ?? null, tokens,
      cost: worker.complete === true && typeof worker.cost === 'number' && Number.isFinite(worker.cost) && worker.cost >= 0 ? worker.cost : null };
  });
  const total = agents.every(agent => agent.tokens) ? agents.reduce((sum, agent) => sum + agent.tokens.total, 0) : null;
  const costTotal = agents.every(agent => agent.cost !== null) ? agents.reduce((sum, agent) => sum + agent.cost, 0) : null;
  const status = report.status === 'FAILED' ? 'FAILED' : report.status === 'DONE' && !uniqueBlockers.length ? 'DONE' : 'PARTIAL';
  const reviewVerdict = review ? parseVerdict(review) : null;
  const reviewEvidence = reviewVerdict ? { runId: review.runId, verdict: reviewVerdict.verdict,
    reviewedRunIds: reviewVerdict.reviewedRunIds,
    security: { status: reviewVerdict.security.status, evidence: reviewVerdict.security.evidence },
    performance: { status: reviewVerdict.performance.status, evidence: reviewVerdict.performance.evidence } } : null;
  const proof = auditor ? parseVerdict(auditor).proof.filter(item => contract.required.some(required => required.id === item?.criterionId)
    && item.result === 'passed' && text(item.method) && strings(item.evidence))
    .map(item => ({ criterionId: item.criterionId, criterion: contract.required.find(required => required.id === item.criterionId).text,
      result: item.result, method: item.method, evidence: item.evidence })) : [];
  const audit = { schemaVersion: 1, nativeWorkerReport: 1, project, harness, sessionId: `report:${report.reportId}`,
    reportId: report.reportId, createdAt: new Date(now()).toISOString(), status, summary: report.summary,
    contractId: contract.id, agents, totals: { tokens: count(total) ? total : null, cost: typeof costTotal === 'number' && Number.isFinite(costTotal) ? costTotal : null },
    accounting: 'Worker-only observed usage and native reported USD cost when available, not an account invoice. Aggregate input is not unique prompt size or a full-price charge; optional cached and uncached input details are retained only when validated. Conductor usage is excluded. Missing values remain unavailable. Requested model is not proof of actual model.',
    taskavel: report.taskavel, trackerReconciliation, review: reviewEvidence,
    auditorRunId: auditor?.runId ?? null, proof, blockers: uniqueBlockers,
    evidenceBoundary: 'Collected native output proves role-linked worker statements, not their truth. Independent review/audit statements and supplied tracker packet remain evidence for human inspection.' };
  const content = encode(audit), revision = `${report.reportId}-${hash(audit).slice(0, 12)}-${randomUUID()}`;
  const savedPath = path.join(runs, `native-worker-${revision}.json`);
  fs.writeFileSync(savedPath, content, { flag: 'wx', mode: 0o600 });
  const latest = path.join(runs, 'latest.json');
  let replace = false;
  try { const previous = read(latest); replace = previous.nativeWorkerReport === 1 && previous.project === project; }
  catch (error) { if (error.code !== 'ENOENT') throw error; replace = true; }
  if (replace) {
    const temporary = path.join(runs, `.native-report-${randomUUID()}.json`);
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, latest);
  }
  return { ...audit, savedPath, latestUpdated: replace };
}
