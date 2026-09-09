import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readSoloMcpOutput, RAW_OUTPUT_LIMIT } from './native-solo-output.mjs';
import { liveWorkerTool, readLiveWorkerOutput } from './native-worker-live.mjs';
import { recoverCodexWorker } from './native-worker-recovery.mjs';
import { validateTaskContract } from './orchestra.mjs';
import { verifySoloBinary } from './native-solo-mirror.mjs';
import { resolveNativeWorkerBrowser, BROWSER_TOOLS } from './native-worker-browser.mjs';
import { nativeTaskavelArguments, preflightNativeTaskavelSync, extractClaudeTaskavelEvidence } from './native-worker-taskavel.mjs';
import { bindTaskavelAssignment } from './native-taskavel-binding.mjs';

const LIMIT = 262144;
export function workerDisplayName(harness, model, role) {
  const labels = { 'dev-planner': 'Planner', 'dev-builder': 'Builder', 'dev-tester': 'Tester', 'frontend-qa': 'Browser QA', 'dev-auditor': 'Auditor', reviewer: 'Reviewer', 'product-designer': 'Designer', 'task-manager': 'Taskavel' };
  const provider = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode' }[harness] ?? harness;
  const named = /(?:^|[-/])(terra|luna|sol|astra)(?:$|[-/])/i.exec(model)?.[1];
  const label = named ? named[0].toUpperCase() + named.slice(1).toLowerCase() : model;
  return `${provider} ${label} · ${labels[role] ?? role}`;
}
const roles = new Set(['explorer', 'product-designer', 'dev-planner', 'dev-builder', 'dev-tester', 'reviewer', 'dev-auditor', 'verifier', 'frontend-qa', 'task-manager']);
// unified_exec selects the shell implementation; shell_tool gates its availability.
const browserDisabledFeatures = ['shell_tool', 'browser_use', 'browser_use_external',
  'browser_use_full_cdp_access', 'computer_use', 'in_app_browser', 'image_generation', 'hooks'];
// config/read exposes effective approval settings that `mcp get` omits. The
// static child keeps the public dispatcher synchronous and never starts a turn.
const browserApprovalProbe = `
const {spawn}=require('node:child_process');
const {binary,overrides,project,name}=JSON.parse(process.argv[1]);
const child=spawn(binary,['app-server',...overrides],{stdio:['pipe','pipe','ignore']});
let buffer='',done=false;
const finish=(value)=>{if(done)return;done=true;clearTimeout(timer);child.kill();if(value)process.stdout.write(JSON.stringify(value));else process.exitCode=1;};
const timer=setTimeout(()=>finish(),12000);
child.on('error',()=>finish());child.on('exit',()=>finish());child.stdin.on('error',()=>finish());
const send=value=>child.stdin.write(JSON.stringify(value)+'\\n');
child.stdout.on('data',chunk=>{try{buffer+=chunk;if(Buffer.byteLength(buffer)>2097152)return finish();let end;while((end=buffer.indexOf('\\n'))>=0){const row=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(row.id===1){if(row.error)return finish();send({method:'initialized'});send({id:2,method:'config/read',params:{includeLayers:false,cwd:project}});}if(row.id===2){const server=row.result?.config?.mcp_servers?.[name];finish(server?{defaultToolsApprovalMode:server.default_tools_approval_mode,tools:server.tools}:null);}}}catch{finish();}});
send({id:1,method:'initialize',params:{clientInfo:{name:'orkestar-browser-preflight',version:'1'},capabilities:{experimentalApi:true}}});
`;
const hash = value => createHash('sha256').update(value).digest('hex');
const text = (value, label, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
};
function safePath(project, relative, create = false) {
  const target = path.join(project, relative);
  if (!target.startsWith(`${project}${path.sep}`)) throw new Error('Path outside project');
  let current = project;
  const parts = path.relative(project, target).split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (create && index < parts.length - 1) fs.mkdirSync(current, { mode: 0o700 });
      else if (index < parts.length - 1) throw error;
      continue;
    }
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw new Error('Unsafe worker path');
  }
  return target;
}
function read(project, relative) {
  const file = safePath(project, relative);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > LIMIT) throw new Error('Invalid bounded worker file');
  return fs.readFileSync(file, 'utf8');
}
function json(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > LIMIT) throw new Error('Oversized worker response');
  return JSON.parse(value);
}
function setup(project, invoke) {
  if (!path.isAbsolute(project ?? '') || fs.realpathSync(project) !== project) throw new Error('Project must be canonical absolute directory');
  const binding = json(read(project, '.agent-orchestra/runtime/solo-observer.json'));
  if (binding.schemaVersion !== 1 || binding.project !== project || !Number.isSafeInteger(binding.projectId) || binding.projectId < 1) throw new Error('Invalid worker Solo binding');
  const soloBinary = verifySoloBinary(binding.soloBinary);
  const execute = (binary, args) => {
    const result = invoke(binary, args, { cwd: project, encoding: 'utf8', timeout: 15000, maxBuffer: LIMIT });
    if (result.error || result.status !== 0) throw new Error('Worker CLI failed; no success inferred');
    return result.stdout;
  };
  const solo = args => {
    const response = json(execute(soloBinary, [...args, '--json']));
    if (response.ok !== true || !response.data) throw new Error('Solo worker request failed');
    return response.data;
  };
  const actual = solo(['projects', 'get', String(binding.projectId)]);
  if (actual.id !== binding.projectId || actual.path !== project) throw new Error('Solo project mismatch');
  return { binding, execute, solo };
}
function safeTool(command, harness) {
  if (command === harness) return command;
  if (!path.isAbsolute(command ?? '') || ![harness, `${harness}.exe`].includes(path.basename(command))) throw new Error('Unsafe native agent command');
  fs.accessSync(command, fs.constants.X_OK);
  return command;
}

