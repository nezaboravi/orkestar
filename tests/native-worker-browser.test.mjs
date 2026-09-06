import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { browserCandidates, browserEnvironment, browserScreenshotDirectory, BROWSER_TOOLS,
  installNativeWorkerBrowser, resolveNativeWorkerBrowser, resolveNativeWorkerNpm, PLAYWRIGHT_MCP_VERSION,
  PLAYWRIGHT_MCP_INTEGRITY, browserProtocolGateway } from '../native-worker-browser.mjs';

function fixture() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-browser-'))); }
function installed(project) {
  const root = path.join(project, '.agent-orchestra/browser');
  const pkg = path.join(root, 'node_modules/@playwright/mcp');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'orkestar-managed-browser', private: true,
    version: '1.0.0', dependencies: { '@playwright/mcp': PLAYWRIGHT_MCP_VERSION } }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {
    'node_modules/@playwright/mcp': { version: PLAYWRIGHT_MCP_VERSION, integrity: PLAYWRIGHT_MCP_INTEGRITY } } }));
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@playwright/mcp', version: PLAYWRIGHT_MCP_VERSION,
    bin: { 'playwright-mcp': 'cli.js' } }));
  fs.writeFileSync(path.join(pkg, 'cli.js'), '// Fixture only; never executed.');
  return { root, pkg };
}

