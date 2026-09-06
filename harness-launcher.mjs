#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { realpathSync, readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const allowedReasoningEfforts = new Set(['low', 'medium', 'high']);

function assertReasoningEffort(reasoningEffort) {
  if (reasoningEffort && !allowedReasoningEfforts.has(reasoningEffort)) {
    throw new Error(`Reasoning effort ${JSON.stringify(reasoningEffort)} exceeds Orkestar's high ceiling`);
  }
}

function soloCodexInstructions(project) {
  const file = path.join(project, '.codex', 'agents', 'lenka.toml');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024
    || !realpathSync(file).startsWith(`${project}${path.sep}`)) throw new Error('Unsafe installed Lenka conductor instructions');
  const raw = readFileSync(file, 'utf8');
  const match = raw.match(/\ndeveloper_instructions = """\n([\s\S]*)\n"""\s*$/);
  if (!/^name = "lenka"$/m.test(raw) || !match || !match[1].includes('orkestar_worker')) {
    throw new Error('Installed Lenka conductor instructions are missing; run lenka up to refresh the project');
  }
  const body = `You are Lenka, the primary orchestrator running INSIDE SOLO for ${project}.\n${match[1]}\n\nSolo dispatch is mandatory: use orkestar_worker worker_contract, worker_dispatch_wave for every multi-worker ready wave, worker_dispatch only for a one-node wave, then worker_status, worker_result and worker_report. Native hidden subagents are disabled. Never substitute raw process spawning or direct implementation if the worker bridge is unavailable; report the precise blocker. Use the bridge coordination tools for meaningful Solo todos and scratchpads.`;
  return `ORKESTAR_SOLO_CONDUCTOR_${createHash('sha256').update(body).digest('hex')}\n${body}`;
}

function launcherArgs(harness, model, cwd = process.cwd(), reasoningEffort = null, context = {}) {
  assertReasoningEffort(reasoningEffort);
  const args = ['--model', model];
  if (harness === 'codex') {
    const project = realpathSync(cwd);
    args.push('--config', `projects={${JSON.stringify(project)}={trust_level="trusted"}}`);
    if (reasoningEffort) args.push('--config', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
    if (context.workspace === 'solo') {
      args.push('--config', `developer_instructions=${JSON.stringify(soloCodexInstructions(project))}`,
        '--disable', 'apps', '--disable', 'multi_agent', '--approve-for-me');
    } else args.push('--enable', 'multi_agent', '--approve-for-me');
  } else if (harness === 'claude') {
    args.push('--agent', 'lenka', '--permission-mode', 'auto');
    if (reasoningEffort) args.push('--effort', reasoningEffort);
  } else if (harness === 'kimi') {
    args.push('--agent-file', path.join(cwd, '.kimi-code', 'agents', 'lenka.md'), '--auto');
  } else if (harness === 'opencode') {
    args.push('--agent', 'lenka', '--auto');
  } else if (harness === 'cursor') {
    args.push('--force', '--approve-mcps');
  } else {
    throw new Error(`Unsupported harness: ${harness}`);
  }
  return args;
}

function main() {
  const harness = process.env.AGENT_ORCHESTRA_HARNESS;
  const binary = process.env.AGENT_ORCHESTRA_HARNESS_BINARY;
  const model = process.env.AGENT_ORCHESTRA_PRIMARY_MODEL;
  const reasoningEffort = process.env.AGENT_ORCHESTRA_REASONING_EFFORT || null;
  if (!['cursor', 'codex', 'claude', 'kimi', 'opencode'].includes(harness) || !binary || !model) {
    console.error('ERROR: Lenka launcher is missing a verified harness or coordination model.');
    return 1;
  }

  const args = launcherArgs(harness, model, process.cwd(), reasoningEffort);
  console.log(`Lenka is conducting with ${harness} / ${model}${reasoningEffort ? ` / ${reasoningEffort} reasoning` : ''}`);
  const result = spawnSync(binary, args, { stdio: 'inherit', env: process.env });
  if (result.error) {
    console.error(`ERROR: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();

export { launcherArgs, main, soloCodexInstructions };
