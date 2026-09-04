import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildPlan, classify, runtimeManifest } from './orchestra.mjs';

const text = value => typeof value === 'string' && value.trim() && value.length <= 512
  && !/[\x00-\x1f\x7f]/.test(value);

function guard(project, target) {
  const relative = path.relative(project, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Runtime target escaped project');
  const parts = relative.split(path.sep);
  let current = project;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error('Unsafe runtime target');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function directory(project, target) {
  const relative = path.relative(project, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe runtime directory');
  let current = project;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe runtime directory');
  }
}

/** Project-only projection of already verified routes; no inventory, probes or global writes. */
export function refreshProjectRuntime({ project, harness, manifest, conflict = 'backup' }) {
  if (!path.isAbsolute(project ?? '') || path.resolve(project) !== project || fs.realpathSync(project) !== project
    || !['codex', 'claude', 'opencode', 'cursor', 'kimi'].includes(harness)
    || !['backup', 'skip'].includes(conflict) || manifest?.schemaVersion !== 1 || manifest.harness !== harness
    || !text(manifest.primary?.model) || manifest.primary?.role !== 'coordination') throw new Error('Invalid cached runtime scope');
  const expected = JSON.parse(runtimeManifest(harness));
  if (manifest.primary.modelClass !== expected.primary.modelClass
    || manifest.primary.reasoningEffort !== expected.primary.reasoningEffort || !manifest.profiles
    || Object.keys(manifest.profiles).length !== Object.keys(expected.profiles).length) throw new Error('Cached runtime profiles require revalidation');
  const roles = { lenka: manifest.primary.model, 'dev-lead': manifest.primary.model };
  const candidates = {};
  for (const [name, profile] of Object.entries(expected.profiles)) {
    const cached = manifest.profiles[name];
    if (!cached || !text(cached.model) || ['permissionEnvelope', 'modelClass', 'writes', 'externalWrites', 'independentProofRequired', 'reasoningEffort']
      .some(key => cached[key] !== profile[key])) throw new Error(`Cached runtime profile requires revalidation: ${name}`);
    if (roles[cached.permissionEnvelope] && roles[cached.permissionEnvelope] !== cached.model) throw new Error('Contradictory cached role routes');
    roles[cached.permissionEnvelope] = cached.model;
    (candidates[cached.modelClass] ??= new Set()).add(cached.model);
  }
  const factory = Object.fromEntries(Object.entries(candidates).filter(([, models]) => models.size === 1)
    .map(([modelClass, models]) => [modelClass, [...models][0]]));
  factory[manifest.primary.modelClass] = manifest.primary.model;
  const plan = buildPlan({ selectedTools: [harness], projectOnly: true, project,
    resolvedModelsByTool: { [harness]: roles }, resolvedFactoryModelsByTool: { [harness]: factory } });
  const runtimeTarget = path.join(project, '.agent-orchestra', 'runtime', `${harness}.json`);
  const runtime = plan.operations.find(operation => operation.target === runtimeTarget);
  const generated = JSON.parse(runtime.content);
  runtime.content = JSON.stringify({ ...manifest, scopeProtocol: generated.scopeProtocol }, null, 2) + '\n';
  // No operation is classified/read until all output parents have passed the guard.
  for (const operation of plan.operations) guard(project, operation.target);
  guard(project, path.join(project, '.agent-orchestra', 'backups', 'refresh', 'manifest.json'));
  const classified = classify(plan, conflict);
  const changed = classified.filter(operation => ['create', 'replace'].includes(operation.action));
  if (!changed.length) return { changed: 0, changedCount: 0, warnings: plan.warnings };
  const backupRoot = path.join(project, '.agent-orchestra', 'backups', `refresh-${randomUUID()}`);
  directory(project, backupRoot);
  const backups = [];
  for (const [index, operation] of changed.entries()) {
    guard(project, operation.target);
    directory(project, path.dirname(operation.target));
    let backup = null;
    if (operation.action === 'replace') {
      backup = path.join(backupRoot, `${index}.backup`);
      fs.copyFileSync(operation.target, backup, fs.constants.COPYFILE_EXCL);
    }
    backups.push({ target: operation.target, backup });
  }
  // Recovery mapping exists before any replacement, including interrupted refreshes.
  fs.writeFileSync(path.join(backupRoot, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files: backups }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  for (const operation of changed) {
    guard(project, operation.target);
    const temporary = `${operation.target}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, operation.content, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, operation.target);
  }
  return { changed: changed.length, changedCount: changed.length, warnings: plan.warnings, recoveryManifest: path.join(backupRoot, 'manifest.json') };
}