/** Construct an actual CLI role, never an agent name posing as role activation. */
export function nativeWorkerArguments({ harness, role, model, effort, body, tools = [], task, mcpNames = [], project }) {
  if (!['codex', 'claude'].includes(harness) || !roles.has(role)) throw new Error('Unsupported worker envelope');
  text(model, 'model');
  if (!['low', 'medium', 'high'].includes(effort) && !(harness === 'claude' && effort == null)) throw new Error('Unsupported reasoning effort');
  if (typeof body !== 'string' || !body.trim() || body.length > 65536) throw new Error('Invalid role instructions');
  const contract = validateTaskContract(task?.contract);
  const goal = text(task?.goal, 'bounded task', 16000);
  if (!Array.isArray(task?.evidence) || !task.evidence.length || task.evidence.length > 30) throw new Error('Required evidence contract is missing');
  task.evidence.forEach(value => text(value, 'evidence', 1000));
  if (role === 'task-manager') {
    if (task.requiresWrite === true) throw new Error('Taskavel workers cannot write project files');
    const taskavelLaunch = nativeTaskavelArguments({ harness, model, effort, roleBody: body, task });
    return { args: taskavelLaunch.args, readOnly: true, limitations: taskavelLaunch.limitations, taskavelLaunch };
  }
  if (task.taskavel !== undefined) throw new Error('Taskavel authorization requires the task-manager envelope');
  const readOnly = role !== 'dev-builder';
  if (readOnly && task.requiresWrite === true) throw new Error('This worker route is read-only; request test edits from the builder');
  let browser;
  if (role === 'frontend-qa') {
    try { browser = resolveNativeWorkerBrowser({ project, role }); } catch { throw new Error('Frontend QA requires explicit pinned browser setup'); }
    if (mcpNames.includes(browser.name)) throw new Error('Reserved browser MCP name conflicts with inherited configuration');
  }
  const browserInstruction = browser ? ` Browser discovery is already verified: ${browser.browserBinary}. Use only orkestar_browser tools. Screenshots belong in ${browser.outputDir}. Do not submit real data or perform external changes. The present_image helper is unavailable in this route; return screenshot absolute paths to the conductor for display. Browser interaction does not grant permission to edit project files.` : '';
  const ownershipInstruction = task.ownership
    ? ` This concurrent writer owns only these project-relative paths: ${task.ownership.paths.join(', ')}. Do not edit any other path.` : '';
  const instruction = `${body}\n\nThis is one bounded visible Solo worker. Do not delegate or start other agents. Return evidence to the conductor; your completion is not independent acceptance. ${readOnly ? 'This invocation is strictly read-only, including the tester: return proposed test changes instead of applying them.' : 'Only the approved project work is authorized; no deletion, resets, publication or external changes.'}${ownershipInstruction}${browserInstruction}`;
  const prompt = JSON.stringify({ contract, goal, evidence: task.evidence, requiresWrite: task.requiresWrite === true,
    ...(task.ownership ? { ownership: task.ownership } : {}) });
  if (harness === 'codex') {
    // The validated, explicitly bound project may be a fresh non-Git application.
    // This skips only repository detection; the role sandbox remains enforced.
    const args = ['exec', '--skip-git-repo-check', '--json', '--color', 'never', '--model', model, '--sandbox', readOnly ? 'read-only' : 'workspace-write'];
    for (const value of ['approval_policy="never"', `model_reasoning_effort=${JSON.stringify(effort)}`, `developer_instructions=${JSON.stringify(instruction)}`,
      'apps._default.enabled=false', 'features.apps=false', 'features.plugins=false', 'features.multi_agent=false', 'web_search="disabled"',
      'sandbox_workspace_write.network_access=false', 'sandbox_workspace_write.writable_roots=[]', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.exclude_slash_tmp=true']) args.push('-c', value);
    for (const name of mcpNames) {
      text(name, 'MCP server name');
      // Codex splits override keys on dots; quoted TOML segments become literal names.
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Unsupported MCP server name for safe Codex override');
      args.push('-c', `mcp_servers.${name}.enabled=false`);
    }
    if (browser) {
      for (const feature of browserDisabledFeatures) args.push('-c', `features.${feature}=false`);
      const approvals = browser.enabledTools.map(name => `${name}={approval_mode="approve"}`).join(',');
      args.push('-c', `mcp_servers.${browser.name}={command=${JSON.stringify(browser.server.command)},args=${JSON.stringify(browser.server.args)},enabled=true,required=true,enabled_tools=${JSON.stringify(browser.enabledTools)},default_tools_approval_mode="prompt",tools={${approvals}},env={},env_vars=[]}`);
    }
    return { args: [...args, prompt], readOnly, ...(browser ? { browser } : {}), limitations: [
      ...(browser ? [...browser.limitations, 'Browser worker has no shell. Codex may expose read-only helpers and apply_patch, but its read-only sandbox rejects edits. The MCP gateway alone is limited to 17 browser tools; screenshot display must be performed by the conductor.'] : ['Shell sandbox enforces filesystem policy, not every role command pattern.']),
      ...(role === 'dev-tester' ? ['Tester cannot edit tests in this route.'] : [])] };
  }
  let allowed = browser ? [] : tools.filter(tool => typeof tool === 'string' && tool !== 'Task' && tool !== 'Agent' && !tool.startsWith('mcp__'));
  if (readOnly && allowed.some(tool => ['Write', 'Edit', 'NotebookEdit', 'Bash', 'PowerShell'].includes(tool))) throw new Error('Claude read-only role has broad write-capable tools');
  // Existing user allow rules must not turn a patterned Bash tool into a write escape.
  // A narrower read-only Claude worker returns requested execution to the conductor.
  if (readOnly) allowed = allowed.filter(tool => !tool.startsWith('Bash(') && !tool.startsWith('PowerShell('));
  const builtinTools = [...new Set(allowed.map(tool => tool.split('(')[0]))].join(',');
  if (browser) allowed = browser.enabledTools.map(tool => `mcp__${browser.name}__${tool}`);
  return { args: ['--agent', role, '--model', model, ...(effort == null ? [] : ['--effort', effort]), '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config',
    JSON.stringify({ mcpServers: browser ? { [browser.name]: browser.server } : {} }),
    '--tools', builtinTools, '--allowedTools', allowed.join(','), '--disallowedTools', browser ? 'Agent,Task,Bash,PowerShell,Read,Write,Edit,NotebookEdit,WebFetch,WebSearch' : 'Agent,Task',
    ...(browser ? ['--no-chrome', '--restricted', '--setting-sources', '', '--disable-slash-commands'] : []),
    '--append-system-prompt', instruction, '--print', '--verbose', '--output-format', 'stream-json', prompt], readOnly, ...(browser ? { browser } : {}),
  limitations: ['Claude tool permissions do not replace an operating-system filesystem sandbox.', ...(browser ? [...browser.limitations, 'Screenshot display must be performed by the conductor.'] : []), ...(readOnly ? ['Read-only Claude workers have no shell execution; request execution evidence from the conductor.'] : []), ...(role === 'dev-tester' ? ['Tester cannot edit tests in this route.'] : [])] };
}

export function preflightNativeWorkerBrowser({ project, harness, binary, launch }, { invoke = spawnSync } = {}) {
  const browser = launch.browser;
  if (!browser) throw new Error('Missing browser worker preflight configuration');
  const run = (args, input) => {
    const result = invoke(binary, args, { cwd: project, encoding: 'utf8', timeout: 15000, maxBuffer: LIMIT, ...(input ? { input } : {}) });
    if (result.error || result.status !== 0) throw new Error('Native browser configuration preflight failed');
    return result.stdout;
  };
  const sameTools = list => Array.isArray(list) && list.length === BROWSER_TOOLS.length && new Set(list).size === BROWSER_TOOLS.length && list.every(tool => BROWSER_TOOLS.includes(tool));
  const commandMatches = server => server?.command === browser.server.command && JSON.stringify(server.args) === JSON.stringify(browser.server.args)
    && Object.keys(server.env ?? {}).length === 0 && (server.env_vars ?? []).length === 0 && !server.cwd;
  if (harness === 'codex') {
    const overrides = launch.args.flatMap((value, index) => value === '-c' ? ['-c', launch.args[index + 1]] : []);
    const list = json(run(['mcp', 'list', '--json', ...overrides]));
    if (!Array.isArray(list) || !list.length || list.length > 101 || new Set(list.map(server => server.name)).size !== list.length
      || list.some(server => typeof server.name !== 'string' || server.enabled !== (server.name === browser.name))
      || !list.some(server => server.name === browser.name)) throw new Error('Native browser configuration preflight failed');
    const server = json(run(['mcp', 'get', browser.name, '--json', ...overrides]));
    if (server.name !== browser.name || server.enabled !== true || server.transport?.type !== 'stdio' || !commandMatches(server.transport)
      || !sameTools(server.enabled_tools) || (server.disabled_tools ?? []).length) throw new Error('Native browser configuration preflight failed');
    const features = run(['features', 'list', ...overrides]);
    for (const feature of browserDisabledFeatures) if (!new RegExp(`^${feature}\\s+.*\\sfalse\\s*$`, 'm').test(features)) throw new Error('Native browser configuration preflight failed');
    const probe = invoke(process.execPath, ['-e', browserApprovalProbe, JSON.stringify({ binary, overrides, project, name: browser.name })],
      { cwd: project, encoding: 'utf8', timeout: 15000, maxBuffer: LIMIT });
    if (probe.error || probe.status !== 0) throw new Error('Native browser configuration preflight failed');
    const approvals = json(probe.stdout);
    if (approvals.defaultToolsApprovalMode !== 'prompt' || !approvals.tools || !sameTools(Object.keys(approvals.tools))
      || Object.values(approvals.tools).some(tool => tool?.approval_mode !== 'approve')) throw new Error('Native browser configuration preflight failed');
  } else if (harness === 'claude') {
    const input = [{ type: 'control_request', request_id: 'orkestar-init', request: { subtype: 'initialize' } },
      { type: 'control_request', request_id: 'orkestar-mcp', request: { subtype: 'mcp_status' } }].map(JSON.stringify).join('\n') + '\n';
    const output = run([...launch.args.slice(0, -1), '--input-format', 'stream-json', '--no-session-persistence'], input);
    const rows = output.split('\n').filter(Boolean).map(json);
    const response = rows.find(row => row.type === 'control_response' && row.response?.request_id === 'orkestar-mcp')?.response;
    const servers = response?.response?.mcpServers;
    if (response?.subtype !== 'success' || !Array.isArray(servers) || servers.length !== 1 || servers[0].name !== browser.name
      || servers[0].status !== 'connected' || servers[0].config?.type !== 'stdio' || !commandMatches(servers[0].config)
      || !sameTools(servers[0].tools?.map(tool => tool.name))) throw new Error('Native browser configuration preflight failed');
  } else throw new Error('Unsupported worker envelope');
  return true;
}

export function dispatchNativeSoloWorker(options, { invoke = spawnSync } = {}) {
  const { project, harness, profile, name, runId, task, ownerSessionId } = options;
  if (!['codex', 'claude'].includes(harness) || !/^[a-z0-9-]{1,80}$/.test(profile ?? '') || !/^[a-f0-9-]{36}$/.test(runId ?? '')) throw new Error('Invalid worker request');
  text(name, 'worker name', 120); text(ownerSessionId, 'owner session');
  const { binding, execute, solo } = setup(project, invoke);
  if (!(binding.harnesses ?? [binding.harness]).includes(harness)) throw new Error('Harness not bound to this Solo project');
  const runtime = json(read(project, `.agent-orchestra/runtime/${harness}.json`));
  const route = runtime.profiles?.[profile];
  if (runtime.schemaVersion !== 1 || runtime.harness !== harness || !route || !roles.has(route.permissionEnvelope)
    || route.externalWrites === true && !(profile === 'taskavel' && route.permissionEnvelope === 'task-manager')) throw new Error('Unsupported runtime worker route');
  const role = route.permissionEnvelope;
  if ((profile === 'taskavel') !== (role === 'task-manager')) throw new Error('Unsupported runtime worker route');
  if ((profile === 'ui-verify') !== (role === 'frontend-qa')) throw new Error('Unsupported runtime worker route');
  const roleRelative = harness === 'codex' ? `.codex/agents/${role}.toml` : `.claude/agents/${role}.md`;
  const raw = read(project, roleRelative);
  let body, allowed;
  if (harness === 'codex') {
    const match = raw.match(/\ndeveloper_instructions = """\n([\s\S]*)\n"""\s*$/);
    if (!match || !raw.includes(`name = "${role}"`) || !raw.includes(`model = "${route.model}"`)) throw new Error('Installed Codex role does not match runtime');
    body = match[1];
  } else {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) throw new Error('Invalid installed Claude role');
    // Accept only the generated frontmatter subset, not arbitrary YAML coercions.
    const front = match[1].match(/^name: ([^\n]+)\ndescription: [^\n]*\nmodel: ([^\n]+)\ntools:\n((?:  - [^\n]+\n?)*)$/);
    if (!front || front[1] !== role || front[2] !== route.model) throw new Error('Installed Claude role does not match runtime');
    body = match[2]; allowed = front[3].split('\n').filter(Boolean).map(line => line.slice(4));
    if (role === 'dev-tester') allowed = allowed.filter(tool => !['Edit', 'Write'].includes(tool));
  }
  const toolList = solo(['agents', 'list']);
  const visibleTool = liveWorkerTool(toolList.agentTools ?? []);
  const matches = (toolList.agentTools ?? []).filter(tool => tool.enabled === true && tool.toolType === harness).filter(tool => {
    try { safeTool(tool.command, harness); return true; } catch { return false; }
  });
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].id < 1) throw new Error('Exactly one safe native Solo agent tool is required');
  const tool = matches[0], binary = safeTool(tool.command, harness);
  let mcpNames = [];
  if (harness === 'codex') {
    const features = execute(binary, ['features', 'list']);
    for (const feature of ['apps', 'plugins', 'multi_agent']) if (!new RegExp(`^${feature}\\s+`, 'm').test(features)) throw new Error('Installed Codex cannot prove worker isolation features');
    const list = json(execute(binary, ['mcp', 'list', '--json', '--disable', 'plugins', '--disable', 'apps']));
    if (!Array.isArray(list) || list.length > 100 || list.some(server => typeof server.name !== 'string')) throw new Error('Cannot enumerate inherited MCP servers');
    mcpNames = list.map(server => server.name);
  }
  const launch = nativeWorkerArguments({ project, harness, role, model: route.model, effort: route.reasoningEffort, body, tools: allowed, task, mcpNames });
  if (harness === 'codex') {
    const disabled = json(execute(binary, ['mcp', 'list', '--json', '--disable', 'plugins', '--disable', 'apps',
      ...mcpNames.flatMap(server => ['-c', `mcp_servers.${server}.enabled=false`])]));
    if (!Array.isArray(disabled) || disabled.length !== mcpNames.length || disabled.some(server => !mcpNames.includes(server.name) || server.enabled !== false)) {
      throw new Error('Codex inherited MCP isolation was not verified; no worker launched');
    }
  }
  if (launch.browser) preflightNativeWorkerBrowser({ project, harness, binary, launch }, { invoke });
  if (launch.taskavelLaunch) {
    const preflight = preflightNativeTaskavelSync({ project, binary, launch: launch.taskavelLaunch }, { invoke });
    bindTaskavelAssignment({ project, contract: task.contract, authorization: launch.taskavelLaunch.authorization, names: preflight.projectNames });
  }
  const file = safePath(project, `.agent-orchestra/dispatch/native-${runId}.json`, true);
  // Exclusive reservation prevents duplicate workers on retries/concurrent dispatch.
  const receipt = { schemaVersion: 1, project, projectId: binding.projectId, ownerSessionId, runId, harness, profile, role, name, model: route.model,
    displayName: workerDisplayName(harness, route.model, role), reasoningEffort: route.reasoningEffort, readOnly: launch.readOnly, limitations: launch.limitations, contractId: task.contract.id,
    argumentsHash: hash(JSON.stringify(launch.args)), roleHash: hash(raw), dispatchedAt: Date.now(), launchArgumentsVerified: false, processId: null, state: 'launching', acceptance: 'PARTIAL' };
  receipt.policyHash = hash(JSON.stringify(launch.args.slice(0, -1)));
  if (options.continueRunId !== undefined) {
    if (!/^[a-f0-9-]{36}$/.test(options.continueRunId) || options.continueRunId === runId
      || role === 'task-manager') throw new Error('Invalid worker continuation');
    const previous = collectNativeSoloWorkerResult({ project, runId: options.continueRunId }, { invoke });
    if (!['stopped', 'exited'].includes(previous.state) || !/^[a-f0-9-]{36}$/.test(previous.sessionId ?? '')
      || previous.project !== project || previous.harness !== harness || previous.profile !== profile
      || previous.ownerSessionId !== ownerSessionId || previous.contractId !== task.contract.id
      || previous.roleHash !== receipt.roleHash || previous.policyHash !== receipt.policyHash
      || previous.model !== route.model || previous.readOnly !== launch.readOnly) throw new Error('Invalid worker continuation');
    const priorLaunch = json(read(project, `.agent-orchestra/dispatch/native-${options.continueRunId}.launch.json`));
    const priorTask = JSON.parse(priorLaunch.args.at(-1));
    if (JSON.stringify(priorTask.ownership ?? null) !== JSON.stringify(task.ownership ?? null)) throw new Error('Invalid worker continuation');
    const prompt = launch.args.pop();
    if (harness === 'codex') launch.args.push('resume', previous.sessionId, prompt);
    else launch.args.push('--resume', previous.sessionId, prompt);
    receipt.continueRunId = options.continueRunId;
    receipt.workerSessionRunId = previous.workerSessionRunId ?? previous.runId;
    receipt.resumedSessionId = previous.sessionId;
    receipt.argumentsHash = hash(JSON.stringify(launch.args));
  }
  if (launch.taskavelLaunch) receipt.taskavelAuthorization = launch.taskavelLaunch.authorization;
  const fd = fs.openSync(file, 'wx', 0o600);
  let descriptorCreated = false, continuationClaim = null, spawnAttempted = false;
  try {
    // The descriptor is private (0600). Keeping the validated contract goal here
    // lets the visible wrapper identify the bounded work without inspecting the
    // provider prompt or retaining raw provider output.
    const encoded = JSON.stringify({ project, runId, harness, role, name, model: route.model, goal: task.contract.goal, binary, args: launch.args });
    receipt.liveLaunchHash = hash(encoded);
    receipt.outputFormat = 'private-native-stream-v1';
    fs.writeFileSync(file.replace(/\.json$/, '.launch.json'), encoded, { flag: 'wx', mode: 0o600 });
    descriptorCreated = true;
    if (receipt.continueRunId) {
      // Claim only after exclusive successor files exist. Duplicate IDs cannot
      // consume a predecessor. After a spawn attempt, retain the claim because
      // a missing acknowledgement cannot prove that no process was started.
      fs.writeFileSync(safePath(project, `.agent-orchestra/dispatch/native-${receipt.continueRunId}.continued.json`, true),
        JSON.stringify({ runId, sessionId: receipt.resumedSessionId }), { flag: 'wx', mode: 0o600 });
      continuationClaim = safePath(project, `.agent-orchestra/dispatch/native-${receipt.continueRunId}.continued.json`);
    }
    fs.writeSync(fd, JSON.stringify(receipt), 0, 'utf8');
    const wrapper = path.join(project, '.agent-orchestra/worker/native-worker-live.mjs');
    safePath(project, '.agent-orchestra/worker/native-worker-live.mjs');
    spawnAttempted = true;
    const result = solo(['processes', 'spawn', '--project-id', String(binding.projectId), '--kind', 'agent', '--agent-tool-id', String(visibleTool.id), '--name', receipt.displayName,
      ...[wrapper, project, runId, receipt.liveLaunchHash].flatMap(arg => ['--arg', arg])]);
    const process = result.process ?? result;
    if (!Number.isSafeInteger(process.id) || process.id < 1 || process.kind !== 'agent') throw new Error('Solo did not return a real agent worker');
    receipt.processId = process.id; receipt.state = 'started';
    // Keep the exclusive descriptor: never reopen a replaced receipt path for truncation.
    fs.ftruncateSync(fd, 0); fs.writeSync(fd, JSON.stringify(receipt), 0, 'utf8');
  } finally {
    // Before spawn, roll back only artifacts created by this invocation. Once
    // spawn is attempted its outcome may be uncertain, so retain all evidence.
    if (!spawnAttempted) {
      if (continuationClaim) fs.unlinkSync(continuationClaim);
      if (descriptorCreated) fs.unlinkSync(file.replace(/\.json$/, '.launch.json'));
      const owned = fs.fstatSync(fd), current = fs.lstatSync(file);
      if (owned.ino === current.ino && owned.dev === current.dev) fs.unlinkSync(file);
    }
    fs.closeSync(fd);
  }
  return receipt;
}

