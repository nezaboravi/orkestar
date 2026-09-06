import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifySoloBinary } from './native-solo-mirror.mjs';
import { nativeTaskavelArguments, preflightNativeTaskavelSync } from './native-worker-taskavel.mjs';
import { readTaskavelBinding } from './native-taskavel-binding.mjs';
import { liveWorkerTool } from './native-worker-live.mjs';

const LIMIT = 262144;
const PROFILES = Object.freeze(['project-read', 'product-design', 'project-write', 'project-plan', 'project-test',
  'project-audit', 'ui-verify', 'project-verify', 'code-review', 'taskavel']);
const ROLES = new Set(['explorer', 'product-designer', 'dev-builder', 'dev-planner', 'dev-tester', 'dev-auditor', 'frontend-qa', 'verifier', 'reviewer', 'task-manager', 'browser-ops']);
const PROFILE_ROLES = Object.freeze({ 'project-read': 'explorer', 'product-design': 'product-designer', 'project-write': 'dev-builder',
  'project-plan': 'dev-planner', 'project-test': 'dev-tester', 'project-audit': 'dev-auditor', 'ui-verify': 'frontend-qa',
  'project-verify': 'verifier', 'code-review': 'reviewer', taskavel: 'task-manager' });
const safeText = (value, max = 200) => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const safeBinding = value => typeof value === 'string' && value.trim() && value.length <= 65536 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);

