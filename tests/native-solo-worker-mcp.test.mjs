import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWorkerMcpHandler, serveWorkerMcp, parseWorkerMcpLaunch, MAX_FRAME } from '../native-solo-worker-mcp.mjs';

const project = () => fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'worker-mcp-')));
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const call = (id, name, args) => request(id, 'tools/call', { name, arguments: args });
const draft = { schemaVersion: 1, goal: 'Inspect only the project README', required: [{ id: 'R1', text: 'Return README evidence' }],
  localDecisions: [], outOfScope: ['Changes'], discoveryPolicy: 'report-only',
  changeSurface: { modules: [], fileKinds: [], migrationsAllowed: false, dependenciesAllowed: false, architectureChangesAllowed: false } };
const runId = 'a1234567-1234-4123-8123-123456789012';
async function ready(handle) {
  const init = await handle(request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }));
  assert.equal(init.result.protocolVersion, '2025-06-18');
  await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

test('auditor dispatch returns actionable review coverage before launching paid work', async () => {
  let launches = 0;
  const handle = createWorkerMcpHandler({ project: project(), harness: 'codex' }, { api: { dispatchNativeSoloWorker: () => { launches++; } } });
  await ready(handle);
  const created = await handle(call(2, 'worker_contract', draft));
  const contract = JSON.parse(created.result.content[0].text);
  const response = await handle(call(3, 'worker_dispatch', { profile: 'project-audit', name: 'Independent auditor', runId, contract,
    task: { goal: 'Audit the contract evidence', evidence: ['Independent acceptance'] } }));
  assert.equal(response.result.isError, true);
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.code, 'REVIEW_COVERAGE_REQUIRED');
  assert.equal(result.reviewCoverage.ready, false);
  assert.match(result.reviewCoverage.nextAction, /collect its result/);
  assert.equal(launches, 0);
});

test('worker UUID validation explains invalid dispatch and report IDs without executing work', async () => {
  let calls = 0;
  const handle = createWorkerMcpHandler({ project: project(), harness: 'codex' }, { api: {
    dispatchNativeSoloWorker: () => { calls++; }, nativeSoloWorkerStatus: () => { calls++; },
  } });
  await ready(handle);
  const tools = (await handle(request(2, 'tools/list'))).result.tools;
  assert.match(tools.find(tool => tool.name === 'worker_dispatch').inputSchema.properties.runId.description, /lowercase UUID/);
  for (const [name, args, field] of [
    ['worker_dispatch', { runId: 'meetup-picks-design' }, 'runId'],
    ['worker_status', { runId: 'PRIVATE_TOKEN_VALUE' }, 'runId'],
    ['worker_result', {}, 'runId'],
    ['worker_report', { reportId: 'meetup-report' }, 'reportId'],
    ['worker_report', { reportId: runId, workerRunIds: ['meetup-design'] }, 'workerRunIds'],
  ]) {
    const result = await handle(call(3, name, args));
    assert.equal(result.error.code, -32602);
    assert.ok(result.error.message.includes(field));
    assert.match(result.error.message, /UUID/);
    assert.doesNotMatch(result.error.message, /PRIVATE_TOKEN_VALUE/);
  }
  assert.equal(calls, 0);
});

test('MCP Taskavel profile carries a closed authorization charter without accepting endpoint or model overrides', async () => {
  const root = project(), dispatched = [];
  const handle = createWorkerMcpHandler({ project: root, harness: 'claude' }, { api: {
    dispatchNativeSoloWorker: args => { dispatched.push(args); return { role: 'task-manager', acceptance: 'PARTIAL' }; },
  } });
  await ready(handle);
  const created = await handle(call(2, 'worker_contract', draft));
  const contract = JSON.parse(created.result.content[0].text);
  const authorization = { projectId: 25, taskIds: [41], operations: ['read'], externalWriteAuthorized: false };
  const args = { profile: 'taskavel', name: 'Tracker reader', runId, contract,
    task: { goal: 'Read authorized task', evidence: ['Native task readback'], taskavel: authorization } };
  const result = await handle(call(3, 'worker_dispatch', args));
  assert.equal(result.result.isError, false);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].harness, 'claude'); assert.equal(dispatched[0].project, root);
  assert.deepEqual(dispatched[0].task.taskavel, authorization);
  for (const extra of [{ url: 'https://foreign.example' }, { token: 'not-accepted' }, { model: 'unapproved' }]) {
    const rejected = await handle(call(4, 'worker_dispatch', { ...args, task: { ...args.task, taskavel: { ...authorization, ...extra } } }));
    assert.equal(rejected.error.code, -32602);
  }
  assert.equal((await handle(call(5, 'worker_dispatch', { ...args, task: { ...args.task, taskavel: { ...authorization, operations: ['delete-task'] } } }))).error.code, -32602);
  assert.equal(dispatched.length, 1);
});

