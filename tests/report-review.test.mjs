import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as module from 'node:module';
import vm from 'node:vm';
import { posix } from 'node:path';
import { reportTrackerGate } from '../report-tracker-gate.mjs';
const { join, parse, resolve } = posix;

// Exercise the real report executor without a provider, database, or disk writes.
test('report requires independent security and performance approval before DONE', {
  skip: typeof module.stripTypeScriptTypes !== 'function' && 'Requires Node TypeScript stripping support',
}, async (t) => {
  const schema = new Proxy(() => schema, { get: () => schema, apply: () => schema });
  const rows = ['lenka', 'dev-planner', 'dev-builder', 'dev-tester', 'reviewer', 'dev-auditor'].map((agent, i) => ({
    id: `s${i}`, parent_id: i ? 's0' : null, agent, title: agent,
    model: JSON.stringify({ providerID: 'fixture', id: 'model' }), cost: 0,
    tokens_input: 1, tokens_output: 1, tokens_reasoning: 0,
    tokens_cache_read: 0, tokens_cache_write: 0,
  }));
  const writes = [];
  const context = vm.createContext({
    tool: Object.assign(value => value, { schema }),
    executeFile: async () => ({ stdout: JSON.stringify(rows) }),
    join, parse, resolve, mkdir: async () => {},
    writeFile: async (...args) => writes.push(args),
    reportTrackerGate,
  });
  const source = module.stripTypeScriptTypes(readFileSync(new URL('../adapters/opencode/tools/orchestra-report.ts', import.meta.url), 'utf8'))
    .replace(/\r\n/g, '\n')
    .replace(/^import .*\n/gm, '')
    .replace(/^const executeFile = promisify\(execFile\)\n/m, '')
    .replace('export default tool(', 'globalThis.report = tool(');
  vm.runInContext(source, context);
  const valid = () => ({
    status: 'DONE', summary: 'Verified fixture', workflow: 'development',
    designRequired: false, visualProofRequired: false, taskavel: 'not-requested', blockers: [],
    proof: [{ criterion: 'Fixture behavior', method: 'Independent test', result: 'passed', evidence: ['test evidence'] }],
    review: { sessionId: 's4', verdict: 'APPROVED',
      security: { status: 'PASS', evidence: ['Authorization regression passed'] },
      performance: { status: 'PASS', evidence: ['Bounded query count verified'] } },
  });
  const execute = args => context.report.execute(args, { sessionID: 's0', directory: '/tmp/report-fixture' });
  const cases = [
    ['missing approval', args => { delete args.review; }],
    ['changes required', args => { args.review.verdict = 'CHANGES_REQUIRED'; }],
    ...['s0', 's2', 'unknown'].map(id => [`invalid reviewer ${id}`, args => { args.review.sessionId = id; }]),
    ...['security', 'performance'].flatMap(category => [
      ...['FAIL', 'UNVERIFIED'].map(status => [`${category} ${status}`, args => { args.review[category].status = status; }]),
      [`${category} no evidence`, args => { args.review[category].evidence = []; }],
      [`${category} blank evidence`, args => { args.review[category].evidence = ['  ']; }],
    ]),
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    writes.length = 0;
    const args = valid(); mutate(args);
    await assert.rejects(execute(args));
    assert.equal(writes.length, 0, 'Rejected runs must not persist a successful report');
  });
  await t.test('approved categories persist exact review evidence', async () => {
    writes.length = 0;
    const args = valid();
    assert.match(await execute(args), /ORKESTAR RUN DONE/);
    assert.deepEqual(JSON.parse(writes[0][1]).review, args.review);
  });
  await t.test('non-applicability requires explicit evidence', async () => {
    const args = valid();
    args.review.performance = { status: 'NOT_APPLICABLE', evidence: ['Fixture changes documentation only; no executable path changes'] };
    assert.match(await execute(args), /ORKESTAR RUN DONE/);
    args.review.performance.evidence = [];
    await assert.rejects(execute(args));
  });
  const packet = () => ({ projectId: 'taskavel-project', checkedAt: Date.now(), requiredTasks: [{
    taskId: '42', doneColumnId: 'done', claimedComplete: true, lastUpdateAttemptAt: Date.now() - 200,
    proof: { accepted: true, evidenceIds: ['review-42'] },
  }], snapshots: [{ projectId: 'taskavel-project', taskId: '42', columnId: 'done', completed: true, readAt: Date.now() - 100 }] });
  const rejectedPackets = [
    ['missing packet', () => undefined],
    ['incomplete task', () => { const p = packet(); p.snapshots[0].completed = false; return p; }],
    ['wrong column', () => { const p = packet(); p.snapshots[0].columnId = 'doing'; return p; }],
    ['foreign project', () => { const p = packet(); p.snapshots[0].projectId = 'foreign'; return p; }],
    ['stale replay', () => { const p = packet(); p.checkedAt -= 120000; p.requiredTasks[0].lastUpdateAttemptAt -= 120000; p.snapshots[0].readAt -= 120000; return p; }],
  ];
  for (const [name, makePacket] of rejectedPackets) await t.test(`synced rejects ${name} before persistence`, async () => {
    writes.length = 0;
    const args = { ...valid(), taskavel: 'synced', trackerReconciliation: makePacket() };
    await assert.rejects(execute(args)); assert.equal(writes.length, 0);
  });
  await t.test('synced valid fixture persists per-task reconciliation and evidence', async () => {
    writes.length = 0;
    const args = { ...valid(), taskavel: 'synced', trackerReconciliation: packet() };
    assert.match(await execute(args), /ORKESTAR RUN DONE/);
    const saved = JSON.parse(writes[0][1]).trackerReconciliation;
    assert.equal(saved.doneEligible, true); assert.equal(saved.tasks[0].acceptedProof, true);
    assert.deepEqual(saved.packet, args.trackerReconciliation);
    assert.match(saved.evidenceBoundary, /not independently established/);
  });
  const tokenKeys = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
  for (const key of tokenKeys) for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null]) {
    await t.test(`invalid telemetry ${key} ${invalid} rejects DONE`, async () => {
      const prior = rows[0][key]; rows[0][key] = invalid; writes.length = 0;
      try { await assert.rejects(execute(valid())); assert.equal(writes.length, 0); }
      finally { rows[0][key] = prior; }
    });
  }
  for (const invalid of [-0.01, Infinity, NaN, null]) await t.test(`invalid cost ${invalid} rejects DONE`, async () => {
    const prior = rows[0].cost; rows[0].cost = invalid; writes.length = 0;
    try { await assert.rejects(execute(valid())); assert.equal(writes.length, 0); }
    finally { rows[0].cost = prior; }
  });
  await t.test('per-agent and aggregate overflow remain unavailable in PARTIAL reports', async () => {
    for (const update of [{ tokens_input: Number.MAX_SAFE_INTEGER }, { tokens_input: Number.MAX_SAFE_INTEGER - 1 }, { cost: Number.MAX_VALUE }]) {
      const prior = rows.map(row => ({ ...row }));
      Object.assign(rows[0], update);
      if (update.cost) rows[1].cost = Number.MAX_VALUE;
      writes.length = 0;
      try {
        await assert.rejects(execute(valid())); assert.equal(writes.length, 0);
        await execute({ ...valid(), status: 'PARTIAL', blockers: ['Telemetry overflow'] });
        const totals = JSON.parse(writes[0][1]).totals;
        assert.equal(totals.complete, false);
        assert.equal(update.cost ? totals.cost : totals.tokens, 'unavailable');
      } finally { rows.forEach((row, i) => Object.assign(row, prior[i])); }
    }
  });
});
