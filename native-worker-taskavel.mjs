import { spawn, spawnSync } from 'node:child_process';
import { normalizeTaskavelReadback, taskavelMembershipContains } from './native-taskavel-readback.mjs';
import { taskavelProjectNames, assertUniqueTaskavelProject } from './native-taskavel-binding.mjs';

export const TASKAVEL_SERVER = Object.freeze({ name: 'taskavel', type: 'http', url: 'https://taskavel.com/mcp/taskavel' });
export const TASKAVEL_OPERATIONS = Object.freeze({
  read: Object.freeze(['list-projects-tool', 'list-boards-tool', 'list-board-columns-tool', 'search-tasks-tool', 'get-task-details-tool', 'get-board-snapshot-tool', 'filter-tasks-tool']),
  'create-project': Object.freeze(['create-project-tool']),
  'create-board': Object.freeze(['create-board-tool']),
  'create-task': Object.freeze(['create-task-tool']),
  'update-task': Object.freeze(['update-task-tool']),
  'move-task': Object.freeze(['move-task-to-column-tool']),
  'add-comment': Object.freeze(['add-comment-tool']),
});
const disabledFeatures = ['shell_tool', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
  'computer_use', 'in_app_browser', 'image_generation', 'hooks', 'apps', 'plugins', 'multi_agent'];
const constructedLaunches = new WeakSet();
const assignments = new WeakMap();
const registered = (launch, assignment) => {
  const frozen = Object.freeze(launch); constructedLaunches.add(frozen);
  assignments.set(frozen, structuredClone(assignment)); return frozen;
};
const plain = (value, max = 16000) => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const id = value => Number.isSafeInteger(value) && value > 0;

export function validateTaskavelAuthorization(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['projectId', 'projectName', 'taskIds', 'operations', 'externalWriteAuthorized'].includes(key))
    || !Array.isArray(value.operations) || !value.operations.length || value.operations.length > 7
    || new Set(value.operations).size !== value.operations.length
    || value.operations.some(op => !Object.hasOwn(TASKAVEL_OPERATIONS, op))
    || !Array.isArray(value.taskIds) || value.taskIds.length > 100 || value.taskIds.some(task => !id(task))
    || new Set(value.taskIds).size !== value.taskIds.length || typeof value.externalWriteAuthorized !== 'boolean') throw new Error('Invalid Taskavel authorization');
  const creating = value.operations.includes('create-project');
  if (creating ? value.projectId !== null || !plain(value.projectName, 200) || value.operations.some(op => !['read', 'create-project'].includes(op)) || value.taskIds.length
    : !id(value.projectId) && !(value.projectId === null && plain(value.projectName, 200))) throw new Error('Taskavel requires one resolved project or a separate project-creation assignment');
  if (value.projectName !== undefined && !plain(value.projectName, 200)) throw new Error('Invalid Taskavel project name');
  if (value.operations.some(op => ['update-task', 'move-task', 'add-comment'].includes(op)) && !value.taskIds.length) throw new Error('Taskavel task updates require resolved task IDs');
  if (value.operations.some(op => op !== 'read') && !value.externalWriteAuthorized) throw new Error('Taskavel writes require explicit authorization');
  return Object.freeze({ ...value, taskIds: Object.freeze([...value.taskIds]), operations: Object.freeze([...value.operations]) });
}

