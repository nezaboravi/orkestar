import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { captureNativeWorkerResult } from '../native-worker-report.mjs';
import { nativeReviewCoverage } from '../native-worker-review.mjs';

function fixture() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-coverage-')));
  const folder = path.join(project, '.agent-orchestra/dispatch'); fs.mkdirSync(folder, { recursive: true });
  const contractId = 'tc-123456789012', harness = 'codex';
  const builders = Array.from({ length: 7 }, (_, index) => ({ project, harness, contractId, runId: randomUUID(), role: 'dev-builder', readOnly: false, processId: index + 1, sessionId: 'builder-' + index, complete: true, state: 'stopped', dispatchedAt: 1000, result: 'changed scoped files' }));
  const reviewer = { ...builders[0], role: 'reviewer', readOnly: true, runId: randomUUID(), processId: 8, sessionId: 'review', dispatchedAt: 3000 };
  reviewer.result = JSON.stringify({ verdict: 'APPROVED', reviewedRunIds: builders.slice(-2).map(worker => worker.runId), security: { status: 'PASS', evidence: ['Security reviewed'] }, performance: { status: 'PASS', evidence: ['Performance reviewed'] } });
  const workers = [...builders, reviewer];
  const save = () => workers.forEach(worker => fs.writeFileSync(path.join(folder, `native-${worker.runId}.json`), JSON.stringify(worker)));
  save(); builders.forEach(worker => captureNativeWorkerResult({ project, harness, worker }, 2000));
  const capture = () => captureNativeWorkerResult({ project, harness, worker: reviewer }, 4000);
  const run = worker => nativeReviewCoverage({ project, harness, contractId, worker }, { collect: ({ runId }) => workers.find(entry => entry.runId === runId), now: () => 5000 });
  return { project, folder, contractId, harness, workers, builders, reviewer, save, capture, run };
}
test('review of latest two builders reports five missing earlier writes and blocks audit readiness', async () => {
  const f = fixture(); f.capture(); const result = await f.run(f.reviewer);
  assert.equal(result.ready, false); assert.equal(result.requiredBuilderRunIds.length, 7); assert.equal(result.missingBuilderRunIds.length, 5);
  assert.match(result.nextAction, /every requiredBuilderRunId/);
  assert.equal((await f.run()).ready, false);
});
test('full collected review qualifies, a later builder immediately invalidates coverage', async () => {
  const f = fixture(); const verdict = JSON.parse(f.reviewer.result); verdict.reviewedRunIds = f.builders.map(worker => worker.runId); f.reviewer.result = JSON.stringify(verdict); f.save();
  assert.equal((await f.run()).ready, false, 'review must be collected first');
  f.capture(); assert.equal((await f.run()).ready, true);
  f.workers.push({ ...f.builders[0], runId: randomUUID(), sessionId: 'late', processId: 9, dispatchedAt: 4100 }); f.save();
  const late = await f.run(); assert.equal(late.ready, false); assert.equal(late.missingBuilderRunIds.length, 1);
});
test('changed claims or wrong chronology cannot reuse an earlier collected approval', async () => {
  const f = fixture(); const verdict = JSON.parse(f.reviewer.result); verdict.reviewedRunIds = f.builders.map(worker => worker.runId); f.reviewer.result = JSON.stringify(verdict); f.save(); f.capture();
  f.reviewer.dispatchedAt = 1500; f.save(); assert.equal((await f.run()).ready, false);
  f.reviewer.dispatchedAt = 3000; f.reviewer.result = JSON.stringify({ ...verdict, security: { status: 'PASS', evidence: ['changed'] } }); f.save(); assert.equal((await f.run()).ready, false);
});
