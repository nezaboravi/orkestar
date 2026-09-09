#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { modelInventory } from './orchestra.mjs';
import { chooseModels, loadModelSelection, saveModelSelection, validSelection, runtimeMatchesSelection } from './model-selection.mjs';
import { herdrSessionName } from './session-name.mjs';
import { launcherArgs } from './harness-launcher.mjs';
import { findSoloCli, launchInSolo } from './solo-workspace.mjs';
import { prepareNativeSolo } from './native-solo-setup.mjs';
import { refreshProjectRuntime, RuntimeRoutingRevalidationError } from './project-runtime-refresh.mjs';
import { bindSoloObserver } from './native-solo-mirror.mjs';
import {
  commandForHarness,
  connectOptionalTaskavel,
  connectTaskavel,
  harnessLabels,
  harnessOrder,
  inspectHarness,
  inspectHarnesses,
  loadPreferences,
  missingHarnessMessage,
  recommendHarness,
  savePreferences,
  signInArgs,
  workspaceChoices,
  workspaceLabels,
} from './onboarding.mjs';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const harnesses = ['auto', ...harnessOrder];

function usage() {
  console.log(`Lenka — your agent orchestra

Usage:
  lenka setup
  lenka up [solo] [auto|cursor|codex|claude|kimi|opencode] [options]
  lenka connect taskavel [cursor|codex|claude|opencode]
  lenka status [--project PATH]
  lenka report last [--project PATH]
  lenka worker dispatch --contract PROJECT_FILE [--project PATH]
  lenka worker status|result --run-id ID [--project PATH]
  lenka doctor [cursor|codex|claude|kimi|opencode] [--project PATH]

Options:
  --project PATH       Project to open (default: current directory)
  --ask                Choose the harness interactively
  --herdr              Run inside Herdr explicitly
  --solo               Run inside Solo
  --direct             Open the selected CLI without a workspace app
  --no-launch          Install and verify without opening the selected CLI
  --conflict POLICY    fail, skip, or backup (default for up: backup)
  --help               Show this help

Plain \`lenka up\` asks which AI tool to use every time and stays in the current
terminal. Use \`--solo\` or \`--herdr\` to choose a workspace explicitly.

Examples:
  lenka up
  lenka up solo
  lenka up solo codex
  lenka up cursor
  lenka up codex
  lenka up kimi
  lenka up opencode
  lenka up codex --direct
  lenka up --ask
  lenka status
  lenka report last
`);
}

function parse(input) {
  const args = [...input];
  const rawCommand = args.shift() || 'help';
  const command = rawCommand.toLowerCase().replace(/[.!?]+$/, '');
  if (command === '--help' || command === '-h') return { command: 'help' };
  let harness = null;
  let project = process.cwd();
  let ask = false;
  let herdr = true;
  let workspace = 'herdr';
  let workspaceExplicit = false;
  let harnessExplicit = false;
  let noLaunch = false;
  let conflict = 'backup';
  let reportTarget = null;
  if (['report', 'connect'].includes(command) && args[0] && !args[0].startsWith('-')) reportTarget = args.shift();
  while (args.length) {
    const arg = args.shift();
    if (harnesses.includes(arg) && !harness) { harness = arg; harnessExplicit = true; }
    else if (arg === 'solo' || arg === '--solo') {
      workspace = 'solo';
      herdr = false;
      workspaceExplicit = true;
    }
    else if (arg === '--project') {
      const value = args.shift();
      if (!value) throw new Error('--project requires a path');
      project = path.resolve(value);
    } else if (arg === '--ask') ask = true;
    else if (arg === '--herdr') {
      workspace = 'herdr';
      herdr = true;
      workspaceExplicit = true;
    } else if (arg === '--direct') {
      workspace = 'direct';
      herdr = false;
      workspaceExplicit = true;
    }
    else if (arg === '--no-launch') noLaunch = true;
    else if (arg === '--conflict') {
      conflict = args.shift();
      if (!['fail', 'skip', 'backup'].includes(conflict)) throw new Error('--conflict must be fail, skip, or backup');
    } else if (arg === '--help' || arg === '-h') return { command: 'help' };
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { command, harness, harnessExplicit, project, ask, herdr, workspace, workspaceExplicit, noLaunch, conflict, reportTarget };
}

function homeDirectory() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function manifestsAt(root) {
  const directory = path.join(root, '.agent-orchestra', 'runtime');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))];
      } catch {
        return [];
      }
    });
}

