import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  createJsonLineReader, createParagraphRenderer, readableConductorEvent,
  safeConductorText, safeEvidenceRecord,
} from '../native-conductor-protocol.mjs';
import { appServerArgs, createConductor, openPrivateEvidence } from '../native-conductor-live.mjs';

function childFixture() {
  const stdout = new EventEmitter(); const stdin = new EventEmitter(); const child = new EventEmitter(); const writes = [];
  stdin.writable = true; stdin.destroyed = false;
  stdin.write = value => { writes.push(JSON.parse(value)); return true; };
  child.stdout = stdout; child.stdin = stdin; child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true; };
  return { child, stdout, stdin, writes };
}

function readyFixture(options = {}) {
  const fixture = childFixture(); const lines = [];
  const conductor = createConductor({ child: fixture.child, output: value => lines.push(value), projectPath: '/project', modelName: 'gpt-test', reasoningEffort: 'medium', instructionsBase64: Buffer.from('instructions').toString('base64'), ...options });
  conductor.initialize(); const initialize = fixture.writes.find(row => row.method === 'initialize');
  conductor.receive({ jsonrpc: '2.0', id: initialize.id, result: {} });
  return { ...fixture, lines, conductor };
}

const required = (extra = {}) => ({ itemId: 'item-1', startedAtMs: 1, threadId: 'thread-1', turnId: 'turn-1', ...extra });

test('streamed paragraphs redact across chunks, preserve UTF-8, and do not duplicate completed messages', () => {
  const lines = []; const renderer = createParagraphRenderer(value => lines.push(value));
  renderer.append('message-1', 'Čuvam prvi pasus with Bearer abc');
  renderer.append('message-1', 'defghijklmnop\n\nSecond paragraph.');
  renderer.complete('message-1', 'Čuvam prvi pasus with Bearer abcdefghijklmnop\n\nSecond paragraph.');
  assert.deepEqual(lines, ['Čuvam prvi pasus with [redacted]', 'Second paragraph.']);
  assert.equal(lines.join('\n').includes('abcdefghijklmnop'), false);
});

test('normal text is bounded, strips terminal controls, IDs, and credential-shaped values', () => {
  const id = ['12345678', '1234', '4123', '8123', '123456789012'].join('-');
  const value = safeConductorText(`hello\u001b[31m ${id} token=private-value`);
  assert.equal(value, 'hello [id] token=[redacted]');
  assert.deepEqual(safeEvidenceRecord({ authorization: 'Bearer private-value', nested: { text: 'password=hunter2' } }), { authorization: '[redacted]', nested: { text: 'password=[redacted]' } });
});

test('JSON line reader decodes split UTF-8 and fails visibly for malformed and oversized records', () => {
  const values = []; const reader = createJsonLineReader(value => values.push(value));
  const row = Buffer.from(`${JSON.stringify({ method: 'warning', params: { message: 'Čeka se odgovor.' } })}\n`);
  reader.write(row.subarray(0, 31)); reader.write(row.subarray(31)); reader.write(Buffer.from('{bad}\n')); reader.end();
  assert.equal(values[0].params.message, 'Čeka se odgovor.');
  assert.deepEqual(values[1], { type: 'failure', text: 'Codex app-server sent an invalid protocol record.' });
  const failures = []; const oversized = createJsonLineReader(() => {}, value => failures.push(value));
  oversized.write(Buffer.alloc(1024 * 1024 + 1, 97));
  assert.match(failures[0].text, /safety limit/);
});

test('readable events coalesce worker operations and preserve retry state semantics', () => {
  assert.deepEqual(readableConductorEvent({ method: 'item/started', params: { item: { type: 'mcpToolCall', id: 'm', tool: 'worker_status', status: 'inProgress' } } }), { type: 'activity', text: 'Checking worker progress.' });
  assert.equal(readableConductorEvent({ method: 'error', params: { willRetry: true, error: { message: 'temporary' }, threadId: 't', turnId: 'u' } }).type, 'retrying');
  assert.equal(readableConductorEvent({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'terminal' } } } }).terminal, true);
});

