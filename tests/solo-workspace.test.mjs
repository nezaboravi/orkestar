import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { launchInSolo, selectAgentTool, verifySoloStartup } from '../solo-workspace.mjs';

test('Solo selects the enabled tool matching the verified harness', () => {
  assert.equal(selectAgentTool([
    { id: 1, toolType: 'codex', enabled: false },
    { id: 2, toolType: 'claude', enabled: true },
    { id: 3, toolType: 'codex', enabled: true },
  ], 'codex').id, 3);
});

test('Solo launch imports the project and passes adapter-native arguments', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'orkestar-solo-'));
  const canonicalProject = fs.realpathSync(project);
  const calls = [];
  const responses = [
    { ready: true },
    { projects: [] },
    { project: { id: 42, name: 'demo', path: canonicalProject } },
    { agentTools: [{ id: 7, name: 'Codex', toolType: 'codex', enabled: true }] },
    { process: { id: 99, kind: 'agent' } },
  ];
  const result = launchInSolo({
    harness: 'codex',
    manifest: { primary: { model: 'gpt-example', reasoningEffort: 'medium' } },
  }, { project }, {
    binary: '/verified/solo',
    verifyStartup: () => ({ status: 'running' }),
    launcherArgs: () => ['--model', 'gpt-example', '--approve-for-me'],
    invoke(binary, args, cwd) {
      calls.push({ binary, args, cwd });
      return { status: 0, stdout: JSON.stringify({ ok: true, data: responses.shift() }), stderr: '' };
    },
  });

  assert.equal(result.process.id, 99);
  assert.deepEqual(calls[2].args, ['projects', 'create', path.basename(canonicalProject), canonicalProject]);
  assert.deepEqual(calls[4].args, [
    'processes', 'spawn', '--project-id', '42', '--kind', 'agent',
    '--agent-tool-id', '7', '--name', 'Lenka — Orkestar',
    '--arg', '--model', '--arg', 'gpt-example', '--arg', '--approve-for-me',
  ]);
});

test('Solo launch fails clearly when the selected harness is unavailable', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'orkestar-solo-missing-'));
  const responses = [
    { ready: true },
    { projects: [{ id: 1, path: project }] },
    { agentTools: [{ id: 2, toolType: 'claude', enabled: true }] },
  ];
  assert.throws(() => launchInSolo({
    harness: 'codex', manifest: { primary: { model: 'gpt-example' } },
  }, { project }, {
    binary: '/verified/solo',
    verifyStartup: () => ({ status: 'running' }),
    launcherArgs: () => [],
    invoke() {
      return { status: 0, stdout: JSON.stringify({ ok: true, data: responses.shift() }), stderr: '' };
    },
  }), /no enabled codex agent tool/);
});

test('Solo launch reports an agent that exits during startup', () => {
  const responses = [
    { status: 'running' },
    { status: 'exited' },
    { text: 'Operation not permitted' },
  ];
  assert.throws(() => verifySoloStartup('/verified/solo', 20, 110, process.cwd(), () => ({
    status: 0,
    stdout: JSON.stringify({ ok: true, data: responses.shift() }),
    stderr: '',
  }), () => {}), /agent exited: Operation not permitted/);
});
