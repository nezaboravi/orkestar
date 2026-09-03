#!/usr/bin/env node

import fs from 'node:fs';
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
  return agentTools.find((tool) => tool.enabled !== false && tool.toolType === harness) || null;
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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
  const status = decodeSoloJson(invoke(binary, ['status'], projectPath), 'Solo status');
  if (!status.ready) throw new Error('Solo is running but its local API is not ready');

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
  return { binary, project, tool, process: processEntry, startup };
}

export { bundledSoloCandidates, decodeSoloJson, findSoloCli, launchInSolo, selectAgentTool, verifySoloStartup };