test('discovery preserves supported macOS, Linux and Windows conventions without relative PATH candidates', () => {
  assert.ok(browserCandidates({ platform: 'linux', env: { PATH: '/usr/bin:.:relative:/usr/bin' } }).includes('/usr/bin/chromium'));
  assert.ok(browserCandidates({ platform: 'darwin', env: {} }).includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  const windows = browserCandidates({ platform: 'win32', env: { PROGRAMFILES: 'C:\\Program Files', PATH: '.;C:\\bin' } });
  assert.ok(windows.includes('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'));
  assert.equal(windows.some(value => !path.win32.isAbsolute(value)), false);
  const linux = browserCandidates({ platform: 'linux', env: { PATH: '.:relative:/bin:/bin' } });
  assert.equal(linux.length, new Set(linux).size);
  assert.equal(linux.some(value => !path.posix.isAbsolute(value)), false);
});

test('clean environment discards secrets, remote profiles and runtime injection', () => {
  assert.deepEqual(browserEnvironment({ HOME: '/home/test', PATH: '/bin', DISPLAY: ':1', NODE_OPTIONS: '--require=evil',
    PLAYWRIGHT_MCP_CONFIG: '/evil.json', PLAYWRIGHT_MCP_CDP_ENDPOINT: 'http://private', TOKEN: 'private', HTTPS_PROXY: 'private' }),
  { HOME: '/home/test', PATH: '/bin', DISPLAY: ':1' });
});

function npmFixture(layout) {
  const root = fixture();
  const bin = path.join(root, 'usr/bin'); fs.mkdirSync(bin, { recursive: true });
  const nodeBinary = path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.writeFileSync(nodeBinary, '// Never executed.', { mode: 0o700 });
  const npmRoot = path.join(root, layout);
  fs.mkdirSync(path.join(npmRoot, 'bin'), { recursive: true });
  const npm = path.join(npmRoot, 'bin/npm-cli.js');
  fs.writeFileSync(npm, '// Never executed.');
  fs.writeFileSync(path.join(npmRoot, 'package.json'), JSON.stringify({ name: 'npm', bin: { npm: 'bin/npm-cli.js' } }));
  return { root, bin, nodeBinary, npmRoot, npm };
}

test('npm resolver preserves Node-bundled and adjacent Windows-style package layouts', () => {
  for (const layout of ['usr/lib/node_modules/npm', 'usr/bin/node_modules/npm']) {
    const f = npmFixture(layout);
    assert.deepEqual(resolveNativeWorkerNpm({ nodeBinary: f.nodeBinary, env: {} }), { node: f.nodeBinary, npm: f.npm });
  }
});

test('npm resolver follows the Debian system npm symlink without executing its PATH entry', { skip: process.platform === 'win32' }, () => {
  // Debian's published package file list: /usr/share/nodejs/npm/bin/npm-cli.js.
  const f = npmFixture('usr/share/nodejs/npm');
  fs.symlinkSync('../share/nodejs/npm/bin/npm-cli.js', path.join(f.bin, 'npm'));
  assert.deepEqual(resolveNativeWorkerNpm({ nodeBinary: f.nodeBinary, env: { PATH: f.bin } }), { node: f.nodeBinary, npm: f.npm });
  assert.throws(() => resolveNativeWorkerNpm({ nodeBinary: f.nodeBinary, env: { PATH: '.:relative' } }), /setup prerequisite/);
});

test('npm resolver rejects arbitrary shims and mismatched package metadata', () => {
  const f = npmFixture('unrelated/npm');
  fs.writeFileSync(path.join(f.bin, 'npm'), '#!/bin/sh\nexit 0', { mode: 0o700 });
  assert.throws(() => resolveNativeWorkerNpm({ nodeBinary: f.nodeBinary, env: { PATH: f.bin } }), /setup prerequisite/);
  const bundled = npmFixture('usr/lib/node_modules/npm');
  fs.writeFileSync(path.join(bundled.npmRoot, 'package.json'), JSON.stringify({ name: 'not-npm', bin: { npm: 'bin/npm-cli.js' } }));
  assert.throws(() => resolveNativeWorkerNpm({ nodeBinary: bundled.nodeBinary, env: {} }), /setup prerequisite/);
  fs.writeFileSync(path.join(bundled.npmRoot, 'package.json'), JSON.stringify({ name: 'npm', bin: { npm: '../other.js' } }));
  assert.throws(() => resolveNativeWorkerNpm({ nodeBinary: bundled.nodeBinary, env: {} }), /setup prerequisite/);
  assert.throws(() => resolveNativeWorkerNpm({ nodeBinary: 'node', env: {} }), /Invalid browser setup Node/);
});

test('exact browser allowlist excludes code execution, filesystem and configuration mutation', () => {
  assert.ok(BROWSER_TOOLS.includes('browser_console_messages'));
  assert.ok(BROWSER_TOOLS.includes('browser_network_requests'));
  assert.ok(BROWSER_TOOLS.includes('browser_take_screenshot'));
  for (const tool of ['browser_evaluate', 'browser_run_code', 'browser_run_code_unsafe', 'browser_file_upload',
    'browser_network_request', 'browser_get_config', 'browser_set_storage_state']) assert.equal(BROWSER_TOOLS.includes(tool), false);
  assert.ok(Object.isFrozen(BROWSER_TOOLS));
});

test('only frontend QA can request setup-backed browser config; no automatic installation', () => {
  const project = fixture();
  assert.throws(() => resolveNativeWorkerBrowser({ project, role: 'dev-builder' }), /restricted/);
  assert.throws(() => resolveNativeWorkerBrowser({ project, role: 'frontend-qa' }), /explicit pinned browser setup/);
  assert.equal(fs.existsSync(path.join(project, '.agent-orchestra')), false);
});

test('screenshot output is a sanitized project directory under the canonical home', () => {
  const base = fixture(); const project = path.join(base, 'app weird'); fs.mkdirSync(project);
  assert.equal(browserScreenshotDirectory(project, base), path.join(base, 'Pictures/Screenshots/OpenCode/app-weird'));
  assert.throws(() => browserScreenshotDirectory('relative', base), /canonical/);
});

test('pinned package integrity mismatch and symlinked managed directories fail closed', () => {
  const project = fixture(); const { root } = installed(project);
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {} }));
  assert.throws(() => resolveNativeWorkerBrowser({ project, role: 'frontend-qa' }), /pinned integrity/);
  if (process.platform !== 'win32') {
    const other = fixture(); fs.symlinkSync(project, path.join(other, '.agent-orchestra'));
    assert.throws(() => resolveNativeWorkerBrowser({ project: other, role: 'frontend-qa' }), /Unsafe/);
  }
});

