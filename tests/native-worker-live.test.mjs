import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLiveRenderer, createStartupDiagnosticClassifier, liveWorkerTool, liveWorkerCommand, readLiveWorkerOutput } from '../native-worker-live.mjs';
import { parseNativeWorkerOutput } from '../native-solo-worker.mjs';

const wrapper = fileURLToPath(new URL('../native-worker-live.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(script) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-live-')));
  const runId = randomUUID();
  const base = path.join(project, '.agent-orchestra/dispatch', 'native-' + runId);
  fs.mkdirSync(path.dirname(base), { recursive: true, mode: 0o700 });
  const encoded = JSON.stringify({ project, runId, harness: 'codex', name: 'Review outcome', role: 'reviewer', model: 'fixture', binary: process.execPath, args: ['-e', script] });
  fs.writeFileSync(base + '.launch.json', encoded, { mode: 0o600 });
  const liveLaunchHash = hash(encoded);
  return { project, runId, base, liveLaunchHash, run: () => spawnSync(process.execPath, [wrapper, project, runId, liveLaunchHash], { encoding: 'utf8', timeout: 15000 }) };
}
test('dedicated registration is exact, unique and never falls back to another tool', () => {
  const tool = { id: 9, enabled: true, name: 'Orkestar Worker', toolType: 'generic', command: process.execPath };
  assert.equal(liveWorkerTool([tool]).id, 9);
  const spaced = '/Applications/Example App/bin/node';
  assert.equal(liveWorkerTool([{ ...tool, command: liveWorkerCommand(spaced) }], spaced).id, 9);
  assert.equal(spawnSync('/bin/sh', ['-c', 'printf %s ' + liveWorkerCommand(spaced)], { encoding: 'utf8' }).stdout, spaced);
  for (const tools of [[], [tool, tool], [{ ...tool, command: 'node' }], [{ ...tool, toolType: 'codex' }]]) assert.throws(() => liveWorkerTool(tools), /one-time setup/);
});
test('renderer shows bounded readable prose and usage, not command output or control sequences', () => {
  let output = ''; const render = createLiveRenderer(value => { output += value; });
  const raw = [
    { type: 'thread.started', thread_id: 'private-session-id' },
    { type: 'item.completed', item: { type: 'command_execution', command: 'secret command', aggregated_output: 'secret tool output' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Verified café. token=abc and ghp_abcdefghijklmnopqrstuvwx \u001b[31m' } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } },
  ].map(JSON.stringify).join('\n') + '\n';
  const bytes = Buffer.from(raw); for (const byte of bytes) render(Buffer.from([byte]));
  assert.match(output, /café/); assert.match(output, /Ran a project command/); assert.match(output, /Cached input: 80/);
  assert.doesNotMatch(output, /secret command|secret tool output|private-session-id|abc|ghp_abcdefghijklmnopqrstuvwx|\u001b|thread.started|Step 1/);
});
test('renderer preserves paragraphs and lists across multibyte chunks, and renders bounded structured worker evidence', () => {
  let output = ''; const render = createLiveRenderer(value => { output += value; });
  const result = JSON.stringify({ verdict: 'PARTIAL', reviewRunId: 'private-review-id', reviewedRunIds: ['also-private'],
    proof: [{ criterionId: 'badge-visible', result: 'passed', method: 'raw command --secret', evidence: 'private output' }],
    checks: ['Visible badge\n- tied leaders\n- positive votes'], security: ['No secret=abc leaked'], performance: ['No extra query'], blockers: ['Visual check remains blocked; github_pat_abcdefghijklmnopqrstuvwx is private'] });
  const rows = [{ type: 'thread.started', thread_id: 'private' }, { type: 'item.completed', item: { type: 'agent_message', text: 'First paragraph.\n\n- one\n- two\n\nSecond paragraph.' } }, { type: 'result', result }]
    .map(JSON.stringify).join('\n') + '\n';
  for (const byte of Buffer.from(rows)) render(Buffer.from([byte]));
  assert.match(output, /First paragraph\.\n\n- one\n- two\n\nSecond paragraph/);
  assert.match(output, /Worker-reported verdict: PARTIAL\. This is not final acceptance/);
  assert.match(output, /Proof badge-visible: passed/); assert.match(output, /Security: No secret=\[redacted\] leaked/);
  assert.doesNotMatch(output, /private-review-id|also-private|raw command|private output|github_pat_abcdefghijklmnopqrstuvwx/);
});
test('renderer handles Claude text, failures, and does not redact ordinary task-manager text', () => {
  let output = ''; const render = createLiveRenderer(value => { output += value; });
  const rows = [{ type: 'system', subtype: 'init' }, { type: 'assistant', message: { content: [{ type: 'text', text: 'Task-manager checked the tracker; gho_abcdefghijklmnopqrstuvwx stays private.' }, { type: 'tool_use', name: 'private' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'private' }] } }, { type: 'result', subtype: 'error', is_error: true, result: 'password=letmein' }].map(JSON.stringify).join('\n') + '\n';
  render(Buffer.from(rows));
  assert.match(output, /Task-manager checked the tracker/); assert.match(output, /Worker reported a failure/);
  assert.match(output, /password=\[redacted\]/); assert.doesNotMatch(output, /letmein|gho_abcdefghijklmnopqrstuvwx/);
});
test('real wrapper retains private exact raw evidence and verifies receipt binding', () => {
  const raw = [{ type: 'thread.started', thread_id: 'fixture' }, { type: 'item.completed', item: { type: 'agent_message', text: 'Verified outcome.' } }, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }].map(JSON.stringify).join('\n') + '\n';
  const f = fixture('process.stdout.write(' + JSON.stringify(raw) + ')');
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified outcome/); assert.doesNotMatch(result.stdout, /item.completed/);
  assert.deepEqual(readLiveWorkerOutput(f.project, f), { raw, diagnostic: false, truncated: false, exitCode: 0, rawTruncated: false, evidenceTruncated: false, streamInvalid: false });
  assert.equal(fs.statSync(f.base + '.raw').mode & 0o777, 0o600);
  assert.throws(() => readLiveWorkerOutput(f.project, { ...f, liveLaunchHash: '0'.repeat(64) }), /identity/);
});
test('oversized valid tool stream retains complete compact evidence and private raw prefix', () => {
  const f = fixture("for (const row of [{type:'thread.started',thread_id:'fixture'}, {type:'item.completed',item:{type:'command_execution',aggregated_output:'x'.repeat(1200000)}}, {type:'item.completed',item:{type:'agent_message',text:'Verified result'}}, {type:'turn.completed',usage:{input_tokens:100,output_tokens:10}}]) process.stdout.write(JSON.stringify(row)+'\\n')");
  const result = f.run(); assert.equal(result.status, 0);
  const evidence = readLiveWorkerOutput(f.project, f);
  assert.equal(evidence.rawTruncated, true); assert.equal(evidence.truncated, false);
  assert.equal(parseNativeWorkerOutput('codex', evidence.raw).complete, true);
  assert.equal(parseNativeWorkerOutput('codex', evidence.raw).result, 'Verified result');
  assert.ok(evidence.raw.length < 1000); assert.doesNotMatch(result.stdout, /xxxxxxxx/);
});
test('v1 completion remains readable without compact evidence', () => {
  const f = fixture(''); const raw = 'legacy raw'; fs.writeFileSync(f.base + '.raw', raw);
  fs.writeFileSync(f.base + '.output.json', JSON.stringify({ runId: f.runId, launchHash: f.liveLaunchHash, rawHash: hash(raw), diagnostic: false, truncated: false, exitCode: 0 }));
  assert.equal(readLiveWorkerOutput(f.project, f).raw, raw);
});
test('compact evidence tampering is rejected and malformed tails cannot become complete', () => {
  const raw = [{ type: 'thread.started', thread_id: 'fixture' }, { type: 'item.completed', item: { type: 'agent_message', text: 'Verified' } }, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }].map(JSON.stringify).join('\n') + '\n';
  const invalid = fixture('process.stdout.write(' + JSON.stringify(raw + 'malformed tail') + ')');
  assert.equal(invalid.run().status, 0);
  assert.equal(readLiveWorkerOutput(invalid.project, invalid).streamInvalid, true);
  assert.equal(readLiveWorkerOutput(invalid.project, invalid).truncated, true);
  const valid = fixture('process.stdout.write(' + JSON.stringify(raw) + '); process.exitCode=7');
  assert.equal(valid.run().status, 7);
  assert.equal(readLiveWorkerOutput(valid.project, valid).exitCode, 7);
  fs.appendFileSync(valid.base + '.evidence.jsonl', '\n');
  assert.throws(() => readLiveWorkerOutput(valid.project, valid), /evidence/);
});
test('capture limit never interrupts work and incomplete evidence remains explicitly truncated', () => {
  const f = fixture("process.stdout.write('x'.repeat(1100000)); setTimeout(() => { require('fs').writeFileSync('finished', 'yes'); }, 30)");
  const result = f.run(); assert.equal(result.status, 0);
  assert.equal(fs.readFileSync(path.join(f.project, 'finished'), 'utf8'), 'yes');
  assert.equal(fs.statSync(f.base + '.raw').size, 1024 * 1024);
  assert.equal(readLiveWorkerOutput(f.project, f).truncated, true);
  assert.match(result.stdout, /Work continues/);
});
test('native stderr is not printed and failing native exit stays failing', () => {
  const f = fixture("process.stderr.write('Bearer private-credential'); process.exitCode = 7");
  const result = f.run(); assert.equal(result.status, 7);
  assert.doesNotMatch(result.stdout + result.stderr, /private-credential/);
  assert.equal(readLiveWorkerOutput(f.project, f).diagnostic, true);
  assert.equal(readLiveWorkerOutput(f.project, f).exitCode, 7);
});
test('known startup diagnostic survives every chunk split without retaining secrets', () => {
  const message = 'Not inside a trusted directory and --skip-git-repo-check was not specified.';
  for (let split = 0; split <= message.length; split++) {
    const events = [], classifier = createStartupDiagnosticClassifier('codex', value => events.push(value));
    classifier.write(Buffer.from('Bearer secret-before\n' + message.slice(0, split)));
    classifier.write(Buffer.from(message.slice(split) + '\npassword=secret-after'));
    classifier.write(Buffer.from(message));
    assert.equal(events.length, 1); assert.equal(classifier.result().code, 'CODEX_TRUSTED_DIRECTORY_REQUIRED');
    assert.doesNotMatch(JSON.stringify(events) + JSON.stringify(classifier.result()), /secret-before|secret-after/);
  }
  const bounded = createStartupDiagnosticClassifier('codex'); bounded.write(Buffer.alloc(65536, 120)); bounded.write(Buffer.from(message));
  assert.equal(bounded.result(), null);
  const other = createStartupDiagnosticClassifier('claude'); other.write(Buffer.from(message)); assert.equal(other.result(), null);
});
test('wrapper saves and displays only allowlisted startup diagnostic and rejects tampering', () => {
  const message = 'Not inside a trusted directory and --skip-git-repo-check was not specified.';
  const f = fixture(`process.stderr.write('Bearer private-before\\n'+${JSON.stringify(message.slice(0, 27))}); setTimeout(()=>{process.stderr.write(${JSON.stringify(message.slice(27))}+'\\nsecret=private-after');process.exitCode=1},10)`);
  const result = f.run(); assert.equal(result.status, 1);
  const output = readLiveWorkerOutput(f.project, f);
  assert.equal(output.startupDiagnostic.code, 'CODEX_TRUSTED_DIRECTORY_REQUIRED');
  assert.match(result.stdout, /CODEX_TRUSTED_DIRECTORY_REQUIRED/);
  const saved = fs.readFileSync(f.base + '.output.json', 'utf8');
  assert.doesNotMatch(result.stdout + result.stderr + saved + fs.readFileSync(f.base + '.raw', 'utf8'), /private-before|private-after/);
  const altered = JSON.parse(saved); altered.startupDiagnostic.message = 'private-injected';
  fs.writeFileSync(f.base + '.output.json', JSON.stringify(altered));
  assert.throws(() => readLiveWorkerOutput(f.project, f), /Invalid startup diagnostic/);
});
