import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PLAYWRIGHT_MCP_VERSION = '0.0.80';
export const PLAYWRIGHT_MCP_INTEGRITY = 'sha512-FOPXHm2SvFhAQylm10jMZ35B/SR2TaMLVkavAlwoG4N2qCb5RqbvhQYcu3zmXNyxR2DW0Ooxe+9XPVt5UjKRCQ==';
export const BROWSER_TOOLS = Object.freeze(['browser_click', 'browser_close', 'browser_console_messages',
  'browser_fill_form', 'browser_find', 'browser_hover', 'browser_navigate', 'browser_navigate_back',
  'browser_network_requests', 'browser_press_key', 'browser_resize', 'browser_select_option',
  'browser_snapshot', 'browser_take_screenshot', 'browser_type', 'browser_wait_for', 'browser_tabs']);
const self = fileURLToPath(import.meta.url);
const manifest = { name: 'orkestar-managed-browser', private: true, version: '1.0.0', dependencies: { '@playwright/mcp': PLAYWRIGHT_MCP_VERSION } };
const safeString = value => typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value);
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function canonicalDirectory(value) {
  if (!safeString(value) || !path.isAbsolute(value) || fs.realpathSync(value) !== value || !fs.statSync(value).isDirectory()) throw new Error('Expected canonical directory');
  return value;
}
function ownedDirectory(parent, name, create = false) {
  const target = path.join(parent, name);
  if (create && !fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o700 });
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) throw new Error('Unsafe managed browser directory');
  return target;
}
function read(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Unsafe managed browser file');
  return fs.readFileSync(file, 'utf8');
}
function managedRoot(project, create = false) {
  return ownedDirectory(ownedDirectory(canonicalDirectory(project), '.agent-orchestra', create), 'browser', create);
}

// Same browser families and platform locations as adapters/opencode/tools/browser-discovery.ts.
export function browserCandidates({ platform = process.platform, env = process.env } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const names = platform === 'win32' ? ['chrome.exe', 'msedge.exe', 'brave.exe']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave', 'brave-browser', 'microsoft-edge'];
  const candidates = (env.PATH ?? '').split(platform === 'win32' ? ';' : ':')
    .filter(directory => safeString(directory) && paths.isAbsolute(directory))
    .flatMap(directory => names.map(name => paths.join(directory, name)));
  if (platform === 'darwin') candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  if (platform === 'win32') for (const root of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]) {
    if (!safeString(root) || !paths.isAbsolute(root)) continue;
    candidates.push(paths.join(root, 'Google/Chrome/Application/chrome.exe'), paths.join(root, 'Microsoft/Edge/Application/msedge.exe'),
      paths.join(root, 'BraveSoftware/Brave-Browser/Application/brave.exe'));
  }
  return [...new Set(candidates)];
}
export function discoverNativeWorkerBrowser() {
  for (const candidate of browserCandidates()) {
    try {
      const binary = fs.realpathSync(candidate);
      if (!safeString(binary) || !fs.lstatSync(binary).isFile()) continue;
      fs.accessSync(binary, fs.constants.X_OK);
      return binary;
    } catch { /* Continue through installed browser candidates. */ }
  }
  throw new Error('Frontend QA unavailable: install Chrome, Chromium, Brave, or Edge before browser setup.');
}

export function browserEnvironment(env = process.env) {
  // No NODE_OPTIONS, credentials, proxy injection, custom Playwright config or CDP inheritance.
  return Object.fromEntries(['HOME', 'USERPROFILE', 'PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR',
    'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL']
    .filter(key => safeString(env[key])).map(key => [key, env[key]]));
}
function dependency(project) {
  const root = managedRoot(project);
  if (JSON.stringify(JSON.parse(read(path.join(root, 'package.json')))) !== JSON.stringify(manifest)) throw new Error('Preserved modified browser manifest');
  const lock = JSON.parse(read(path.join(root, 'package-lock.json')));
  const entry = lock.packages?.['node_modules/@playwright/mcp'];
  if (entry?.version !== PLAYWRIGHT_MCP_VERSION || entry.integrity !== PLAYWRIGHT_MCP_INTEGRITY) throw new Error('Browser dependency lock does not match pinned integrity');
  const modules = ownedDirectory(root, 'node_modules');
  const scope = ownedDirectory(modules, '@playwright');
  const installed = ownedDirectory(scope, 'mcp');
  const pkg = JSON.parse(read(path.join(installed, 'package.json')));
  if (pkg.name !== '@playwright/mcp' || pkg.version !== PLAYWRIGHT_MCP_VERSION || pkg.bin?.['playwright-mcp'] !== 'cli.js') throw new Error('Browser dependency does not match pinned package');
  const cli = path.join(installed, 'cli.js'); read(cli);
  return { root, cli };
}