function manifests(project, includeGlobalFallback = false) {
  const projectManifests = manifestsAt(project);
  if (projectManifests.length || !includeGlobalFallback) return projectManifests;
  return manifestsAt(homeDirectory());
}

function executable(command) {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension.toLowerCase()}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Continue through PATH.
      }
    }
  }
  return null;
}

function selectInstalledRuntime(project, requested = 'auto', home = homeDirectory(), locate = executable) {
  const projectManifests = manifestsAt(project);
  const globalManifests = manifestsAt(home);
  const byHarness = new Map();
  for (const manifest of [...projectManifests, ...globalManifests]) {
    if (manifest?.harness && !byHarness.has(manifest.harness)) byHarness.set(manifest.harness, manifest);
  }
  const preferences = loadPreferences(home);
  const candidates = requested === 'auto'
    ? [...new Set([preferences?.harness, ...harnesses.slice(1)].filter(Boolean))]
    : [requested];
  for (const harness of candidates) {
    const manifest = byHarness.get(harness);
    const binary = locate(commandForHarness(harness));
    if (manifest?.primary?.model && binary) return { harness, manifest, binary };
  }
  return null;
}

async function chooseHarness() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('--ask requires an interactive terminal');
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\nChoose the conductor harness:');
    console.log('  1. Auto-detect (recommended)');
    console.log('  2. Cursor Agent');
    console.log('  3. Codex');
    console.log('  4. Claude Code');
    console.log('  5. Kimi Code');
    console.log('  6. OpenCode');
    const answer = (await prompt.question('\nSelection [1]: ')).trim() || '1';
    const selected = { 1: 'auto', 2: 'cursor', 3: 'codex', 4: 'claude', 5: 'kimi', 6: 'opencode' }[answer];
    if (!selected) throw new Error('selection must be 1, 2, 3, 4, 5, or 6');
    return selected;
  } finally {
    prompt.close();
  }
}

function runCaptured(command, args, cwd = process.cwd()) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 15000 });
}