/** Native clients own OAuth. This module neither reads nor copies credential stores. */
export function nativeTaskavelArguments({ harness, model, effort, roleBody, task }) {
  if (!['claude', 'codex'].includes(harness)) throw new Error('Unsupported Taskavel harness');
  if (!plain(model, 200) || /\s/.test(model) || !plain(roleBody, 65536) || !plain(task?.goal)) throw new Error('Invalid Taskavel assignment');
  if (!['low', 'medium', 'high'].includes(effort) && !(harness === 'claude' && effort === null)) throw new Error('Unsupported Taskavel reasoning effort');
  const authorization = validateTaskavelAuthorization(task.taskavel);
  const assignment = { harness, model, effort, roleBody, task: { goal: task.goal, taskavel: authorization } };
  const enabledTools = Object.freeze([...new Set([...TASKAVEL_OPERATIONS.read, ...authorization.operations.flatMap(op => TASKAVEL_OPERATIONS[op])])]);
  const instruction = `${roleBody}\n\nUse only the named Taskavel MCP connection. Do not delegate, execute commands, read local files, edit files, upload attachments, delete, archive, invite members, or perform bulk operations. Perform only the charter-authorized project/task operations. Use the exact projectName as project_name; never select another existing project or invent a numeric project ID. After every update, read back task details and its actual board column and completion flag. Do not claim authenticated success from your own summary. Project creation is a separate assignment: return the exact created project name and native creation response before any further writes. The next assignment verifies that name independently. Tool permissions do not enforce project/task argument scope.`;
  const prompt = JSON.stringify({ goal: task.goal, taskavel: authorization });
  const server = Object.freeze({ type: TASKAVEL_SERVER.type, url: TASKAVEL_SERVER.url });
  const limitations = Object.freeze(['Tool access is restricted; project/task IDs are a charter restriction, not an enforced remote authorization boundary.',
    'Each harness must have its own existing native OAuth connection; no cross-harness credential reuse is provided.',
    'Authenticated tool-result readback must be collected independently; model summaries are not reconciliation evidence.']);
  if (harness === 'claude') {
    const args = ['--restricted', '--setting-sources', '', '--disable-slash-commands', '--no-chrome', '--tools', '',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { taskavel: server } }),
      '--allowedTools', enabledTools.map(tool => `mcp__taskavel__${tool}`).join(','), '--disallowedTools', 'Agent,Task,Bash,PowerShell,Read,Write,Edit,NotebookEdit,WebFetch,WebSearch',
      '--model', model, ...(effort === null ? [] : ['--effort', effort]), '--system-prompt', instruction, '--print', '--verbose', '--output-format', 'stream-json', prompt];
    return registered({ harness, args: Object.freeze(args), server, enabledTools, authorization, limitations }, assignment);
  }
  const approvals = enabledTools.map(tool => `${tool}={approval_mode="approve"}`).join(',');
  const overrides = ['approval_policy="never"', 'sandbox_mode="read-only"', 'apps._default.enabled=false', 'web_search="disabled"',
    ...disabledFeatures.map(feature => `features.${feature}=false`), `model_reasoning_effort=${JSON.stringify(effort)}`,
    `developer_instructions=${JSON.stringify(instruction)}`,
    `mcp_servers.taskavel={url=${JSON.stringify(server.url)},enabled=true,required=true,enabled_tools=${JSON.stringify(enabledTools)},default_tools_approval_mode="prompt",tools={${approvals}}}`];
  const args = ['exec', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--json', '--color', 'never', '--sandbox', 'read-only', '--model', model,
    ...overrides.flatMap(value => ['-c', value]), prompt];
  return registered({ harness, args: Object.freeze(args), server, enabledTools, authorization,
    limitations: Object.freeze([...limitations, 'Codex may expose read-only helpers and apply_patch; its read-only sandbox rejects edits. No shell is available.']) }, assignment);
}

const syncProbe = `
const fs = require('node:fs');
(async () => {
  const helper = await import(process.argv[1]);
  const input = fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(input) > 262144) throw new Error();
  const { binary, project, assignment, taskId } = JSON.parse(input);
  const launch = helper.nativeTaskavelArguments(assignment);
  const result = taskId === undefined ? await helper.preflightNativeTaskavel({ binary, project, launch })
    : await helper.readNativeCodexTaskavel({ binary, project, launch, taskId });
  process.stdout.write(JSON.stringify(result));
})().catch(() => { process.exitCode = 1; });
`;