function canonicalProject(project) {
  if (!path.isAbsolute(project ?? '') || fs.realpathSync(project) !== project || !fs.statSync(project).isDirectory()) throw new Error('Project must be a canonical absolute directory');
  return project;
}
function readNativeJson(project, relative) {
  let target = project;
  for (const segment of relative.split('/')) {
    target = path.join(target, segment);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error('Unsafe native runtime path');
  }
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size > LIMIT) throw new Error('Invalid bounded native runtime file');
  try { return JSON.parse(fs.readFileSync(target, 'utf8')); }
  catch { throw new Error('Invalid bounded native runtime JSON'); }
}
function roleFile(project, harness, role) {
  return harness === 'codex' ? `.codex/agents/${role}.toml` : `.claude/agents/${role}.md`;
}
function roleMatches(project, harness, role, model) {
  const relative = roleFile(project, harness, role);
  let target = project;
  for (const segment of relative.split('/')) {
    target = path.join(target, segment);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error('Unsafe installed role file');
  }
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size > LIMIT) throw new Error('Invalid installed role file');
  const raw = fs.readFileSync(target, 'utf8');
  if (harness === 'codex') {
    if (!raw.includes(`name = "${role}"`) || !raw.includes(`model = "${model}"`) || !/\ndeveloper_instructions = """\n[\s\S]*\n"""\s*$/.test(raw)) throw new Error(`Installed Codex role does not match runtime: ${role}`);
  } else if (!new RegExp(`^---\\nname: ${role}\\ndescription: [^\\n]*\\nmodel: ${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\ntools:`, 'm').test(raw)) {
    throw new Error(`Installed Claude role does not match runtime: ${role}`);
  }
  return relative;
}
function safeTool(command, harness) {
  if (command === harness) return command;
  if (!path.isAbsolute(command ?? '') || ![harness, `${harness}.exe`].includes(path.basename(command))) throw new Error('Unsafe native worker command');
  fs.accessSync(command, fs.constants.X_OK);
  return command;
}
function normalProfiles(profiles) {
  if (!Array.isArray(profiles) || !profiles.length || profiles.length > 10 || profiles.some(profile => typeof profile !== 'string' || !PROFILES.includes(profile))) throw new Error('profiles must contain 1 to 10 supported profile names');
  return [...new Set(profiles)];
}
function check(name, action, checks) {
  try { checks.push({ name, status: 'ready', ...action() }); }
  catch (error) { checks.push({ name, status: 'BLOCKED', message: error instanceof Error ? error.message : 'Readiness check failed' }); }
}
function configuredProfiles(runtime, profiles, project, harness, checks) {
  for (const profile of profiles) check(`profile:${profile}`, () => {
    const route = runtime.profiles?.[profile];
    if (!route || !ROLES.has(route.permissionEnvelope) || !safeText(route.model) || !['low', 'medium', 'high', null].includes(route.reasoningEffort)) throw new Error(`Invalid runtime route: ${profile}`);
    if (route.permissionEnvelope !== PROFILE_ROLES[profile]) throw new Error(`Runtime role mismatch: ${profile}`);
    return { role: route.permissionEnvelope, model: route.model, roleFile: roleMatches(project, harness, route.permissionEnvelope, route.model) };
  }, checks);
}
function soloReadiness(project, harness, verify, invoke, checks) {
  let binding, binary;
  check('solo-binding', () => {
    binding = readNativeJson(project, '.agent-orchestra/runtime/solo-observer.json');
    if (binding.schemaVersion !== 1 || binding.project !== project || !Number.isSafeInteger(binding.projectId) || binding.projectId < 1
      || !(binding.harnesses ?? [binding.harness]).includes(harness)) throw new Error('Invalid Solo project binding');
    binary = verify(binding.soloBinary);
    return { projectId: binding.projectId };
  }, checks);
  if (!binding || !binary) return {};
  const solo = args => {
    const result = invoke(binary, [...args, '--json'], { cwd: project, encoding: 'utf8', timeout: 15000, maxBuffer: LIMIT, shell: false });
    if (result?.error || result?.status !== 0 || typeof result?.stdout !== 'string' || Buffer.byteLength(result.stdout) > LIMIT) throw new Error('Solo readiness lookup failed');
    const response = JSON.parse(result.stdout);
    if (response.ok !== true || !response.data) throw new Error('Solo readiness lookup failed');
    return response.data;
  };
  check('solo-project', () => {
    const actual = solo(['projects', 'get', String(binding.projectId)]);
    if (actual.id !== binding.projectId || actual.path !== project) throw new Error('Solo project binding does not match the requested project');
    return { projectId: binding.projectId };
  }, checks);
  let binaryTool;
  check('native-worker-tool', () => {
    const tools = solo(['agents', 'list']).agentTools;
    if (!Array.isArray(tools) || tools.length > 100) throw new Error('Solo worker tool inventory is invalid');
    liveWorkerTool(tools);
    const matches = tools.filter(tool => tool?.enabled === true && tool.toolType === harness).filter(tool => {
      try { safeTool(tool.command, harness); return true; } catch { return false; }
    });
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].id < 1) throw new Error('Exactly one safe native Solo worker tool is required');
    binaryTool = safeTool(matches[0].command, harness);
    return { toolId: matches[0].id };
  }, checks);
  return { binding, binary: binaryTool };
}
function workerInstall(project, harness, checks) {
  check('worker-installation', () => {
    const manifest = readNativeJson(project, '.agent-orchestra/worker/manifest.json');
    if (manifest.schemaVersion !== 1 || !manifest.files || typeof manifest.files !== 'object' || !safeBinding(manifest.settings?.[harness])
      || !/^[a-f0-9]{64}$/.test(manifest.files['native-solo-worker-mcp.mjs'] ?? '')) throw new Error('Invalid Orkestar worker installation binding');
    for (const [name, expected] of Object.entries(manifest.files)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/.test(name) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid Orkestar worker installation binding');
      const source = path.join(project, '.agent-orchestra/worker', name), stat = fs.lstatSync(source);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2 * 1024 * 1024
        || createHash('sha256').update(fs.readFileSync(source)).digest('hex') !== expected) throw new Error('Installed Orkestar worker dependency hash does not match binding');
    }
    const settingsFile = harness === 'codex' ? path.join(project, '.codex/config.toml') : path.join(project, '.mcp.json');
    const settings = fs.readFileSync(settingsFile, 'utf8');
    if (harness === 'codex' ? settings.split(manifest.settings.codex).length !== 2
      : JSON.stringify(JSON.parse(settings).mcpServers?.orkestar_worker) !== manifest.settings.claude) throw new Error('Installed Orkestar worker settings do not match binding');
    return { bridge: '.agent-orchestra/worker/native-solo-worker-mcp.mjs' };
  }, checks);
}