function runInteractive(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function ensureHarnessAuthentication(harness, project, dependencies = {}) {
  if (!harness || harness === 'auto') return;
  const locate = dependencies.locate || executable;
  const capture = dependencies.capture || runCaptured;
  const interactive = dependencies.interactive || runInteractive;
  const input = dependencies.input || process.stdin;
  const output = dependencies.output || process.stdout;
  let status = inspectHarness(harness, locate, capture, project);
  if (!status.installed) throw new Error(missingHarnessMessage(harness));
  if (status.authenticated !== false) return;
  if (!input.isTTY || !output.isTTY) {
    throw new Error(`${harness} is installed but not signed in. Run: ${commandForHarness(harness)} ${signInArgs(harness).join(' ')}`);
  }
  const prompt = readline.createInterface({ input, output });
  try {
    const answer = (await prompt.question(`${harness} is installed but not signed in. Open its login now? [Y/n]: `)).trim().toLowerCase();
    if (['n', 'no'].includes(answer)) {
      throw new Error(`${harness} login is required before Lenka can start it`);
    }
  } finally {
    prompt.close();
  }
  const loginStatus = interactive(status.binary, signInArgs(harness), project);
  if (loginStatus !== 0) throw new Error(`${harness} login did not complete`);
  status = inspectHarness(harness, locate, capture, project);
  if (status.authenticated === false) throw new Error(`${harness} is still not signed in after login`);
}

async function ensureModelSelection(harness, { home = homeDirectory(), input = process.stdin, output = process.stdout, inventory = modelInventory(home, harness), force = false, prompt = null } = {}) {
  const previous = loadModelSelection(home, harness);
  if (!force && validSelection(previous, inventory)) return previous;
  if (!prompt && (!input.isTTY || !output.isTTY)) throw new Error('Model choices are missing, from another computer, or no longer listed. Run `lenka setup` in an interactive terminal.');
  const questions = prompt || readline.createInterface({ input, output });
  try {
    const models = await chooseModels({ harness, inventory, previous, question: text => questions.question(text), write: text => output.write(text + '\n') });
    return saveModelSelection(home, harness, models);
  } finally { if (!prompt) questions.close(); }
}

async function setup(options, { continueToLaunch = false } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('lenka setup requires an interactive terminal');
  const home = homeDirectory();
  const existing = loadPreferences(home);
  const statuses = inspectHarnesses(executable, runCaptured, options.project);
  const verified = [...new Set(manifests(options.project, true).filter((item) => item?.primary?.model).map((item) => item.harness))];
  const recommended = options.harnessExplicit
    ? options.harness
    : recommendHarness(statuses, existing, verified);
  console.log('\nLet\'s set up Lenka');
  console.log('First choose the AI service, then where Lenka should open.');
  console.log('Run `lenka setup` again whenever you want to change either choice.\n');
  for (const status of statuses) {
    const verifiedHere = verified.includes(status.harness);
    const state = verifiedHere ? 'verified model route' : status.evidence;
    console.log(`- ${harnessLabels[status.harness]}: ${state}`);
  }
  const choices = statuses.filter((status) => status.installed).map((status) => status.harness);
  if (!choices.length) throw new Error('No supported AI CLI is installed. Install Cursor, Codex, Claude Code, Kimi Code, or OpenCode first.');
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\nWhich AI service should Lenka use?');
    choices.forEach((name, index) => console.log(`  ${index + 1}. ${harnessLabels[name]}${name === recommended ? ' (recommended)' : ''}`));
    const defaultIndex = Math.max(0, choices.indexOf(recommended)) + 1;
    const harnessAnswer = (await prompt.question(`Selection [${defaultIndex}]: `)).trim() || String(defaultIndex);
    const harness = choices[Number(harnessAnswer) - 1];
    if (!harness) throw new Error('invalid harness selection');
    const selectedStatus = statuses.find((status) => status.harness === harness);
    if (selectedStatus?.authenticated === false && !verified.includes(harness)) {
      const loginAnswer = (await prompt.question(`${harness} is not signed in. Open its login now? [Y/n]: `)).trim().toLowerCase();
      if (!['n', 'no'].includes(loginAnswer)) {
        const loginArgs = signInArgs(harness);
        const loginStatus = runInteractive(selectedStatus.binary, loginArgs, options.project);
        if (loginStatus !== 0) throw new Error(`${harness} login did not complete`);
      }
    }

    if (harness !== 'opencode') await ensureModelSelection(harness, { home, force: true, prompt });

    const workspaces = workspaceChoices({
      platform: process.platform,
      soloInstalled: Boolean(findSoloCli(executable, { platform: process.platform, home, environment: process.env })),
      herdrInstalled: Boolean(executable('herdr')),
    });
    console.log('\nWhere should Lenka work?');
    workspaces.forEach((item, index) => console.log(`  ${index + 1}. ${workspaceLabels[item.id]} — ${item.reason}`));
    const preferredWorkspace = options.workspaceExplicit ? options.workspace : existing?.workspace;
    const workspaceDefault = preferredWorkspace ? workspaces.findIndex((item) => item.id === preferredWorkspace) + 1 : 2;
    const workspaceAnswer = (await prompt.question(`Selection [${workspaceDefault > 0 ? workspaceDefault : 2}]: `)).trim() || String(workspaceDefault > 0 ? workspaceDefault : 2);
    const workspace = workspaces[Number(workspaceAnswer) - 1];
    if (!workspace) throw new Error('invalid workspace selection');
    if (workspace.id === 'solo' && !workspace.available) throw new Error(`Solo is unavailable: ${workspace.reason}. Install it from https://soloterm.com or choose Herdr/direct.`);

    const taskavelAnswer = (await prompt.question('\nConnect Taskavel now? [y/N]: ')).trim().toLowerCase();
    const wantsTaskavel = ['y', 'yes'].includes(taskavelAnswer);
    const target = savePreferences({ harness, workspace: workspace.id, taskavel: wantsTaskavel ? 'requested' : 'later' }, home);
    console.log(`\nSaved preferences: ${target}`);
    if (wantsTaskavel) {
      const result = connectOptionalTaskavel(harness, { home, locate: executable, run: runInteractive, capture: runCaptured, cwd: options.project });
      if (result.warning) {
        savePreferences({ harness, workspace: workspace.id, taskavel: 'later' }, home);
        console.warn(`WARNING: ${result.warning}`);
      } else {
        console.log(result.verification);
      }
    }
    if (continueToLaunch) {
      console.log('\nSetup saved. Starting Lenka with your choices…');
    } else {
      console.log('\nReady. Run: lenka up');
      console.log('Change these choices any time with: lenka setup');
      console.log(`One-time override: lenka up ${harness} --direct`);
    }
    return 0;
  } finally {
    prompt.close();
  }
}