/** Resolve npm's installed JavaScript entry point, never execute a PATH shim or shell. */
export function resolveNativeWorkerNpm({ nodeBinary = process.execPath, env = process.env } = {}) {
  if (!safeString(nodeBinary) || !path.isAbsolute(nodeBinary)) throw new Error('Invalid browser setup Node runtime');
  const node = fs.realpathSync(nodeBinary);
  if (!fs.statSync(node).isFile()) throw new Error('Invalid browser setup Node runtime');
  fs.accessSync(node, fs.constants.X_OK);
  const candidates = [path.resolve(path.dirname(node), '../lib/node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(node), 'node_modules/npm/bin/npm-cli.js')];
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    if (!safeString(directory) || !path.isAbsolute(directory)) continue;
    // Debian's /usr/bin/npm links into /usr/share/nodejs/npm; Windows npm.cmd
    // has a sibling node_modules/npm entry point. Neither shim is executed.
    candidates.push(path.join(directory, 'npm'), path.join(directory, 'node_modules/npm/bin/npm-cli.js'));
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      const npm = fs.realpathSync(candidate);
      if (!safeString(npm) || path.basename(npm) !== 'npm-cli.js' || path.basename(path.dirname(npm)) !== 'bin') continue;
      read(npm);
      const root = path.dirname(path.dirname(npm));
      const pkg = JSON.parse(read(path.join(root, 'package.json')));
      if (pkg.name !== 'npm' || typeof pkg.bin?.npm !== 'string'
        || path.resolve(root, pkg.bin.npm) !== npm) continue;
      return { node, npm };
    } catch { /* An unrelated or unavailable PATH entry is not an npm runtime. */ }
  }
  throw new Error('Browser setup prerequisite: install npm with its npm-cli.js entry point alongside Node or on PATH.');
}