export function nativeSoloWorkerStatus({ project, runId }, { invoke = spawnSync } = {}) {
  if (!/^[a-f0-9-]{36}$/.test(runId ?? '')) throw new Error('Invalid worker run ID');
  const { binding, solo } = setup(project, invoke);
  const receipt = json(read(project, `.agent-orchestra/dispatch/native-${runId}.json`));
  if (receipt.schemaVersion !== 1 || receipt.project !== project || receipt.projectId !== binding.projectId || receipt.runId !== runId || !Number.isSafeInteger(receipt.processId)) throw new Error('Invalid native worker receipt');
  const process = solo(['processes', 'get', String(receipt.processId)]);
  if (process.id !== receipt.processId || process.projectId !== binding.projectId || process.kind !== 'agent' || process.name !== (receipt.displayName ?? receipt.name)) throw new Error('Native worker process identity mismatch');
  return { ...receipt, state: process.status, acceptance: 'PARTIAL' };
}

export function collectNativeSoloWorkerResult(options, dependencies = {}) {
  const receipt = nativeSoloWorkerStatus(options, dependencies);
  const invoke = dependencies.invoke ?? spawnSync;
  const { binding } = setup(options.project, invoke);
  let raw = '';
  let outputIssue = null;
  let liveDiagnostics = null;
  let recovered = null;
  if (receipt.outputFormat === 'private-native-stream-v1') {
    try {
      const output = readLiveWorkerOutput(options.project, receipt); raw = output.raw;
      if (output.diagnostic || output.truncated || output.exitCode !== 0 || output.rawTruncated) liveDiagnostics = { nativeDiagnostic: output.diagnostic, truncated: output.truncated, exitCode: output.exitCode,
        ...(output.rawTruncated ? { rawTruncated: true } : {}), ...(output.streamInvalid ? { streamInvalid: true } : {}), ...(output.evidenceTruncated ? { evidenceTruncated: true } : {}),
        ...(output.startupDiagnostic ? { startupDiagnostic: output.startupDiagnostic } : {}) };
      if (output.truncated) outputIssue = 'Private native evidence is invalid or exceeded its capture limit. Work was not interrupted; complete evidence is unavailable.';
      else if (output.exitCode !== 0) outputIssue = 'The native worker exited unsuccessfully. Its response is partial evidence, not a completed worker result.';
      if (output.startupDiagnostic) outputIssue = output.startupDiagnostic.message;
      if (receipt.harness === 'claude' && receipt.role === 'task-manager' && output.rawTruncated) {
        liveDiagnostics.truncated = true;
        outputIssue = 'Claude Taskavel tool evidence exceeded the raw capture bound. A compact final response cannot prove external tracker operations.';
      }
      if (receipt.harness === 'codex' && ['Exited', 'exited'].includes(receipt.state) && output.exitCode === 0 && output.truncated && output.rawTruncated === undefined) {
        try {
          recovered = (dependencies.recoverCodexWorker ?? recoverCodexWorker)({ project: options.project, receipt,
            launchEncoded: read(options.project, `.agent-orchestra/dispatch/native-${receipt.runId}.launch.json`), rawPrefix: raw, exitCode: output.exitCode });
          const file = safePath(options.project, `.agent-orchestra/dispatch/native-${receipt.runId}.recovery.json`);
          try { fs.writeFileSync(file, JSON.stringify(recovered.recoveryProvenance), { flag: 'wx', mode: 0o600 }); }
          catch (error) { if (error.code !== 'EEXIST') throw error;
            const prior = json(read(options.project, `.agent-orchestra/dispatch/native-${receipt.runId}.recovery.json`));
            if (prior.runId !== receipt.runId || prior.launchHash !== receipt.liveLaunchHash || prior.originalPrefixHash !== hash(raw)) throw new Error('Recovery provenance changed');
          }
          outputIssue = null;
        } catch { recovered = null; outputIssue = 'The original native capture is truncated and exact-session recovery could not be verified.'; }
      }
    }
    catch { outputIssue = 'Private native output is not complete or could not be verified.'; }
  } else {
  try { raw = (dependencies.readMcpOutput ?? readSoloMcpOutput)({ soloBinary: binding.soloBinary,
    project: options.project, projectId: receipt.projectId, processId: receipt.processId }); }
  catch { /* Some Solo distributions expose only the verified CLI route. */ }
  if (!raw.trim()) {
    const result = invoke(binding.soloBinary, ['processes', 'output', String(receipt.processId), '--project-id', String(receipt.projectId), '--lines', '10000', '--raw', '--json'],
      { cwd: options.project, encoding: 'utf8', timeout: 15000, maxBuffer: RAW_OUTPUT_LIMIT * 2 });
    if (!result.error && result.status === 0 && typeof result.stdout === 'string' && Buffer.byteLength(result.stdout) <= RAW_OUTPUT_LIMIT * 2) {
      const response = JSON.parse(result.stdout);
      const output = response.data;
      if (response.ok !== true || !output || output.id !== receipt.processId || output.projectId !== receipt.projectId || output.kind !== 'raw' || typeof output.text !== 'string' || Buffer.byteLength(output.text) > RAW_OUTPUT_LIMIT) throw new Error('Invalid bounded worker output');
      raw = output.text;
    }
  }
  }
  const evidence = recovered ? { ...recovered, actualModel: null } : parseNativeWorkerOutput(receipt.harness, raw);
  if (!raw.trim() && !outputIssue) outputIssue = 'Native output is unavailable; process exit alone does not prove worker failure or success.';
  else if (!evidence.complete && !outputIssue) outputIssue = 'Native evidence is incomplete, still running, or outside the bounded output window; this does not prove provider failure.';
  if ((!recovered && liveDiagnostics?.truncated) || (liveDiagnostics && liveDiagnostics.exitCode !== 0)) evidence.complete = false;
  const taskavelEvidence = receipt.harness === 'claude' && receipt.role === 'task-manager' && evidence.complete
    ? extractClaudeTaskavelEvidence(raw, { sessionId: evidence.sessionId, authorization: receipt.taskavelAuthorization, observedAt: Date.now() }) : null;
  if (receipt.resumedSessionId && evidence.sessionId !== receipt.resumedSessionId) evidence.complete = false;
  return { ...receipt, ...evidence, ...(liveDiagnostics ? { liveDiagnostics } : {}), ...(outputIssue ? { outputIssue } : {}), ...(taskavelEvidence ? { taskavelEvidence } : {}), acceptance: 'PARTIAL', notice: 'Worker output is untrusted evidence. Independent review and acceptance are still required.' };
}

