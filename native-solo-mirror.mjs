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

function canRebindUnusedProject(project, existing, projectId, binary, invoke) {
  if (existing.soloBinary !== binary || !Number.isSafeInteger(existing.projectId) || existing.projectId < 1) return false;
  const get = id => {
    const result = invoke(binary, ['projects', 'get', String(id), '--json'],
      { cwd: project, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    const output = result.status === 0 ? result.stdout : (result.stdout || result.stderr);
    if (result.error || typeof output !== 'string' || Buffer.byteLength(output) > 65536) throw new Error('Unverified Solo project');
    return { status: result.status, value: JSON.parse(output) };
  };
  try {
    const old = get(existing.projectId), next = get(projectId);
    return old.value.ok === false && old.value.error?.code === 'not_found'
      && next.status === 0 && next.value.ok === true && next.value.data?.id === projectId
      && next.value.data.path === project;
  } catch { return false; }
}

export function bindSoloObserver({ project, projectId, soloBinary, harness }, { invoke = spawnSync } = {}) {
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
  if (existing && (existing.projectId !== projectId || existing.soloBinary !== binary)) {
    if (!canRebindUnusedProject(project, existing, projectId, binary, invoke)) throw new Error('Solo binding identity changed; review before rebinding');
    const backup = path.join(project, '.agent-orchestra', 'backups');
    try { fs.mkdirSync(backup, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (fs.lstatSync(backup).isSymbolicLink() || !fs.statSync(backup).isDirectory()) throw new Error('Unsafe Solo binding backup');
    fs.writeFileSync(path.join(backup, `solo-observer-${existing.projectId}-${randomUUID()}.json`),
      fs.readFileSync(file), { flag: 'wx', mode: 0o600 });
    // Solo record IDs belong to the deleted project. Archive their ownership
    // separately; historical worker receipts and Taskavel bindings stay intact.
    const coordination = path.join(directory, 'solo-coordination.json');
    try {
      const stat = fs.lstatSync(coordination);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Unsafe Solo coordination binding');
      const saved = JSON.parse(fs.readFileSync(coordination, 'utf8'));
      if (saved.project !== project || saved.projectId !== existing.projectId) throw new Error('Unverified Solo coordination identity');
      fs.renameSync(coordination, path.join(backup, `solo-coordination-${existing.projectId}-${randomUUID()}.json`));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
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

// This is an explicit project presentation policy, not inferred session ancestry.
// A managed visible-worker bridge owns its compact overview; native hooks still
// save their full audit on disk before reaching this optional UI projection.
function managedBridgeOwnsPresentation(project, harness) {
  const read = relative => {
    let current = project;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Unsafe presentation scope');
    }
    const stat = fs.statSync(current);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid presentation file');
    return fs.readFileSync(current, 'utf8');
  };
  try {
    const manifest = JSON.parse(read('.agent-orchestra/worker/manifest.json'));
    if (manifest.schemaVersion !== 1 || typeof manifest.settings?.[harness] !== 'string') return false;
    for (const file of ['native-solo-worker-mcp.mjs', 'native-worker-summary.mjs']) {
      const content = read(`.agent-orchestra/worker/${file}`);
      if (manifest.files?.[file] !== createHash('sha256').update(content).digest('hex')) return false;
    }
    const server = path.join(project, '.agent-orchestra/worker/native-solo-worker-mcp.mjs');
    if (harness === 'claude') {
      const configured = JSON.parse(read('.mcp.json')).mcpServers?.orkestar_worker;
      return JSON.stringify(configured) === manifest.settings.claude
        && JSON.stringify(configured?.args) === JSON.stringify([server, '--project', project, '--harness', harness]);
    }
    const block = manifest.settings.codex;
    return block.includes('[mcp_servers.orkestar_worker]\n')
      && block.includes(`args = ${JSON.stringify([server, '--project', project, '--harness', harness])}\n`)
      && read('.codex/config.toml').split(block).length === 2;
  } catch { return false; }
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
  if (managedBridgeOwnsPresentation(project, audit.harness)) {
    return { skipped: true, reason: 'Managed visible workers own the Solo team overview; native audit preserved on disk' };
  }
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
  const title = `Team activity — ${audit.harness === 'codex' ? 'Codex' : 'Claude Code'}`;
  const content = renderNativeAudit(audit).replace(/^# .*\n/, `# ${title}\n`);
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
    key: `plan-${index}`, title: safe(item.step),
    body: `Native plan status: ${safe(item.status)}. This is execution status, not independent acceptance.`,
    status: item.status === 'completed' ? 'completed' : ['inProgress', 'in_progress'].includes(item.status) ? 'in_progress' : 'open',
  }));
  // Todos represent work, not telemetry. Preserve any older activity todos;
  // do not create more or silently delete records from an existing run.
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