/** Explicit setup only. The dispatcher never downloads packages or browsers. */
export function installNativeWorkerBrowser({ project }, { invoke = spawnSync } = {}) {
  const browserBinary = discoverNativeWorkerBrowser();
  const root = managedRoot(project, true);
  const file = path.join(root, 'package.json');
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  else if (JSON.stringify(JSON.parse(read(file))) !== JSON.stringify(manifest)) throw new Error('Preserved modified browser manifest');
  try { return { ...dependency(project), browserBinary, installed: false }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { node, npm } = resolveNativeWorkerNpm();
  if (fs.existsSync(path.join(root, 'package-lock.json')) || fs.existsSync(path.join(root, 'node_modules'))) {
    throw new Error('Incomplete browser installation preserved; repair requires explicit review.');
  }
  for (const name of ['.npmrc', 'global.npmrc']) {
    const config = path.join(root, name);
    if (!fs.existsSync(config)) fs.writeFileSync(config, '', { flag: 'wx', mode: 0o600 });
    else if (read(config) !== '') throw new Error('Preserved modified browser npm configuration');
  }
  const args = [fs.realpathSync(npm), 'install',
    '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org',
    `--userconfig=${path.join(root, '.npmrc')}`, `--globalconfig=${path.join(root, 'global.npmrc')}`, `--cache=${path.join(root, '.npm-cache')}`];
  const result = invoke(node, args, { cwd: root, env: browserEnvironment(), encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024, shell: false });
  if (result.error || result.status !== 0) throw new Error('Pinned browser dependency setup failed; browser QA remains unavailable.');
  return { ...dependency(project), browserBinary, installed: true };
}

export function browserScreenshotDirectory(project, home = os.homedir()) {
  canonicalDirectory(project); canonicalDirectory(home);
  const slug = path.basename(project).replace(/[^A-Za-z0-9._-]/g, '-');
  if (!slug || slug === '.' || slug === '..') throw new Error('Invalid screenshot project name');
  let directory = home;
  for (const segment of ['Pictures', 'Screenshots', 'OpenCode', slug]) {
    directory = path.join(directory, segment);
    try { canonicalDirectory(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return directory;
}

/** Immutable client config; the CLI below independently revalidates before starting MCP. */
export function resolveNativeWorkerBrowser({ project, role }) {
  if (role !== 'frontend-qa') throw new Error('Browser tools are restricted to frontend-qa');
  canonicalDirectory(project);
  let installed;
  try { installed = dependency(project); } catch (error) {
    throw new Error(`Frontend QA unavailable: explicit pinned browser setup is required (${error.message}).`);
  }
  const browserBinary = discoverNativeWorkerBrowser();
  const outputDir = browserScreenshotDirectory(project);
  return freeze({ name: 'orkestar_browser', version: PLAYWRIGHT_MCP_VERSION, browserBinary, outputDir,
    server: { command: fs.realpathSync(process.execPath), args: [self, '--serve', '--project', project] },
    enabledTools: [...BROWSER_TOOLS],
    launch: { command: fs.realpathSync(process.execPath), args: [installed.cli, '--isolated', '--sandbox', '--executable-path', browserBinary,
      '--output-dir', outputDir, '--codegen', 'none'], env: browserEnvironment() },
    limitations: ['Browser interactions can change application data; the role must honor the approved QA scope.',
      'Browser isolation and tool allowlists are not an origin security boundary.'] });
}

/** Closed JSON-RPC gateway: tool authorization is enforced here, not entrusted to clients. */
export function browserProtocolGateway({ sendUpstream, sendClient }) {
  const pending = new Map();
  let sequence = 0;
  const validId = id => Number.isSafeInteger(id) || (typeof id === 'string' && id.length <= 128);
  const error = (id, message) => sendClient({ jsonrpc: '2.0', id: validId(id) ? id : null, error: { code: -32601, message } });
  return {
    fromClient(message) {
      if (!message || Array.isArray(message) || message.jsonrpc !== '2.0') return error(null, 'Invalid browser protocol request');
      if (message.method === 'notifications/initialized' && message.id === undefined) {
        sendUpstream({ jsonrpc: '2.0', method: 'notifications/initialized' }); return;
      }
      if (!validId(message.id)) return error(null, 'Browser protocol request ID required');
      if (!['initialize', 'ping', 'tools/list', 'tools/call'].includes(message.method)) return error(message.id, 'Browser protocol method denied');
      if (message.method === 'tools/call' && !BROWSER_TOOLS.includes(message.params?.name)) return error(message.id, 'Browser tool denied by Orkestar allowlist');
      if (pending.size >= 128 || [...pending.values()].some(request => request.id === message.id)) return error(message.id, 'Browser request limit or duplicate ID');
      const id = ++sequence;
      pending.set(id, { id: message.id, method: message.method });
      // Never expose the conductor's filesystem roots, sampling, elicitation, or credentials.
      const params = message.method === 'initialize'
        ? { protocolVersion: message.params?.protocolVersion, capabilities: {}, clientInfo: { name: 'orkestar-browser', version: '1' } }
        : message.method === 'tools/call' ? { name: message.params.name, arguments: message.params.arguments ?? {} } : {};
      sendUpstream({ jsonrpc: '2.0', id, method: message.method, params });
    },
    fromUpstream(message) {
      if (!message || message.jsonrpc !== '2.0' || Array.isArray(message)) throw new Error('Invalid upstream browser protocol');
      if (message.method) {
        if (validId(message.id)) sendUpstream({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Browser server requests are disabled' } });
        return;
      }
      const request = pending.get(message.id);
      if (!request) throw new Error('Unbound browser response');
      pending.delete(message.id);
      let result = message.result;
      if (request.method === 'tools/list' && !message.error) {
        if (!Array.isArray(result?.tools)) throw new Error('Invalid browser tool inventory');
        const tools = result.tools.filter(tool => BROWSER_TOOLS.includes(tool.name));
        if (tools.length !== BROWSER_TOOLS.length || new Set(tools.map(tool => tool.name)).size !== BROWSER_TOOLS.length) throw new Error('Incomplete browser tool inventory');
        result = { tools };
      }
      if (request.method === 'initialize' && !message.error) result = { ...result, capabilities: { tools: {} } };
      sendClient({ jsonrpc: '2.0', id: request.id, ...(message.error ? { error: message.error } : { result }) });
    },
  };
}

function proxyBrowserProtocol(child) {
  const MAX_MESSAGE = 16 * 1024 * 1024;
  let failed = false;
  const fail = () => {
    if (failed) return;
    failed = true; process.exitCode = 1; process.stdin.pause(); child.kill();
    process.stderr.write('Managed browser protocol rejected an invalid or oversized message.\n');
  };
  const send = (stream, source, value) => {
    const line = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(line) > MAX_MESSAGE) throw new Error('Browser message too large');
    if (!stream.write(line)) { source.pause(); stream.once('drain', () => { if (!failed) source.resume(); }); }
  };
  const gateway = browserProtocolGateway({ sendUpstream: value => send(child.stdin, process.stdin, value),
    sendClient: value => send(process.stdout, child.stdout, value) });
  const listen = (stream, receive) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      if (failed) return;
      try {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_MESSAGE) throw new Error('Browser message too large');
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (line.trim()) receive(JSON.parse(line));
        }
      } catch { fail(); }
    });
    stream.on('error', fail);
    stream.on('end', () => { if (buffer.trim()) fail(); });
  };
  listen(process.stdin, gateway.fromClient); listen(child.stdout, gateway.fromUpstream);
  child.stdin.on('error', fail);
  process.stdin.on('end', () => child.stdin.end());
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  try {
    if (process.argv.length !== 5 || process.argv[2] !== '--serve' || process.argv[3] !== '--project') throw new Error('Invalid browser server invocation');
    const config = resolveNativeWorkerBrowser({ project: process.argv[4], role: 'frontend-qa' });
    let directory = canonicalDirectory(os.homedir());
    for (const segment of path.relative(directory, config.outputDir).split(path.sep)) directory = ownedDirectory(directory, segment, true);
    const child = spawn(config.launch.command, config.launch.args, { cwd: directory, env: config.launch.env, stdio: ['pipe', 'pipe', 'inherit'], shell: false });
    proxyBrowserProtocol(child);
    child.on('error', () => { process.stderr.write('Managed browser MCP could not start.\n'); process.exitCode = 1; });
    child.on('exit', code => { if (!process.exitCode) process.exitCode = code ?? 1; process.stdin.pause(); });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
