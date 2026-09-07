import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const runtimeRoot = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));

const dependencies = ['native-solo-worker-mcp.mjs', 'native-solo-worker.mjs', 'native-worker-wait.mjs', 'native-solo-output.mjs',
  'native-conductor-live.mjs', 'native-conductor-protocol.mjs',
  'native-worker-live.mjs', 'native-worker-stream.mjs',
  'native-worker-recovery.mjs', 'native-codex-evidence.mjs',
  'native-review-policy.mjs', 'native-worker-review.mjs',
  'native-worker-budget.mjs', 'native-worker-ownership.mjs', 'native-worker-prerequisites.mjs', 'orchestra-limits.mjs',
  'native-worker-readiness.mjs', 'native-tracker-operations.mjs',
  'native-solo-mirror.mjs', 'native-audit.mjs', 'native-worker-browser.mjs', 'native-worker-taskavel.mjs', 'native-taskavel-readback.mjs', 'native-taskavel-binding.mjs', 'native-worker-tracker.mjs',
  'native-worker-report.mjs', 'native-worker-summary.mjs', 'native-worker-coordination.mjs', 'report-tracker-gate.mjs', 'tracker-reconciliation.mjs',
  'orchestra.mjs', 'AGENTS.md', 'orchestra.json'];
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function read(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Unsafe worker installation file');
    return fs.readFileSync(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function directory(file) {
  try { fs.mkdirSync(file, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe worker installation directory');
}
function replace(file, text) {
  read(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** Additive project-local MCP; never changes global permissions or bypasses client trust. */
export function installNativeWorker({ project, harness, nodeBinary, sourceRoot }) {
  if (!['codex', 'claude'].includes(harness) || ![project, nodeBinary, sourceRoot].every(value =>
    typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value))
    || fs.realpathSync(project) !== project || fs.realpathSync(sourceRoot) !== runtimeRoot
    || fs.realpathSync(nodeBinary) !== fs.realpathSync(process.execPath)
    || !fs.lstatSync(nodeBinary).isFile()) throw new Error('Invalid worker installation scope');
  fs.accessSync(nodeBinary, fs.constants.X_OK);
  const base = path.join(project, '.agent-orchestra'); directory(base);
  const target = path.join(base, 'worker'); directory(target);
  const lock = path.join(target, '.install-lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error('Worker installation is busy'); }
  try {
    const manifestFile = path.join(target, 'manifest.json');
    const oldManifest = read(manifestFile);
    const manifest = oldManifest === null ? { schemaVersion: 1, files: {}, settings: {} } : JSON.parse(oldManifest);
    if (manifest.schemaVersion !== 1 || !object(manifest.files) || !object(manifest.settings)) throw new Error('Invalid worker installation manifest');
    const sources = dependencies.map(name => {
      const content = read(path.join(sourceRoot, name));
      if (content === null) throw new Error(`Missing worker dependency: ${name}`);
      const prior = read(path.join(target, name));
      if (prior !== null && prior !== content && manifest.files[name] !== hash(prior)) throw new Error(`Preserved modified worker dependency: ${name}`);
      return { name, content, prior };
    });
    const args = [path.join(target, 'native-solo-worker-mcp.mjs'), '--project', project, '--harness', harness];
    const server = { command: nodeBinary, args };
    let settingsFile, output;
    if (harness === 'claude') {
      settingsFile = path.join(project, '.mcp.json');
      const raw = read(settingsFile);
      const settings = raw === null ? {} : JSON.parse(raw);
      if (!object(settings) || (settings.mcpServers !== undefined && !object(settings.mcpServers))) throw new Error('Invalid project MCP settings');
      const previous = settings.mcpServers?.orkestar_worker;
      if (previous && JSON.stringify(previous) !== JSON.stringify(server)
        && JSON.stringify(previous) !== manifest.settings.claude) throw new Error('Preserved existing orkestar_worker MCP server');
      output = JSON.stringify({ ...settings, mcpServers: { ...settings.mcpServers, orkestar_worker: server } }, null, 2) + '\n';
      manifest.settings.claude = JSON.stringify(server);
    } else {
      directory(path.join(project, '.codex'));
      settingsFile = path.join(project, '.codex', 'config.toml');
      const raw = read(settingsFile) ?? '';
      const begin = '# BEGIN ORKESTAR WORKER MCP';
      const end = '# END ORKESTAR WORKER MCP';
      // Keep transport headroom above the MCP operation's hard 60-second wait
      // limit so a client timeout cannot cancel an otherwise bounded response.
      const block = `${begin}\n[mcp_servers.orkestar_worker]\ncommand = ${JSON.stringify(nodeBinary)}\nargs = ${JSON.stringify(args)}\ntool_timeout_sec = 90\n${end}\n`;
      const previous = manifest.settings.codex;
      if (previous && (raw.split(previous).length !== 2)) throw new Error('Preserved modified worker MCP settings');
      const rest = previous ? raw.replace(previous, '') : raw;
      if (rest.includes('orkestar_worker') || rest.includes(begin) || rest.includes(end)) throw new Error('Preserved existing orkestar_worker MCP settings');
      output = `${rest.trimEnd()}${rest.trimEnd() ? '\n\n' : ''}${block}`;
      manifest.settings.codex = block;
    }
    let changed = false;
    for (const { name, content, prior } of sources) {
      if (prior !== content) { replace(path.join(target, name), content); changed = true; }
      manifest.files[name] = hash(content);
    }
    if (read(settingsFile) !== output) { replace(settingsFile, output); changed = true; }
    replace(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    return { project, harness, changed, settingsFile, serverPath: args[0], trustRequired: true };
  } finally { fs.rmdirSync(lock); }
}
