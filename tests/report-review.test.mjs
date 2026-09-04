import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as module from 'node:module';
import vm from 'node:vm';
import { posix } from 'node:path';
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
});