/** Synchronous dispatcher bridge; never echoes native stderr or raw responses. */
export function preflightNativeTaskavelSync({ binary, project, launch }, { invoke = spawnSync } = {}) {
  if (!assignments.has(launch)) throw new Error('Taskavel preflight requires an immutable constructed launch');
  const result = invoke(process.execPath, ['-e', syncProbe, import.meta.url], {
    cwd: project, input: JSON.stringify({ binary, project, assignment: assignments.get(launch) }),
    encoding: 'utf8', timeout: 35000, maxBuffer: 262144, stdio: ['pipe', 'pipe', 'ignore'],
  });
  try {
    if (result.error || result.status !== 0) throw new Error();
    const value = JSON.parse(result.stdout);
    if (value.name !== 'taskavel' || value.status !== 'connected' || !Array.isArray(value.enabledTools)
      || JSON.stringify(value.enabledTools) !== JSON.stringify(launch.enabledTools)) throw new Error();
    if (launch.authorization.projectName && !Array.isArray(value.projectNames)) throw new Error();
    return Object.freeze({ name: 'taskavel', status: 'connected', enabledTools: launch.enabledTools, ...(value.projectNames ? { projectNames: value.projectNames } : {}) });
  } catch { throw new Error('Native Taskavel preflight failed'); }
}

export function readNativeCodexTaskavelSync({ binary, project, launch, taskId }, { invoke = spawnSync } = {}) {
  if (!assignments.has(launch) || launch.harness !== 'codex' || !launch.authorization.taskIds.includes(taskId)) throw new Error('Invalid scoped Taskavel read');
  const result = invoke(process.execPath, ['-e', syncProbe, import.meta.url], {
    cwd: project, input: JSON.stringify({ binary, project, assignment: assignments.get(launch), taskId }),
    encoding: 'utf8', timeout: 35000, maxBuffer: 262144, stdio: ['pipe', 'pipe', 'ignore'],
  });
  try {
    if (result.error || result.status !== 0) throw new Error();
    const value = JSON.parse(result.stdout), readback = value.readback, snapshot = value.snapshot;
    if (!readback || readback.taskId !== taskId || readback.url !== `https://taskavel.com/tasks/${taskId}`
      || !plain(readback.projectLabel, 300) || !plain(readback.status, 300) || !plain(readback.columnName, 300)
      || !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.completedAt) || value.startedAt > value.completedAt
      || snapshot?.projectId !== (launch.authorization.projectId === null ? `name:${launch.authorization.projectName}` : String(launch.authorization.projectId)) || snapshot.taskId !== String(taskId)
      || snapshot.columnId !== `name:${readback.columnName}` || !['Open', 'Completed'].includes(readback.status)
      || snapshot.completed !== (readback.status === 'Completed') || snapshot.readAt !== value.completedAt) throw new Error();
    return { startedAt: value.startedAt, completedAt: value.completedAt,
      readback: { taskId, projectLabel: readback.projectLabel, status: readback.status, columnName: readback.columnName, url: readback.url },
      snapshot: { projectId: snapshot.projectId, taskId: snapshot.taskId, columnId: snapshot.columnId, completed: snapshot.completed, readAt: snapshot.readAt } };
  } catch { throw new Error('Native scoped Taskavel read failed'); }
}

export async function readNativeCodexTaskavel({ binary, project, launch, taskId }, { spawnProcess = spawn, timeoutMs = 30000 } = {}) {
  if (!constructedLaunches.has(launch) || launch.harness !== 'codex' || !launch.authorization.taskIds.includes(taskId)) throw new Error('Invalid scoped Taskavel read');
  return preflightCodexTaskavel({ binary, project, launch, spawnProcess, timeoutMs, taskId });
}

function taskDetailsReadback(content, taskId) {
  const field = label => {
    const matches = [...content.matchAll(new RegExp(`^${label}: ([^\\r\\n]+)$`, 'gm'))];
    return matches.length === 1 && plain(matches[0][1], 300) ? matches[0][1] : null;
  };
  const projectLabel = field('Project'), status = field('Status'), columnName = field('Column'), url = field('Link');
  if (!projectLabel || !status || !columnName || url !== `https://taskavel.com/tasks/${taskId}`) return null;
  return { taskId, projectLabel, status, columnName, url };
}

/** Parse only native tool events, never assistant prose or final summaries.
 * The caller must supply collector-owned JSONL and the expected session identity.
 * observedAt is collection time, NOT a claim about the remote read's freshness.
 */
