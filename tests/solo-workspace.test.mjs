import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureCursorWorkspaceTrusted, ensureSoloReady, launchInSolo, matchesSoloRuntime, openSolo, selectAgentTool, soloProcessName, verifySoloStartup } from '../solo-workspace.mjs';

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
    { processes: [] },
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
  assert.deepEqual(calls[5].args, [
    'processes', 'spawn', '--project-id', '42', '--kind', 'agent',
    '--agent-tool-id', '7', '--name', 'Lenka — Codex',
    '--arg', '--model', '--arg', 'gpt-example', '--arg', '--approve-for-me',
  ]);
  assert.deepEqual(opened, [42]);
});

test('Solo process names identify the selected AI service', () => {
  assert.equal(soloProcessName('cursor'), 'Lenka — Cursor Agent');
  assert.equal(soloProcessName('codex'), 'Lenka — Codex');
});

test('Solo reuses an already running matching Lenka process', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'orkestar-solo-reuse-'));
  const opened = [];
  const calls = [];
  const responses = [
    { ready: true },
    { projects: [{ id: 42, name: 'demo', path: project }] },
    { processes: [{ id: 99, name: 'Lenka — Cursor Agent', kind: 'agent', command: '/verified/agent --model auto --force', status: 'running' }] },
  ];
  const runtime = { harness: 'cursor', binary: '/verified/agent', manifest: { primary: { model: 'auto' } } };
  const result = launchInSolo(runtime, { project }, {
    binary: '/verified/solo',
    openSolo: (projectId) => { opened.push(projectId); return true; },
    ensureCursorTrust: () => ({ reused: true }),
    launcherArgs: () => ['--model', 'auto'],
    invoke(binary, args) {
      calls.push(args);
      return { status: 0, stdout: JSON.stringify({ ok: true, data: responses.shift() }), stderr: '' };
    },
  });
  assert.equal(result.process.id, 99);
  assert.equal(result.reused, true);
  assert.deepEqual(opened, [42]);
  assert.equal(calls.some((args) => args.includes('spawn')), false);
});

test('Solo renames and restarts the newest stopped legacy Lenka process', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'orkestar-solo-restart-'));
  const calls = [];
  const responses = [
    { ready: true },
    { projects: [{ id: 42, name: 'demo', path: project }] },
    { processes: [{ id: 99, name: 'Lenka — Orkestar', kind: 'agent', command: '/verified/agent --model auto --force', status: 'stopped' }] },
    { process: { id: 99, name: 'Lenka — Cursor Agent', status: 'stopped' } },
    { process: { id: 99, status: 'starting' } },
  ];
  const runtime = { harness: 'cursor', binary: '/verified/agent', manifest: { primary: { model: 'auto' } } };
  const result = launchInSolo(runtime, { project }, {
    binary: '/verified/solo',
    openSolo: () => true,
    ensureCursorTrust: () => ({ reused: true }),
    launcherArgs: () => ['--model', 'auto'],
    verifyStartup: () => ({ id: 99, status: 'running' }),
    invoke(binary, args) {
      calls.push(args);
      return { status: 0, stdout: JSON.stringify({ ok: true, data: responses.shift() }), stderr: '' };
    },
  });
  assert.equal(result.process.id, 99);
  assert.equal(result.process.name, 'Lenka — Cursor Agent');
  assert.equal(result.reused, true);
  assert.deepEqual(calls[3], ['processes', 'rename', '99', 'Lenka — Cursor Agent']);
  assert.deepEqual(calls[4], ['processes', 'start', '99']);
  assert.equal(calls.some((args) => args.includes('spawn')), false);
});

test('Solo runtime matching requires the same harness name, binary, and model', () => {
  const runtime = { harness: 'cursor', binary: '/verified/agent', manifest: { primary: { model: 'auto' } } };
  assert.equal(matchesSoloRuntime({
    kind: 'agent', name: 'Lenka — Cursor Agent', command: '/verified/agent --model auto',
  }, runtime), true);
  assert.equal(matchesSoloRuntime({
    kind: 'agent', name: 'Lenka — Codex', command: '/verified/agent --model auto',
  }, runtime), false);
  assert.equal(matchesSoloRuntime({
    kind: 'agent', name: 'Lenka — Orkestar', command: '/verified/agent --model auto',
  }, runtime), true);
});

test('Solo launch fails clearly when the selected harness is unavailable', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'orkestar-solo-missing-'));
  const responses = [
    { ready: true },
    { projects: [{ id: 1, path: project }] },
    { processes: [] },
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
