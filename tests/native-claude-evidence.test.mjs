import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeEvidence } from '../native-claude-evidence.mjs';

const row = (id = 'message1', extra = {}) => ({
  type: 'assistant', sessionId: 'parent', cwd: '/project', ...extra,
  message: { id, model: 'claude-fixture', stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
    content: [{ type: 'thinking', thinking: 'PRIVATE' }] },
});
test('Claude counts disjoint cache inputs once and deduplicates message snapshots', () => {
  const evidence = parseClaudeEvidence([row(), row()]);
  assert.deepEqual(evidence.tokens, { input: 130, output: 5, cacheRead: 100, cacheWrite: 20, reasoning: null, total: 135 });
  assert.equal(evidence.finalMessageCount, 1);
  assert.equal(evidence.cost, null);
  assert.equal(evidence.state, 'unknown');
  assert.ok(!JSON.stringify(evidence).includes('PRIVATE'));
});
test('Claude binds child identity to explicit native hook parent and agent metadata', () => {
  const child = row('m', { agentId: 'child' });
  const evidence = parseClaudeEvidence([child], { agentId: 'child', parentSessionId: 'parent', role: 'reviewer' });
  assert.equal(evidence.sessionId, 'child');
  assert.equal(evidence.parentSessionId, 'parent');
  assert.equal(evidence.tokens.total, 135);
  assert.equal(parseClaudeEvidence([child]).tokens, null);
  assert.equal(parseClaudeEvidence([child], { agentId: 'other', parentSessionId: 'parent' }).tokens, null);
  assert.equal(parseClaudeEvidence([child], { agentId: 'child', parentSessionId: 'wrong' }).sessionId, null);
});
test('Claude missing, invalid, conflicting usage is unknown, never a fabricated zero', () => {
  for (const value of [undefined, -1, '5', Infinity, 1.5]) {
    const sample = row(); sample.message.usage.output_tokens = value;
    assert.equal(parseClaudeEvidence([sample]).tokens, null);
  }
  assert.equal(parseClaudeEvidence([]).tokens, null);
  assert.equal(parseClaudeEvidence([row(), row('m2', { sessionId: 'other' })]).sessionId, null);
  const changed = row('m2'); changed.message.model = 'other';
  assert.equal(parseClaudeEvidence([row(), changed]).model, null);
});

test('Claude never attributes missing or conflicting message models to the known model', () => {
  const missing = row('m2'); delete missing.message.model;
  assert.equal(parseClaudeEvidence([row(), missing]).model, null);
  const conflict = row(); conflict.message.model = 'other';
  const evidence = parseClaudeEvidence([row(), conflict]);
  assert.equal(evidence.model, null);
  assert.equal(evidence.tokens, null);
});

test('Claude conflicting snapshots do not silently replace authoritative usage', () => {
  const changed = row(); changed.message.usage.output_tokens = 99;
  assert.equal(parseClaudeEvidence([row(), changed]).tokens, null);
  changed.message.usage.output_tokens = 5;
  changed.message.stop_reason = null;
  assert.equal(parseClaudeEvidence([row(), changed]).tokens, null);
});
