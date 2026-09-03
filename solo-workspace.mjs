#!/usr/bin/env node

import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

function bundledSoloCandidates(platform = process.platform, home = os.homedir(), environment = process.env) {
  const candidates = [];
  if (environment.SOLO_CLI) candidates.push(environment.SOLO_CLI);
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Solo.app/Contents/MacOS/solo-cli',
      path.join(home, 'Applications', 'Solo.app', 'Contents', 'MacOS', 'solo-cli'),
    );
  }
  return candidates;
}

function findSoloCli(locate, options = {}) {
  const fromPath = locate('solo');
  if (fromPath) return fromPath;
  for (const candidate of bundledSoloCandidates(options.platform, options.home, options.environment)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue through verified installation locations.
    }
  }
  return null;
}

function decodeSoloJson(result, label) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${label} failed${detail ? `: ${detail}` : ''}`);
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (payload?.ok !== true) throw new Error(`${label} did not return a successful response`);
  return payload.data;
}

function defaultInvoke(binary, args, cwd) {
  return spawnSync(binary, [...args, '--json'], { cwd, encoding: 'utf8' });
}

function selectAgentTool(agentTools, harness) {
  const enabled = agentTools.filter((tool) => tool.enabled !== false);
  const native = enabled.find((tool) => tool.toolType === harness);
  if (native) return native;
  if (harness === 'cursor') {
    return enabled.find((tool) => {
      if (tool.toolType !== 'generic') return false;
      const command = String(tool.command || '').trim().split(/\s+/)[0];
      return String(tool.name || '').trim().toLowerCase() === 'cursor' || path.basename(command) === 'agent';
    }) || null;
  }
  return null;
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function openSolo(projectId = null, platform = process.platform, runner = spawnSync) {
  if (platform === 'darwin') {
    const args = projectId == null ? ['-a', 'Solo'] : [`solo://proj/${encodeURIComponent(String(projectId))}`];
    const result = runner('open', args, { encoding: 'utf8' });
    return !result.error && result.status === 0;
  }
  if (platform === 'win32') {
    const target = projectId == null ? 'solo:' : `solo://proj/${encodeURIComponent(String(projectId))}`;
    const result = runner('powershell.exe', ['-NoProfile', '-Command', 'Start-Process', target], { encoding: 'utf8' });
    return !result.error && result.status === 0;
  }
  if (platform === 'linux') {
    const target = projectId == null ? 'solo:' : `solo://proj/${encodeURIComponent(String(projectId))}`;
    const result = runner('xdg-open', [target], { encoding: 'utf8' });
    return !result.error && result.status === 0;
  }
  return false;
}

