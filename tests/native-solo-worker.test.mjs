import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createTaskContract, runtimeManifest, buildPlan } from '../orchestra.mjs';
import { refreshProjectRuntime } from '../project-runtime-refresh.mjs';
import { bindSoloObserver, verifySoloBinary } from '../native-solo-mirror.mjs';
import { dispatchNativeSoloWorker, nativeSoloWorkerStatus, collectNativeSoloWorkerResult, nativeWorkerArguments, parseNativeWorkerOutput, preflightNativeWorkerBrowser, workerDisplayName } from '../native-solo-worker.mjs';
import { resolveNativeWorkerBrowser, browserEnvironment, BROWSER_TOOLS, PLAYWRIGHT_MCP_VERSION, PLAYWRIGHT_MCP_INTEGRITY } from '../native-worker-browser.mjs';
import { TASKAVEL_OPERATIONS } from '../native-worker-taskavel.mjs';

const contract = createTaskContract({ goal: 'Inspect project safely', required: [{ id: 'R1', text: 'Return project evidence' }],
  localDecisions: [], outOfScope: ['All external writes'], discoveryPolicy: 'report-only',
  changeSurface: { modules: [], fileKinds: [], migrationsAllowed: false, dependenciesAllowed: false, architectureChangesAllowed: false } });
const task = { contract, goal: 'Read README and report findings', evidence: ['README path and observed content summary'] };
const base = { harness: 'codex', role: 'reviewer', model: 'fixture-model', effort: 'high', body: 'Read only. Review security and performance.', task };
const taskavelAuthorization = { projectId: 25, taskIds: [41], operations: ['read'], externalWriteAuthorized: false };

test('worker labels show the actual harness, model and role without inventing unknown model aliases', () => {
  assert.equal(workerDisplayName('codex', 'gpt-5.6-terra', 'dev-builder'), 'Codex Terra · Builder');
  assert.equal(workerDisplayName('codex', 'gpt-5.6-luna', 'dev-tester'), 'Codex Luna · Tester');
  assert.equal(workerDisplayName('codex', 'gpt-5.6-sol', 'reviewer'), 'Codex Sol · Reviewer');
  assert.equal(workerDisplayName('claude', 'claude-sonnet-4-6', 'product-designer'), 'Claude Code claude-sonnet-4-6 · Designer');
  assert.equal(workerDisplayName('opencode', 'opencode-go/deepseek-v4-flash', 'dev-tester'), 'OpenCode opencode-go/deepseek-v4-flash · Tester');
});

test('Taskavel worker arguments isolate the service and reject filesystem writes or wrong envelopes', () => {
  const assignment = { ...task, taskavel: taskavelAuthorization };
  const launch = nativeWorkerArguments({ ...base, harness: 'claude', role: 'task-manager', task: assignment, tools: ['Bash', 'Read', 'mcp__foreign__write'] });
  assert.equal(launch.readOnly, true);
  assert.equal(launch.args[launch.args.indexOf('--tools') + 1], '');
  assert.equal(launch.args[launch.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(launch.args.includes('--strict-mcp-config'));
  assert.deepEqual(launch.args[launch.args.indexOf('--allowedTools') + 1].split(','), TASKAVEL_OPERATIONS.read.map(name => `mcp__taskavel__${name}`));
  assert.deepEqual(JSON.parse(launch.args[launch.args.indexOf('--mcp-config') + 1]), { mcpServers: { taskavel: { type: 'http', url: 'https://taskavel.com/mcp/taskavel' } } });
  assert.throws(() => nativeWorkerArguments({ ...base, role: 'task-manager', task: { ...assignment, requiresWrite: true } }), /cannot write project files/);
  assert.throws(() => nativeWorkerArguments({ ...base, task: assignment }), /task-manager envelope/);
});

test('Codex role overrides bind body model and readonly sandbox, disable inherited external tools', () => {
  const result = nativeWorkerArguments({ ...base, mcpNames: ['taskavel', 'chrome-devtools'] });
  assert.equal(result.readOnly, true);
  assert.ok(result.args.includes('--skip-git-repo-check'));
  assert.ok(result.args.includes('read-only'));
  for (const expected of ['features.apps=false', 'features.plugins=false', 'features.multi_agent=false', 'mcp_servers.taskavel.enabled=false', 'mcp_servers.chrome-devtools.enabled=false']) assert.ok(result.args.includes(expected));
  assert.throws(() => nativeWorkerArguments({ ...base, mcpNames: ['server.with.dots'] }), /Unsupported MCP server name/);
  assert.ok(result.args.some(arg => arg.startsWith('developer_instructions=') && arg.includes(base.body)));
  assert.equal(result.args.some(arg => arg.includes('dangerously')), false);
  assert.throws(() => nativeWorkerArguments({ ...base, role: 'dev-tester', task: { ...task, requiresWrite: true } }), /read-only/);
  assert.throws(() => nativeWorkerArguments({ ...base, task: { ...task, contract: { ...contract, hash: 'bad' } } }), /hash/i);
});

test('Claude uses exact named role and strict MCP, denies nested delegation', () => {
  const result = nativeWorkerArguments({ ...base, harness: 'claude', tools: ['Read', 'Bash(git diff*)', 'Task'] });
  assert.deepEqual(result.args.slice(0, 2), ['--agent', 'reviewer']);
  assert.equal(result.args.includes('--skip-git-repo-check'), false);
  assert.ok(result.args.includes('--strict-mcp-config'));
  assert.ok(result.args.includes('Agent,Task'));
  assert.equal(result.args.includes('Read,Bash(git diff*)'), false);
  assert.ok(result.args.includes('Read'));
  assert.throws(() => nativeWorkerArguments({ ...base, harness: 'claude', tools: ['Read', 'Write'] }), /write-capable/);
});

test('fresh non-Git project workers retain their role sandbox without initializing Git', t => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'worker-no-git-')));
  for (const role of ['product-designer', 'dev-planner', 'dev-builder', 'dev-tester', 'reviewer', 'dev-auditor']) {
    const launch = nativeWorkerArguments({ ...base, project, role });
    assert.equal(launch.args.filter(arg => arg === '--skip-git-repo-check').length, 1);
    assert.equal(launch.args[launch.args.indexOf('--sandbox') + 1], role === 'dev-builder' ? 'workspace-write' : 'read-only');
    assert.ok(launch.args.includes('approval_policy="never"'));
    assert.equal(launch.args.some(arg => arg.includes('dangerously')), false);
  }
  assert.equal(fs.existsSync(path.join(project, '.git')), false);
});

