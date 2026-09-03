import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureCursorWorkspaceTrusted, ensureSoloReady, launchInSolo, openSolo, selectAgentTool, verifySoloStartup } from '../solo-workspace.mjs';

test('Solo selects the enabled tool matching the verified harness', () => {
  assert.equal(selectAgentTool([
    { id: 1, toolType: 'codex', enabled: false },
    { id: 2, toolType: 'claude', enabled: true },
    { id: 3, toolType: 'codex', enabled: true },
  ], 'codex').id, 3);
});

test('Solo accepts a generic Cursor tool when this Solo version cannot classify agent CLI', () => {
  assert.equal(selectAgentTool([
    { id: 13, name: 'Generic shell', command: 'sh', toolType: 'generic', enabled: true },
    { id: 14, name: 'Cursor', command: '/Users/demo/.local/bin/agent', toolType: 'generic', enabled: true },
  ], 'cursor').id, 14);
});

test('Solo launch imports the project and passes adapter-native arguments', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'orkestar-solo-'));
  const canonicalProject = fs.realpathSync(project);
  const calls = [];
  const opened = [];
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
    openSolo: (projectId) => { opened.push(projectId); return true; },
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
  assert.deepEqual(opened, [42]);
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
    openSolo: () => true,
    verifyStartup: () => ({ status: 'running' }),
    launcherArgs: () => [],
    invoke() {
      return { status: 0, stdout: JSON.stringify({ ok: true, data: responses.shift() }), stderr: '' };
    },
  }), /no enabled codex agent tool/);
});

test('Solo desktop is opened and awaited when its API is not running', () => {
  const calls = [];
  const opened = [];
  const responses = [
    { status: 1, stdout: '', stderr: 'not reachable' },
    { status: 0, stdout: JSON.stringify({ ok: true, data: { ready: false } }), stderr: '' },
    { status: 0, stdout: JSON.stringify({ ok: true, data: { ready: true } }), stderr: '' },
  ];
  const result = ensureSoloReady('/verified/solo', '/project', (binary, args) => {
    calls.push({ binary, args });
    return responses.shift();
  }, (projectId) => { opened.push(projectId); return true; }, () => {});
  assert.equal(result.ready, true);
  assert.deepEqual(opened, [null]);
  assert.equal(calls.length, 3);
});

test('macOS Solo activation opens the app or exact project URL', () => {
  const calls = [];
  const runner = (binary, args) => { calls.push({ binary, args }); return { status: 0 }; };
  assert.equal(openSolo(null, 'darwin', runner), true);
  assert.equal(openSolo(21, 'darwin', runner), true);
  assert.deepEqual(calls, [
    { binary: 'open', args: ['-a', 'Solo'] },
    { binary: 'open', args: ['solo://proj/21'] },
  ]);
});

test('Linux Solo activation uses the registered desktop URL handler', () => {
  const calls = [];
  const runner = (binary, args) => { calls.push({ binary, args }); return { status: 0 }; };
  assert.equal(openSolo(null, 'linux', runner), true);
  assert.equal(openSolo(21, 'linux', runner), true);
  assert.deepEqual(calls, [
    { binary: 'xdg-open', args: ['solo:'] },
    { binary: 'xdg-open', args: ['solo://proj/21'] },
  ]);
});

test('Cursor workspace trust is established once before Solo starts the interactive agent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orkestar-cursor-trust-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'orkestar-cursor-project-'));
  const calls = [];
  const runtime = { binary: '/verified/agent', manifest: { primary: { model: 'auto' } } };
  const runner = (binary, args, options) => {
    calls.push({ binary, args, cwd: options.cwd });
    return { status: 0, stdout: 'ORCHESTRA_CURSOR_WORKSPACE_TRUSTED\n', stderr: '' };
  };

  const first = ensureCursorWorkspaceTrusted(runtime, project, home, runner);
  const second = ensureCursorWorkspaceTrusted(runtime, project, home, runner);

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    binary: '/verified/agent',
    args: ['--print', '--trust', '--mode', 'ask', '--model', 'auto', 'Reply with exactly ORCHESTRA_CURSOR_WORKSPACE_TRUSTED. Do not use tools.'],
    cwd: project,
  });
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
