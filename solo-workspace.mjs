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

function findSoloMcp(soloBinary, options = {}) {
  const environment = options.environment || process.env;
  const home = options.home || os.homedir();
  const candidates = [];
  if (environment.SOLO_MCP) candidates.push(environment.SOLO_MCP);
  if (soloBinary) candidates.push(path.join(path.dirname(soloBinary), 'mcp'));
  if ((options.platform || process.platform) === 'darwin') {
    candidates.push(
      '/Applications/Solo.app/Contents/MacOS/mcp',
      path.join(home, 'Applications', 'Solo.app', 'Contents', 'MacOS', 'mcp'),
    );
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue through verified installation locations.
    }
  }
  return null;
}

function writeJsonConfiguration(target, mutate) {
  let config = {};
  if (fs.existsSync(target)) {
    try {
      config = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch {
      throw new Error(`MCP configuration is not valid JSON: ${target}`);
    }
  }
  const before = JSON.stringify(config);
  mutate(config);
  if (JSON.stringify(config) === before) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return true;
}

function escapeRegularExpression(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function configureSoloMcp(harness, harnessBinary, soloMcp, options = {}) {
  if (!soloMcp) throw new Error('Solo is installed but its MCP helper is not executable');
  const home = options.home || os.homedir();
  if (harness === 'opencode') {
    const target = path.join(home, '.config', 'opencode', 'opencode.json');
    const changed = writeJsonConfiguration(target, (config) => {
      config.mcp ||= {};
      config.mcp.solo = { type: 'local', command: [soloMcp], enabled: true };
    });
    return { changed, target };
  }
  if (harness === 'cursor') {
    const target = path.join(home, '.cursor', 'mcp.json');
    const changed = writeJsonConfiguration(target, (config) => {
      config.mcpServers ||= {};
      config.mcpServers.solo = { command: soloMcp };
    });
    return { changed, target };
  }

  const runner = options.runner || spawnSync;
  if (harness === 'codex') {
    const configured = runner(harnessBinary, ['mcp', 'get', 'solo', '--json'], { encoding: 'utf8' });
    if (configured?.status === 0) {
      let server;
      try {
        server = JSON.parse(configured.stdout);
      } catch {
        throw new Error('Codex MCP server "solo" could not be verified because `codex mcp get solo --json` returned invalid JSON');
      }
      const transport = server?.transport || {};
      if (server?.enabled === true
        && transport.type === 'stdio'
        && transport.command === soloMcp
        && Array.isArray(transport.args)
        && transport.args.length === 0) {
        return { changed: false, target: 'codex MCP registry' };
      }
      throw new Error('Codex MCP server "solo" is already configured but is disabled or points to a different command; update it before running lenka up solo again');
    }
    const detail = String(configured?.stderr || configured?.stdout || '').trim();
    if (configured?.error || !/No MCP server named ['"]solo['"] found\.?/i.test(detail)) {
      throw new Error(`Codex MCP server "solo" could not be verified${detail ? `: ${detail}` : ''}`);
    }
  }
  if (harness === 'claude') {
    const configured = runner(harnessBinary, ['mcp', 'get', 'solo'], { encoding: 'utf8' });
    if (configured?.status === 0) {
      const output = String(configured.stdout || '');
      const command = escapeRegularExpression(soloMcp);
      const valid = /^solo:\s*$/m.test(output)
        && /^\s*Status:\s*.*\bConnected\s*$/m.test(output)
        && /^\s*Type:\s*stdio\s*$/m.test(output)
        && new RegExp(`^\\s*Command:\\s*${command}\\s*$`, 'm').test(output)
        && /^\s*Args:\s*$/m.test(output);
      if (valid) return { changed: false, target: 'claude MCP registry' };
      throw new Error('Claude MCP server "solo" is already configured but is unavailable, disabled, or points to a different command; update it before running lenka up solo again');
    }
    const detail = String(configured?.stderr || configured?.stdout || '').trim();
    if (configured?.error || !/No MCP server named ['"]solo['"]\.?/i.test(detail)) {
      throw new Error(`Claude MCP server "solo" could not be verified${detail ? `: ${detail}` : ''}`);
    }
  }
  const argsByHarness = {
    codex: ['mcp', 'add', 'solo', '--', soloMcp],
    claude: ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'solo', '--', soloMcp],
  };
  const args = argsByHarness[harness];
  if (!args) throw new Error(`Solo MCP automatic setup is not supported for ${harness}; its installed CLI cannot verify an existing Solo MCP registration`);
  const added = runner(harnessBinary, args, { encoding: 'utf8' });
  if (added?.error || added?.status !== 0) {
    const detail = String(added?.stderr || added?.stdout || '').trim();
    throw new Error(`${harness} could not connect Solo MCP${detail ? `: ${detail}` : ''}`);
  }
  return { changed: true, target: `${harness} MCP registry` };
}

function verifySoloMcpReady(soloMcp, options = {}) {
  if (!soloMcp) throw new Error('Solo is installed but its MCP helper is not executable');
  const runner = options.runner || spawnSync;
  const request = `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'orkestar-preflight', version: '1' },
    },
  })}\n`;
  const result = runner(soloMcp, [], { input: request, encoding: 'utf8', timeout: 3000 });
  const output = String(result?.stdout || '');
  let response = null;
  try {
    response = output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.id === 1);
  } catch {
    // Report the supported recovery path below.
  }
  if (result?.error || result?.status !== 0 || !response?.result?.serverInfo) {
    throw new Error('Solo MCP is off. Open Solo Settings → MCP, turn on MCP server, then run lenka up solo again. This is a one-time Solo setting.');
  }
  return response.result;
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

function soloProcessName(harness) {
  const labels = {
    cursor: 'Cursor Agent',
    codex: 'Codex',
    claude: 'Claude Code',
    kimi: 'Kimi Code',
    opencode: 'OpenCode',
  };
  return `Lenka — ${labels[harness] || harness} · Solo team`;
}

function matchesSoloRuntime(processEntry, runtime, name = soloProcessName(runtime.harness)) {
  const command = String(processEntry.command || '');
  const model = String(runtime.manifest.primary.model || '');
  const legacyName = soloProcessName(runtime.harness).replace(' · Solo team', '');
  return processEntry.kind === 'agent'
    && [name, legacyName, 'Lenka — Orkestar'].includes(processEntry.name)
    && command.includes(runtime.binary)
    && (!model || command.includes(`--model ${model}`));
}

function renameSoloProcess(binary, processEntry, name, projectPath, invoke) {
  if (processEntry.name === name) return processEntry;
  const renamed = decodeSoloJson(invoke(binary, [
    'processes', 'rename', String(processEntry.id), name,
  ], projectPath), 'Solo process rename');
  return { ...processEntry, ...(renamed.process || renamed), name };
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
  const soloMcp = dependencies.soloMcp || findSoloMcp(binary, dependencies);
  const verifyMcp = dependencies.verifyMcp || verifySoloMcpReady;
  verifyMcp(soloMcp, { runner: dependencies.runner || spawnSync });
  const configureMcp = dependencies.configureMcp || configureSoloMcp;
  const mcp = configureMcp(runtime.harness, runtime.binary, soloMcp, {
    home: dependencies.home || os.homedir(),
    runner: dependencies.runner || spawnSync,
  });
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

  if (dependencies.bindObserver) dependencies.bindObserver({ project: projectPath,
    projectId: project.id, soloBinary: binary, harness: runtime.harness });
  const processName = soloProcessName(runtime.harness);
  let existingProcesses = [];
  try {
    existingProcesses = decodeSoloJson(invoke(binary, [
      'processes', 'list', '--project-id', String(project.id),
    ], projectPath), 'Solo process list').processes || [];
  } catch {
    // Older Solo builds may not expose process inventory; spawning still works.
  }
  const matchingProcesses = existingProcesses
    .filter((entry) => matchesSoloRuntime(entry, runtime, processName))
    .sort((left, right) => Number(right.id) - Number(left.id));
  const active = matchingProcesses.find((entry) => ['running', 'starting'].includes(entry.status));
  if (active) {
    const named = renameSoloProcess(binary, active, processName, projectPath, invoke);
    if (!activate(project.id)) throw new Error('Lenka is running in Solo, but Orkestar could not show the Solo project window');
    return { binary, project, tool: null, process: named, startup: named, reused: true, mcp };
  }
  const stopped = matchingProcesses.find((entry) => ['stopped', 'exited'].includes(entry.status));
  if (stopped) {
    const named = renameSoloProcess(binary, stopped, processName, projectPath, invoke);
    const started = decodeSoloJson(invoke(binary, [
      'processes', 'start', String(named.id),
    ], projectPath), 'Solo agent restart');
    const processEntry = started.process || started;
    const verifyStartup = dependencies.verifyStartup || verifySoloStartup;
    const startup = verifyStartup(binary, project.id, processEntry.id || named.id, projectPath, invoke, dependencies.wait);
    if (!activate(project.id)) throw new Error('Lenka is running in Solo, but Orkestar could not show the Solo project window');
    return { binary, project, tool: null, process: { ...named, ...processEntry }, startup, reused: true, mcp };
  }

  const agentTools = decodeSoloJson(invoke(binary, ['agents', 'list'], projectPath), 'Solo agent tool list').agentTools || [];
  const tool = selectAgentTool(agentTools, runtime.harness);
  if (!tool) throw new Error(`Solo has no enabled ${runtime.harness} agent tool on this machine`);

  const args = [
    'processes', 'spawn', '--project-id', String(project.id), '--kind', 'agent',
    '--agent-tool-id', String(tool.id), '--name', processName,
  ];
  for (const arg of dependencies.launcherArgs(runtime.harness, runtime.manifest.primary.model, projectPath, runtime.manifest.primary.reasoningEffort || null)) {
    args.push('--arg', arg);
  }
  const spawned = decodeSoloJson(invoke(binary, args, projectPath), 'Solo agent launch');
  const processEntry = spawned.process || spawned;
  const verifyStartup = dependencies.verifyStartup || verifySoloStartup;
  const startup = verifyStartup(binary, project.id, processEntry.id, projectPath, invoke, dependencies.wait);
  if (!activate(project.id)) throw new Error('Lenka is running in Solo, but Orkestar could not show the Solo project window');
  return { binary, project, tool, process: processEntry, startup, reused: false, mcp };
}

export { bundledSoloCandidates, configureSoloMcp, decodeSoloJson, ensureCursorWorkspaceTrusted, ensureSoloReady, findSoloCli, findSoloMcp, launchInSolo, matchesSoloRuntime, openSolo, selectAgentTool, soloProcessName, verifySoloMcpReady, verifySoloStartup };