function connect(options) {
  const target = options.reportTarget;
  if (target !== 'taskavel') throw new Error('connect currently supports only: lenka connect taskavel [harness]');
  const preferences = loadPreferences(homeDirectory());
  const harness = options.harness || preferences?.harness;
  if (!harness || harness === 'auto') throw new Error('choose a harness: lenka connect taskavel cursor|codex|claude|opencode');
  const result = connectTaskavel(harness, { home: homeDirectory(), locate: executable, run: runInteractive, capture: runCaptured, cwd: options.project });
  console.log(result.verification);
  return result.configured ? 0 : 1;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    stdio: 'inherit',
    env: { ...process.env, LENKA_CLI_ACTIVE: '1', ...(options.env || {}) },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function shouldOpenHerdr(options, environment = process.env) {
  return options.herdr && environment.HERDR_ENV !== '1';
}

async function launchInstalledRuntime(runtime, options, dependencies = {}) {
  const refreshed = (dependencies.refreshProjectRuntime ?? refreshProjectRuntime)({ project: fs.realpathSync(options.project),
    harness: runtime.harness, manifest: runtime.manifest });
  console.log(options.workspace === 'solo' && !options.noLaunch ? '\nStarting Lenka in Solo…' : '\nLenka is ready.');
  console.log(`Project: ${options.project}`);
  console.log(`Harness: ${runtime.harness}`);
  console.log(`Conductor model: ${runtime.manifest.primary.model}`);
  if (runtime.manifest.primary.reasoningEffort) {
    console.log(`Reasoning effort: ${runtime.manifest.primary.reasoningEffort}`);
  }
  console.log('Runtime: previously verified; no model probe');
  if (refreshed.changed) console.log(`Project team: updated ${refreshed.changed} files; conflicting files backed up`);
  if (options.noLaunch) return 0;

  if (options.workspace === 'solo') {
    const native = await (dependencies.prepareNativeSolo ?? prepareNativeSolo)({ project: fs.realpathSync(options.project), harness: runtime.harness,
      nodeBinary: process.execPath, sourceRoot: repoRoot });
    const observation = native?.observer;
    const soloDependencies = { locate: executable, bindObserver: observation ? bindSoloObserver : null };
    const launched = (dependencies.launchInSolo ?? launchInSolo)(runtime, options, soloDependencies);
    console.log('Lenka is ready.');
    console.log(`Workspace: Solo (${launched.project.name})`);
    console.log(`Agent: ${launched.process.name} (${runtime.harness})`);
    if (launched.mcp.available === false) console.warn(`WARNING: ${launched.mcp.warning}`);
    else console.log(`Solo MCP: connected${launched.mcp.changed ? ' now' : ''}`);
    console.log(`Process: ${launched.process.id}`);
    console.log(`Session: ${launched.reused ? 'reused' : 'new'}`);
    if (observation?.changed && launched.reused) console.log('Observer updated: start a new native session to load the hooks; current work was preserved.');
    if (native?.worker) console.log('Visible workers: project-local dispatch bridge installed; role capability checks run before each dispatch.');
    if (native?.worker.changed && launched.reused) console.log('Worker bridge updated: start a new native session to load it; current work was preserved.');
    return 0;
  }

  const env = {
    AGENT_ORCHESTRA_HARNESS: runtime.harness,
    AGENT_ORCHESTRA_HARNESS_BINARY: runtime.binary,
    AGENT_ORCHESTRA_PRIMARY_MODEL: runtime.manifest.primary.model,
    AGENT_ORCHESTRA_REASONING_EFFORT: runtime.manifest.primary.reasoningEffort || '',
  };
  if (!shouldOpenHerdr(options)) {
    console.log(process.env.HERDR_ENV === '1' ? 'Workspace: current Herdr pane' : 'Workspace: direct CLI');
    return run(process.execPath, [path.join(repoRoot, 'harness-launcher.mjs')], { cwd: options.project, env });
  }

  const herdr = executable('herdr');
  if (!herdr || process.platform === 'win32') return null;
  const runtimeDirectory = path.join(homeDirectory(), '.local', 'share', 'agent-orchestra');
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  const session = herdrSessionName(options.project);
  console.log(`Workspace: Herdr (${session})`);
  const logFile = path.join(runtimeDirectory, `herdr-${session}.log`);
  const starter = spawn(process.execPath, [
    path.join(repoRoot, 'herdr-starter.mjs'),
    '--herdr', herdr,
    '--session', session,
    '--harness', runtime.harness,
    '--binary', runtime.binary,
    '--project', options.project,
    '--model', runtime.manifest.primary.model,
    '--reasoning', runtime.manifest.primary.reasoningEffort || '',
    '--log', logFile,
  ], {
    cwd: options.project,
    env: { ...process.env, HERDR_SESSION: session },
    detached: true,
    stdio: 'ignore',
  });
  starter.unref();
  return run(herdr, ['--session', session], { cwd: options.project, env });
}

async function up(options, dependencies = {}) {
  const loadSavedPreferences = dependencies.loadPreferences ?? loadPreferences;
  const ensureAuthentication = dependencies.ensureHarnessAuthentication ?? ensureHarnessAuthentication;
  const selectRuntime = dependencies.selectInstalledRuntime ?? selectInstalledRuntime;
  const launchRuntime = dependencies.launchInstalledRuntime ?? launchInstalledRuntime;
  const execute = dependencies.run ?? run;
  if (!fs.existsSync(options.project) || !fs.statSync(options.project).isDirectory()) {
    throw new Error(`project directory does not exist: ${options.project}`);
  }
  const plainLaunch = !options.harness && !options.workspaceExplicit;
  let preferences = loadSavedPreferences(homeDirectory());
  if (needsFirstRunSetup(options, preferences)) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('No saved Lenka setup exists. Run `lenka setup` in an interactive terminal, or choose explicitly, for example: lenka up codex --direct');
    }
    const setupStatus = await setup(options, { continueToLaunch: true });
    if (setupStatus !== 0) return setupStatus;
    preferences = loadSavedPreferences(homeDirectory());
    if (!preferences) throw new Error('Lenka setup finished without saving preferences');
  }
  if (plainLaunch) {
    options.workspace = 'direct';
    options.herdr = false;
  } else if (!options.workspaceExplicit && preferences?.workspace) {
    options.workspace = preferences.workspace;
    options.herdr = preferences.workspace === 'herdr';
  }
  let harness = options.ask || plainLaunch
    ? await (dependencies.chooseHarness ?? chooseHarness)()
    : (options.harness || preferences?.harness || 'auto');
  await ensureAuthentication(harness, options.project);
  if (harness === 'auto') {
    harness = selectRuntime(options.project, harness)?.harness || recommendHarness(inspectHarnesses(executable, runCaptured, options.project), preferences);
    if (!harness) throw new Error('Choose an AI tool with lenka setup before starting.');
  }
  const selection = harness === 'opencode' ? null : await (dependencies.ensureModelSelection ?? ensureModelSelection)(harness);
  const installed = selectRuntime(options.project, harness);
  if (installed && (!selection || runtimeMatchesSelection(installed.manifest, selection))) {
    try {
      const launched = await launchRuntime(installed, options);
      if (launched !== null) return launched;
      console.log('\nHerdr is not ready on this machine; completing its one-time setup.');
    } catch (error) {
      if (!(error instanceof RuntimeRoutingRevalidationError)
        && error?.code !== 'RUNTIME_ROUTING_REVALIDATION_REQUIRED') throw error;
      console.log('\nThe installed model route changed; verifying the current route.');
    }
  }
  console.log('\nLenka is assembling the orchestra…');
  console.log(`Project: ${options.project}`);
  console.log(`Harness: ${harness === 'auto' ? 'auto-detect' : harness}`);
  if (process.platform === 'win32') {
    const windows = ['-Project', options.project, '-ProjectOnly', '-Conflict', options.conflict, '-Harness', harness];
    windows.push('-NoLaunch');
    if (options.workspace === 'herdr') windows.push('-UseHerdr');
    const installedStatus = execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'bootstrap.ps1'), ...windows]);
    if (installedStatus !== 0) return installedStatus;
    const runtime = selectRuntime(options.project, harness);
    if (!runtime || (selection && !runtimeMatchesSelection(runtime.manifest, selection))) throw new Error('Installed runtime does not match your model choices; no session was launched.');
    if (options.noLaunch) return 0;
    return launchRuntime(runtime, options);
  }
  const common = ['--project', options.project, '--project-only', '--conflict', options.conflict, '--harness', harness];
  common.push('--no-launch');
  if (options.workspace === 'herdr') common.push('--herdr');
  const installedStatus = execute('sh', [path.join(repoRoot, 'bootstrap.sh'), ...common]);
  if (installedStatus !== 0) return installedStatus;
  const runtime = selectRuntime(options.project, harness);
  if (!runtime || (selection && !runtimeMatchesSelection(runtime.manifest, selection))) throw new Error('Installed runtime does not match your model choices; no session was launched.');
  if (options.noLaunch) return 0;
  return launchRuntime(runtime, options);
}

