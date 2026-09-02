#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const harnesses = ['auto', 'codex', 'claude', 'kimi', 'opencode'];

function usage() {
  console.log(`Lenka — your agent orchestra

Usage:
  lenka up [auto|codex|claude|kimi|opencode] [options]
  lenka status [--project PATH]
  lenka doctor [codex|claude|kimi|opencode] [--project PATH]

Options:
  --project PATH       Project to open (default: current directory)
  --ask                Choose the harness interactively
  --herdr              Run the selected CLI inside Herdr
  --no-launch          Install and verify without opening the selected CLI
  --conflict POLICY    fail, skip, or backup (default for up: backup)
  --help               Show this help

Examples:
  lenka up
  lenka up codex
  lenka up kimi
  lenka up opencode --herdr
  lenka up --ask
  lenka status
`);
}

function parse(input) {
  const args = [...input];
  const command = args.shift() || 'help';
  if (command === '--help' || command === '-h') return { command: 'help' };
  let harness = null;
  let project = process.cwd();
  let ask = false;
  let herdr = false;
  let noLaunch = false;
  let conflict = 'backup';
  while (args.length) {
    const arg = args.shift();
    if (harnesses.includes(arg) && !harness) harness = arg;
    else if (arg === '--project') {
      const value = args.shift();
      if (!value) throw new Error('--project requires a path');
      project = path.resolve(value);
    } else if (arg === '--ask') ask = true;
    else if (arg === '--herdr') herdr = true;
    else if (arg === '--no-launch') noLaunch = true;
    else if (arg === '--conflict') {
      conflict = args.shift();
      if (!['fail', 'skip', 'backup'].includes(conflict)) throw new Error('--conflict must be fail, skip, or backup');
    } else if (arg === '--help' || arg === '-h') return { command: 'help' };
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { command, harness, project, ask, herdr, noLaunch, conflict };
}

function manifests(project) {
  const directory = path.join(project, '.agent-orchestra', 'runtime');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
}

async function chooseHarness() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('--ask requires an interactive terminal');
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\nChoose the conductor harness:');
    console.log('  1. Auto-detect (recommended)');
    console.log('  2. Codex');
    console.log('  3. Claude Code');
    console.log('  4. Kimi Code');
    console.log('  5. OpenCode');
    const answer = (await prompt.question('\nSelection [1]: ')).trim() || '1';
    const selected = { 1: 'auto', 2: 'codex', 3: 'claude', 4: 'kimi', 5: 'opencode' }[answer];
    if (!selected) throw new Error('selection must be 1, 2, 3, 4, or 5');
    return selected;
  } finally {
    prompt.close();
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, LENKA_CLI_ACTIVE: '1' },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function up(options) {
  if (!fs.existsSync(options.project) || !fs.statSync(options.project).isDirectory()) {
    throw new Error(`project directory does not exist: ${options.project}`);
  }
  const harness = options.ask ? await chooseHarness() : (options.harness || 'auto');
  console.log('\nLenka is assembling the orchestra…');
  console.log(`Project: ${options.project}`);
  console.log(`Harness: ${harness === 'auto' ? 'auto-detect' : harness}`);
  if (process.platform === 'win32') {
    if (!['auto', 'opencode'].includes(harness)) {
      throw new Error('Windows currently supports lenka up with OpenCode only');
    }
    const windows = ['-Project', options.project, '-ProjectOnly', '-Conflict', options.conflict];
    if (options.noLaunch) windows.push('-NoLaunch');
    if (options.herdr) windows.push('-UseHerdr');
    return run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'bootstrap.ps1'), ...windows]);
  }
  const common = ['--project', options.project, '--project-only', '--conflict', options.conflict, '--harness', harness];
  if (options.noLaunch) common.push('--no-launch');
  if (options.herdr) common.push('--herdr');
  return run('sh', [path.join(repoRoot, 'bootstrap.sh'), ...common]);
}

function status(options) {
  const installed = manifests(options.project);
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
  if (!harness) throw new Error('choose a harness: lenka doctor codex|claude|kimi|opencode');
  return run(process.execPath, [path.join(repoRoot, 'orchestra.mjs'), 'doctor', '--tool', harness, '--project', options.project, '--project-only', '--installed']);
}

async function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (options.command === 'help') {
    usage();
    return 0;
  }
  if (options.command === 'up') return up(options);
  if (options.command === 'status') return status(options);
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

export { main, manifests, parse };
