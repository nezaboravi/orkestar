import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as module from 'node:module';
import vm from 'node:vm';
import { join } from 'node:path';

test('native Solo wait is bounded, scoped and does not turn idle into success', {
  skip: typeof module.stripTypeScriptTypes !== 'function' && 'Requires TypeScript stripping',
}, async t => {
  const schema = new Proxy(() => schema, { get: () => schema, apply: () => schema });
  let receipt, row, calls, now;
  const reset = () => {
    now = 1000; calls = [];
    receipt = { schemaVersion: 1, status: 'started', sessionId: 'ses_test', ownerSessionId: 'ses_root', taskStartedAt: 1000,
      role: 'reviewer', model: 'provider/model' };
    row = { agent: 'reviewer', model: JSON.stringify({ providerID: 'provider', id: 'model' }),
      user_count: 2, last_message: JSON.stringify({ role: 'assistant', finish: 'stop', time: { completed: 1 } }) };
  };
  const context = vm.createContext({
    tool: Object.assign(x => x, { schema }), join, Buffer,
    Date: { now: () => { now += 100; return now; } },
    setTimeout: fn => { now += 3000; fn(); },
    realpath: async x => x,
    readFile: async () => JSON.stringify(receipt),
    executeFile: async (...args) => { calls.push(args); return { stdout: JSON.stringify([row]) }; },
  });
  const source = module.stripTypeScriptTypes(readFileSync(new URL('../adapters/opencode/tools/orchestra-solo-wait.ts', import.meta.url), 'utf8'))
    .replace(/^import .*\n/gm, '').replace(/^const executeFile = promisify\(execFile\)\n/m, '')
    .replace('export default tool(', 'globalThis.wait = tool(');
  vm.runInContext(source, context);
  const run = () => context.wait.execute({ sessionId: 'ses_test' }, { directory: '/project', sessionID: 'ses_root' });
  await t.test('returns result-ready, never DONE, with unknown usage explicit', async () => {
    reset(); const result = JSON.parse(await run());
    assert.equal(result.status, 'RESULT_READY'); assert.equal(result.cost, 'unavailable');
    assert.equal(calls.length, 1); assert.match(calls[0][1][1], /s.directory='\/project'/);
    assert.equal(calls[0][2].timeout, 10000); assert.equal(calls[0][2].shell, undefined);
  });
  await t.test('foreign receipt and native model/role drift fail closed', async () => {
    reset(); receipt.ownerSessionId = 'other'; await assert.rejects(run()); assert.equal(calls.length, 0);
    reset(); receipt.status = 'spawn-validation-failed'; await assert.rejects(run()); assert.equal(calls.length, 0);
    reset(); row.agent = 'lenka'; await assert.rejects(run());
    reset(); row.model = JSON.stringify({ providerID: 'wrong', id: 'model' }); await assert.rejects(run());
  });
  await t.test('bootstrap completion alone cannot complete the actual task', async () => {
    reset(); row.user_count = 1;
    assert.equal(JSON.parse(await run()).status, 'PENDING');
    assert.ok(calls.length <= 12);
  });
  await t.test('tool-call completion is still pending', async () => {
    reset(); row.last_message = JSON.stringify({ role: 'assistant', finish: 'tool-calls', time: { completed: 1 } });
    assert.equal(JSON.parse(await run()).status, 'PENDING');
  });
  await t.test('provider errors and hard deadlines stop normal advancement', async () => {
    reset(); row.last_message = JSON.stringify({ role: 'assistant', error: { message: 'secret must not escape' } });
    const result = await run(); assert.equal(JSON.parse(result).status, 'FAILED'); assert.doesNotMatch(result, /secret/);
    reset(); receipt.taskStartedAt = -1000000;
    assert.equal(JSON.parse(await run()).status, 'PARTIAL'); assert.equal(calls.length, 0);
  });
});
