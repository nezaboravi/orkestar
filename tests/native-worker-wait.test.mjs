import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForNativeWorker } from '../native-worker-wait.mjs';
test('bounded wait returns terminal state without inventing completion', async () => {
  let calls = 0, sleeps = 0;
  const result = await waitForNativeWorker({ runId: 'example' }, { status: async options => ({ runId: options.runId, state: ++calls === 2 ? 'exited' : 'running' }), sleep: async ms => { assert.equal(ms, 2000); sleeps++; } });
  assert.equal(result.ready, true); assert.equal(result.acceptance, 'PARTIAL'); assert.equal(sleeps, 1);
});
test('bounded wait stops after ten delays and propagates identity failures', async () => {
  let calls = 0;
  const result = await waitForNativeWorker({}, { status: async () => { calls++; return { state: 'running' }; }, sleep: async () => {} });
  assert.equal(calls, 11); assert.equal(result.ready, false);
  await assert.rejects(waitForNativeWorker({}, { status: async () => { throw new Error('identity'); } }), /identity/);
});
test('CLI reads share the remaining wall-clock budget', async () => {
  let clock = 0; const timeouts = [];
  const result = await waitForNativeWorker({ runId: 'example' }, {
    now: () => clock, sleep: async ms => { clock += ms; },
    invoke: (_binary, _args, settings) => { timeouts.push(settings.timeout); clock += settings.timeout; return {}; },
    status: async (options, deps) => { deps.invoke('solo', [], { timeout: 15000 }); deps.invoke('solo', [], { timeout: 15000 }); return { runId: options.runId, state: 'running' }; },
  });
  assert.deepEqual(timeouts, [15000, 5000]); assert.equal(clock, 20000); assert.equal(result.ready, false);
});
