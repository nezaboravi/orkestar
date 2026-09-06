import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNativeWorkerOutput } from '../native-solo-worker.mjs';

const output = cost => [
  { type: 'system', subtype: 'init', session_id: 'cost-fixture', model: 'reported-model' },
  { type: 'result', subtype: 'success', session_id: 'cost-fixture', result: 'Verified',
    usage: { input_tokens: 10, output_tokens: 2 }, ...cost },
].map(JSON.stringify).join('\n');

test('Claude reported cost is retained without deriving prices or account billing', () => {
  for (const cost of [0, 0.0123, 1]) {
    const actual = parseNativeWorkerOutput('claude', output({ total_cost_usd: cost }));
    assert.equal(actual.cost, cost);
    assert.equal(actual.actualModel, 'reported-model');
  }
});

test('missing, invalid and failed native costs remain unavailable', () => {
  for (const cost of [undefined, null, -1, '0.01', Infinity, NaN]) {
    assert.equal(parseNativeWorkerOutput('claude', output({ total_cost_usd: cost })).cost, null);
  }
  assert.equal(parseNativeWorkerOutput('claude', output({ total_cost_usd: 1, is_error: true })).cost, null);
  const codex = [{ type: 'thread.started', thread_id: 'one' },
    { type: 'turn.completed', total_cost_usd: 1 }].map(JSON.stringify).join('\n');
  assert.equal(parseNativeWorkerOutput('codex', codex).cost, null);
});