test('initialization acknowledgement, pending focus, steering, and interrupt use schema-correct requests', () => {
  const { conductor, writes } = readyFixture();
  assert.ok(writes.some(row => row.method === 'initialized' && row.id === undefined));
  conductor.line('first'); const threadStart = writes.find(row => row.method === 'thread/start');
  assert.equal(threadStart.params.model, 'gpt-test'); assert.equal(threadStart.params.developerInstructions, 'instructions');
  assert.equal(Object.hasOwn(threadStart.params, 'approvalPolicy'), false); assert.equal(Object.hasOwn(threadStart.params, 'sandbox'), false);
  conductor.receive({ id: threadStart.id, result: { thread: { id: 'thread-1' } } });
  const turnStart = writes.find(row => row.method === 'turn/start');
  assert.equal(turnStart.params.model, 'gpt-test'); assert.equal(turnStart.params.effort, 'medium');
  assert.equal(Object.hasOwn(turnStart.params, 'approvalPolicy'), false); assert.equal(Object.hasOwn(turnStart.params, 'sandboxPolicy'), false);
  conductor.line('focus before start');
  conductor.receive({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
  const steer = writes.find(row => row.method === 'turn/steer');
  assert.deepEqual(steer.params, { threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'focus before start' }] });
  conductor.line('/stop'); const interrupt = writes.find(row => row.method === 'turn/interrupt');
  assert.deepEqual(interrupt.params, { threadId: 'thread-1', turnId: 'turn-1' });
  conductor.line('continue after interrupt');
  assert.equal(writes.filter(row => row.method === 'turn/steer').length, 1);
  conductor.receive({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } });
  assert.ok(writes.some(row => row.method === 'turn/start' && row.params.input[0].text === 'continue after interrupt'));
});