test('Taskavel phase and local-write mistakes return actionable errors before dispatch', async () => {
  let calls = 0;
  const handle = createWorkerMcpHandler({ project: project(), harness: 'codex' }, { api: { dispatchNativeSoloWorker: () => { calls++; } } });
  await ready(handle);
  const contract = JSON.parse((await handle(call(2, 'worker_contract', draft))).result.content[0].text);
  const base = { profile: 'taskavel', name: 'Tracker', runId, contract, task: { goal: 'Create scoped project', evidence: ['Native readback'],
    taskavel: { projectId: null, projectName: 'Exact Demo', taskIds: [], operations: ['create-project'], externalWriteAuthorized: true } } };
  const cases = [
    [{ ...base.task, requiresWrite: true }, 'TASKAVEL_LOCAL_WRITE_FLAG', /requiresWrite:false/],
    [{ ...base.task, taskavel: { ...base.task.taskavel, operations: ['create-project', 'create-task'] } }, 'TASKAVEL_SEPARATE_CREATION', /separate assignment/],
    [{ ...base.task, taskavel: { ...base.task.taskavel, operations: ['move-task'] } }, 'TASKAVEL_RESOLVED_TASKS_REQUIRED', /actual numeric task IDs/],
  ];
  for (const [task, category, message] of cases) {
    const result = await handle(call(3, 'worker_dispatch', { ...base, task }));
    assert.equal(result.result.isError, true);
    const failure = JSON.parse(result.result.content[0].text);
    assert.equal(failure.category, category); assert.match(failure.message, message);
  }
  assert.equal(calls, 0);
});

test('read-only tester rejects write flag with safe recovery instruction and no dispatch', async () => {
  let calls = 0;
  const handle = createWorkerMcpHandler({ project: project(), harness: 'codex' }, { api: { dispatchNativeSoloWorker: () => { calls++; return { readOnly: true }; } } });
  await ready(handle);
  const contract = JSON.parse((await handle(call(2, 'worker_contract', draft))).result.content[0].text);
  const args = { profile: 'project-test', name: 'Independent tester', runId, contract,
    task: { goal: 'PRIVATE_INPUT inspect verification', evidence: ['Coverage and execution evidence'], requiresWrite: true } };
  const result = await handle(call(3, 'worker_dispatch', args));
  assert.equal(result.result.isError, true);
  const failure = JSON.parse(result.result.content[0].text);
  assert.equal(failure.category, 'READ_ONLY_TESTER');
  assert.match(failure.message, /requiresWrite:false/);
  assert.match(failure.message, /builder apply test edits/);
  assert.match(failure.message, /independently/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_INPUT/);
  assert.equal(calls, 0);
  const corrected = await handle(call(4, 'worker_dispatch', { ...args, task: { ...args.task, requiresWrite: false } }));
  assert.equal(corrected.result.isError, false);
  assert.equal(calls, 1);
});

test('coordination schema accepts multiline content without allowing control bytes or multiline names', async () => {
  const handle = createWorkerMcpHandler({ project: project(), harness: 'codex' }); await ready(handle);
  const args = { key: 'proof', name: 'Proof', content: 'First line\n\nSecond line' };
  // The fresh fixture deliberately has no Solo binding: passing schema validation
  // reaches the bounded setup error rather than an invalid-input JSON-RPC error.
  const accepted = await handle(call(2, 'coord_scratchpad_create', args));
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.result.isError, true);
  assert.equal((await handle(call(3, 'coord_scratchpad_create', { ...args, name: 'Bad\nName' }))).error.code, -32602);
  assert.equal((await handle(call(4, 'coord_scratchpad_create', { ...args, content: 'Bad\u001binput' }))).error.code, -32602);
  assert.equal((await handle(call(5, 'worker_contract', { ...draft, goal: 'Bad\nGoal' }))).error.code, -32602);
});

