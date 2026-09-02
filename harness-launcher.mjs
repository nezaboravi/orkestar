#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

function launcherArgs(harness, model, cwd = process.cwd(), reasoningEffort = null) {
  const args = ['--model', model];
  if (harness === 'codex') {
    const project = realpathSync(cwd);
    args.push('--config', `projects={${JSON.stringify(project)}={trust_level="trusted"}}`);
    if (reasoningEffort) args.push('--config', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
    args.push('--enable', 'multi_agent', '--approve-for-me');
  } else if (harness === 'claude') {
    args.push('--agent', 'lenka', '--permission-mode', 'auto');
    if (reasoningEffort) args.push('--effort', reasoningEffort);
  } else if (harness === 'kimi') {
    args.push('--agent-file', path.join(cwd, '.kimi-code', 'agents', 'lenka.md'), '--auto');
  } else if (harness === 'opencode') {
    args.push('--agent', 'lenka', '--auto');
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
  if (!['codex', 'claude', 'kimi', 'opencode'].includes(harness) || !binary || !model) {
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

export { launcherArgs, main };
