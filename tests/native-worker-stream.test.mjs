import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createNativeEvidenceStream, NATIVE_EVENT_LIMIT, NATIVE_FINAL_LIMIT } from '../native-worker-stream.mjs';
import { parseNativeWorkerOutput } from '../native-solo-worker.mjs';
const start = { type: 'thread.started', thread_id: 'fixture' };
const final = { type: 'item.completed', item: { type: 'agent_message', text: 'Done evidence' } };
const end = { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } };
function collect(rows, tail = '') {
  const raw = rows.map(JSON.stringify).join('\n') + '\n' + tail;
  const stream = createNativeEvidenceStream('codex'), bytes = Buffer.from(raw);
  for (let i = 0; i < bytes.length; i += 65536) stream.write(bytes.subarray(i, i + 65536));
  return { raw, ...stream.finish() };
}
test('stream hash covers all large tool output while compact result retains exact native usage', () => {
  const result = collect([start, { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'x'.repeat(1500000) } }, final, end]);
  assert.equal(result.streamInvalid, false); assert.equal(result.evidenceTruncated, false);
  assert.equal(result.fullStreamHash, createHash('sha256').update(result.raw).digest('hex'));
  assert.equal(parseNativeWorkerOutput('codex', result.compact).tokens.total, 12);
  assert.ok(result.compact.length < 1000);
});
test('malformed tail, multiple sessions, missing terminal and post-terminal records stay invalid', () => {
  for (const result of [collect([start, final, end], 'bad tail'), collect([start, start, final, end]), collect([start, final]), collect([start, final, end, { type: 'anything' }]), collect([start, { type: 'error' }, final, end]), collect([start, { type: 'tool', session_id: '' }, final, end])]) assert.equal(result.streamInvalid, true);
});
test('oversized final and oversized event fail evidence without synthesizing a verdict', () => {
  const finalResult = collect([start, { ...final, item: { ...final.item, text: 'x'.repeat(NATIVE_FINAL_LIMIT) } }, end]);
  assert.equal(finalResult.evidenceTruncated, true);
  const event = collect([start, { type: 'tool', output: 'x'.repeat(NATIVE_EVENT_LIMIT + 1) }, final, end]);
  assert.equal(event.evidenceTruncated, true); assert.equal(event.streamInvalid, true);
});
test('Claude session and success result retain native model and cost', () => {
  const stream = createNativeEvidenceStream('claude');
  stream.write(Buffer.from([{ type: 'system', subtype: 'init', session_id: 'claude-fixture', model: 'fixture-model' }, { type: 'assistant', session_id: 'claude-fixture', message: { content: [{ type: 'text', text: 'progress' }] } }, { type: 'result', subtype: 'success', session_id: 'claude-fixture', result: 'Approved', total_cost_usd: 0.1, usage: { input_tokens: 10, output_tokens: 2 } }].map(JSON.stringify).join('\n')));
  const result = stream.finish(); assert.equal(result.streamInvalid, false);
  const parsed = parseNativeWorkerOutput('claude', result.compact); assert.equal(parsed.complete, true); assert.equal(parsed.cost, 0.1);
});
