import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectNativeWorkerReadiness } from '../native-worker-readiness.mjs';
import { installNativeWorker } from '../native-worker-install.mjs';

function fixture() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-readiness-')));
  const runtime = { schemaVersion: 1, harness: 'codex', profiles: { 'code-review': { permissionEnvelope: 'reviewer', model: 'review-model', reasoningEffort: 'high' }, taskavel: { permissionEnvelope: 'task-manager', model: 'task-model', reasoningEffort: 'low' } } };
  fs.mkdirSync(path.join(project, '.agent-orchestra/runtime'), { recursive: true });
  fs.mkdirSync(path.join(project, '.codex/agents'), { recursive: true });
  fs.writeFileSync(path.join(project, '.agent-orchestra/runtime/codex.json'), JSON.stringify(runtime));
  fs.writeFileSync(path.join(project, '.agent-orchestra/runtime/solo-observer.json'), JSON.stringify({ schemaVersion: 1, project, projectId: 7, soloBinary: '/fixture/solo', harness: 'codex' }));
  installNativeWorker({ project, harness: 'codex', nodeBinary: fs.realpathSync(process.execPath), sourceRoot: fs.realpathSync(process.cwd()) });
  fs.writeFileSync(path.join(project, '.codex/agents/reviewer.toml'), 'name = "reviewer"\nmodel = "review-model"\n\ndeveloper_instructions = """\nFixture\n"""\n');
  fs.writeFileSync(path.join(project, '.codex/agents/task-manager.toml'), 'name = "task-manager"\nmodel = "task-model"\n\ndeveloper_instructions = """\nFixture\n"""\n');
  const invoke = (_binary, args) => ({ status: 0, stdout: JSON.stringify({ ok: true, data: args[0] === 'projects' ? { id: 7, path: project } : { agentTools: [
    { id: 8, name: 'Orkestar Worker', enabled: true, toolType: 'generic', command: process.execPath },
    { id: 9, enabled: true, toolType: 'codex', command: 'codex' },
  ] } }) });
  return { project, invoke };
}

test('readiness proves bounded installed roles, Solo tool, browser artifact and session ceiling without launching a worker', async () => {
  const f = fixture();
  const result = await inspectNativeWorkerReadiness({ project: f.project, harness: 'codex', profiles: ['code-review', 'code-review'], requireBrowser: true, plannedWorkerCount: 12 }, {
    invoke: f.invoke, verifySoloBinary: value => value, probeBrowser: async () => ({ ready: true, artifact: { sha256: 'a'.repeat(64), relativePath: '.agent-orchestra/browser/readiness.png', bytes: 12 } }),
  });
  assert.equal(result.status, 'ready'); assert.equal(result.ready, true); assert.deepEqual(result.profiles, ['code-review']);
  assert.equal(result.sessionCeiling, 12); assert.equal(result.continuationSupported, false); assert.equal(result.capacityReservationSupported, false);
  assert.match(result.limitations.join('\n'), /requested count only/);
  assert.ok(result.checks.every(check => check.status === 'ready'));
});

test('readiness fails closed for malformed worker binding, missing roles, excessive profiles and continuation', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.project, '.agent-orchestra/worker/manifest.json'), '{');
  const malformed = await inspectNativeWorkerReadiness({ project: f.project, harness: 'codex', profiles: ['code-review'] }, { invoke: f.invoke, verifySoloBinary: value => value });
  assert.equal(malformed.status, 'BLOCKED'); assert.match(malformed.checks.find(check => check.name === 'worker-installation').message, /Unexpected|Invalid/);
  fs.writeFileSync(path.join(f.project, '.agent-orchestra/worker/manifest.json'), JSON.stringify({ schemaVersion: 1, files: {}, settings: { codex: '# fixture\n' } }));
  fs.unlinkSync(path.join(f.project, '.codex/agents/reviewer.toml'));
  const missing = await inspectNativeWorkerReadiness({ project: f.project, harness: 'codex', profiles: ['code-review'], requireContinuation: true }, { invoke: f.invoke, verifySoloBinary: value => value });
  assert.equal(missing.status, 'BLOCKED'); assert.equal(missing.checks.find(check => check.name === 'continuation').status, 'BLOCKED');
  const invalid = await inspectNativeWorkerReadiness({ project: f.project, harness: 'codex', profiles: Array(11).fill('code-review') }, { invoke: f.invoke, verifySoloBinary: value => value });
  assert.equal(invalid.status, 'BLOCKED'); assert.match(invalid.checks[0].message, /1 to 10/);
});