export function extractClaudeTaskavelEvidence(jsonl, { sessionId, authorization, observedAt }) {
  const scope = validateTaskavelAuthorization(authorization);
  if (!plain(sessionId, 200) || !Number.isSafeInteger(observedAt) || observedAt < 1
    || typeof jsonl !== 'string' || Buffer.byteLength(jsonl) > 2 * 1024 * 1024) throw new Error('Invalid native Taskavel evidence');
  const allowed = new Set([...TASKAVEL_OPERATIONS.read, ...scope.operations.flatMap(op => TASKAVEL_OPERATIONS[op])]);
  const pending = new Map(), seen = new Set(), calls = [], readbacks = [];
  let rejectedCalls = 0;
  const lines = jsonl.split('\n').filter(line => line.trim());
  if (lines.length > 10000) throw new Error('Invalid native Taskavel evidence');
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { throw new Error('Invalid native Taskavel evidence'); }
    if (row.session_id !== sessionId || row.parent_tool_use_id != null || !Array.isArray(row.message?.content)) continue;
    for (const block of row.message.content) {
      if (row.type === 'assistant' && block.type === 'tool_use' && typeof block.name === 'string' && block.name.startsWith('mcp__taskavel__')) {
        const tool = block.name.slice('mcp__taskavel__'.length);
        if (!allowed.has(tool)) { rejectedCalls++; continue; }
        if (!plain(block.id, 200) || seen.has(block.id)) throw new Error('Duplicate or invalid native Taskavel call ID');
        seen.add(block.id);
        pending.set(block.id, { callId: block.id, tool, ...(id(block.input?.task_id) ? { taskId: block.input.task_id } : {}) });
      }
      if (row.type !== 'user' || block.type !== 'tool_result' || !pending.has(block.tool_use_id)) continue;
      const call = pending.get(block.tool_use_id); pending.delete(block.tool_use_id);
      calls.push({ ...call, status: block.is_error === true ? 'failed' : 'completed' });
      if (block.is_error === true || call.tool !== 'get-task-details-tool' || !scope.taskIds.includes(call.taskId)) continue;
      const content = typeof block.content === 'string' ? block.content
        : Array.isArray(block.content) && block.content.every(item => item.type === 'text' && typeof item.text === 'string')
          ? block.content.map(item => item.text).join('\n') : '';
      // Verified Taskavel get-task-details response is Markdown, not a JSON
      // resource. It has no project/column IDs; never fabricate those fields.
      const readback = taskDetailsReadback(content, call.taskId);
      if (readback) readbacks.push({ callId: call.callId, ...readback, observedAt });
    }
  }
  return { calls: [...calls, ...[...pending.values()].map(call => ({ ...call, status: 'incomplete' }))], readbacks, rejectedCalls,
    limitations: ['Readbacks contain textual project/column labels, not verified numeric project/column IDs or a normalized completion flag.',
      'observedAt is collector time; historical output does not establish a fresh remote read.'] };
}

