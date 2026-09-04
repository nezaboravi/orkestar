import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { renderNativeAudit } from './native-audit.mjs';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const safe = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 500);

export function verifySoloBinary(binary) {
  if (!path.isAbsolute(binary ?? '')) throw new Error('Solo executable must be absolute');
  const resolved = fs.realpathSync(binary);
  if (!fs.statSync(resolved).isFile()) throw new Error('Solo executable is not a file');
  const candidates = (process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute)
    .map(directory => path.join(directory, process.platform === 'win32' ? 'solo.exe' : 'solo'));
  if (process.platform === 'darwin') candidates.push('/Applications/Solo.app/Contents/MacOS/solo-cli',
    path.join(process.env.HOME ?? '', 'Applications/Solo.app/Contents/MacOS/solo-cli'));
  if (!candidates.some(candidate => { try { return fs.realpathSync(candidate) === resolved; } catch { return false; } })) {
    throw new Error('Solo executable does not match installed CLI discovery');
  }
  fs.accessSync(resolved, fs.constants.X_OK);
  return resolved;
}

export function bindSoloObserver({ project, projectId, soloBinary, harness }) {
  if (fs.realpathSync(project) !== project || !Number.isSafeInteger(projectId) || projectId < 1
    || !['codex', 'claude'].includes(harness)) throw new Error('Invalid Solo binding scope');
  const binary = verifySoloBinary(soloBinary);
  const directory = path.join(project, '.agent-orchestra', 'runtime');
  const file = path.join(directory, 'solo-observer.json');
  for (const item of [path.join(project, '.agent-orchestra'), directory]) {
    try { fs.mkdirSync(item, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (fs.lstatSync(item).isSymbolicLink() || !fs.statSync(item).isDirectory()) throw new Error('Unsafe Solo binding directory');
  }
  const existing = readBinding(project);
  if (existing && (existing.schemaVersion !== 1 || existing.project !== project)) throw new Error('Preserved unmanaged Solo binding');
  if (existing && (existing.projectId !== projectId || existing.soloBinary !== binary)) throw new Error('Solo binding identity changed; review before rebinding');
  const harnesses = [...new Set([...(existing?.harnesses ?? [existing?.harness]).filter(value => ['codex', 'claude'].includes(value)), harness])];
  const output = JSON.stringify({ schemaVersion: 1, project, projectId, soloBinary: binary, harness, harnesses });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, output, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
  return file;
}

function readBinding(project) {
  const directory = path.join(project, '.agent-orchestra', 'runtime');
  const file = path.join(directory, 'solo-observer.json');
  try { fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const item of [path.join(project, '.agent-orchestra'), directory, file]) {
    if (fs.lstatSync(item).isSymbolicLink()) throw new Error('Unsafe Solo observation binding');
  }
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > 16384) throw new Error('Invalid Solo observation binding');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Mirror native metadata, never transcripts, fake workers, or acceptance verdicts. */
export async function mirrorNativeAudit(audit, options = {}) {
  const project = options.project;
  const binding = options.binding ?? readBinding(project);
  if (!binding) return { skipped: true, reason: 'No Solo binding' };
  const directory = path.join(project, '.agent-orchestra', 'runtime');
  for (const item of [path.join(project, '.agent-orchestra'), directory]) {
    if (fs.lstatSync(item).isSymbolicLink() || !fs.statSync(item).isDirectory()) throw new Error('Unsafe Solo observation directory');
  }
  const lock = path.join(directory, '.solo-observer-lock');
  let acquired = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); acquired = true; break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; await new Promise(done => setTimeout(done, 50)); }
  }
  if (!acquired) throw new Error('Solo observation is busy');
  try { return await mirror(audit, { ...options, binding }); }
  finally { fs.rmdirSync(lock); }
}