function needsFirstRunSetup(options, preferences) {
  if (!options.harness && !options.workspaceExplicit) return false;
  return !preferences && !(options.harnessExplicit && options.workspaceExplicit);
}

function status(options) {
  const installed = manifests(options.project, true);
  if (!installed.length) {
    console.log(`No orchestra runtime is installed in ${options.project}`);
    console.log('Run: lenka up');
    return 1;
  }
  console.log('\nLenka orchestra status');
  console.log(`Project: ${options.project}`);
  for (const manifest of installed) {
    console.log(`\nHarness: ${manifest.harness}`);
    console.log(`Conductor: Lenka`);
    console.log(`Model: ${manifest.primary?.model || 'not verified'}`);
    console.log(`Model class: ${manifest.primary?.modelClass || 'unknown'}`);
    if (manifest.primary?.reasoningEffort) console.log(`Reasoning effort: ${manifest.primary.reasoningEffort}`);
    console.log(`Agents: ${manifest.lifecycle === 'one-run' ? 'created on demand' : manifest.lifecycle}`);
    console.log('Verification: required after writes');
  }
  return 0;
}

function doctor(options) {
  const installed = manifests(options.project);
  const candidates = installed.map((manifest) => manifest.harness).filter((name) => name && name !== 'auto');
  const harness = options.harness || (candidates.length === 1 ? candidates[0] : null);
  if (!harness) throw new Error('choose a harness: lenka doctor cursor|codex|claude|kimi|opencode');
  return run(process.execPath, [path.join(repoRoot, 'orchestra.mjs'), 'doctor', '--tool', harness, '--project', options.project, '--project-only', '--installed']);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function refreshOpenCodeAudit(audit, project) {
  const binary = executable('opencode');
  if (!binary || !audit.sessionId) return audit;
  const query = `WITH RECURSIVE tree AS (
    SELECT id, parent_id, agent, title, model, cost, tokens_input, tokens_output,
           tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created
    FROM session WHERE id = ${sqlString(audit.sessionId)}
    UNION ALL
    SELECT s.id, s.parent_id, s.agent, s.title, s.model, s.cost, s.tokens_input,
           s.tokens_output, s.tokens_reasoning, s.tokens_cache_read, s.tokens_cache_write, s.time_created
    FROM session s JOIN tree t ON s.parent_id = t.id
  ) SELECT * FROM tree ORDER BY time_created ASC`;
  const result = spawnSync(binary, ['db', query, '--format', 'json'], {
    cwd: project, encoding: 'utf8', timeout: 10000, maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) return audit;
  let rows;
  try {
    rows = JSON.parse(result.stdout);
  } catch {
    return audit;
  }
  const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
  if (!Array.isArray(rows) || !rows.length || rows.length > 10000
    || rows.some(row => !row || typeof row !== 'object' || !identity(row.id))) return audit;
  const byId = new Map();
  for (const row of rows) {
    if (byId.has(row.id)) return audit;
    byId.set(row.id, row);
  }
  const root = byId.get(audit.sessionId);
  if (!root || root.parent_id !== null) return audit;
  const rooted = new Set([root.id]);
  for (const row of rows) {
    const visiting = new Set();
    let current = row;
    while (!rooted.has(current.id)) {
      if (visiting.has(current.id) || !identity(current.parent_id) || !byId.has(current.parent_id)) return audit;
      visiting.add(current.id);
      current = byId.get(current.parent_id);
    }
    for (const id of visiting) rooted.add(id);
  }
  const token = value => Number.isSafeInteger(value) && value >= 0 ? value : 'unavailable';
  const cost = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 'unavailable';
  const sum = (values, validate) => values.every(value => typeof value === 'number')
    ? validate(values.reduce((total, value) => total + value, 0)) : 'unavailable';
  const agents = rows.map(row => {
    let model = typeof row.model === 'string' && row.model.trim() ? row.model : 'unavailable';
    try {
      const parsed = JSON.parse(model);
      model = parsed?.providerID && (parsed.id || parsed.modelID)
        ? `${parsed.providerID}/${parsed.id || parsed.modelID}`
        : (parsed.id || parsed.modelID || model);
    } catch {
      // A plain model string is already usable.
    }
    if (typeof model !== 'string' || !model.trim()) model = 'unavailable';
    const tokens = {
      input: token(row.tokens_input),
      output: token(row.tokens_output),
      reasoning: token(row.tokens_reasoning),
      cacheRead: token(row.tokens_cache_read),
      cacheWrite: token(row.tokens_cache_write),
    };
    return {
      sessionId: row.id,
      parentSessionId: row.parent_id,
      agent: row.agent || (row.id === root.id ? 'lenka' : 'unavailable'),
      task: row.title || 'unavailable',
      model,
      tokens: { ...tokens, total: Object.values(tokens).every(value => typeof value === 'number')
        ? sum([tokens.input, tokens.output, tokens.reasoning], token) : 'unavailable' },
      cost: cost(row.cost),
    };
  });
  const totals = { tokens: sum(agents.map(agent => agent.tokens.total), token), cost: sum(agents.map(agent => agent.cost), cost) };
  const complete = totals.tokens !== 'unavailable' && totals.cost !== 'unavailable' && agents.every(agent => agent.model !== 'unavailable');
  return {
    ...audit,
    status: !complete && audit.status === 'DONE' ? 'PARTIAL' : audit.status,
    blockers: !complete ? [...(Array.isArray(audit.blockers) ? audit.blockers : []), 'Refreshed native telemetry is incomplete or invalid.'] : audit.blockers,
    agents,
    totals: { ...totals, complete },
    refreshedAt: new Date().toISOString(),
  };
}

function report(options) {
  if (options.reportTarget && options.reportTarget !== 'last') {
    throw new Error('report currently supports only: lenka report last');
  }
  const runsDirectory = path.join(options.project, '.agent-orchestra', 'runs');
  const acceptancePath = path.join(runsDirectory, 'latest.json');
  const nativePath = path.join(runsDirectory, 'native-latest.json');
  const candidates = [acceptancePath, nativePath].filter(file => fs.existsSync(file));
  const reportPath = candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!reportPath) {
    console.log(`No orchestra audit report exists for ${options.project}`);
    console.log('Run a non-trivial task with Lenka, then use: lenka report last');
    return 1;
  }
  let audit;
  try {
    audit = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    throw new Error(`invalid orchestra audit report: ${reportPath}`);
  }
  if (!audit || typeof audit !== 'object' || !Array.isArray(audit.agents)
    || audit.agents.some(agent => !agent || typeof agent !== 'object')
    || !['DONE', 'PARTIAL', 'FAILED'].includes(audit.status)) throw new Error('Invalid orchestra audit report structure');
  if (audit.harness === 'opencode') audit = refreshOpenCodeAudit(audit, options.project);
  if (reportPath === nativePath) {
    if (audit.observerSchema !== 1 || audit.project !== fs.realpathSync(options.project)) throw new Error('Invalid native observation report scope');
    console.log('Native activity snapshot — not an acceptance verdict.');
    if (fs.existsSync(acceptancePath)) console.log(`Independent acceptance report remains separate: ${acceptancePath}`);
  }
  console.log(`\nOrkestar run ${audit.status}`);
  console.log(`Harness: ${audit.harness}`);
  console.log(`Session: ${audit.sessionId}`);
  console.log(`Agents: ${audit.agents.length}`);
  const tokens = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : 'unavailable';
  const cost = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `$${value.toFixed(6)}` : 'unavailable';
  for (const agent of audit.agents) {
    console.log(`- ${agent.agent}: ${agent.model || 'unavailable'} — ${tokens(agent.tokens?.total)} tokens — ${cost(agent.cost)}`);
  }
  console.log(`Total: ${tokens(audit.totals?.tokens)} tokens — ${cost(audit.totals?.cost)}`);
  if (Array.isArray(audit.verification) && audit.verification.length) {
    console.log('Verification:');
    for (const item of audit.verification) console.log(`- ${item}`);
  }
  if (Array.isArray(audit.proof) && audit.proof.length) {
    console.log('Behavior proof:');
    for (const item of audit.proof) {
      if (!item || typeof item !== 'object') continue;
      console.log(`- [${item.result ?? 'unavailable'}] ${item.criterion ?? 'unavailable'} — ${item.method ?? 'unavailable'} — ${Array.isArray(item.evidence) ? item.evidence.join('; ') : 'evidence unavailable'}`);
    }
  }
  if (audit.trackerReconciliation && typeof audit.trackerReconciliation === 'object') {
    const tracker = audit.trackerReconciliation;
    console.log(`Taskavel supplied-packet reconciliation: ${tracker.doneEligible === true ? 'eligible' : 'PARTIAL'} (saved snapshot; not a live tracker read).`);
    if (Array.isArray(tracker.reasons)) for (const reason of tracker.reasons) console.log(`- ${reason}`);
    if (Array.isArray(tracker.tasks)) for (const task of tracker.tasks) {
      if (task && typeof task === 'object') console.log(`- Task ${task.taskId}: accepted proof ${task.acceptedProof === true ? 'yes' : 'no'}; tracker eligible ${task.doneEligible === true ? 'yes' : 'no'}`);
    }
  }
  if (Array.isArray(audit.blockers) && audit.blockers.length) {
    console.log('Blockers:');
    for (const item of audit.blockers) console.log(`- ${item}`);
  }
  return audit.status === 'FAILED' ? 1 : 0;
}

async function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'worker') return (await import('./native-solo-worker-cli.mjs')).workerCli(argv.slice(1));
  const options = parse(argv);
  if (options.command === 'help') {
    usage();
    return 0;
  }
  if (options.command === 'setup') return setup(options);
  if (options.command === 'up') return up(options);
  if (options.command === 'connect') return connect(options);
  if (options.command === 'status') return status(options);
  if (options.command === 'report') return report(options);
  if (options.command === 'doctor') return doctor(options);
  throw new Error(`unknown command: ${options.command}`);
}

const invokedFile = process.argv[1] ? fs.realpathSync(process.argv[1]) : null;
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

export { ensureModelSelection, ensureHarnessAuthentication, launchInstalledRuntime, main, manifests, needsFirstRunSetup, parse, selectInstalledRuntime, setup, shouldOpenHerdr, up };
