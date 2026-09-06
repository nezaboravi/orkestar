import test from 'node:test';
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