test('contract requirement schema rejects prose IDs and categorizes duplicate R IDs', async () => {
  const handle = createWorkerMcpHandler({ project: project(), harness: 'codex' }); await ready(handle);
  const bad = await handle(call(2, 'worker_contract', { ...draft, required: [{ id: 'readme-marker', text: 'Proof' }] }));
  assert.equal(bad.error.code, -32602);
  const duplicate = await handle(call(3, 'worker_contract', { ...draft, required: [draft.required[0], draft.required[0]] }));
  assert.equal(JSON.parse(duplicate.result.content[0].text).category, 'INVALID_CONTRACT');
});

test('MCP closed contract creation and dispatch derive trusted project/harness', async () => {
  const root = project(), calls = [];
  const handle = createWorkerMcpHandler({ project: root, harness: 'codex' }, { api: { dispatchNativeSoloWorker: options => { calls.push(options); return { processId: 42, acceptance: 'PARTIAL' }; } } });
  assert.equal((await handle(request(0, 'tools/list'))).error.code, -32002);
  await ready(handle);
  const listed = (await handle(request(2, 'tools/list'))).result.tools;
  assert.equal(listed.length, 14);
  assert.match(listed.find(tool => tool.name === 'worker_dispatch').description, /ui-verify requires the explicitly preinstalled pinned browser gateway/);
  const created = await handle(call(3, 'worker_contract', draft));
  const contract = JSON.parse(created.result.content[0].text);
  assert.match(contract.hash, /^sha256:/);
  const file = path.join(root, '.agent-orchestra/runs', contract.id, 'task-contract.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), contract);
  assert.equal((await handle(call(4, 'worker_contract', draft))).result.isError, false);
  const args = { profile: 'project-read', name: 'README inspector', runId, contract, task: { goal: 'Read README', evidence: ['README summary'] } };
  assert.equal((await handle(call(5, 'worker_dispatch', { ...args, model: 'unapproved' }))).error.code, -32602);
  assert.equal((await handle(call(6, 'worker_dispatch', { ...args, profile: 'browser' }))).error.code, -32602);
  assert.equal((await handle(call(7, 'worker_dispatch', args))).result.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].project, root); assert.equal(calls[0].harness, 'codex');
  assert.equal(calls[0].ownerSessionId, `dispatch:${runId}`);
  fs.writeFileSync(file, 'user changed contract');
  assert.equal((await handle(call(8, 'worker_dispatch', args))).result.isError, true);
  assert.equal(calls.length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), 'user changed contract');
});

test('the thirteenth worker is rejected before paid dispatch', async () => {
  const root = project(), launches = [];
  const dispatchDirectory = path.join(root, '.agent-orchestra', 'dispatch');
  const handle = createWorkerMcpHandler({ project: root, harness: 'codex' }, { api: {
    dispatchNativeSoloWorker: options => {
      launches.push(options.runId);
      fs.mkdirSync(dispatchDirectory, { recursive: true });
      fs.writeFileSync(path.join(dispatchDirectory, `native-${options.runId}.json`), JSON.stringify({
        project: root, harness: 'codex', contractId: options.task.contract.id, runId: options.runId,
      }));
      return { processId: launches.length, acceptance: 'PARTIAL' };
    },
  } });
  await ready(handle);
  const contract = JSON.parse((await handle(call(2, 'worker_contract', draft))).result.content[0].text);
  for (let index = 1; index <= 12; index++) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const response = await handle(call(index + 2, 'worker_dispatch', { profile: 'project-read', name: `Reader ${index}`,
      runId: id, contract, task: { goal: 'Read bounded project evidence', evidence: ['Bounded result'] } }));
    assert.equal(response.result.isError, false);
  }
  const rejected = await handle(call(20, 'worker_dispatch', { profile: 'project-read', name: 'Reader 13',
    runId: '00000000-0000-4000-8000-000000000013', contract,
    task: { goal: 'Read bounded project evidence', evidence: ['Bounded result'] } }));
  assert.equal(rejected.result.isError, true);
  assert.equal(JSON.parse(rejected.result.content[0].text).category, 'SESSION_BUDGET_EXCEEDED');
  assert.equal(launches.length, 12);
});

