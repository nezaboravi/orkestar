import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadModelSelection } from './model-selection.mjs';
import { validTeam } from './team-routing.mjs';
import { createTaskContract, parseAgent, modelInventory } from './orchestra.mjs';
import { nativeWorkerArguments, parseNativeWorkerOutput } from './native-solo-worker.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const roles = { mid: 'dev-builder', economy: 'verifier', strongest: 'reviewer' };
function inside(project, relative, create = false) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('Expected project-relative path');
  const target = path.resolve(project, relative), parts = path.relative(project, target).split(path.sep);
  if (parts[0] === '..' || target === project) throw new Error('Path escapes project');
  let current = project;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    if (!fs.existsSync(current) && create && index < parts.length - 1) fs.mkdirSync(current, { mode: 0o700 });
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symlinked delegation paths are not allowed'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}
function locate(name) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    for (const suffix of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      const file = path.join(directory, name + suffix);
      try { fs.accessSync(file, fs.constants.X_OK); return file; } catch {}
    }
  }
  throw new Error(`${name} CLI is not available`);
}
export function runCrossWorker({ project, harness, role, taskFile }, { home = os.homedir(), invoke = spawnSync, find = locate, selection = null, inventory = modelInventory } = {}) {
  project = fs.realpathSync(project);
  if (!roles[role]) throw new Error('Unknown worker role');
  const chosen = selection ?? loadModelSelection(home, harness, undefined, { strict: true });
  if (!chosen || chosen.harness !== harness || !validTeam(chosen.externalWorkers, chosen.models?.lenka)) throw new Error('Configure an explicit cross-CLI team with lenka setup first');
  const route = chosen.externalWorkers[role];
  const binary = find(route.harness);
  if (!inventory(home, route.harness).includes(route.model)) throw new Error('Selected worker model is no longer listed; configure the team again');
  const file = inside(project, taskFile);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 32768) throw new Error('Task must be a bounded project JSON file');
  const task = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!task || Object.keys(task).some(key => !['goal', 'required', 'ownership'].includes(key))) throw new Error('Unknown task fields');
  const contract = createTaskContract({ goal: task.goal, required: task.required });
  if (typeof task.goal !== 'string' || task.goal.length > 16000 || !Array.isArray(task.required) || !task.required.length) throw new Error('Task needs a goal and acceptance criteria');
  if (role === 'mid' && (!Array.isArray(task.ownership) || !task.ownership.length || task.ownership.length > 50)) throw new Error('Implementation requires explicit owned paths');
  for (const owned of task.ownership ?? []) inside(project, owned);
  const agentName = roles[role];
  const template = parseAgent(path.join(root, role === 'mid' ? 'teams/dev/dev-builder.md' : `agents/${agentName}.md`));
  const launch = nativeWorkerArguments({ harness: route.harness, role: agentName, model: route.model, effort: route.effort,
    body: template.body + '\nRead this project AGENTS.md and applicable rules before working. This is a direct cross-CLI worker, not a Solo process. Stay within this project.',
    tools: role === 'mid' ? ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'] : ['Read', 'Grep', 'Glob'],
    task: { contract, goal: task.goal, evidence: task.required, requiresWrite: role === 'mid', ...(role === 'mid' ? { ownership: { paths: task.ownership } } : {}) }, project });
  // Isolate inherited integrations while retaining each CLI's own account login.
  const prompt = launch.args.pop();
  if (route.harness === 'codex') {
    launch.args.push('--ignore-user-config', '-c', 'features.hooks=false', '-c', 'mcp_servers={}');
  } else {
    launch.args.push('--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--no-chrome',
      '--agents', JSON.stringify({ [agentName]: { description: 'Scoped cross-CLI worker', prompt: template.body } }));
  }
  launch.args.push(prompt);
  const base = `.agent-orchestra/cross-workers/${contract.id}`;
  const outputFile = inside(project, `${base}/${randomUUID()}.json`, true);
  let slot;
  for (let index = 1; index <= 2; index++) {
    try { slot = fs.openSync(inside(project, `${base}/launch-${index}.json`), 'wx', 0o600); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (slot === undefined) throw new Error('Two-worker contract budget reached; no new process was launched');
  fs.writeFileSync(slot, JSON.stringify({ role, route, contract, startedAt: Date.now() })); fs.closeSync(slot);
  const result = invoke(binary, launch.args, { cwd: project, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, input: '' });
  const evidence = parseNativeWorkerOutput(route.harness, String(result.stdout || ''));
  const report = { schemaVersion: 1, contractId: contract.id, role, route, ...evidence,
    complete: result.status === 0 && !result.error && evidence.complete === true,
    acceptance: 'PARTIAL', notice: 'Untrusted worker output; completion is not independent acceptance.',
    limitations: launch.limitations,
    exitCode: result.status, error: result.error?.code ?? null,
    diagnostic: result.status === 0 ? null : String(result.stderr || '').replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[redacted]').slice(-2400) };
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ...report, outputFile };
}
export function crossWorkerCli(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--harness', '--role', '--task', '--project'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Use lenka delegate --harness TOOL --role mid|economy|strongest --task PROJECT_FILE');
    options[args[i]] = args[i + 1];
  }
  const result = runCrossWorker({ project: options['--project'] ?? process.cwd(), harness: options['--harness'], role: options['--role'], taskFile: options['--task'] });
  console.log(JSON.stringify(result, null, 2));
  return result.complete ? 0 : 1;
}
