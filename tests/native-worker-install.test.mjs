import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { installNativeWorker } from '../native-worker-install.mjs';

function fixture() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-install-')));
  const sourceRoot = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  return { project, sourceRoot, nodeBinary: process.execPath };
}
test('Codex worker installation preserves settings and owns only its additive MCP block', () => {
  const input = fixture(); fs.mkdirSync(path.join(input.project, '.codex'));
  const settings = path.join(input.project, '.codex/config.toml');
  fs.writeFileSync(settings, 'model = "existing"\n');
  assert.equal(installNativeWorker({ ...input, harness: 'codex' }).changed, true);
  assert.match(fs.readFileSync(settings, 'utf8'), /^model = "existing"/);
  assert.match(fs.readFileSync(settings, 'utf8'), /tool_timeout_sec = 90/);
  assert.equal(installNativeWorker({ ...input, harness: 'codex' }).changed, false);
  fs.appendFileSync(settings, '\n# user customization\n');
  installNativeWorker({ ...input, harness: 'codex' });
  assert.match(fs.readFileSync(settings, 'utf8'), /user customization/);
  fs.appendFileSync(path.join(input.project, '.agent-orchestra/worker/native-solo-worker.mjs'), ' user edit');
  assert.throws(() => installNativeWorker({ ...input, harness: 'codex' }), /Preserved modified/);
});
test('Claude additive config preserves unrelated servers and refuses a conflicting name', () => {
  const input = fixture(); const settings = path.join(input.project, '.mcp.json');
  fs.writeFileSync(settings, JSON.stringify({ mcpServers: { existing: { command: 'untouched' } } }));
  installNativeWorker({ ...input, harness: 'claude' });
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).mcpServers.existing, { command: 'untouched' });
  assert.equal(installNativeWorker({ ...input, harness: 'claude' }).changed, false);
  const config = JSON.parse(fs.readFileSync(settings, 'utf8'));
  config.mcpServers.orkestar_worker.command = 'user-custom';
  fs.writeFileSync(settings, JSON.stringify(config));
  assert.throws(() => installNativeWorker({ ...input, harness: 'claude' }), /Preserved existing/);
});
test('worker installation rejects unsafe project directories', () => {
  const input = fixture(); fs.mkdirSync(path.join(input.project, 'other'));
  assert.throws(() => installNativeWorker({ ...input, harness: 'codex', sourceRoot: input.project }), /Invalid/);
  assert.throws(() => installNativeWorker({ ...input, harness: 'codex', nodeBinary: input.sourceRoot }), /Invalid/);
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(input.project, 'other'), path.join(input.project, '.agent-orchestra'));
    assert.throws(() => installNativeWorker({ ...input, harness: 'codex' }), /Unsafe/);
  }
});

for (const harness of ['codex', 'claude']) test(`${harness} installed MCP starts with all transitive dependencies`, () => {
  const input = fixture();
  const installed = installNativeWorker({ ...input, harness });
  const result = spawnSync(process.execPath, [installed.serverPath, '--project', input.project, '--harness', harness], {
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'installation-test', version: '1' } } }) + '\n',
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.id, 1);
  assert.ok(response.result.serverInfo);
});
