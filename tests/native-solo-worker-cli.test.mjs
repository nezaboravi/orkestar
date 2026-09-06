import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { workerCli } from '../native-solo-worker-cli.mjs';

test('worker CLI dispatches only project-local exact contracts', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-cli-')));
  const contract = { harness: 'codex', profile: 'project-read', name: 'Inspect routes', runId: 'run', task: 'Read only', ownerSessionId: 'owner' };
  const file = path.join(project, 'contract.json');
  fs.writeFileSync(file, JSON.stringify(contract));
  let call;
  const dependencies = { print() {}, api: { dispatchNativeSoloWorker: value => { call = value; return { status: 'RUNNING' }; } } };
  assert.equal(await workerCli(['dispatch', '--project', project, '--contract', file], dependencies), 0);
  assert.deepEqual(call, { ...contract, project });
  fs.writeFileSync(file, JSON.stringify({ ...contract, project: '/foreign' }));
  await assert.rejects(workerCli(['dispatch', '--project', project, '--contract', file], dependencies), /fields/);
  await assert.rejects(workerCli(['dispatch', '--project', project, '--contract', '../other'], dependencies));
});

test('worker CLI status/result do not dispatch and reject unknown options', async () => {
  const api = { nativeSoloWorkerStatus: () => ({ state: 'running' }), collectNativeSoloWorkerResult: () => ({ state: 'stopped', complete: false }) };
  assert.equal(await workerCli(['status', '--run-id', 'run'], { api, print() {} }), 0);
  assert.equal(await workerCli(['result', '--run-id', 'run'], { api, print() {} }), 1);
  api.collectNativeSoloWorkerResult = () => ({ complete: true, acceptance: 'PARTIAL' });
  assert.equal(await workerCli(['result', '--run-id', 'run'], { api, print() {} }), 0);
  await assert.rejects(workerCli(['dispatch', '--dangerous', 'yes'], { api }), /arguments/);
});
