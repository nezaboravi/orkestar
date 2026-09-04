import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexEvidence } from '../native-codex-evidence.mjs';

const record = (type, payload) => ({ type, payload });
const meta = record('session_meta', { id: 'root', cwd: '/project', source: 'cli' });
const usage = { input_tokens: 100, output_tokens: 20, cached_input_tokens: 80,
  cache_write_input_tokens: 0, reasoning_output_tokens: 5, total_tokens: 120 };
const snapshot = value => record('event_msg', { type: 'token_count', info: { total_token_usage: value } });

test('uses the last cumulative snapshot without double counting caches, reasoning or repeats', () => {
  const result = parseCodexEvidence([meta, snapshot(usage), snapshot(usage)]);
  assert.deepEqual(result.tokens, { input: 100, output: 20, cacheRead: 80, cacheWrite: 0, reasoning: 5, total: 120 });
  assert.equal(result.cost, null);
  assert.equal(result.provenance.tokenRecord, 2);
});

test('missing metadata and unsupported schemas stay unavailable', () => {
  for (const records of [null, [], [snapshot(usage)], [record('session_meta', {})]]) {
    const result = parseCodexEvidence(records);
    assert.equal(result.sessionId, null);
    assert.equal(result.tokens, null);
    assert.equal(result.state, 'unknown');
  }
  const result = parseCodexEvidence([meta, record('other', { tokens: 999, cost: 9 }),
    record('response_item', { type: 'function_call', name: 'update_plan', arguments: '{"plan":[]}' })]);
  assert.equal(result.tokens, null);
  assert.deepEqual(result.plan, []);
});

test('rejects invalid and inconsistent counts rather than retaining stale good data', () => {
  for (const bad of [{ input_tokens: -1 }, { total_tokens: 121 }, { output_tokens: '20' },
    { cached_input_tokens: 101 }, { reasoning_output_tokens: 21 }, { cache_write_input_tokens: null },
    { total_tokens: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(parseCodexEvidence([meta, snapshot(usage), snapshot({ ...usage, ...bad })]).tokens, null);
  }
  const result = parseCodexEvidence([meta, snapshot({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })]);
  assert.deepEqual(result.tokens, { input: 0, output: 0, total: 0, cacheRead: null, cacheWrite: null, reasoning: null });
});

test('canonical final messages are counted once and completion is not acceptance', () => {
  const final = record('response_item', { type: 'message', id: 'final', role: 'assistant', phase: 'final_answer', content: 'private' });
  const result = parseCodexEvidence([meta, record('event_msg', { type: 'task_started', turn_id: 'turn' }),
    record('response_item', { type: 'message', role: 'assistant', phase: 'commentary' }), final, final,
    record('event_msg', { type: 'item_completed', item: final.payload }),
    record('event_msg', { type: 'task_complete', last_agent_message: 'private' })]);
  assert.equal(result.finalMessageCount, 1);
  assert.equal(result.state, 'idle');
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(parseCodexEvidence([meta, record('event_msg', { type: 'task_started' })]).state, 'running');
});

test('forked parent metadata, usage, models and finals cannot overwrite child evidence', () => {
  const child = record('session_meta', { id: 'child', cwd: '/project', source: { subagent: { thread_spawn: {
    parent_thread_id: 'root', agent_role: 'product-designer' } } } });
  const result = parseCodexEvidence([child, meta,
    record('event_msg', { type: 'task_started', turn_id: 'parent-turn' }),
    record('turn_context', { turn_id: 'parent-turn', model: 'parent-model' }), snapshot(usage),
    record('response_item', { type: 'message', role: 'assistant', phase: 'final_answer' }),
    record('event_msg', { type: 'task_started', turn_id: 'child-turn' }),
    record('turn_context', { turn_id: 'child-turn', model: 'child-model' }),
    record('token_usage_record', { thread_id: 'child', turn_id: 'child-turn', thread_token_usage: usage }),
    record('event_msg', { type: 'task_complete', turn_id: 'child-turn' })]);
  assert.equal(result.sessionId, 'child');
  assert.equal(result.parentSessionId, 'root');
  assert.equal(result.model, 'child-model');
  assert.equal(result.role, 'product-designer');
  assert.equal(result.finalMessageCount, 0);
  assert.equal(result.tokens.total, 120);
  assert.equal(result.state, 'idle');
  assert.equal(parseCodexEvidence([child, meta, snapshot(usage)]).tokens, null);
});

test('cumulative usage is not attributed to the last model after model changes or missing models', () => {
  const first = record('turn_context', { turn_id: 'a', model: 'first-model' });
  for (const tail of [record('turn_context', { turn_id: 'b', model: 'second-model' }),
    record('turn_context', { turn_id: 'b' }),
    record('token_usage_record', { thread_id: 'root', turn_id: 'b', thread_token_usage: usage })]) {
    const result = parseCodexEvidence([meta, first, tail, snapshot(usage)]);
    assert.equal(result.model, null);
    assert.equal(result.provenance.modelRecord, null);
    assert.equal(result.tokens.total, 120);
  }
  assert.equal(parseCodexEvidence([meta, first, record('turn_context', { turn_id: 'b', model: 'first-model' })]).model, 'first-model');
});