function ensureSoloReady(binary, cwd, invoke = defaultInvoke, activate = openSolo, wait = pause) {
  try {
    const status = decodeSoloJson(invoke(binary, ['status'], cwd), 'Solo status');
    if (status.ready) return status;
  } catch {
    // Start the installed desktop app below, then wait for its local API.
  }
  if (!activate(null)) throw new Error('Solo is installed but Orkestar could not open its desktop app');
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    wait(250);
    try {
      const status = decodeSoloJson(invoke(binary, ['status'], cwd), 'Solo status');
      if (status.ready) return status;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Solo desktop app did not become ready${lastError ? `: ${lastError.message}` : ''}`);
}

function ensureCursorWorkspaceTrusted(runtime, projectPath, home = os.homedir(), runner = spawnSync) {
  const identity = crypto.createHash('sha256').update(projectPath).digest('hex').slice(0, 24);
  const markerPath = path.join(home, '.agent-orchestra', 'trusted-workspaces', `cursor-${identity}.json`);
  if (fs.existsSync(markerPath)) return { reused: true, markerPath };
  const expected = 'ORCHESTRA_CURSOR_WORKSPACE_TRUSTED';
  const result = runner(runtime.binary, [
    '--print', '--trust', '--mode', 'ask', '--model', runtime.manifest.primary.model,
    `Reply with exactly ${expected}. Do not use tools.`,
  ], { cwd: projectPath, encoding: 'utf8', timeout: 45000, input: '' });
  const output = String(result?.stdout || '').trim();
  if (result?.error || result?.status !== 0 || !output.includes(expected)) {
    const detail = String(result?.stderr || result?.stdout || '').trim();
    throw new Error(`Cursor could not establish one-time workspace trust${detail ? `: ${detail}` : ''}`);
  }
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, `${JSON.stringify({ schemaVersion: 1, harness: 'cursor', project: projectPath }, null, 2)}\n`, { mode: 0o600 });
  return { reused: false, markerPath };
}

function verifySoloStartup(binary, projectId, processId, cwd, invoke = defaultInvoke, wait = pause) {
  let state = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    wait(250);
    state = decodeSoloJson(invoke(binary, ['processes', 'get', String(processId)], cwd), 'Solo agent status');
    if (['exited', 'failed', 'stopped'].includes(state.status)) {
      const output = decodeSoloJson(invoke(binary, [
        'processes', 'output', String(processId), '--project-id', String(projectId), '--lines', '40',
      ], cwd), 'Solo agent output');
      const detail = String(output.text || '').trim();
      throw new Error(`Solo started Lenka but the agent ${state.status}${detail ? `: ${detail}` : ''}`);
    }
  }
  if (!state || !['running', 'starting'].includes(state.status)) {
    throw new Error(`Solo agent did not reach a running state${state?.status ? ` (${state.status})` : ''}`);
  }
  return state;
}

function launchInSolo(runtime, options, dependencies = {}) {
  const locate = dependencies.locate || (() => null);
  const invoke = dependencies.invoke || defaultInvoke;
  const binary = dependencies.binary || findSoloCli(locate, dependencies);
  if (!binary) {
    throw new Error('Solo CLI is not available. Install Solo and enable its HTTP API, or use lenka up with Herdr / --direct.');
  }

  const projectPath = fs.realpathSync(options.project);
  const activate = dependencies.openSolo || ((projectId) => openSolo(projectId, dependencies.platform || process.platform, dependencies.runner || spawnSync));
  ensureSoloReady(binary, projectPath, invoke, activate, dependencies.wait || pause);
  if (runtime.harness === 'cursor') {
    const ensureTrust = dependencies.ensureCursorTrust || ensureCursorWorkspaceTrusted;
    ensureTrust(runtime, projectPath, dependencies.home || os.homedir(), dependencies.runner || spawnSync);
  }

  const projects = decodeSoloJson(invoke(binary, ['projects', 'list'], projectPath), 'Solo project list').projects || [];
  let project = projects.find((candidate) => {
    try {
      return fs.realpathSync(candidate.path) === projectPath;
    } catch {
      return false;
    }
  });
  if (!project) {
    const created = decodeSoloJson(invoke(binary, [
      'projects', 'create', path.basename(projectPath), projectPath,
    ], projectPath), 'Solo project import');
    project = created.project;
  }

  const agentTools = decodeSoloJson(invoke(binary, ['agents', 'list'], projectPath), 'Solo agent tool list').agentTools || [];
  const tool = selectAgentTool(agentTools, runtime.harness);
  if (!tool) throw new Error(`Solo has no enabled ${runtime.harness} agent tool on this machine`);

  const args = [
    'processes', 'spawn', '--project-id', String(project.id), '--kind', 'agent',
    '--agent-tool-id', String(tool.id), '--name', 'Lenka — Orkestar',
  ];
  for (const arg of dependencies.launcherArgs(runtime.harness, runtime.manifest.primary.model, projectPath, runtime.manifest.primary.reasoningEffort || null)) {
    args.push('--arg', arg);
  }
  const spawned = decodeSoloJson(invoke(binary, args, projectPath), 'Solo agent launch');
  const processEntry = spawned.process || spawned;
  const verifyStartup = dependencies.verifyStartup || verifySoloStartup;
  const startup = verifyStartup(binary, project.id, processEntry.id, projectPath, invoke, dependencies.wait);
  if (!activate(project.id)) throw new Error('Lenka is running in Solo, but Orkestar could not show the Solo project window');
  return { binary, project, tool, process: processEntry, startup };
}

export { bundledSoloCandidates, decodeSoloJson, ensureCursorWorkspaceTrusted, ensureSoloReady, findSoloCli, launchInSolo, openSolo, selectAgentTool, verifySoloStartup };