test('independent MCP handlers cannot race past the worker-session ceiling', async () => {
  const root = project(), launches = [], releases = [];
  const dispatchDirectory = path.join(root, '.agent-orchestra', 'dispatch');
  const api = {
    dispatchNativeSoloWorker: options => new Promise(resolve => {
      launches.push(options.runId);
      releases.push(() => {
        fs.mkdirSync(dispatchDirectory, { recursive: true });
        fs.writeFileSync(path.join(dispatchDirectory, `native-${options.runId}.json`), JSON.stringify({
          project: root, harness: 'codex', contractId: options.task.contract.id, runId: options.runId,
        }));
        resolve({ processId: launches.length, acceptance: 'PARTIAL' });
      });
    }),
  };
  const firstHandle = createWorkerMcpHandler({ project: root, harness: 'codex' }, { api });
  const secondHandle = createWorkerMcpHandler({ project: root, harness: 'codex' }, { api });
  await ready(firstHandle); await ready(secondHandle);
  const contract = JSON.parse((await firstHandle(call(2, 'worker_contract', draft))).result.content[0].text);
  fs.mkdirSync(dispatchDirectory, { recursive: true });
  for (let index = 1; index <= 11; index++) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    fs.writeFileSync(path.join(dispatchDirectory, `native-${id}.json`), JSON.stringify({
      project: root, harness: 'codex', contractId: contract.id, runId: id,
    }));
  }
  const assignment = index => ({ profile: 'project-read', name: `Reader ${index}`,
    runId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, contract,
    task: { goal: 'Read bounded project evidence', evidence: ['Bounded result'] } });
  const first = firstHandle(call(20, 'worker_dispatch', assignment(12)));
  await new Promise(resolve => setImmediate(resolve));
  const second = await secondHandle(call(21, 'worker_dispatch', assignment(13)));
  assert.equal(second.result.isError, true);
  assert.equal(JSON.parse(second.result.content[0].text).category, 'SESSION_BUDGET_EXCEEDED');
  assert.equal(launches.length, 1);
  releases[0]();
  assert.equal((await first).result.isError, false);
});

