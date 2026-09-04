import { constants } from 'node:fs';
import { open, lstat, mkdir, rename, unlink, rmdir, realpath } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseCodexEvidence } from './native-codex-evidence.mjs';
import { parseClaudeEvidence } from './native-claude-evidence.mjs';
import { assembleNativeAudit } from './native-audit.mjs';

const limit = 32 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const text = (value, size = 512) => typeof value === 'string' && value.trim()
  && value.length <= size && !/[\x00-\x1f\x7f-\x9f]/.test(value) ? value : null;
const events = new Set(['SessionStart', 'SubagentStart', 'SubagentStop', 'PostToolUse', 'Stop']);

async function boundedFile(path, max = limit) {
  if (!isAbsolute(path)) throw new Error('An absolute evidence path is required');
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > max) throw new Error('Invalid evidence file');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max || info.ino !== before.ino || info.dev !== before.dev) throw new Error('Evidence changed while opening');
    const buffer = Buffer.alloc(max + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > max) throw new Error('Evidence exceeds size limit');
    return buffer.subarray(0, used).toString('utf8');
  } finally { await handle.close(); }
}

async function transcript(path) {
  const raw = await boundedFile(path);
  const lines = raw.split('\n');
  // Native transcripts may be observed during an incomplete final append.
  if (!raw.endsWith('\n')) {
    try { JSON.parse(lines.at(-1)); } catch { lines.pop(); }
  }
  return lines.filter(Boolean).map(line => JSON.parse(line));
}

async function directory(path) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe observation directory');
}

async function readManaged(path) {
  try {
    const data = JSON.parse(await boundedFile(path, 2 * 1024 * 1024));
    if (data.observerSchema !== 1) throw new Error('Unmanaged observation file');
    return data;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeManaged(path, value) {
  await readManaged(path); // Never replace an unrelated user file or a symlink.
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ ...value, observerSchema: 1 })); }
  finally { await handle.close(); }
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary); throw error; }
}

function normalize(evidence, id, project, parent = undefined) {
  if (evidence.sessionId !== id || evidence.project !== project
    || (parent !== undefined && evidence.parentSessionId !== parent)) throw new Error('Native event identity does not match transcript');
  return {
    sessionId: evidence.sessionId, parentSessionId: evidence.parentSessionId,
    project, role: text(evidence.role), model: text(evidence.model), tokens: evidence.tokens,
    cost: null, plan: [], state: evidence.state,
  };
}

function planFrom(event, previous) {
  if (event.hook_event_name !== 'PostToolUse' || event.tool_response?.is_error === true
    || event.tool_response?.success === false) return previous;
  const input = event.tool_input;
  if (!input || typeof input !== 'object') return previous;
  const status = value => ({ pending: 'pending', in_progress: 'inProgress', inProgress: 'inProgress', completed: 'completed' })[value];
  if (event.tool_name === 'update_plan' || event.tool_name === 'TodoWrite') {
    const items = event.tool_name === 'update_plan' ? input.plan : input.todos;
    if (!Array.isArray(items) || items.length > 100) return previous;
    return items.filter(item => text(item?.step ?? item?.content, 500) && status(item.status))
      .map(item => ({ step: item.step ?? item.content, status: status(item.status) }));
  }
  // Task IDs are required to correlate updates; the rest of tool output is discarded.
  if (event.tool_name === 'TaskCreate') {
    const id = text(String(event.tool_response?.task?.id ?? ''));
    if (!id || !text(input.subject, 500) || previous.length >= 100) return previous;
    return [...previous.filter(item => item.id !== id), { id, step: input.subject, status: 'pending' }];
  }
  if (event.tool_name === 'TaskUpdate' && text(input.taskId) && status(input.status)) {
    return previous.map(item => item.id === input.taskId ? { ...item, status: status(input.status) } : item);
  }
  return previous;
}