/** No model turn: CLI control protocol only. Raw responses never leave this function. */
export async function preflightNativeTaskavel({ binary, project, launch }, { spawnProcess = spawn, timeoutMs = 30000 } = {}) {
  if (!constructedLaunches.has(launch)) throw new Error('Taskavel preflight requires an immutable constructed launch');
  if (launch.harness === 'codex') return preflightCodexTaskavel({ binary, project, launch, spawnProcess, timeoutMs });
  const args = [...launch.args.slice(0, -1), '--input-format', 'stream-json', '--no-session-persistence'];
  return new Promise((resolve, reject) => {
    let child, buffer = '', bytes = 0, done = false, retry;
    const finish = (error, result) => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(retry); child?.kill();
      if (error) reject(new Error('Native Taskavel preflight failed')); else resolve(result);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    try { child = spawnProcess(binary, args, { cwd: project, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { finish(true); return; }
    const send = (requestId, subtype) => { if (!done) child.stdin.write(JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype } }) + '\n'); };
    child.on('error', () => finish(true)); child.on('exit', () => finish(true)); child.stdin.on('error', () => finish(true));
    child.stdout.on('data', chunk => {
      try {
        buffer += chunk;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 2 * 1024 * 1024) return finish(true);
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const row = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          const response = row.response;
          if (response?.request_id === 'orkestar-init') {
            if (response.subtype !== 'success') return finish(true);
            send('orkestar-status', 'mcp_status');
          }
          if (response?.request_id !== 'orkestar-status') continue;
          const servers = response.response?.mcpServers;
          if (response.subtype !== 'success' || !Array.isArray(servers) || servers.length !== 1 || servers[0].name !== 'taskavel') return finish(true);
          const server = servers[0];
          if (server.status === 'pending') { retry = setTimeout(() => send('orkestar-status', 'mcp_status'), 500); continue; }
          const names = server.tools?.map(tool => tool.name);
          if (server.status !== 'connected' || server.config?.type !== 'http' || server.config?.url !== TASKAVEL_SERVER.url
            || server.config.headersHelper || Object.keys(server.config.headers ?? {}).length
            || !Array.isArray(names) || !launch.enabledTools.every(tool => names.includes(tool))) return finish(true);
          finish(false, Object.freeze({ name: 'taskavel', status: 'connected', enabledTools: launch.enabledTools }));
        }
      } catch { finish(true); }
    });
    send('orkestar-init', 'initialize');
  });
}