function fixture(t, harness = 'codex') {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'native-worker-')));
  const bin = path.join(project, 'bin'); fs.mkdirSync(bin);
  const soloBinary = path.join(bin, process.platform === 'win32' ? 'solo.exe' : 'solo');
  fs.writeFileSync(soloBinary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const original = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${original}`;
  t.after(() => { process.env.PATH = original; });
  const manifest = JSON.parse(runtimeManifest(harness, { economy: 'cheap', mid: 'mid', strongest: 'strong' }));
  refreshProjectRuntime({ project, harness, manifest });
  bindSoloObserver({ project, harness, soloBinary, projectId: 25 });
  const state = { calls: [], output: '', projectId: 25 };
  const invoke = (binary, args) => {
    state.calls.push(args);
    if (binary !== soloBinary) {
      if (args[0] === 'features') return { status: 0, stdout: 'apps stable true\nplugins stable true\nmulti_agent stable true\n' };
      return { status: 0, stdout: JSON.stringify([{ name: 'taskavel', enabled: !args.includes('mcp_servers.taskavel.enabled=false') }]) };
    }
    const response = data => ({ status: 0, stdout: JSON.stringify({ ok: true, data }) });
    if (args[0] === 'projects') return response({ id: 25, path: project });
    if (args[0] === 'agents') return response({ agentTools: [{ id: 99, name: 'Orkestar Worker', toolType: 'generic', command: process.execPath, enabled: true }, { id: 3, toolType: harness, command: harness, enabled: true }, { id: 8, toolType: harness, command: `${harness} --dangerously-skip-permissions`, enabled: true }] });
    if (args[1] === 'spawn') { state.displayName = args[args.indexOf('--name') + 1]; return response({ id: 200, kind: 'agent' }); }
    if (args[1] === 'get') return response({ id: 200, projectId: state.projectId, name: state.displayName ?? 'Security reviewer', kind: 'agent', status: 'stopped' });
    if (args[1] === 'output') return response({ id: 200, projectId: 25, kind: 'raw', text: state.output });
    throw new Error('Unexpected call');
  };
  const options = { project, harness, profile: 'code-review', name: 'Security reviewer', runId: 'a1234567-1234-4123-8123-123456789012', task, ownerSessionId: 'conductor-root' };
  fs.mkdirSync(path.join(project, '.agent-orchestra/worker'), { recursive: true });
  fs.writeFileSync(path.join(project, '.agent-orchestra/worker/native-worker-live.mjs'), '// fixture');
  return { project, options, state, invoke };
}
function legacy(f) {
  const file = path.join(f.project, `.agent-orchestra/dispatch/native-${f.options.runId}.json`);
  const receipt = JSON.parse(fs.readFileSync(file)); delete receipt.outputFormat; delete receipt.liveLaunchHash;
  fs.writeFileSync(file, JSON.stringify(receipt));
}

test('Codex Taskavel preflight fails closed before any Solo worker spawn', t => {
  const f = fixture(t);
  const options = { ...f.options, profile: 'taskavel', task: { ...task, taskavel: taskavelAuthorization } };
  assert.throws(() => dispatchNativeSoloWorker(options, f), /Native Taskavel preflight failed/);
  assert.equal(f.state.calls.some(args => args[1] === 'spawn'), false);
});

test('Claude Taskavel authentication alone cannot bypass required project binding', t => {
  const f = fixture(t, 'claude');
  const runtimePath = path.join(f.project, '.agent-orchestra/runtime/claude.json');
  const runtime = JSON.parse(fs.readFileSync(runtimePath)); runtime.profiles.taskavel.reasoningEffort = 'low';
  fs.writeFileSync(runtimePath, JSON.stringify(runtime));
  const options = { ...f.options, profile: 'taskavel', task: { ...task, taskavel: taskavelAuthorization } };
  let probes = 0;
  const invoke = (binary, args, input) => {
    if (binary === process.execPath && args[0] === '-e') {
      probes++;
      assert.deepEqual(JSON.parse(input.input).assignment.task.taskavel, taskavelAuthorization);
      return { status: 0, stdout: JSON.stringify({ name: 'taskavel', status: 'connected', enabledTools: TASKAVEL_OPERATIONS.read }) };
    }
    return f.invoke(binary, args, input);
  };
  assert.throws(() => dispatchNativeSoloWorker(options, { invoke }), /explicit name-bound project/);
  assert.equal(probes, 1);
  assert.equal(f.state.calls.filter(args => args[1] === 'spawn').length, 0);
});

test('Claude Taskavel failed preflight cannot spawn or persist a launch receipt', t => {
  const f = fixture(t, 'claude');
  const runtimePath = path.join(f.project, '.agent-orchestra/runtime/claude.json');
  const runtime = JSON.parse(fs.readFileSync(runtimePath)); runtime.profiles.taskavel.reasoningEffort = 'low';
  fs.writeFileSync(runtimePath, JSON.stringify(runtime));
  const options = { ...f.options, profile: 'taskavel', task: { ...task, taskavel: taskavelAuthorization } };
  const invoke = (binary, args, input) => binary === process.execPath && args[0] === '-e'
    ? { status: 1, stdout: '', stderr: 'not exposed' } : f.invoke(binary, args, input);
  assert.throws(() => dispatchNativeSoloWorker(options, { invoke }), /preflight failed/);
  assert.equal(f.state.calls.some(args => args[1] === 'spawn'), false);
  assert.equal(fs.existsSync(path.join(f.project, `.agent-orchestra/dispatch/native-${options.runId}.json`)), false);
});

test('private result collection preserves diagnostic and truncation without raw terminal fallback', t => {
  const f = fixture(t); const receipt = dispatchNativeSoloWorker(f.options, f);
  const base = path.join(f.project, `.agent-orchestra/dispatch/native-${f.options.runId}`);
  const raw = [{ type: 'thread.started', thread_id: 'fixture' }, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }].map(JSON.stringify).join('\n');
  fs.writeFileSync(base + '.raw', raw, { mode: 0o600 });
  const completion = { runId: f.options.runId, launchHash: receipt.liveLaunchHash, rawHash: createHash('sha256').update(raw).digest('hex'), diagnostic: true, truncated: true, exitCode: 0 };
  fs.writeFileSync(base + '.output.json', JSON.stringify(completion), { mode: 0o600 });
  const result = collectNativeSoloWorkerResult(f.options, f);
  assert.equal(result.complete, false);
  assert.deepEqual(result.liveDiagnostics, { nativeDiagnostic: true, truncated: true, exitCode: 0 });
  assert.match(result.outputIssue, /capture limit/);
  assert.equal(f.state.calls.some(args => args[1] === 'output'), false);
  fs.writeFileSync(base + '.output.json', JSON.stringify({ ...completion, truncated: false, exitCode: 7 }));
  const failed = collectNativeSoloWorkerResult(f.options, f);
  assert.equal(failed.complete, false); assert.match(failed.outputIssue, /unsuccessfully/);
  fs.writeFileSync(base + '.output.json', JSON.stringify({ ...completion, truncated: false, exitCode: '0' }));
  assert.equal(collectNativeSoloWorkerResult(f.options, f).complete, false);
});

test('empty startup output preserves the safe actionable diagnostic in collected results', t => {
  const f = fixture(t); const receipt = dispatchNativeSoloWorker(f.options, f);
  const base = path.join(f.project, `.agent-orchestra/dispatch/native-${f.options.runId}`);
  const startupDiagnostic = { code: 'CODEX_TRUSTED_DIRECTORY_REQUIRED', message: 'Codex refused to start outside a trusted Git directory. The Orkestar launcher must handle the approved project explicitly; no agent work was verified.' };
  fs.writeFileSync(base + '.raw', '');
  fs.writeFileSync(base + '.output.json', JSON.stringify({ runId: f.options.runId, launchHash: receipt.liveLaunchHash,
    rawHash: createHash('sha256').update('').digest('hex'), diagnostic: true, truncated: true, exitCode: 1, startupDiagnostic }));
  const result = collectNativeSoloWorkerResult(f.options, f);
  assert.equal(result.complete, false);
  assert.equal(result.outputIssue, startupDiagnostic.message);
  assert.deepEqual(result.liveDiagnostics.startupDiagnostic, startupDiagnostic);
});

test('truncated Claude Taskavel stream cannot substitute compact prose for tool proof', t => {
  const f=fixture(t); const receipt=dispatchNativeSoloWorker(f.options,f);
  const base=path.join(f.project,`.agent-orchestra/dispatch/native-${receipt.runId}`);
  fs.writeFileSync(base+'.json',JSON.stringify({...receipt,harness:'claude',role:'task-manager'}));
  const compact=[{type:'system',subtype:'init',session_id:'fixture'},{type:'result',subtype:'success',session_id:'fixture',result:'Tracker done'}].map(JSON.stringify).join('\n');
  const digest=value=>createHash('sha256').update(value).digest('hex');
  const raw='x'.repeat(1024*1024);
  fs.writeFileSync(base+'.raw',raw);fs.writeFileSync(base+'.evidence.jsonl',compact);
  fs.writeFileSync(base+'.output.json',JSON.stringify({schemaVersion:2,runId:receipt.runId,launchHash:receipt.liveLaunchHash,rawHash:digest(raw),evidenceHash:digest(compact),fullStreamHash:digest(raw+'tail'),fullStreamBytes:raw.length+4,diagnostic:false,truncated:false,exitCode:0,rawTruncated:true,evidenceTruncated:false,streamInvalid:false}));
  const result=collectNativeSoloWorkerResult(f.options,f);
  assert.equal(result.complete,false);assert.match(result.outputIssue,/Taskavel tool evidence/);assert.equal(result.taskavelEvidence,undefined);
});

test('only exited successful v1 truncated Codex capture can use exact-session recovery', t => {
  const f = fixture(t); const receipt = dispatchNativeSoloWorker(f.options, f);
  const base = path.join(f.project, `.agent-orchestra/dispatch/native-${f.options.runId}`);
  const raw = JSON.stringify({type:'thread.started',thread_id:'fixture'})+'\n';
  const digest = value => createHash('sha256').update(value).digest('hex');
  fs.writeFileSync(base+'.raw',raw);
  const completion = {runId:receipt.runId,launchHash:receipt.liveLaunchHash,rawHash:digest(raw),diagnostic:false,truncated:true,exitCode:0};
  fs.writeFileSync(base+'.output.json',JSON.stringify(completion));
  let calls=0;
  const deps={...f,invoke:(binary,args)=>{
    const value=f.invoke(binary,args);
    if(args[1]==='get'){const data=JSON.parse(value.stdout);data.data.status='Exited';value.stdout=JSON.stringify(data);}return value;
  },recoverCodexWorker:()=>{calls++;return {sessionId:'fixture',result:'Actual recovered final',complete:true,cost:null,tokens:{input:10,output:2,total:12,cachedInput:8,uncachedInput:2},
    recoveryProvenance:{runId:receipt.runId,launchHash:receipt.liveLaunchHash,originalPrefixHash:digest(raw),method:'thread/read'}};}};
  const result=collectNativeSoloWorkerResult(f.options,deps);
  assert.equal(result.complete,true);assert.equal(calls,1);assert.equal(result.tokens.cachedInput,8);
  assert.equal(result.liveDiagnostics.truncated,true);assert.equal(result.outputIssue,undefined);
  assert.equal(JSON.parse(fs.readFileSync(base+'.recovery.json')).method,'thread/read');
  assert.equal(fs.readFileSync(base+'.raw','utf8'),raw);
  fs.writeFileSync(base+'.evidence.jsonl',raw);
  fs.writeFileSync(base+'.output.json',JSON.stringify({...completion,schemaVersion:2,evidenceHash:digest(raw),fullStreamHash:digest(raw),fullStreamBytes:Buffer.byteLength(raw),rawTruncated:false,evidenceTruncated:false,streamInvalid:true}));
  assert.equal(collectNativeSoloWorkerResult(f.options,deps).complete,false);assert.equal(calls,1);
});

test('dispatch creates a real role process once, status binds exact project and preserves receipt privacy', t => {
  const f = fixture(t);
  const receipt = dispatchNativeSoloWorker(f.options, f);
  assert.equal(receipt.processId, 200);
  assert.equal(receipt.role, 'reviewer');
  assert.equal(receipt.acceptance, 'PARTIAL');
  assert.ok(Number.isSafeInteger(receipt.dispatchedAt) && receipt.dispatchedAt <= Date.now());
  const spawn = f.state.calls.find(args => args[0] === 'processes' && args[1] === 'spawn');
  assert.ok(spawn.includes('99'));
  const launch = JSON.parse(fs.readFileSync(path.join(f.project, `.agent-orchestra/dispatch/native-${f.options.runId}.launch.json`)));
  assert.ok(launch.args.includes('exec')); assert.ok(launch.args.includes('features.plugins=false'));
  assert.equal(launch.goal, contract.goal);
  const raw = fs.readFileSync(path.join(f.project, `.agent-orchestra/dispatch/native-${f.options.runId}.json`), 'utf8');
  assert.equal(raw.includes(task.goal), false);
  assert.equal(JSON.parse(raw).dispatchedAt, receipt.dispatchedAt);
  assert.throws(() => dispatchNativeSoloWorker(f.options, f), /exist/i);
  assert.equal(f.state.calls.filter(args => args[1] === 'spawn').length, 1);
  assert.equal(nativeSoloWorkerStatus(f.options, f).state, 'stopped');
  f.state.projectId = 999;
  assert.throws(() => nativeSoloWorkerStatus(f.options, f), /identity mismatch/);
});

test('collection requires native start and terminal event; usage never means acceptance', t => {
  const f = fixture(t); dispatchNativeSoloWorker(f.options, f);
  legacy(f);
  f.state.output = [ { type: 'thread.started', thread_id: 'native-thread' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Review evidence' } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } } ].map(JSON.stringify).join('\n');
  const result = collectNativeSoloWorkerResult(f.options, f);
  assert.equal(result.complete, true); assert.equal(result.acceptance, 'PARTIAL');
  assert.equal(result.tokens.total, 110); assert.equal(result.cost, null);
  assert.equal(parseNativeWorkerOutput('codex', f.state.output.split('\n').slice(1).join('\n')).complete, false);
  assert.equal(parseNativeWorkerOutput('codex', 'UI terminal output not JSON').tokens, null);
});

test('Claude final usage includes cache once, failed and missing usage are unavailable', () => {
  const rows = [{ type: 'system', subtype: 'init', session_id: 'claude-thread' }, { type: 'result', subtype: 'success', result: 'Evidence',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } }];
  assert.equal(parseNativeWorkerOutput('claude', rows.map(JSON.stringify).join('\n')).tokens.total, 65);
  rows[1].usage.input_tokens = -1;
  assert.equal(parseNativeWorkerOutput('claude', rows.map(JSON.stringify).join('\n')).tokens, null);
  rows[1].usage.input_tokens = 10; rows[1].usage.cache_read_input_tokens = -2;
  assert.equal(parseNativeWorkerOutput('claude', rows.map(JSON.stringify).join('\n')).tokens, null);
  rows[1].session_id = 'other';
  assert.equal(parseNativeWorkerOutput('claude', rows.map(JSON.stringify).join('\n')).complete, false);
  assert.equal(parseNativeWorkerOutput('codex', [{ type: 'thread.started', thread_id: 'one' }, { type: 'thread.started', thread_id: 'two' }, { type: 'turn.completed' }].map(JSON.stringify).join('\n')).complete, false);
});

test('Codex optional cache accounting preserves existing totals and rejects unsafe details', () => {
  const parse = usage => parseNativeWorkerOutput('codex', [{ type: 'thread.started', thread_id: 'cache-session' },
    { type: 'turn.completed', usage }].map(JSON.stringify).join('\n')).tokens;
  assert.deepEqual(parse({ input_tokens: 903323, output_tokens: 9280, cached_input_tokens: 780544 }),
    { input: 903323, output: 9280, total: 912603, cachedInput: 780544, uncachedInput: 122779 });
  for (const cached of [undefined, -1, 11, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(parse({ input_tokens: 10, output_tokens: 2, cached_input_tokens: cached }), { input: 10, output: 2, total: 12 });
  }
  assert.deepEqual(parse({ input_tokens: Number.MAX_SAFE_INTEGER - 1, output_tokens: 1, cached_input_tokens: Number.MAX_SAFE_INTEGER - 2 }),
    { input: Number.MAX_SAFE_INTEGER - 1, output: 1, total: Number.MAX_SAFE_INTEGER, cachedInput: Number.MAX_SAFE_INTEGER - 2, uncachedInput: 1 });
  assert.equal(parse({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1, cached_input_tokens: 1 }), null);
});

test('exact same-session Codex rollout diagnostic preserves a blocked final response with warning', () => {
  const session = '01a06ce9-684f-71b0-9b3e-26b60da587c3';
  const diagnostic = `2026-09-04T14:56:53.635155Z ERROR codex_core::session: failed to record rollout items: thread ${session} not found`;
  const rows = [{ type: 'thread.started', thread_id: session },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Blocked: backend routes are missing. No changes made.' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }].map(JSON.stringify);
  const result = parseNativeWorkerOutput('codex', [rows[0], diagnostic, ...rows.slice(1)].join('\n'));
  assert.equal(result.complete, true); assert.match(result.result, /^Blocked:/); assert.equal(result.tokens.total, 12);
  assert.equal(result.diagnostics[0].code, 'CODEX_ROLLOUT_RECORDING_FAILED');
  for (const bad of ['arbitrary diagnostic', '{malformed JSON', diagnostic.replace(session, 'a1234567-1234-4123-8123-123456789012')]) {
    assert.equal(parseNativeWorkerOutput('codex', [rows[0], bad, ...rows.slice(1)].join('\n')).complete, false);
  }
});

test('empty Solo CLI raw output recovers from exact bound MCP process without inventing failure', t => {
  const f = fixture(t); dispatchNativeSoloWorker(f.options, f);
  legacy(f);
  const raw = [{ type: 'thread.started', thread_id: 'planner-session' },
    { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'x'.repeat(330000) } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Verified plan' } },
    { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } }].map(JSON.stringify).join('\n');
  let reads = 0;
  const result = collectNativeSoloWorkerResult(f.options, { ...f, readMcpOutput: input => {
    reads++;
    assert.equal(input.project, f.project); assert.equal(input.projectId, 25); assert.equal(input.processId, 200);
    assert.equal(path.basename(input.soloBinary), process.platform === 'win32' ? 'solo.exe' : 'solo');
    return raw;
  } });
  assert.equal(reads, 1); assert.equal(result.complete, true); assert.equal(result.result, 'Verified plan');
  assert.equal(result.tokens.total, 120); assert.equal(result.acceptance, 'PARTIAL');
  assert.equal(result.outputIssue, undefined);
});

test('unavailable fallback output remains unknown rather than a failed model result', t => {
  const f = fixture(t); dispatchNativeSoloWorker(f.options, f);
  legacy(f);
  const result = collectNativeSoloWorkerResult(f.options, { ...f, readMcpOutput: () => { throw new Error('private diagnostic'); } });
  assert.equal(result.complete, false); assert.equal(result.result, null); assert.equal(result.tokens, null);
  assert.match(result.outputIssue, /does not prove worker failure or success/);
  assert.equal(JSON.stringify(result).includes('private diagnostic'), false);
});

test('portable CLI raw output accepts large native streams without expanding configuration limits', t => {
  const f = fixture(t); dispatchNativeSoloWorker(f.options, f);
  legacy(f);
  f.state.output = [{ type: 'thread.started', thread_id: 'large-cli-session' },
    { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'x'.repeat(330000) } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Large stream result' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }].map(JSON.stringify).join('\n');
  const result = collectNativeSoloWorkerResult(f.options, { ...f, readMcpOutput: () => { throw new Error('helper absent'); } });
  assert.equal(result.complete, true); assert.equal(result.result, 'Large stream result'); assert.equal(result.tokens.total, 12);
});

test('Claude dispatch reads the installed audited role, not an arbitrary display name', t => {
  const f = fixture(t, 'claude');
  const result = dispatchNativeSoloWorker(f.options, f);
  assert.equal(result.role, 'reviewer');
  const args = JSON.parse(fs.readFileSync(path.join(f.project, `.agent-orchestra/dispatch/native-${f.options.runId}.launch.json`))).args;
  assert.ok(args.includes('--agent')); assert.ok(args.includes('reviewer'));
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
});

test('native MCP override verification fails before spawn when the CLI rejects or ignores keys', t => {
  const f = fixture(t);
  const invoke = (binary, args, options) => {
    if (args.includes('mcp_servers.taskavel.enabled=false')) return { status: 0, stdout: '[{"name":"taskavel","enabled":true}]' };
    return f.invoke(binary, args, options);
  };
  assert.throws(() => dispatchNativeSoloWorker(f.options, { invoke }), /isolation was not verified/);
  assert.equal(f.state.calls.some(args => args[1] === 'spawn'), false);
});

function browserFixture(t, harness = 'codex') {
  const f = fixture(t, harness);
  const browser = path.join(f.project, 'bin', process.platform === 'win32' ? 'chrome.exe' : 'chromium');
  fs.writeFileSync(browser, '', { mode: 0o700 });
  const root = path.join(f.project, '.agent-orchestra/browser');
  const pkg = path.join(root, 'node_modules/@playwright/mcp'); fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'orkestar-managed-browser', private: true, version: '1.0.0', dependencies: { '@playwright/mcp': PLAYWRIGHT_MCP_VERSION } }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@playwright/mcp': { version: PLAYWRIGHT_MCP_VERSION, integrity: PLAYWRIGHT_MCP_INTEGRITY } } }));
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@playwright/mcp', version: PLAYWRIGHT_MCP_VERSION, bin: { 'playwright-mcp': 'cli.js' } }));
  fs.writeFileSync(path.join(pkg, 'cli.js'), '// not executed');
  const config = resolveNativeWorkerBrowser({ project: f.project, role: 'frontend-qa' });
  const invoke = (binary, args, options) => {
    if (args[0] === '-e') return { status: 0, stdout: JSON.stringify({ defaultToolsApprovalMode: 'prompt',
      tools: Object.fromEntries(BROWSER_TOOLS.map(name => [name, { approval_mode: 'approve' }])) }) };
    const activated = args.some(value => value.startsWith('mcp_servers.orkestar_browser={'));
    if (activated && args[0] === 'features') return { status: 0, stdout: ['shell_tool', 'unified_exec', 'browser_use', 'browser_use_external',
      'browser_use_full_cdp_access', 'computer_use', 'in_app_browser', 'image_generation', 'hooks'].map(name => `${name} stable false`).join('\n') };
    if (activated && args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ name: 'taskavel', enabled: false }, { name: config.name, enabled: true }]) };
    if (activated && args[1] === 'get') return { status: 0, stdout: JSON.stringify({ name: config.name, enabled: true, transport: { type: 'stdio', ...config.server }, enabled_tools: config.enabledTools }) };
    if (harness === 'claude' && args.includes('--input-format')) {
      assert.equal(args.includes('--no-session-persistence'), true);
      assert.match(options.input, /mcp_status/);
      return { status: 0, stdout: JSON.stringify({ type: 'control_response', response: { request_id: 'orkestar-mcp', subtype: 'success', response: {
        mcpServers: [{ name: config.name, status: 'connected', config: { type: 'stdio', ...config.server }, tools: config.enabledTools.map(name => ({ name })) }] } } }) + '\n' };
    }
    return f.invoke(binary, args, options);
  };
  return { ...f, config, invoke, options: { ...f.options, profile: 'ui-verify' } };
}

test('frontend QA alone activates the exact installed gateway and disables Codex shell/native browser tools', t => {
  const f = browserFixture(t);
  const launch = nativeWorkerArguments({ ...base, role: 'frontend-qa', project: f.project, mcpNames: ['taskavel'] });
  assert.equal(launch.readOnly, true);
  for (const value of ['features.shell_tool=false', 'features.browser_use=false', 'features.computer_use=false', 'features.hooks=false', 'mcp_servers.taskavel.enabled=false']) assert.ok(launch.args.includes(value));
  assert.equal(launch.args.includes('features.unified_exec=false'), false);
  const serverOverride = launch.args.find(value => value.startsWith('mcp_servers.orkestar_browser='));
  assert.ok(serverOverride.includes('default_tools_approval_mode="prompt"'));
  for (const name of BROWSER_TOOLS) assert.ok(serverOverride.includes(`${name}={approval_mode="approve"}`));
  assert.ok(launch.args.some(value => value.startsWith('mcp_servers.orkestar_browser={') && value.includes('enabled_tools=')));
  assert.deepEqual(launch.browser.enabledTools, BROWSER_TOOLS);
  assert.throws(() => nativeWorkerArguments({ ...base, role: 'frontend-qa', project: f.project, mcpNames: ['orkestar_browser'] }), /conflicts/);
  assert.throws(() => nativeWorkerArguments({ ...base, role: 'frontend-qa', project: f.project, task: { ...task, requiresWrite: true } }), /read-only/);
  assert.equal(dispatchNativeSoloWorker(f.options, f).role, 'frontend-qa');
});

test('Claude frontend QA has no builtins and only exact gateway MCP permissions', t => {
  const f = browserFixture(t, 'claude');
  const launch = nativeWorkerArguments({ ...base, harness: 'claude', role: 'frontend-qa', project: f.project, tools: ['Bash', 'Read', 'Write', 'mcp__other__write'] });
  assert.equal(launch.args[launch.args.indexOf('--tools') + 1], '');
  assert.deepEqual(launch.args[launch.args.indexOf('--allowedTools') + 1].split(','), BROWSER_TOOLS.map(tool => `mcp__orkestar_browser__${tool}`));
  assert.deepEqual(JSON.parse(launch.args[launch.args.indexOf('--mcp-config') + 1]), { mcpServers: { orkestar_browser: f.config.server } });
  for (const flag of ['--strict-mcp-config', '--restricted', '--no-chrome', '--disable-slash-commands']) assert.ok(launch.args.includes(flag));
  assert.equal(dispatchNativeSoloWorker(f.options, f).role, 'frontend-qa');
});

test('browser availability and native readback failures never spawn a worker', t => {
  const f = fixture(t);
  assert.throws(() => dispatchNativeSoloWorker({ ...f.options, profile: 'ui-verify' }, f), /explicit pinned browser setup/);
  assert.equal(f.state.calls.some(args => args[1] === 'spawn'), false);
  assert.equal(fs.existsSync(path.join(f.project, '.agent-orchestra/browser')), false);
  const ready = browserFixture(t);
  const invoke = (binary, args, options) => args[0] === 'mcp' && args[1] === 'get'
    ? { status: 0, stdout: JSON.stringify({ name: 'orkestar_browser', enabled: true, transport: { type: 'stdio', command: 'evil' }, enabled_tools: BROWSER_TOOLS }) }
    : ready.invoke(binary, args, options);
  assert.throws(() => dispatchNativeSoloWorker(ready.options, { invoke }), /configuration preflight failed/);
  assert.equal(ready.state.calls.some(args => args[1] === 'spawn'), false);
});

test('Claude readback rejects extra MCP servers and forbidden tool expansion', t => {
  const f = browserFixture(t, 'claude');
  const launch = nativeWorkerArguments({ ...base, harness: 'claude', role: 'frontend-qa', project: f.project });
  for (const expansion of ['server', 'tool']) {
    const invoke = (binary, args, options) => {
      const result = f.invoke(binary, args, options); const row = JSON.parse(result.stdout);
      const servers = row.response.response.mcpServers;
      if (expansion === 'server') servers.push({ name: 'other', status: 'connected' });
      else servers[0].tools.push({ name: 'browser_evaluate' });
      return { status: 0, stdout: JSON.stringify(row) };
    };
    assert.throws(() => preflightNativeWorkerBrowser({ project: f.project, harness: 'claude', binary: 'claude', launch }, { invoke }), /configuration preflight failed/);
  }
});

test('Codex effective tool approval readback rejects defaults, missing tools and extra tools before spawn', t => {
  for (const mode of ['default', 'missing', 'extra']) {
    const f = browserFixture(t);
    const invoke = (binary, args, options) => {
      if (args[0] !== '-e') return f.invoke(binary, args, options);
      const tools = Object.fromEntries(BROWSER_TOOLS.map(name => [name, { approval_mode: 'approve' }]));
      if (mode === 'missing') delete tools.browser_snapshot;
      if (mode === 'extra') tools.browser_evaluate = { approval_mode: 'approve' };
      return { status: 0, stdout: JSON.stringify({ defaultToolsApprovalMode: mode === 'default' ? 'approve' : 'prompt', tools }) };
    };
    assert.throws(() => dispatchNativeSoloWorker(f.options, { invoke }), /configuration preflight failed/);
    assert.equal(f.state.calls.some(args => args[1] === 'spawn'), false);
  }
});

if (process.env.ORKESTAR_BROWSER_PROTOCOL_PROJECT) {
  // Upstream's core/tests/common/responses.rs and suite/code_mode.rs define this
  // no-model SSE fixture. Tools may be deferred: inspect ALL_TOOLS, not tools[].
  test('real Codex registry exposes only browser MCP, removes shell, and rejects edits', { timeout: 45000 }, async t => {
    const project = process.env.ORKESTAR_BROWSER_PROTOCOL_PROJECT;
    const binding = JSON.parse(fs.readFileSync(path.join(project, '.agent-orchestra/runtime/solo-observer.json'), 'utf8'));
    const inventory = spawnSync(verifySoloBinary(binding.soloBinary), ['agents', 'list', '--json'], { cwd: project, encoding: 'utf8', timeout: 15000 });
    assert.equal(inventory.status, 0);
    const candidates = JSON.parse(inventory.stdout).data.agentTools.filter(tool => tool.enabled && tool.toolType === 'codex'
      && path.isAbsolute(tool.command) && path.basename(tool.command) === 'codex');
    assert.equal(candidates.length, 1);
    const route = JSON.parse(fs.readFileSync(path.join(project, '.agent-orchestra/runtime/codex.json'), 'utf8')).profiles['ui-verify'];
    const directory = fs.mkdtempSync(path.join(project, 'tool-policy-proof.'));
    const sentinel = path.join(directory, 'readonly-sentinel.txt');
    for (const shellEnabled of [false, true]) {
      const launch = nativeWorkerArguments({ ...base, project, role: 'frontend-qa', model: route.model, effort: route.reasoningEffort });
      const patch = `*** Begin Patch\n*** Add File: ${sentinel}\n+Scoped sandbox diagnostic\n*** End Patch`;
      const code = 'text(JSON.stringify({names:ALL_TOOLS.map(t=>t.name)}));' + (shellEnabled ? ''
        : `try{text(await tools.apply_patch(${JSON.stringify(patch)}));}catch(error){text(String(error));}`);
      let responses = 0, names, rejected = false, protocolError;
      const server = http.createServer((request, response) => {
        let body = '';
        if (request.headers.authorization || ![undefined, 'identity'].includes(request.headers['content-encoding'])) {
          protocolError = 'Unexpected credentials or encoding'; request.resume(); response.writeHead(400); response.end(); return;
        }
        request.on('data', chunk => { body += chunk; if (body.length > 2000000) request.destroy(); });
        request.on('end', () => {
          if (request.url !== '/v1/responses') { response.writeHead(400); response.end(); return; }
          try {
            const payload = JSON.parse(body);
            for (const item of payload.input ?? []) if (item.type === 'custom_tool_call_output' && item.call_id === 'policy-probe') {
              const output = (typeof item.output === 'string' ? item.output : JSON.stringify(item.output)).replaceAll('\\"', '"');
              const match = output.match(/"names":\[([^\]]*)\]/);
              if (match) names = JSON.parse(`[${match[1]}]`);
              rejected = output.includes('rejected') && output.includes('approval');
            }
          } catch { protocolError = 'Invalid bounded tool output'; }
          body = ''; // Never retain request bodies, prompts, history, or headers.
          if (responses++ === 0) {
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            for (const event of [{ type: 'response.created', response: { id: 'policy-1' } },
              { type: 'response.output_item.done', item: { type: 'custom_tool_call', call_id: 'policy-probe', name: 'exec', input: code } },
              { type: 'response.completed', response: { id: 'policy-1', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }]) response.write(`data: ${JSON.stringify(event)}\n\n`);
            response.end();
          } else { response.writeHead(400, { 'content-type': 'application/json' }); response.end('{"error":{"message":"Intentional local stop","type":"invalid_request_error"}}'); }
        });
      });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const provider = `model_providers.orkestar_policy_probe={name="Local policy proof",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`;
      assert.equal(launch.args.filter(arg => arg === '--skip-git-repo-check').length, 1);
      const child = spawn(candidates[0].command, [...launch.args.slice(0, -1), '--ignore-user-config', '--ephemeral',
        '-c', 'project_doc_max_bytes=0', '-c', 'features.enable_request_compression=false', '-c', `features.shell_tool=${shellEnabled}`,
        '-c', 'model_provider="orkestar_policy_probe"', '-c', provider, 'Fixed local policy diagnostic.'],
      { cwd: directory, env: browserEnvironment(), stdio: 'ignore' });
      const timeout = setTimeout(() => child.kill(), 18000);
      try { await once(child, 'exit'); } finally { clearTimeout(timeout); server.closeAllConnections(); server.close(); }
      assert.equal(protocolError, undefined);
      assert.ok(Array.isArray(names), 'The controlled tool call must return the actual registry');
      assert.equal(names.includes('exec_command'), shellEnabled);
      assert.equal(names.includes('write_stdin'), shellEnabled);
      assert.deepEqual(names.filter(name => name.startsWith('mcp__')).sort(), BROWSER_TOOLS.map(name => `mcp__orkestar_browser__${name}`).sort());
      if (!shellEnabled) { assert.equal(rejected, true); assert.equal(fs.existsSync(sentinel), false); }
      t.diagnostic(JSON.stringify({ shellEnabled, names, editsRejected: !shellEnabled && rejected }));
    }
  });
  for (const harness of ['codex', 'claude']) test(`real ${harness} browser configuration preflight, no model turn or model availability claim`, { timeout: 20000 }, () => {
    const project = process.env.ORKESTAR_BROWSER_PROTOCOL_PROJECT;
    const binding = JSON.parse(fs.readFileSync(path.join(project, '.agent-orchestra/runtime/solo-observer.json'), 'utf8'));
    const inventory = spawnSync(verifySoloBinary(binding.soloBinary), ['agents', 'list', '--json'], { cwd: project, encoding: 'utf8', timeout: 15000 });
    assert.equal(inventory.status, 0);
    const tools = JSON.parse(inventory.stdout).data.agentTools.filter(tool => tool.enabled === true && tool.toolType === harness
      && (tool.command === harness || path.isAbsolute(tool.command) && [harness, `${harness}.exe`].includes(path.basename(tool.command))));
    assert.equal(tools.length, 1); const binary = tools[0].command;
    let route, body, inlineAgent;
    if (harness === 'codex') {
      route = JSON.parse(fs.readFileSync(path.join(project, '.agent-orchestra/runtime/codex.json'), 'utf8')).profiles['ui-verify'];
      body = fs.readFileSync(path.join(project, '.codex/agents/frontend-qa.toml'), 'utf8');
    } else {
      // UNVERIFIED MODEL configuration fixture only: never persist a fake verified runtime.
      const repository = JSON.parse(fs.readFileSync(new URL('../orchestra.json', import.meta.url), 'utf8'));
      const policy = Object.values(repository).find(value => value?.adapters?.claude?.classes);
      const model = policy.adapters.claude.classes.strongest[0];
      route = { model };
      const plan = buildPlan({ selectedTools: ['claude'], projectOnly: true, project, resolvedModelsByTool: { claude: { 'frontend-qa': model } } });
      const generated = plan.operations.find(operation => operation.target === path.join(project, '.claude/agents/frontend-qa.md')).content;
      body = generated.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)[1];
      inlineAgent = { 'frontend-qa': { description: 'UNVERIFIED MODEL: isolated browser configuration preflight only', prompt: body,
        tools: BROWSER_TOOLS.map(tool => `mcp__orkestar_browser__${tool}`), model } };
    }
    let mcpNames = [];
    if (harness === 'codex') {
      const result = spawnSync(binary, ['mcp', 'list', '--json', '--disable', 'plugins', '--disable', 'apps'], { cwd: project, encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0); mcpNames = JSON.parse(result.stdout).map(server => server.name);
    }
    const launch = nativeWorkerArguments({ ...base, harness, role: 'frontend-qa', project, model: route.model, effort: route.reasoningEffort, body, mcpNames });
    if (inlineAgent) launch.args.splice(-1, 0, '--agents', JSON.stringify(inlineAgent));
    assert.equal(preflightNativeWorkerBrowser({ project, harness, binary, launch }), true);
  });
}
