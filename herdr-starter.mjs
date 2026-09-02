#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launcherArgs } from './harness-launcher.mjs';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

function parse(input) {
  const options = {};
  const args = [...input];
  while (args.length) {
    const key = args.shift();
    if (!key?.startsWith('--') || !args.length) throw new Error(`invalid Herdr starter argument: ${key || '(empty)'}`);
    options[key.slice(2)] = args.shift();
  }
  for (const required of ['herdr', 'session', 'harness', 'project', 'model']) {
    if (!options[required]) throw new Error(`missing --${required}`);
  }
  return options;
}

function nestedRecords(value, predicate, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (predicate(value)) found.push(value);
  for (const child of Object.values(value)) nestedRecords(child, predicate, found);
  return found;
}

function selectPane(snapshot, project) {
  const panes = nestedRecords(snapshot, (value) => typeof value.pane_id === 'string');
  const unique = [...new Map(panes.map((pane) => [pane.pane_id, pane])).values()];
  const normalizedProject = path.resolve(project);
  const inProject = unique.find((pane) => {
    const candidate = pane.foreground_cwd || pane.cwd;
    return typeof candidate === 'string' && path.resolve(candidate) === normalizedProject;
  });
  if (inProject) return inProject.pane_id;
  const focused = nestedRecords(snapshot, (value) => typeof value.focused_pane_id === 'string')[0]?.focused_pane_id;
  if (focused && unique.some((pane) => pane.pane_id === focused)) return focused;
  return unique[0]?.pane_id || null;
}

function run(command, args, options) {
  return spawnSync(command, args, {
    cwd: options.project,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeout || 12000,
  });
}

function appendLog(file, message) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function main(input = process.argv.slice(2)) {
  const options = parse(input);
  const logFile = options.log || path.join(process.env.HOME || process.env.USERPROFILE || repoRoot, '.local', 'share', 'agent-orchestra', `herdr-${options.session}.log`);
  const env = { ...process.env, HERDR_SESSION: options.session };
  const harnessDirectory = path.dirname(options.binary || '');
  if (harnessDirectory && harnessDirectory !== '.') env.PATH = `${harnessDirectory}${path.delimiter}${env.PATH || ''}`;
  const commandOptions = { project: options.project, env };
  const deadline = Date.now() + 45000;

  while (Date.now() < deadline) {
    const existing = run(options.herdr, ['agent', 'get', 'lenka'], commandOptions);
    if (existing.status === 0) return 0;

    const snapshot = run(options.herdr, ['api', 'snapshot'], commandOptions);
    if (snapshot.status !== 0) {
      sleep(150);
      continue;
    }

    let pane;
    try {
      pane = selectPane(JSON.parse(snapshot.stdout), options.project);
    } catch {
      appendLog(logFile, 'ERROR: Herdr returned an invalid session snapshot.');
      return 1;
    }
    if (!pane) {
      sleep(150);
      continue;
    }

    const agentArgs = launcherArgs(options.harness, options.model, options.project, options.reasoning || null);
    const started = run(options.herdr, [
      'agent', 'start', 'lenka', '--kind', options.harness, '--pane', pane, '--timeout', '30000', '--', ...agentArgs,
    ], { ...commandOptions, timeout: 32000 });
    if (started.status === 0) {
      appendLog(logFile, `READY: Lenka started in ${options.session} on ${pane} with ${options.harness}.`);
      return 0;
    }
    const failure = `${started.stderr || started.stdout || ''}`.trim();
    if (!/not[_ -]?(available|ready)|server|socket|connect|shell/i.test(failure)) {
      appendLog(logFile, `ERROR: ${failure || `Herdr agent start exited ${started.status}`}`);
      return 1;
    }
    sleep(200);
  }

  appendLog(logFile, `ERROR: Timed out waiting for a shell pane in ${options.session}.`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

export { main, parse, selectPane };
