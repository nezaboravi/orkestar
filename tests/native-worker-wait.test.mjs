import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForNativeWorker } from '../native-worker-wait.mjs';
test('bounded wait returns terminal state without inventing completion', async () => {
  let calls = 0, sleeps = 0;
  const result = await waitForNativeWorker({ runId: 'example' }, { status: async options => ({ runId: options.runId, state: ++calls === 2 ? 'exited' : 'running' }), sleep: async ms => { assert.equal(ms, 1000); sleeps++; } });
  assert.equal(result.ready, true); assert.equal(result.acceptance, 'PARTIAL'); assert.equal(sleeps, 1);
});
test('bounded wait uses internal backoff for one minute and propagates identity failures', async () => {
  let calls = 0, clock = 0, delays = [];
  const result = await waitForNativeWorker({}, { now: () => clock, status: async () => { calls++; return { state: 'running' }; }, sleep: async ms => { delays.push(ms); clock += ms; } });
  assert.equal(calls, 8); assert.equal(clock, 60000); assert.deepEqual(delays, [1000, 3000, 6000, 10000, 10000, 10000, 10000, 10000]);
  assert.equal(result.ready, false); assert.match(result.next, /repeat worker_wait only if authorized work remains/);
  await assert.rejects(waitForNativeWorker({}, { status: async () => { throw new Error('identity'); } }), /identity/);
});
test('CLI reads share the remaining wall-clock budget', async () => {
  let clock = 0; const timeouts = [];
  const result = await waitForNativeWorker({ runId: 'example' }, {
    now: () => clock, sleep: async ms => { clock += ms; },
    invoke: (_binary, _args, settings) => { timeouts.push(settings.timeout); clock += settings.timeout; return {}; },
    status: async (options, deps) => { deps.invoke('solo', [], { timeout: 15000 }); deps.invoke('solo', [], { timeout: 15000 }); return { runId: options.runId, state: 'running' }; },
  });
  assert.deepEqual(timeouts, [15000, 15000, 15000, 14000]); assert.equal(clock, 60000); assert.equal(result.ready, false);
});
test('a sub-millisecond remaining CLI budget returns a partial timeout without another status call', async () => {
  let clock = 0, calls = 0;
  const result = await waitForNativeWorker({ runId: 'example' }, {
    now: () => clock,
    status: async (_options, deps) => {
      calls++; clock = 59999.5;
      deps.invoke('solo', [], { timeout: 15000 });
      return { runId: 'example', state: 'running' };
    },
  });
  assert.equal(calls, 1); assert.equal(result.ready, false); assert.equal(result.acceptance, 'PARTIAL');
  assert.match(result.next, /window elapsed/);
});
test('an abort signal returns a partial cancellation without another status poll', async () => {
  const controller = new AbortController(); let calls = 0;
  const result = await waitForNativeWorker({ runId: 'example', signal: controller.signal }, {
    status: async () => { calls++; return { runId: 'example', state: 'running' }; },
    sleep: async () => controller.abort(),
  });
  assert.equal(calls, 1); assert.equal(result.cancelled, true); assert.equal(result.acceptance, 'PARTIAL');
});