export async function observeNativeHook({ harness, project, event }) {
  if (!['codex', 'claude'].includes(harness) || !isAbsolute(project ?? '')
    || !text(event?.session_id) || !events.has(event?.hook_event_name)
    || event.cwd !== project || resolve(project) !== project || await realpath(project) !== project) throw new Error('Invalid native observation scope');
  const sessionId = event.session_id;
  const parse = records => harness === 'codex' ? parseCodexEvidence(records) : parseClaudeEvidence(records);
  let records;
  try { records = await transcript(event.transcript_path); }
  catch (error) {
    // Native startup can precede creation of the transcript. No snapshot means
    // no observation claim; a subsequent tool hook retries using real evidence.
    if (event.hook_event_name === 'SessionStart' && error.code === 'ENOENT') return null;
    throw error;
  }
  const parsed = parse(records);
  if (event.hook_event_name === 'SessionStart' && (parsed.sessionId === null || parsed.project === null)
    && (parsed.sessionId === null || parsed.sessionId === sessionId)
    && (parsed.project === null || parsed.project === project)) return null;
  const parent = normalize(parsed, sessionId, project);
  let child = null;
  if (event.hook_event_name.startsWith('Subagent')) {
    if (!text(event.agent_id)) throw new Error('Native child identity is missing');
    if (event.hook_event_name === 'SubagentStop') {
      const rows = await transcript(event.agent_transcript_path);
      child = normalize(harness === 'codex' ? parseCodexEvidence(rows) : parseClaudeEvidence(rows,
        { agentId: event.agent_id, parentSessionId: sessionId, role: event.agent_type }), event.agent_id, project, sessionId);
      child.state = 'idle';
    } else child = { sessionId: event.agent_id, parentSessionId: sessionId, project,
      role: text(event.agent_type), model: null, tokens: null, cost: null, plan: [], state: 'running' };
  }
  const home = join(project, '.agent-orchestra'); await directory(home);
  const runs = join(home, 'runs'); await directory(runs);
  const native = join(runs, 'native'); await directory(native);
  const lock = join(native, '.lock');
  let acquired = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; await new Promise(done => setTimeout(done, 50)); }
  }
  if (!acquired) throw new Error('Native observation is busy; retry on the next hook');
  try {
    const indexPath = join(native, 'index.json');
    const index = await readManaged(indexPath) ?? { sessions: {} };
    const key = hash(`${harness}:${sessionId}`);
    const rootId = parent.parentSessionId ? index.sessions[key] : sessionId;
    if (!text(rootId)) throw new Error('Root ancestry was not observed');
    const runDirectory = join(native, hash(`${harness}:${rootId}`)); await directory(runDirectory);
    const statePath = join(runDirectory, 'state.json');
    const state = await readManaged(statePath) ?? { sessions: {} };
    if (Object.keys(state.sessions).length >= 256 || Object.keys(index.sessions).length >= 4096) throw new Error('Native observation session limit reached');
    const old = state.sessions[key];
    parent.plan = planFrom(event, old?.plan ?? []);
    if (event.hook_event_name === 'Stop') parent.state = 'idle';
    else if (event.hook_event_name === 'SessionStart') parent.state = 'running';
    state.sessions[key] = parent;
    index.sessions[key] = rootId;
    if (child) {
      const childKey = hash(`${harness}:${child.sessionId}`);
      if (!state.sessions[childKey] || event.hook_event_name === 'SubagentStop') state.sessions[childKey] = child;
      index.sessions[childKey] = rootId;
    }
    const rootKey = hash(`${harness}:${rootId}`);
    const root = state.sessions[rootKey];
    const audit = assembleNativeAudit({ harness, project, root,
      children: Object.entries(state.sessions).filter(([id]) => id !== rootKey).map(([, value]) => value) });
    audit.observedAt = new Date().toISOString();
    audit.state = root.state;
    audit.agents = audit.agents.map(agent => ({ ...agent, state: state.sessions[hash(`${harness}:${agent.sessionId}`)].state }));
    await writeManaged(statePath, state);
    await writeManaged(indexPath, index);
    await writeManaged(join(runs, 'native-latest.json'), audit);
    return audit;
  } finally { await rmdir(lock); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--harness' || args[2] !== '--project') throw new Error('Invalid observer arguments');
    let input = ''; for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Oversized hook'); }
    const project = args[3];
    const audit = await observeNativeHook({ harness: args[1], project, event: JSON.parse(input) });
    if (audit) {
      const { mirrorNativeAudit } = await import('./native-solo-mirror.mjs');
      await mirrorNativeAudit(audit, { project });
    }
    process.stdout.write('{}\n');
  } catch { process.stdout.write(JSON.stringify({ systemMessage: 'Orkestar native observation could not be updated. Acceptance remains unverified.' }) + '\n'); }
}