/** No AI worker or model request is made. Optional browser proof writes one bounded local PNG artifact. */
export async function inspectNativeWorkerReadiness(input, deps = {}) {
  const checks = [], limitations = ['No AI worker was started and no model request was made.',
    'Optional browser readiness writes one bounded local PNG artifact.', 'Provider capacity is unknown until an actual request.',
    'plannedWorkerCount is a requested count only; this check does not reserve capacity or account for existing sessions.',
    'Native Solo workers cannot resume a prior worker session.'];
  let project, profiles = [];
  try {
    project = canonicalProject(input?.project);
    if (!['codex', 'claude'].includes(input?.harness)) throw new Error('harness must be codex or claude');
    profiles = normalProfiles(input.profiles);
    for (const key of ['requireBrowser', 'requireTaskavel', 'requireContinuation']) {
      if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
    }
    if (input.taskavelProjectName !== undefined && !safeText(input.taskavelProjectName, 200)) throw new Error('taskavelProjectName must be a bounded project name');
    if (input.taskavelProjectName !== undefined && input.requireTaskavel !== true) throw new Error('taskavelProjectName requires requireTaskavel:true');
    if (input.plannedWorkerCount !== undefined && (!Number.isSafeInteger(input.plannedWorkerCount) || input.plannedWorkerCount < 0 || input.plannedWorkerCount > 12)) throw new Error('plannedWorkerCount must be a whole number from 0 to 12');
  } catch (error) {
    checks.push({ name: 'request', status: 'BLOCKED', message: error instanceof Error ? error.message : 'Invalid readiness request' });
    return { status: 'BLOCKED', ready: false, project: input?.project ?? null, harness: input?.harness ?? null, profiles,
      continuationSupported: false, capacityReservationSupported: false, checks, limitations };
  }
  const runtimeResult = { value: null };
  check('runtime', () => {
    const runtime = readNativeJson(project, `.agent-orchestra/runtime/${input.harness}.json`);
    if (runtime.schemaVersion !== 1 || runtime.harness !== input.harness || !runtime.profiles || typeof runtime.profiles !== 'object') throw new Error('Invalid installed native runtime');
    runtimeResult.value = runtime;
    return { runtime: `.agent-orchestra/runtime/${input.harness}.json` };
  }, checks);
  if (runtimeResult.value) configuredProfiles(runtimeResult.value, profiles, project, input.harness, checks);
  const solo = soloReadiness(project, input.harness, deps.verifySoloBinary ?? verifySoloBinary, deps.invoke ?? spawnSync, checks);
  workerInstall(project, input.harness, checks);
  if (input.requireBrowser === true) {
    try {
      const probe = deps.probeBrowser ?? (await import('./native-worker-browser.mjs')).probeNativeWorkerBrowser;
      if (typeof probe !== 'function') throw new Error('Browser readiness probe is unavailable');
      const value = await probe({ project });
      const artifact = value?.artifact;
      if (!value?.ready || !safeText(artifact?.sha256, 128) || !/^[a-f0-9]{64}$/.test(artifact.sha256)
        || !safeText(artifact.relativePath, 4096) || path.isAbsolute(artifact.relativePath) || artifact.relativePath.split(path.sep).includes('..')
        || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 8 || artifact.bytes > 16 * 1024 * 1024) throw new Error('Browser readiness was not proven');
      checks.push({ name: 'browser', status: 'ready', artifactHash: artifact.sha256, path: artifact.relativePath, bytes: artifact.bytes });
    } catch (error) { checks.push({ name: 'browser', status: 'BLOCKED', message: error instanceof Error ? error.message : 'Browser readiness check failed' }); }
  }
  if (input.requireTaskavel === true) check('taskavel', () => {
    if (!runtimeResult.value || !solo.binary) throw new Error('Taskavel readiness requires a verified runtime and native worker tool');
    const route = runtimeResult.value.profiles?.taskavel;
    if (!route || route.permissionEnvelope !== 'task-manager' || !safeText(route.model) || !['low', 'medium', 'high'].includes(route.reasoningEffort)) throw new Error('Taskavel runtime route is invalid');
    let binding, projectName, bindingPending = false;
    try {
      binding = readTaskavelBinding(project);
      if (input.taskavelProjectName !== undefined && input.taskavelProjectName !== binding.projectName) throw new Error('Requested Taskavel project name conflicts with the workspace binding');
      projectName = binding.projectName;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (input.taskavelProjectName === undefined) throw new Error('Taskavel workspace binding is missing; provide taskavelProjectName for native read-only verification');
      projectName = input.taskavelProjectName; bindingPending = true;
    }
    const launch = nativeTaskavelArguments({ harness: input.harness, model: route.model, effort: route.reasoningEffort,
      roleBody: 'Read only the explicitly assigned Taskavel tasks. Never mutate external state.',
      task: { goal: 'Prove native Taskavel readiness without modifying external state.', taskavel: { projectId: null, projectName, taskIds: [], operations: ['read'], externalWriteAuthorized: false } } });
    const preflight = (deps.preflightTaskavel ?? preflightNativeTaskavelSync)({ binary: solo.binary, project, launch }, { invoke: deps.invoke ?? spawnSync });
    if (preflight?.status !== 'connected') throw new Error('Native Taskavel OAuth readiness was not proven');
    return { status: 'connected', verifiedProjectName: projectName, binding: bindingPending ? 'pending' : '.agent-orchestra/runtime/taskavel-binding.json', bindingPending };
  }, checks);
  if (input.requireContinuation === true) checks.push({ name: 'continuation', status: 'BLOCKED', message: 'Native Solo workers do not support continuation.' });
  const blocked = checks.some(item => item.status === 'BLOCKED');
  return { status: blocked ? 'BLOCKED' : 'ready', ready: !blocked, project, harness: input.harness, profiles,
    ...(input.plannedWorkerCount !== undefined ? { plannedWorkerCount: input.plannedWorkerCount, sessionCeiling: 12 } : { sessionCeiling: 12 }),
    continuationSupported: false, capacityReservationSupported: false, checks, limitations };
}