test('installed config binds canonical browser, isolated sandbox, immutable tools and fixed server invocation', () => {
  const project = fixture(); installed(project);
  // Use a fake executable in the same PATH discovery shape; never launch it.
  const bin = path.join(project, 'bin'); fs.mkdirSync(bin);
  const browser = path.join(bin, process.platform === 'win32' ? 'chrome.exe' : 'chromium');
  fs.writeFileSync(browser, '', { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    const config = resolveNativeWorkerBrowser({ project, role: 'frontend-qa' });
    assert.equal(config.browserBinary, fs.realpathSync(browser));
    assert.ok(config.launch.args.includes('--isolated')); assert.ok(config.launch.args.includes('--sandbox'));
    assert.equal(config.launch.args.includes('--no-sandbox'), false);
    assert.equal(config.launch.args.includes('--cdp-endpoint'), false);
    assert.equal(config.launch.args.includes('--user-data-dir'), false);
    assert.deepEqual(config.server.args.slice(1), ['--serve', '--project', project]);
    assert.ok(Object.isFrozen(config.server.args)); assert.ok(Object.isFrozen(config.enabledTools));
    assert.throws(() => { config.launch.args.push('--no-sandbox'); }, TypeError);
    assert.equal(installNativeWorkerBrowser({ project }, { invoke: () => { throw new Error('must not download'); } }).installed, false);
  } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
});

const forbiddenTools = ['browser_evaluate', 'browser_run_code', 'browser_run_code_unsafe', 'browser_file_upload',
  'browser_set_storage_state', 'browser_cookie_set', 'browser_get_config', 'browser_network_request'];

test('gateway rejects direct forbidden calls without forwarding them upstream', () => {
  const upstream = [], client = [];
  const gateway = browserProtocolGateway({ sendUpstream: row => upstream.push(row), sendClient: row => client.push(row) });
  for (const [id, name] of forbiddenTools.entries()) gateway.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });
  assert.equal(upstream.length, 0);
  assert.equal(client.length, forbiddenTools.length);
  assert.ok(client.every(row => row.error?.code === -32601 && /allowlist/.test(row.error.message)));
  gateway.fromClient({ jsonrpc: '2.0', id: 99, method: 'resources/read', params: { uri: 'file:///private' } });
  assert.equal(upstream.length, 0);
  assert.match(client.at(-1).error.message, /method denied/);
});

test('gateway filters inventory, suppresses client capabilities, and rejects filesystem requests', () => {
  const upstream = [], client = [];
  const gateway = browserProtocolGateway({ sendUpstream: row => upstream.push(row), sendClient: row => client.push(row) });
  gateway.fromClient({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: { roots: {}, sampling: {} } } });
  assert.deepEqual(upstream[0].params.capabilities, {});
  gateway.fromUpstream({ jsonrpc: '2.0', id: 1, result: { capabilities: { resources: {}, tools: {} } } });
  assert.deepEqual(client[0].result.capabilities, { tools: {} });
  gateway.fromClient({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
  gateway.fromUpstream({ jsonrpc: '2.0', id: 2, result: { tools: [...BROWSER_TOOLS, ...forbiddenTools].map(name => ({ name })) } });
  assert.deepEqual(client.at(-1).result.tools.map(tool => tool.name), BROWSER_TOOLS);
  gateway.fromUpstream({ jsonrpc: '2.0', id: 23, method: 'roots/list' });
  assert.equal(upstream.at(-1).error.code, -32601);
  assert.throws(() => gateway.fromUpstream({ jsonrpc: '2.0', id: 777, result: {} }), /Unbound/);
});

test('gateway binds allowed calls and bounds pending requests', () => {
  const upstream = [], client = [];
  const gateway = browserProtocolGateway({ sendUpstream: row => upstream.push(row), sendClient: row => client.push(row) });
  gateway.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {}, _meta: { unauthorized: true } } });
  assert.deepEqual(upstream[0].params, { name: 'browser_snapshot', arguments: {} });
  gateway.fromClient({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.match(client.at(-1).error.message, /duplicate/);
  for (let id = 2; id <= 129; id++) gateway.fromClient({ jsonrpc: '2.0', id, method: 'ping' });
  assert.equal(upstream.length, 128);
  assert.match(client.at(-1).error.message, /limit/);
});

// Explicit opt-in uses an already-installed isolated fixture; never downloads or launches a browser.
if (process.env.ORKESTAR_BROWSER_PROTOCOL_PROJECT) test('real managed MCP gateway exposes only 17 tools and rejects forbidden direct protocol calls', { timeout: 15000 }, async () => {
  const config = resolveNativeWorkerBrowser({ project: process.env.ORKESTAR_BROWSER_PROTOCOL_PROJECT, role: 'frontend-qa' });
  const child = spawn(config.server.command, config.server.args, { env: browserEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  const pending = new Map(); let buffer = '', id = 0, stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const row = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      pending.get(row.id)?.(row); pending.delete(row.id);
    }
  });
  const call = (method, params = {}) => new Promise(resolve => {
    const requestId = ++id; pending.set(requestId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  });
  const timer = setTimeout(() => child.kill(), 12000);
  try {
    const initialize = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.ok(initialize.result, stderr);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await call('tools/list');
    assert.deepEqual(list.result.tools.map(tool => tool.name).sort(), [...BROWSER_TOOLS].sort());
    for (const name of forbiddenTools) {
      const response = await call('tools/call', { name, arguments: {} });
      assert.equal(response.error?.code, -32601, name);
      assert.match(response.error.message, /Orkestar allowlist/, name);
    }
    assert.deepEqual((await call('ping')).result, {});
    child.stdin.end();
    const [code] = await exit; assert.equal(code, 0, stderr);
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
});
