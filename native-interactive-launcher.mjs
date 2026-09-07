#!/usr/bin/env node

// Solo owns the PTY. The selected CLI owns its editor, paste handling and
// approval screens. This adapter must never read or translate terminal input.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { launcherArgs } from './harness-launcher.mjs';

const script = fileURLToPath(import.meta.url);
const harnesses = new Set(['codex', 'claude', 'opencode', 'kimi', 'cursor']);

export function interactiveSpec({ harness, binary, project, model, effort = null }) {
  if (!harnesses.has(harness) || !path.isAbsolute(binary || '') || !model
    || /[\0\r\n]/.test(binary)) throw new Error('Missing verified interactive harness route');
  project = fs.realpathSync(project);
  const args = launcherArgs(harness, model, project, effort, { workspace: 'solo' });
  const digest = createHash('sha256').update(JSON.stringify({ script, harness, binary, project, args }));
  for (const file of [script, path.join(path.dirname(script), 'harness-launcher.mjs')]) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('Unsafe installed interactive launcher');
    digest.update(fs.readFileSync(file));
  }
  return { binary, project, args, marker: `ORKESTAR_NATIVE_UI_${digest.digest('hex')}` };
}

export function interactiveArgs(runtime, project) {
  const { model, reasoningEffort: effort } = runtime.manifest.primary;
  const spec = interactiveSpec({ harness: runtime.harness, binary: runtime.binary, project, model, effort });
  return [script, '--project', spec.project, '--harness', runtime.harness, '--binary', runtime.binary,
    '--model', model, ...(effort ? ['--effort', effort] : []), '--marker', spec.marker];
}

export function parseInteractiveArgs(argv) {
  const options = {};
  const allowed = new Set(['project', 'harness', 'binary', 'model', 'effort', 'marker']);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '');
    if (!argv[index]?.startsWith('--') || !allowed.has(key) || key in options || !argv[index + 1]) {
      throw new Error('Invalid interactive launcher arguments');
    }
    options[key] = argv[index + 1];
  }
  const spec = interactiveSpec(options);
  if (options.marker !== spec.marker) throw new Error('Lenka launch settings changed. Run lenka up solo again; this old session was not restarted.');
  return spec;
}

export function runInteractive(spec, dependencies = {}) {
  const host = dependencies.host || process;
  const start = dependencies.spawn || spawn;
  return new Promise((resolve) => {
    const child = start(spec.binary, spec.args, { cwd: spec.project, stdio: 'inherit', env: host.env });
    const handlers = new Map();
    // A PTY sends Ctrl-C to the foreground group itself. Forward termination
    // addressed to just this wrapper (e.g. Solo Stop), without double Ctrl-C.
    for (const signal of ['SIGTERM', 'SIGHUP']) {
      const handler = () => { if (child.exitCode === null) child.kill(signal); };
      handlers.set(signal, handler);
      host.on(signal, handler);
    }
    const interrupt = () => {};
    host.on('SIGINT', interrupt);
    const done = (code) => {
      for (const [signal, handler] of handlers) host.removeListener(signal, handler);
      host.removeListener('SIGINT', interrupt);
      resolve(code);
    };
    child.once('error', (error) => { console.error(`ERROR: Could not start the selected CLI: ${error.message}`); done(1); });
    child.once('exit', (code, signal) => done(code ?? ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal] || 1)));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  try { process.exitCode = await runInteractive(parseInteractiveArgs(process.argv.slice(2))); }
  catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}