test('commentary is not mistaken for a final answer and follow-up stays on the same thread', () => {
  const { conductor, writes, lines } = readyFixture();
  conductor.receive({ method: 'thread/started', params: { thread: { id: 'thread-1' } } });
  conductor.receive({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
  conductor.receive({ method: 'item/completed', params: { item: { id: 'commentary-1', type: 'agentMessage', phase: 'commentary', text: 'Still checking.' } } });
  conductor.receive({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
  assert.ok(lines.some(line => line.includes('completed without a final answer')));
  conductor.line('continue');
  assert.equal(writes.filter(row => row.method === 'thread/start').length, 0);
  assert.equal(writes.filter(row => row.method === 'turn/start').length, 1);
});

test('a failed steering race queues the exact user input for the next turn', () => {
  const { conductor, writes, lines } = readyFixture();
  conductor.receive({ method: 'thread/started', params: { thread: { id: 'thread-1' } } });
  conductor.receive({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
  conductor.line('preserve this update'); const steer = writes.find(row => row.method === 'turn/steer');
  conductor.receive({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } });
  conductor.receive({ id: steer.id, error: { code: -32000, message: 'turn is no longer active' } });
  const next = writes.filter(row => row.method === 'turn/start').at(-1);
  assert.equal(next.params.input[0].text, 'preserve this update');
  assert.ok(lines.some(line => line.includes('queued for the next turn')));
});

test('retry notifications retain the active turn and interruption permits continuation', () => {
  const { conductor, writes, lines } = readyFixture();
  conductor.receive({ method: 'thread/started', params: { thread: { id: 'thread-1' } } });
  conductor.receive({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
  conductor.receive({ method: 'error', params: { willRetry: true, error: { message: 'temporary' }, threadId: 'thread-1', turnId: 'turn-1' } });
  conductor.receive({ method: 'error', params: { willRetry: true, error: { message: 'temporary' }, threadId: 'thread-1', turnId: 'turn-1' } });
  conductor.line('steer while retrying'); assert.ok(writes.some(row => row.method === 'turn/steer'));
  assert.equal(lines.filter(line => line.startsWith('[RETRYING]')).length, 1);
  conductor.receive({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } });
  conductor.line('new turn'); assert.ok(writes.some(row => row.method === 'turn/start' && row.params.input[0].text === 'new turn'));
});

test('command, file, and permission approvals preserve exact decision scope', () => {
  const { conductor, writes, lines } = readyFixture();
  conductor.receive({ id: 40, method: 'item/commandExecution/requestApproval', params: required({ command: 'git status', cwd: '/project' }) });
  conductor.line('/approve-session');
  assert.deepEqual(writes.at(-1), { jsonrpc: '2.0', id: 40, result: { decision: 'acceptForSession' } });
  conductor.receive({ id: 41, method: 'item/fileChange/requestApproval', params: required({ reason: 'Update file' }) });
  conductor.line('/decline');
  assert.deepEqual(writes.at(-1), { jsonrpc: '2.0', id: 41, result: { decision: 'decline' } });
  const permissions = { fileSystem: { entries: [
    { access: 'read', path: { type: 'path', path: '/project/config' } },
    { access: 'write', path: { type: 'special', value: { kind: 'root' } } },
    { access: 'deny', path: { type: 'glob_pattern', pattern: '**/.env' } },
  ] }, network: { enabled: true } };
  conductor.receive({ id: 42, method: 'item/permissions/requestApproval', params: required({ cwd: '/project', permissions }) });
  assert.ok(lines.some(line => line.includes('Filesystem read: /project/config')));
  assert.ok(lines.some(line => line.includes('Filesystem write: / (filesystem root)')));
  assert.ok(lines.some(line => line.includes('Filesystem deny: glob **/.env')));
  assert.ok(lines.some(line => line.includes('Network access: enabled')));
  conductor.line('/approve-session');
  assert.deepEqual(writes.at(-1), { jsonrpc: '2.0', id: 42, result: { permissions, scope: 'session' } });
  conductor.receive({ id: 43, method: 'item/permissions/requestApproval', params: required({ cwd: '/project',
    permissions: { fileSystem: { entries: [{ access: 'execute', path: { type: 'path', path: '/project' } }] } } }) });
  assert.equal(writes.at(-1).id, 43); assert.equal(writes.at(-1).error.code, -32602);
  conductor.receive({ id: 44, method: 'item/permissions/requestApproval', params: required({ cwd: '/project',
    permissions: { network: { enabled: true, domains: ['example.com'] } } }) });
  assert.equal(writes.at(-1).id, 44); assert.equal(writes.at(-1).error.code, -32602);
});

test('questions preserve free text, accept multiple questions one at a time, and reject secrets', () => {
  const { conductor, writes, lines } = readyFixture();
  conductor.receive({ id: 50, method: 'item/tool/requestUserInput', params: required({ isBlocking: true, questions: [
    { id: 'scope', header: 'Scope', question: 'Choose scope' },
    { id: 'risk', header: 'Risk', question: 'Choose risk' },
  ] }) });
  conductor.line('/answer extra=value'); assert.equal(writes.some(row => row.id === 50), false);
  conductor.line('/answer scope=small; precise=✓'); assert.equal(writes.some(row => row.id === 50), false);
  conductor.line('/answer risk=low=medium; Unicode ✓');
  assert.deepEqual(writes.at(-1).result.answers, {
    scope: { answers: ['small; precise=✓'] }, risk: { answers: ['low=medium; Unicode ✓'] },
  });
  conductor.receive({ id: 52, method: 'item/tool/requestUserInput', params: required({ isBlocking: true, questions: [
    { id: 'note', header: 'Note', question: 'Add a note' },
  ] }) });
  conductor.line('/answer note=a;b=c — zdravo');
  assert.deepEqual(writes.at(-1).result.answers, { note: { answers: ['a;b=c — zdravo'] } });
  conductor.receive({ id: 51, method: 'item/tool/requestUserInput', params: required({ isBlocking: true, questions: [
    { id: 'credential', header: 'Credential', question: 'Enter value', isSecret: true },
  ] }) });
  assert.equal(writes.at(-1).id, 51); assert.equal(writes.at(-1).error.code, -32002);
  assert.ok(lines.some(line => line.includes('cannot safely accept a secret')));
  assert.equal(lines.some(line => line.includes('Enter value')), false);
});

test('unknown and malformed required server requests fail closed', () => {
  const { conductor, writes, lines } = readyFixture();
  conductor.receive({ id: 60, method: 'item/commandExecution/requestApproval', params: { command: 'git status' } });
  assert.equal(writes.at(-1).error.code, -32602);
  conductor.receive({ id: 61, method: 'unknown/request', params: {} });
  assert.equal(writes.at(-1).error.code, -32601);
  assert.ok(lines.some(line => line.includes('Invalid Codex request'))); assert.ok(lines.some(line => line.includes('Unsupported Codex request')));
});

test('RPC timeouts and child transport failures are visible', async () => {
  const fixture = childFixture(); const lines = [];
  const conductor = createConductor({ child: fixture.child, output: value => lines.push(value), rpcTimeoutMs: 10 });
  conductor.initialize(); await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(lines.some(line => line.includes('initialize timed out')));
  const second = readyFixture(); second.stdin.emit('error', new Error('broken pipe'));
  assert.ok(second.lines.some(line => line.includes('could not send a request')));
});

test('private evidence rejects a symlinked .agent-orchestra ancestor', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkestar-conductor-symlink-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'); const outside = path.join(root, 'outside'); fs.mkdirSync(project); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(project, '.agent-orchestra'));
  assert.throws(() => openPrivateEvidence(fs.realpathSync(project), 'marker'), /Unsafe conductor evidence path/);
});

test('private evidence stops at its one-megabyte cap and closes on child exit', t => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orkestar-conductor-cap-'))); t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const evidence = openPrivateEvidence(project, 'cap'); const fixture = childFixture();
  const conductor = createConductor({ child: fixture.child, evidenceFd: evidence.fd, output: () => {} });
  for (let index = 0; index < 100; index += 1) conductor.receive({ method: 'warning', params: { message: 'x'.repeat(12_000), index } });
  fixture.child.emit('exit', 0);
  assert.ok(fs.statSync(evidence.file).size <= 1024 * 1024);
  assert.throws(() => fs.writeSync(evidence.fd, 'closed'), /bad file descriptor/i);
});

test('app-server arguments preserve project trust while disabling apps and native multi-agent', () => {
  const args = appServerArgs('/project');
  assert.deepEqual(args.slice(0, 2), ['app-server', '--stdio']);
  assert.ok(args.includes('projects={"/project"={trust_level="trusted"}}'));
  assert.deepEqual(args.filter(value => value === 'apps' || value === 'multi_agent'), ['apps', 'multi_agent']);
});

test('the conductor entrypoint runs from a path with spaces', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkestar conductor entrypoint-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = fs.realpathSync(root);
  const entrypoint = path.join(project, 'native conductor live.mjs');
  fs.copyFileSync(fileURLToPath(new URL('../native-conductor-live.mjs', import.meta.url)), entrypoint);
  fs.copyFileSync(fileURLToPath(new URL('../native-conductor-protocol.mjs', import.meta.url)), path.join(project, 'native-conductor-protocol.mjs'));
  const result = spawnSync(process.execPath, [entrypoint, '--project', project, '--codex', process.execPath, '--model', 'fixture',
    '--instructions-base64', Buffer.from('bounded instructions').toString('base64'), '--marker', 'space-test'], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[STARTING\] Lenka route: fixture\./, result.stderr);
});

test('the conductor module imports safely from standard input', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    cwd: path.resolve(import.meta.dirname, '..'), input: "import './native-conductor-live.mjs';\n", encoding: 'utf8', timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('portable Node child proves readable initial, approval, follow-up, and private evidence boundaries', async t => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orkestar-conductor-process-'))); t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const fake = path.join(project, 'fake-codex.mjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args[0] !== 'app-server' || !args.includes('--stdio') || !args.includes('apps') || !args.includes('multi_agent')) process.exit(4);
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let initialized = false; let turn = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (row.method === 'initialize') return send({ jsonrpc: '2.0', id: row.id, result: { userAgent: 'fake' } });
  if (row.method === 'initialized') { initialized = true; return; }
  if (row.method === 'thread/start') {
    if (!initialized || row.params.model !== 'gpt-test' || row.params.approvalPolicy || row.params.sandbox) process.exit(5);
    return send({ jsonrpc: '2.0', id: row.id, result: { thread: { id: 'thread-1' } } });
  }
  if (row.method === 'turn/start') {
    if (row.params.model !== 'gpt-test' || row.params.effort !== 'medium' || row.params.approvalPolicy || row.params.sandboxPolicy) process.exit(6);
    turn += 1; const turnId = 'turn-' + turn; send({ jsonrpc: '2.0', id: row.id, result: { turn: { id: turnId } } });
    send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: turnId, status: 'inProgress', items: [] } } });
    if (turn === 1) {
      send({ method: 'item/started', params: { threadId: 'thread-1', turnId, item: { id: 'worker-1', type: 'mcpToolCall', tool: 'worker_status', server: 'orkestar_worker', status: 'inProgress', arguments: {} } } });
      send({ method: 'item/completed', params: { threadId: 'thread-1', turnId, completedAtMs: 2, item: { id: 'worker-1', type: 'mcpToolCall', tool: 'worker_status', server: 'orkestar_worker', status: 'completed', arguments: {} } } });
      return send({ jsonrpc: '2.0', id: 900, method: 'item/commandExecution/requestApproval', params: { itemId: 'command-1', startedAtMs: 1, threadId: 'thread-1', turnId, command: 'git status', cwd: ${JSON.stringify(project)} } });
    }
    if (turn === 3) return send({ method: 'item/started', params: { threadId: 'thread-1', turnId, startedAtMs: 3, item: { id: 'long-command', type: 'commandExecution', command: 'long-running', commandActions: [], cwd: ${JSON.stringify(project)}, status: 'inProgress' } } });
    const finalText = turn === 2 ? 'Follow-up finished.' : 'Continued after interruption.';
    send({ method: 'item/completed', params: { threadId: 'thread-1', turnId, completedAtMs: 3, item: { id: 'final-' + turn, type: 'agentMessage', phase: 'final_answer', text: finalText } } });
    return send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } } });
  }
  if (row.method === 'turn/interrupt') {
    send({ jsonrpc: '2.0', id: row.id, result: {} });
    return send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: row.params.turnId, status: 'interrupted' } } });
  }
  if (row.id === 900) {
    if (row.result?.decision !== 'decline') process.exit(7);
    const turnId = 'turn-1';
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId, itemId: 'final-1', delta: 'First paragraph with Bearer abc' } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId, itemId: 'final-1', delta: 'defghijklmnop\\n\\nSecond paragraph.' } });
    send({ method: 'item/completed', params: { threadId: 'thread-1', turnId, completedAtMs: 3, item: { id: 'final-1', type: 'agentMessage', phase: 'final_answer', text: 'First paragraph with Bearer abcdefghijklmnop\\n\\nSecond paragraph.' } } });
    return send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } } });
  }
});
`);
  // Execute the real conductor protocol against a portable Node child. This
  // avoids relying on POSIX shebang execution for the fake app-server.
  const actual = spawn(process.execPath, [fake, ...appServerArgs(project)], { cwd: project, stdio: ['pipe', 'pipe', 'pipe'] });
  const evidence = openPrivateEvidence(project, 'process-test');
  const evidenceFile = evidence.file;
  const evidenceFd = evidence.fd;
  const lines = []; const errors = []; let completedTurns = 0; let sentDecision = false; let sentSignal = false; let continued = false; let conductor;
  const exit = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { actual.kill(); reject(new Error(`conductor process timed out\n${lines.join('\n')}\n${errors.join('')}`)); }, 5_000);
    conductor = createConductor({ child: actual, evidenceFd, projectPath: project, modelName: 'gpt-test', reasoningEffort: 'medium',
      instructionsBase64: Buffer.from('bounded instructions').toString('base64'), onExit: status => { clearTimeout(timer); resolve(status); }, output: line => {
        lines.push(line);
        if (line.includes('Lenka is ready')) conductor.line('initial request');
        else if (line.startsWith('[APPROVAL]') && !sentDecision) { sentDecision = true; conductor.line('/decline'); }
        else if (line === '[ACTIVITY] Running a project command.' && !sentSignal) { sentSignal = true; conductor.interrupt(); }
        else if (line.includes('[INTERRUPTED]') && !continued) { continued = true; conductor.line('continue after interruption'); }
        else if (line.startsWith('[READY] Turn finished')) {
          completedTurns += 1;
          if (completedTurns === 1) conductor.line('follow-up request');
          else if (completedTurns === 2) conductor.line('long request');
          else conductor.line('/quit');
        }
      } });
    conductor.initialize();
  });
  actual.stderr.on('data', chunk => errors.push(String(chunk)));
  const status = await exit;
  assert.equal(status.expected, true, errors.join(''));
  assert.equal(lines.filter(line => line === '[ACTIVITY] Checking worker progress.').length, 1);
  assert.equal(lines.filter(line => line.startsWith('First paragraph with')).length, 1);
  assert.ok(lines.includes('First paragraph with [redacted]')); assert.ok(lines.includes('Second paragraph.')); assert.ok(lines.includes('Follow-up finished.'));
  assert.ok(lines.includes('Continued after interruption.')); assert.equal(sentSignal, true); assert.equal(continued, true);
  assert.equal(lines.join('\n').includes('abcdefghijklmnop'), false); assert.equal(lines.join('\n').includes('jsonrpc'), false);
  assert.equal(completedTurns, 3);
  const stat = fs.statSync(evidenceFile);
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600); assert.ok(stat.size <= 1024 * 1024);
  const evidenceText = fs.readFileSync(evidenceFile, 'utf8');
  assert.equal(evidenceText.includes('abcdefghijklmnop'), false); assert.ok(evidenceText.includes('[streamed text omitted]'));
});

test('POSIX conductor entrypoint forwards an interrupt to its app-server and quits cleanly', { skip: process.platform === 'win32' && 'requires POSIX shebang and terminal signal handling' }, async t => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orkestar-conductor-signal-'))); t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const fake = path.join(project, 'signal-codex.mjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node
import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (row.method === 'initialize') return send({ jsonrpc: '2.0', id: row.id, result: {} });
  if (row.method === 'thread/start') return send({ jsonrpc: '2.0', id: row.id, result: { thread: { id: 'thread-1' } } });
  if (row.method === 'turn/start') { send({ jsonrpc: '2.0', id: row.id, result: { turn: { id: 'turn-1' } } }); return send({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'command-1', type: 'commandExecution', command: 'wait', status: 'inProgress' } } }); }
  if (row.method === 'turn/interrupt') { send({ jsonrpc: '2.0', id: row.id, result: {} }); return send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } }); }
});
`);
  fs.chmodSync(fake, 0o700);
  const command = [process.execPath, path.resolve('native-conductor-live.mjs'), '--project', project, '--codex', fake,
    '--model', 'gpt-test', '--instructions-base64', Buffer.from('bounded instructions').toString('base64'), '--marker', 'signal-test'];
  const pty = path.join(project, 'pty-runner.py');
  if (process.platform === 'darwin') fs.writeFileSync(pty, `import os, pty, select, sys
pid, master = pty.fork()
if pid == 0: os.execv(sys.argv[1], sys.argv[1:])
stdin, open_ = sys.stdin.fileno(), True
while True:
  ready = select.select([master] + ([stdin] if open_ else []), [], [])[0]
  if master in ready:
    data = os.read(master, 4096)
    if not data: break
    os.write(sys.stdout.fileno(), data)
  if open_ and stdin in ready:
    data = os.read(stdin, 4096)
    if data: os.write(master, data)
    else: os.write(master, b'\\x04'); open_ = False
_, status = os.waitpid(pid, 0)
raise SystemExit(os.waitstatus_to_exitcode(status))
`);
  const actual = process.platform === 'darwin'
    ? spawn('/usr/bin/python3', [pty, ...command], { cwd: project, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(command[0], command.slice(1), { cwd: project, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = []; let interrupted = false;
  readline.createInterface({ input: actual.stdout }).on('line', line => {
    lines.push(line);
    if (line.includes('Lenka is ready')) actual.stdin.write('start\n');
    else if (line === '[ACTIVITY] Running a project command.') {
      if (process.platform === 'darwin') actual.stdin.write('\x03'); else actual.kill('SIGINT');
    } else if (line.includes('[INTERRUPTED]') && !interrupted) { interrupted = true; actual.stdin.write('/quit\n'); }
  });
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { actual.kill(); reject(new Error(`conductor signal process timed out: ${lines.join('\n')}`)); }, 5_000);
    actual.on('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exit, 0); assert.equal(interrupted, true); assert.ok(lines.includes('[ACTIVITY] Running a project command.'));
});

test('spawned conductor exits on idle quit and reports an unexpected app-server crash', async t => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orkestar-conductor-exit-'))); t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const fake = path.join(project, 'crashing-codex.mjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node
import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (row.method === 'initialize') return send({ jsonrpc: '2.0', id: row.id, result: {} });
  if (row.method === 'initialized') process.exit(17);
});
`);
  const actual = spawn(process.execPath, [fake, ...appServerArgs(project)], { cwd: project, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { actual.kill(); reject(new Error('crashing conductor did not exit')); }, 2_000);
    const conductor = createConductor({ child: actual, projectPath: project, modelName: 'gpt-test', output: line => stdout.push(line),
      onExit: status => { clearTimeout(timer); resolve(status); } });
    conductor.initialize();
  });
  assert.equal(exit.expected, false);
  assert.match(stdout.join(''), /\[FAILED\] The Codex app-server stopped unexpectedly \(exit 17\)\./);
});