async function mirror(audit, { project, invoke = spawnSync, binding } = {}) {
  if (!binding) return { skipped: true, reason: 'No Solo binding' };
  if (binding.schemaVersion !== 1 || binding.project !== project || audit.project !== project
    || !(binding.harnesses ?? [binding.harness]).includes(audit.harness) || !['codex', 'claude'].includes(audit.harness)
    || !Number.isSafeInteger(binding.projectId) || binding.projectId < 1
    || !path.isAbsolute(binding.soloBinary ?? '') || fs.realpathSync(project) !== project
    || typeof audit.sessionId !== 'string' || !audit.sessionId || audit.sessionId.length > 512
    || !Array.isArray(audit.agents) || audit.agents.length > 256 || !Array.isArray(audit.plan) || audit.plan.length > 100) {
    throw new Error('Invalid Solo observation scope');
  }
  verifySoloBinary(binding.soloBinary);
  let calls = 0;
  const deadline = Date.now() + 10000;
  const call = (args, input) => {
    if (++calls > 800 || Date.now() >= deadline) throw new Error('Solo observation request limit');
    const result = invoke(binding.soloBinary, [...args, '--json'], {
      cwd: project, encoding: 'utf8', timeout: Math.min(1500, deadline - Date.now()), maxBuffer: 1024 * 1024, input,
    });
    if (result.status !== 0 || result.error) throw new Error('Solo observation request failed');
    const response = JSON.parse(result.stdout);
    if (response.ok !== true) throw new Error('Solo observation request rejected');
    return response.data;
  };
  const scope = ['--project-id', String(binding.projectId)];
  const record = call(['projects', 'get', String(binding.projectId)]);
  const target = record.project ?? record;
  if (target.id !== binding.projectId || fs.realpathSync(target.path) !== project) throw new Error('Solo project identity changed');
  const tag = `orkestar-native-${hash(`${audit.harness}:${audit.sessionId}`)}`;
  const list = kind => {
    const result = call([kind, 'list', ...scope, '--tag', tag, '--limit', '500']);
    if (result.hasMore) throw new Error('Ambiguous Solo observation inventory');
    return result[kind] ?? [];
  };
  const title = `Orkestar · ${audit.harness} · ${safe(audit.sessionId).slice(0, 8)}`;
  const content = renderNativeAudit(audit).replace(/^# .*\n/, `# ${title}\n`)
    + '\n\n## Native activity\n\n'
    + audit.agents.map(agent => `- ${safe(agent.agent)} (${safe(agent.sessionId)}): ${safe(agent.state ?? 'unknown')}`).join('\n')
    + '\n\nSession idle means the response ended, not acceptance approval. Solo is a local mirror; Taskavel remains authoritative.\n';
  const scratchpads = list('scratchpads');
  if (scratchpads.length > 1) throw new Error('Duplicate native Solo scratchpads require review');
  if (!scratchpads.length) call(['scratchpads', 'create', ...scope, '--name', title, '--tag', tag, '--content-file', '-'], content);
  else {
    const read = call(['scratchpads', 'read', String(scratchpads[0].id), ...scope]);
    const pad = read.scratchpad ?? read;
    if (pad.content !== content) {
      if (!Number.isSafeInteger(pad.revision)) throw new Error('Solo scratchpad revision is unavailable');
      call(['scratchpads', 'update', String(scratchpads[0].id), ...scope, '--expected-revision', String(pad.revision), '--content-file', '-'], content);
    }
  }
  const todos = list('todos');
  const desired = audit.plan.map((item, index) => ({
    key: `plan-${index}`, title: `[Native plan] ${safe(item.step)}`,
    body: `Native plan status: ${safe(item.status)}. This is execution status, not independent acceptance.`,
    status: item.status === 'completed' ? 'completed' : ['inProgress', 'in_progress'].includes(item.status) ? 'in_progress' : 'open',
  }));
  for (const agent of audit.agents.filter(agent => agent.parentSessionId)) desired.push({
    key: `agent-${hash(agent.sessionId)}`, title: `[Native agent] ${safe(agent.agent)}`,
    body: `Session: ${safe(agent.sessionId)}\nModel: ${safe(agent.model)}\nState: ${safe(agent.state ?? 'unknown')}\nCumulative tokens: ${agent.tokens?.total ?? 'unavailable'}\nCost: unavailable\nResponse completion is not acceptance approval.`,
    status: agent.state === 'running' ? 'in_progress' : 'open',
  });
  for (const item of desired) {
    const marker = `Orkestar observation: ${tag}/${item.key}`;
    const body = `${marker}\n${item.body}`;
    const matches = todos.filter(todo => todo.body?.startsWith(`${marker}\n`));
    if (matches.length > 1) throw new Error('Duplicate native Solo todos require review');
    const existing = matches[0];
    if (!existing) {
      const created = call(['todos', 'create', ...scope, '--title', item.title, '--body', body, '--tag', tag]);
      const id = created.todo?.id ?? created.todo_id ?? created.id;
      if (!Number.isSafeInteger(id)) throw new Error('Solo todo creation receipt is unavailable');
      if (item.status !== 'open') call(['todos', 'update', String(id), ...scope, '--status', item.status]);
    } else if (existing.title !== item.title || existing.body !== body || existing.status !== item.status) {
      call(['todos', 'update', String(existing.id), ...scope, '--title', item.title, '--body', body, '--status', item.status]);
    }
  }
  return { projectId: binding.projectId, tag, mirrored: true };
}