test('a ready wave dispatches every independent worker before waiting', async () => {
  const root = project(), events = [], releases = [];
  const handle = createWorkerMcpHandler({ project: root, harness: 'codex' }, { api: {
    dispatchNativeSoloWorker: options => new Promise(resolve => {
      events.push(`dispatch:${options.name}`); releases.push(() => resolve({ processId: releases.length, acceptance: 'PARTIAL' }));
    }),
    nativeSoloWorkerStatus: () => { events.push('wait'); return { state: 'running' }; },
  } });
  await ready(handle);
  const contract = JSON.parse((await handle(call(2, 'worker_contract', draft))).result.content[0].text);
  const assignments = ['Backend', 'Frontend', 'Docs'].map((name, index) => ({ profile: 'project-read', name,
    runId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, contract,
    task: { goal: `Inspect ${name}`, evidence: [`${name} evidence`] } }));
  const wave = handle(call(3, 'worker_dispatch_wave', { assignments }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['dispatch:Backend', 'dispatch:Frontend', 'dispatch:Docs']);
  releases.forEach(release => release());
  assert.equal((await wave).result.isError, false);
  await handle(call(4, 'worker_status', { runId: assignments[0].runId }));
  assert.equal(events.at(-1), 'wait');
});

test('a writer wave requires safe disjoint ownership before any launch', async () => {
  const root = project(), launches = [];
  const handle = createWorkerMcpHandler({ project: root, harness: 'codex' }, { api: {
    dispatchNativeSoloWorker: options => { launches.push(options); return { processId: launches.length, acceptance: 'PARTIAL' }; },
  } });
  await ready(handle);
  const contract = JSON.parse((await handle(call(2, 'worker_contract', draft))).result.content[0].text);
  const writer = (index, paths) => ({ profile: 'project-write', name: `Writer ${index}`,
    runId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, contract,
    task: { goal: `Write outcome ${index}`, evidence: [`Outcome ${index}`], requiresWrite: true },
    ...(paths ? { ownership: { paths } } : {}) });
  for (const assignments of [
    [writer(1), writer(2, ['resources/views'])],
    [writer(1, ['resources']), writer(2, ['resources/views'])],
  ]) {
    const rejected = await handle(call(3, 'worker_dispatch_wave', { assignments }));
    assert.equal(JSON.parse(rejected.result.content[0].text).category, 'WAVE_OWNERSHIP_INVALID');
    assert.equal(launches.length, 0);
  }
  const accepted = await handle(call(4, 'worker_dispatch_wave', { assignments: [
    writer(3, ['app/Models']), writer(4, ['resources/views']),
  ] }));
  assert.equal(accepted.result.isError, false);
  assert.deepEqual(launches.map(item => item.task.ownership.paths), [['app/Models'], ['resources/views']]);
});

test('ui-verify is the only browser profile and missing setup returns an actionable safe category', async () => {
  const root = project(), calls = [];
  const handle = createWorkerMcpHandler({ project: root, harness: 'claude' }, { api: { dispatchNativeSoloWorker: options => {
    calls.push(options); throw new Error('Frontend QA requires explicit pinned browser setup');
  } } });
  await ready(handle);
  const created = await handle(call(3, 'worker_contract', draft));
  const contract = JSON.parse(created.result.content[0].text);
  const args = { profile: 'ui-verify', name: 'UI verifier', runId, contract, task: { goal: 'Verify approved local UI', evidence: ['Desktop and mobile evidence'] } };
  const response = await handle(call(4, 'worker_dispatch', args));
  assert.equal(response.result.isError, true);
  assert.equal(JSON.parse(response.result.content[0].text).category, 'BROWSER_SETUP_REQUIRED');
  assert.equal(calls[0].profile, 'ui-verify'); assert.equal(calls[0].harness, 'claude');
  assert.equal((await handle(call(5, 'worker_dispatch', { ...args, profile: 'browser' }))).error.data.category, 'UNSUPPORTED_ENVELOPE');
  assert.equal(calls.length, 1);
});

test('MCP status/result are scoped, suppress native errors, and bound concurrent tool work', async () => {
  const root = project(); let complete;
  const gate = new Promise(resolve => { complete = resolve; });
  const observed = [];
  const handle = createWorkerMcpHandler({ project: root, harness: 'claude' }, { api: {
    nativeSoloWorkerStatus: async options => { observed.push(options); await gate; return { state: 'running', cost: null }; },
    collectNativeSoloWorkerResult: () => { throw new Error('secret_token=PRIVATE'); },
  } });
  await ready(handle);
  const one = handle(call(2, 'worker_status', { runId })); const two = handle(call(3, 'worker_status', { runId }));
  assert.equal((await handle(call(4, 'worker_status', { runId }))).error.code, -32001);
  complete(); await Promise.all([one, two]);
  assert.deepEqual(observed, [{ project: root, runId }, { project: root, runId }]);
  const failed = await handle(call(5, 'worker_result', { runId }));
  assert.equal(failed.result.isError, true); assert.equal(JSON.stringify(failed).includes('PRIVATE'), false);
  assert.equal((await handle(call(6, 'worker_status', { runId, project: '/foreign' }))).error.code, -32602);
});

test('contract creation rejects symlink parents without touching outside files', async t => {
  const root = project(), outside = project();
  try { fs.symlinkSync(outside, path.join(root, '.agent-orchestra'), 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Symlinks unavailable'); throw error; }
  const handle = createWorkerMcpHandler({ project: root, harness: 'codex' }); await ready(handle);
  assert.equal((await handle(call(2, 'worker_contract', draft))).result.isError, true);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('result projection warning does not hide collected evidence or change acceptance', async () => {
  const root = project();
  const worker = { project: root, harness: 'codex', runId, state: 'stopped', complete: true,
    sessionId: 'native-session', role: 'dev-planner', result: 'Plan evidence', acceptance: 'PARTIAL' };
  let projected = 0;
  const handle = createWorkerMcpHandler({ project: root, harness: 'codex' }, {
    api: { collectNativeSoloWorkerResult: () => worker },
    projectSummary: async input => { projected++; assert.equal(input.worker, worker); return { state: 'unavailable', warning: 'Projection unavailable' }; },
  });
  await ready(handle);
  const response = await handle(call(2, 'worker_result', { runId }));
  assert.equal(response.result.isError, false);
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(projected, 1); assert.equal(result.result, 'Plan evidence'); assert.equal(result.acceptance, 'PARTIAL');
  assert.equal(result.presentation.state, 'unavailable');
});

test('stdio emits JSONRPC only, handles split frames and limits oversized input', async () => {
  const input = new PassThrough(), output = new PassThrough(); let result = '';
  output.on('data', data => { result += data; });
  const serving = serveWorkerMcp({ project: project(), harness: 'codex', input, output });
  const line = JSON.stringify(request(1, 'initialize', { protocolVersion: '2025-06-18' }));
  input.write(line.slice(0, 12)); input.write(`${line.slice(12)}\n`);
  input.write('invalid json\n'); input.end(`${JSON.stringify(request(2, 'ping'))}\n`);
  await serving;
  const rows = result.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3); assert.ok(rows.every(row => row.jsonrpc === '2.0'));
  assert.ok(rows.some(row => row.error?.code === -32700));
  const hugeInput = new PassThrough(), hugeOutput = new PassThrough(); let huge = '';
  hugeOutput.on('data', data => { huge += data; });
  const bounded = serveWorkerMcp({ project: project(), harness: 'codex', input: hugeInput, output: hugeOutput });
  hugeInput.write('x'.repeat(MAX_FRAME + 1)); await bounded;
  assert.match(huge, /Frame exceeds limit/);
});

test('real MCP executable initialize/tools list require no AI or Solo launch', () => {
  const root = project();
  const frames = [request(1, 'initialize', { protocolVersion: '2025-06-18' }), { jsonrpc: '2.0', method: 'notifications/initialized' }, request(2, 'tools/list')];
  const script = fileURLToPath(new URL('../native-solo-worker-mcp.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, '--project', root, '--harness', 'claude'], { encoding: 'utf8', input: `${frames.map(JSON.stringify).join('\n')}\n`, timeout: 5000 });
  assert.equal(run.status, 0); assert.equal(run.stderr, '');
  const rows = run.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2); assert.equal(rows[1].result.tools.length, 14);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.throws(() => parseWorkerMcpLaunch(['--project', root, '--command', 'unsafe']), /Invalid/);
});

test('failures expose only allowlisted safe categories, never native paths or provider guesses', async () => {
  const root = project(); let failure, calls = 0;
  const handle = createWorkerMcpHandler({ project: root, harness: 'codex' }, { api: {
    nativeSoloWorkerStatus: () => { calls++; throw failure; },
  } });
  await ready(handle);
  const cases = [
    [new Error('Unsupported worker envelope'), 'UNSUPPORTED_ENVELOPE'],
    [new Error('Invalid worker Solo binding'), 'MISSING_BINDING'],
    [new Error('Codex inherited MCP isolation was not verified; no worker launched'), 'NATIVE_CONFIG_PREFLIGHT'],
    [new Error('Native worker process identity mismatch'), 'INVALID_RUN_RECEIPT'],
    [new Error('Stored immutable contract mismatch'), 'INVALID_CONTRACT'],
    [new Error('Worker CLI failed; no success inferred'), 'CLI_EXECUTION_FAILED'],
    [Object.assign(new Error('PRIVATE'), { code: 'EEXIST', path: path.join(root, `.agent-orchestra/dispatch/native-${runId}.json`) }), 'DUPLICATE_RUN'],
    [Object.assign(new Error('PRIVATE'), { code: 'ENOENT', path: path.join(root, '.agent-orchestra/runtime/solo-observer.json') }), 'MISSING_BINDING'],
    [Object.assign(new Error('PRIVATE token=abc HTTP 401'), { code: 'ENOENT', path: '/foreign/PRIVATE' }), 'REQUEST_FAILED'],
    [new Error('Cannot enumerate inherited MCP servers PRIVATE'), 'REQUEST_FAILED'],
  ];
  for (const [error, category] of cases) {
    failure = error;
    const response = await handle(call(10, 'worker_status', { runId }));
    assert.equal(response.result.isError, true);
    const body = JSON.parse(response.result.content[0].text);
    assert.equal(body.category, category);
    assert.equal(body.status, 'FAILED'); assert.equal(body.acceptance, 'PARTIAL');
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE|token=|HTTP 401|\/foreign|worker-mcp-/);
  }
  const before = calls;
  const unsupported = await handle(call(11, 'worker_dispatch', { profile: 'browser' }));
  assert.equal(unsupported.error.data.category, 'UNSUPPORTED_ENVELOPE');
  assert.equal(calls, before);
});