async function preflightCodexTaskavel({ binary, project, launch, spawnProcess, timeoutMs, taskId }) {
  const deadline = Date.now() + timeoutMs;
  const overrides = launch.args.flatMap((value, index) => value === '-c' ? ['-c', launch.args[index + 1]] : []);
  const run = (args, inspect) => new Promise((resolve, reject) => {
    let child, buffer = '', bytes = 0, done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer); child?.kill();
      if (error) reject(new Error('Native Codex Taskavel preflight failed')); else resolve(value);
    };
    const timer = setTimeout(() => finish(true), Math.max(1, deadline - Date.now()));
    try { child = spawnProcess(binary, ['app-server', ...args], { cwd: project, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { finish(true); return; }
    const send = value => { if (!done) child.stdin.write(JSON.stringify(value) + '\n'); };
    child.on('error', () => finish(true)); child.on('exit', () => finish(true)); child.stdin.on('error', () => finish(true));
    child.stdout.on('data', chunk => {
      try {
        bytes += Buffer.byteLength(chunk); buffer += chunk;
        if (bytes > 2 * 1024 * 1024) return finish(true);
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const row = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (row.id != null && row.error) return finish(true);
          if (row.id === 1) {
            send({ method: 'initialized' });
            send({ id: 2, method: 'config/read', params: { includeLayers: false, cwd: project } });
          } else inspect(row, send, value => finish(false, value));
        }
      } catch { finish(true); }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'orkestar-taskavel-preflight', version: '1' }, capabilities: { experimentalApi: true } } });
  });
  // No thread is created during discovery. Only names escape this callback;
  // global transport configuration and credentials are never copied or logged.
  const names = await run(overrides, (row, send, finish) => {
    if (row.id !== 2) return;
    const servers = row.result?.config?.mcp_servers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error();
    const names = Object.keys(servers);
    if (names.length > 100 || names.some(name => !/^[A-Za-z0-9_-]{1,200}$/.test(name))) throw new Error();
    finish(names);
  });
  const disabled = names.filter(name => name !== 'taskavel').flatMap(name => ['-c', `mcp_servers.${name}.enabled=false`]);
  let probeThreadId, startedAt, membershipResponse, projectNames;
  const afterProjects = (send, finish) => {
    if (taskId === undefined) return finish(Object.freeze({ name: 'taskavel', status: 'connected', enabledTools: launch.enabledTools, ...(projectNames ? { projectNames } : {}) }));
    startedAt = Date.now();
    const selector = launch.authorization.projectId === null ? { project_name: launch.authorization.projectName } : { project_id: launch.authorization.projectId };
    send({ id: 5, method: 'mcpServer/tool/call', params: { server: 'taskavel', threadId: probeThreadId,
      tool: 'filter-tasks-tool', arguments: { ...selector, status: 'any', limit: 100 } } });
  };
  return run([...overrides, ...disabled], (row, send, finish) => {
    if (row.id === 2) {
      const config = row.result?.config, servers = config?.mcp_servers, server = servers?.taskavel;
      const sameTools = list => Array.isArray(list) && list.length === launch.enabledTools.length
        && new Set(list).size === list.length && list.every(name => launch.enabledTools.includes(name));
      if (!servers || Object.entries(servers).some(([name, entry]) => name !== 'taskavel' && entry.enabled !== false)
        || server?.enabled !== true || server.url !== TASKAVEL_SERVER.url || server.command || server.bearer_token_env_var
        || Object.keys(server.http_headers ?? {}).length || Object.keys(server.env_http_headers ?? {}).length
        || !sameTools(server.enabled_tools) || (server.disabled_tools ?? []).length || server.default_tools_approval_mode !== 'prompt'
        || !sameTools(Object.keys(server.tools ?? {})) || Object.values(server.tools).some(tool => tool.approval_mode !== 'approve')
        || disabledFeatures.some(feature => config.features?.[feature] !== false) || config.approval_policy !== 'never'
        || config.sandbox_mode !== 'read-only') throw new Error();
      send({ id: 3, method: 'thread/start', params: { cwd: project, model: assignments.get(launch).model,
        ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' } });
    } else if (row.id === 3) {
      const threadId = row.result?.thread?.id;
      if (typeof threadId !== 'string' || !threadId) throw new Error();
      probeThreadId = threadId;
      send({ id: 4, method: 'mcpServerStatus/list', params: { threadId, detail: 'toolsAndAuthOnly' } });
    } else if (row.id === 4) {
      const result = row.result, servers = result?.data;
      if (!Array.isArray(servers) || result.nextCursor != null) throw new Error();
      const selected = servers.filter(server => server.name === 'taskavel');
      if (selected.length !== 1) throw new Error();
      const tools = server => Object.values(server.tools ?? {}).map(tool => tool.name);
      const active = selected[0], activeTools = tools(active);
      if (active.authStatus !== 'oAuth' || servers.some(server => server.name !== 'taskavel' && tools(server).length)
        || activeTools.length !== launch.enabledTools.length || new Set(activeTools).size !== activeTools.length
        || !launch.enabledTools.every(tool => activeTools.includes(tool))) throw new Error();
      if (launch.authorization.projectName) send({ id: 7, method: 'mcpServer/tool/call', params: { server: 'taskavel', threadId: probeThreadId, tool: 'list-projects-tool', arguments: {} } });
      else afterProjects(send, finish);
    } else if (row.id === 7) {
      projectNames = taskavelProjectNames(row.result);
      assertUniqueTaskavelProject(projectNames, launch.authorization.projectName, launch.authorization.operations.includes('create-project'));
      afterProjects(send, finish);
    } else if ((row.id === 5 || row.id === 6) && taskId !== undefined) {
      const result = row.result;
      if (result?.isError === true || !Array.isArray(result?.content) || !result.content.length
        || result.content.some(block => block.type !== 'text' || typeof block.text !== 'string')) throw new Error();
      if (row.id === 5) {
        if (!taskavelMembershipContains(result, taskId)) throw new Error();
        membershipResponse = result;
        send({ id: 6, method: 'mcpServer/tool/call', params: { server: 'taskavel', threadId: probeThreadId,
          tool: 'get-task-details-tool', arguments: { task_id: taskId } } });
        return;
      }
      if (!membershipResponse) throw new Error();
      const completedAt = Date.now();
      const normalized = normalizeTaskavelReadback({ taskId, projectId: launch.authorization.projectId, projectName: launch.authorization.projectName,
        details: result, membership: membershipResponse, readAt: completedAt });
      if (!normalized.snapshot || !normalized.observed || normalized.blockers.length) throw new Error();
      const { readAt, ...readback } = normalized.observed;
      finish({ startedAt, completedAt, readback, snapshot: normalized.snapshot });
    }
  });
}
