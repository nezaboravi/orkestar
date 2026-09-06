import fs from 'node:fs';
import path from 'node:path';
import { collectNativeSoloWorkerResult } from './native-solo-worker.mjs';
import { verifyNativeWorkerCapture } from './native-worker-report.mjs';
import { assessNativeReview } from './native-review-policy.mjs';

export async function nativeReviewCoverage({ project, harness, contractId, worker }, { collect = collectNativeSoloWorkerResult, now = Date.now } = {}) {
  if (!path.isAbsolute(project) || fs.realpathSync(project) !== project || !['codex', 'claude'].includes(harness) || !/^tc-[a-f0-9]{12}$/.test(contractId)) throw new Error('Invalid review coverage scope');
  let folder = project;
  for (const part of ['.agent-orchestra', 'dispatch']) {
    folder = path.join(folder, part);
    try { const stat = fs.lstatSync(folder); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid review receipt directory'); }
    catch (error) { if (error.code === 'ENOENT') return assessNativeReview(null, [], false); throw error; }
  }
  const files = fs.readdirSync(folder).filter(name => /^native-[a-f0-9-]{36}\.json$/.test(name));
  if (files.length > 256) throw new Error('Review receipt inventory exceeds limit');
  const receipts = [];
  for (const name of files) {
    const file = path.join(folder, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144) throw new Error('Invalid review receipt');
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (receipt.project !== project || receipt.harness !== harness || receipt.contractId !== contractId) continue;
    if (name !== `native-${receipt.runId}.json`) throw new Error('Invalid review receipt identity');
    receipts.push(receipt);
  }
  if (receipts.length > 32) throw new Error('Review contract inventory exceeds limit');
  const builders = receipts.filter(receipt => receipt.role === 'dev-builder');
  const required = builders.map(receipt => receipt.runId).sort();
  const captures = new Map();
  const collected = async receipt => {
    const result = worker?.runId === receipt.runId ? worker : await collect({ project, runId: receipt.runId });
    if (result.project !== project || result.harness !== harness || result.contractId !== contractId || result.runId !== receipt.runId || result.role !== receipt.role || result.processId !== receipt.processId || result.readOnly !== receipt.readOnly) throw new Error('Invalid review worker identity');
    const capture = verifyNativeWorkerCapture({ project, harness, worker: result }, now());
    if (capture) captures.set(receipt.runId, capture);
    return result;
  };
  for (const receipt of builders) await collected(receipt);
  let best = assessNativeReview(null, required, false);
  for (const receipt of receipts.filter(receipt => receipt.role === 'reviewer' && (!worker || worker.runId === receipt.runId))) {
    const result = await collected(receipt);
    const chronology = Number.isSafeInteger(receipt.dispatchedAt) && receipt.dispatchedAt >= 0 && receipt.dispatchedAt <= now()
      && captures.has(receipt.runId) && builders.every(builder => captures.has(builder.runId) && receipt.dispatchedAt >= captures.get(builder.runId).observedAt);
    const assessment = assessNativeReview(result, required, chronology);
    if (assessment.ready) return { ...assessment, reviewRunId: receipt.runId };
    if (worker || assessment.blockers.length < best.blockers.length) best = { ...assessment, reviewRunId: receipt.runId };
  }
  return best;
}
