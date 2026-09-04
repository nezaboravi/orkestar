import { lstat, mkdir, readFile, writeFile, rename, realpath, rmdir } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const files = ['native-observer.mjs', 'native-audit.mjs', 'native-codex-evidence.mjs',
  'native-claude-evidence.mjs', 'native-solo-mirror.mjs'];
const events = ['SessionStart', 'SubagentStart', 'SubagentStop', 'PostToolUse', 'Stop'];
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
const windowsQuote = value => {
  if (/["%!\r\n]/.test(value)) throw new Error('Unsupported Windows hook path characters');
  return `"${value}"`;
};

async function directory(path) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe observer installation directory');
}

async function existing(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Unsafe observer installation file');
    return await readFile(path, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function replace(path, value) {
  await existing(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

/** Project-local installation only. Codex trust review remains the user's native decision.
 * Schemas: https://learn.chatgpt.com/docs/hooks and https://code.claude.com/docs/en/hooks
 */
export async function installNativeObserver({ project, harness, nodeBinary, sourceRoot }) {
  if (!['codex', 'claude'].includes(harness) || ![project, nodeBinary, sourceRoot].every(value => typeof value === 'string'
    && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value)) || resolve(project) !== project
    || await realpath(project) !== project) throw new Error('Invalid observer installation scope');
  const source = new Map();
  for (const name of files) {
    const content = await existing(join(sourceRoot, name));
    if (content === null) throw new Error(`Missing observer dependency: ${name}`);
    source.set(name, content);
  }
  const base = join(project, '.agent-orchestra'); await directory(base);
  const target = join(base, 'observer'); await directory(target);
  const lock = join(target, '.install-lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch { throw new Error('Observer installation is already running'); }
  try {
    const manifestPath = join(target, 'manifest.json');
    const rawManifest = await existing(manifestPath);
    const manifest = rawManifest === null ? { schemaVersion: 1, files: {}, hooks: {} } : JSON.parse(rawManifest);
    if (manifest.schemaVersion !== 1 || !object(manifest.files) || !object(manifest.hooks)) throw new Error('Unmanaged observer manifest');
    // Validate all ownership before writing any dependency or hook setting.
    for (const [name, content] of source) {
      const old = await existing(join(target, name));
      if (old !== null && old !== content && manifest.files[name] !== hash(old)) throw new Error(`Preserved modified observer file: ${name}`);
    }
    const settingsDirectory = join(project, harness === 'codex' ? '.codex' : '.claude'); await directory(settingsDirectory);
    const settingsPath = join(settingsDirectory, harness === 'codex' ? 'hooks.json' : 'settings.json');
    const rawSettings = await existing(settingsPath);
    const settings = rawSettings === null ? {} : JSON.parse(rawSettings);
    if (!object(settings) || (settings.hooks !== undefined && !object(settings.hooks))) throw new Error('Invalid native hook settings');
    const hooks = { ...settings.hooks };
    const argv = [join(target, 'native-observer.mjs'), '--harness', harness, '--project', project];
    const handler = harness === 'claude'
      ? { type: 'command', command: nodeBinary, args: argv, timeout: 30 }
      : { type: 'command', command: [nodeBinary, ...argv].map(quote).join(' '),
        ...(process.platform === 'win32' ? { commandWindows: [nodeBinary, ...argv].map(windowsQuote).join(' ') } : {}), timeout: 30 };
    const installed = {};
    for (const event of events) {
      if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new Error('Invalid native hook event list');
      let entries = hooks[event] ?? [];
      const old = manifest.hooks[harness]?.[event];
      if (old) {
        const matches = entries.filter(entry => JSON.stringify(entry) === JSON.stringify(old));
        if (matches.length !== 1) throw new Error(`Managed hook was modified or removed: ${event}`);
        entries = entries.filter(entry => JSON.stringify(entry) !== JSON.stringify(old));
      }
      const entry = { ...(event === 'Stop' ? {} : { matcher: '' }), hooks: [handler] };
      hooks[event] = [...entries, entry];
      installed[event] = entry;
    }
    let changed = false;
    for (const [name, content] of source) {
      if (await existing(join(target, name)) !== content) {
        await replace(join(target, name), content);
        changed = true;
      }
      manifest.files[name] = hash(content);
    }
    const output = JSON.stringify({ ...settings, hooks }, null, 2) + '\n';
    if (rawSettings !== output) { await replace(settingsPath, output); changed = true; }
    manifest.hooks[harness] = installed;
    await replace(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    return { harness, project, settingsPath, observerPath: join(target, 'native-observer.mjs'), changed,
      trustRequired: harness === 'codex', trustInstruction: harness === 'codex'
        ? 'Open /hooks in Codex and review the Orkestar observer hooks before they can run.' : null };
  } finally { await rmdir(lock); }
}
