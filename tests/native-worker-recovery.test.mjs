import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { recoverCodexWorker, RECOVERY_LIMIT } from '../native-worker-recovery.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const id = '01a06d3c-4981-7cc0-864d-b84c0effd48f';
const turnId = '01a06d3c-49df-7a21-8fbc-5623e6b7b227';
function fixture(t) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-test-')));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const binary = path.join(project, 'codex'); fs.writeFileSync(binary, '', { mode: 0o700 });
  const runId = 'dd52b097-2f15-4c3e-a79d-d45e81fbe8a4';
  const launch = { project, runId, harness: 'codex', model: 'model', role: 'reviewer', binary, args: ['exec', '--json'] };
  const launchEncoded = JSON.stringify(launch);
  const receipt = { ...launch, state: 'Exited', liveLaunchHash: hash(launchEncoded), argumentsHash: hash(JSON.stringify(launch.args)) };
  const input = { project, receipt, launchEncoded, rawPrefix: JSON.stringify({ type: 'thread.started', thread_id: id }) + '\n', exitCode: 0 };
  const thread = { id, cwd: project, turns: [{ id: turnId, status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: '{"verdict":"PARTIAL"}' }] }] };
  let calls = 0;
  const invoke = (binary, args, options) => {
    calls++; assert.equal(binary, process.execPath); assert.equal(options.timeout, 30000); assert.equal(options.maxBuffer, RECOVERY_LIMIT);
    assert.match(args[1], /method:'thread\/read'/); assert.doesNotMatch(args[1], /method:'(?:thread\/resume|turn\/start|account\/read|config\/read)'/);
    return { status: 0, stdout: JSON.stringify({ thread }) };
  };
  return { input, thread, invoke, calls: () => calls };
}

test('recovers exact completed final without granting acceptance or altering capture', t => {
  const f = fixture(t), before = JSON.stringify(f.input);
  const value = recoverCodexWorker(f.input, { invoke: f.invoke, now: () => 100 });
  assert.equal(value.result, '{"verdict":"PARTIAL"}'); assert.equal(value.complete, true);
  assert.equal(value.tokens, null); assert.equal(value.cost, null);
  assert.equal(value.recoveryProvenance.recoveredAt, 100); assert.match(value.recoveryProvenance.hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(f.input), before); assert.equal(f.calls(), 1);
});

test('rejects wrong receipt, nonterminal exit, altered launch and missing header before read', t => {
  const f = fixture(t);
  for (const input of [
    { ...f.input, exitCode: 1 }, { ...f.input, receipt: { ...f.input.receipt, state: 'Running' } },
    { ...f.input, launchEncoded: f.input.launchEncoded + ' ' }, { ...f.input, rawPrefix: '{"type":"other"}' },
    { ...f.input, receipt: { ...f.input.receipt, project: '/wrong' } },
  ]) assert.throws(() => recoverCodexWorker(input, { invoke: f.invoke }));
  assert.equal(f.calls(), 0);
});

test('rejects foreign identity, interrupted and multiple turns, commentary and ambiguous finals', t => {
  const f = fixture(t); const good = structuredClone(f.thread);
  for (const change of [
    x => x.id = 'foreign', x => x.cwd = '/wrong', x => x.turns[0].status = 'interrupted',
    x => x.turns.push(structuredClone(x.turns[0])), x => x.turns[0].items[0].phase = 'commentary',
    x => x.turns[0].items.push(structuredClone(x.turns[0].items[0])),
  ]) {
    Object.assign(f.thread, structuredClone(good)); change(f.thread);
    assert.throws(() => recoverCodexWorker(f.input, { invoke: f.invoke }));
  }
});

test('native error and bounded read failure do not expose native text', t => {
  const f = fixture(t);
  for (const result of [{ status: 1, stdout: 'PRIVATE' }, { status: 0, stdout: 'PRIVATE' }, { error: new Error('PRIVATE') }, { status: 0, stdout: 'x'.repeat(RECOVERY_LIMIT + 1) }])
    assert.throws(() => recoverCodexWorker(f.input, { invoke: () => result }), error => !error.message.includes('PRIVATE'));
});

test('exact terminal rollout supplies cumulative actual tokens, no cache double count', t => {
  const f = fixture(t);
  const dir = path.join(f.input.project, 'sessions/2026/09/04'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-04T18-24-22-${id}.jsonl`); f.thread.path = file;
  const rows = [
    { type: 'session_meta', payload: { id, cwd: f.input.project } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, total_tokens: 110 } } } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '{"verdict":"PARTIAL"}' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
  ];
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n'));
  const result = recoverCodexWorker(f.input, { invoke: f.invoke });
  assert.equal(result.tokens.total, 110); assert.equal(result.tokens.cachedInput, 80); assert.equal(result.tokens.uncachedInput, 20); assert.match(result.recoveryProvenance.rolloutHash, /^[a-f0-9]{64}$/);
  rows[3].payload.content[0].text = 'different'; fs.writeFileSync(file, rows.map(JSON.stringify).join('\n'));
  assert.throws(() => recoverCodexWorker(f.input, { invoke: f.invoke }), /final evidence mismatch/);
  rows[3].payload.content[0].text = '{"verdict":"PARTIAL"}';
  rows[0].payload.cwd = '/foreign'; fs.writeFileSync(file, rows.map(JSON.stringify).join('\n'));
  assert.throws(() => recoverCodexWorker(f.input, { invoke: f.invoke }), /identity mismatch/);
});

test('rejects unrelated rollout paths without reading them', t => {
  const f = fixture(t); f.thread.path = '/unrelated/auth.json';
  assert.throws(() => recoverCodexWorker(f.input, { invoke: f.invoke }), /rollout path/);
});