export function parseNativeWorkerOutput(harness, output) {
  if (!['codex', 'claude'].includes(harness) || typeof output !== 'string' || Buffer.byteLength(output) > RAW_OUTPUT_LIMIT) throw new Error('Invalid worker output');
  let rows; const rolloutDiagnostics = [];
  try { rows = output.split(/\r?\n/).filter(line => line.trim()).filter(line => {
    const diagnostic = harness === 'codex' && line.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}Z ERROR codex_core::session: failed to record rollout items: thread ([a-f0-9-]{36}) not found$/);
    if (!diagnostic) return true;
    rolloutDiagnostics.push(diagnostic[1]); return false;
  }).map(JSON.parse); } catch { return { sessionId: null, result: null, tokens: null, cost: null, complete: false }; }
  const start = rows[0];
  const sessionId = harness === 'codex' && start?.type === 'thread.started' ? start.thread_id
    : harness === 'claude' && start?.type === 'system' && start.subtype === 'init' ? start.session_id : null;
  const last = rows.at(-1);
  const starts = rows.filter(row => harness === 'codex' ? row?.type === 'thread.started' : row?.type === 'system' && row.subtype === 'init');
  const foreign = rows.some(row => row?.session_id && row.session_id !== sessionId) || rolloutDiagnostics.some(id => id !== sessionId);
  const complete = Boolean(typeof sessionId === 'string' && sessionId.length > 0 && starts.length === 1 && !foreign && (harness === 'codex' ? last?.type === 'turn.completed' : last?.type === 'result' && last.subtype === 'success' && !last.is_error));
  let result = null, tokens = null;
  if (complete) {
    result = harness === 'codex' ? rows.filter(row => row.type === 'item.completed' && row.item?.type === 'agent_message').at(-1)?.item.text ?? null : last.result ?? null;
    const usage = last.usage;
    const counts = usage && [usage.input_tokens, usage.output_tokens, ...(harness === 'claude' ? [usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0] : [])];
    if (counts && counts.every(value => Number.isSafeInteger(value) && value >= 0)) {
      const input = usage.input_tokens + (harness === 'claude' ? (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : 0);
      const total = input + usage.output_tokens;
      if (Number.isSafeInteger(input) && Number.isSafeInteger(total) && input >= 0) tokens = { input, output: usage.output_tokens, total };
      if (tokens && harness === 'codex' && Number.isSafeInteger(usage.cached_input_tokens)
        && usage.cached_input_tokens >= 0 && usage.cached_input_tokens <= input) {
        tokens.cachedInput = usage.cached_input_tokens;
        tokens.uncachedInput = input - usage.cached_input_tokens;
      }
    }
  }
  return { sessionId: typeof sessionId === 'string' ? sessionId : null, actualModel: harness === 'claude' && complete && typeof start.model === 'string' ? start.model : null,
    result: typeof result === 'string' ? result : null, tokens,
    cost: harness === 'claude' && complete && typeof last.total_cost_usd === 'number'
      && Number.isFinite(last.total_cost_usd) && last.total_cost_usd >= 0 ? last.total_cost_usd : null,
    complete, ...(rolloutDiagnostics.length ? { diagnostics: [{ code: 'CODEX_ROLLOUT_RECORDING_FAILED', count: rolloutDiagnostics.length,
      warning: 'Codex reported a local rollout recording failure. Response completion does not establish task success or durable native history.' }] } : {}) };
}
