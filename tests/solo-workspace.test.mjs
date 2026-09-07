import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const readableTool = { id: 99, name: 'Orkestar Worker', toolType: 'generic', enabled: true, command: process.execPath };

import { configureSoloMcp, ensureCursorWorkspaceTrusted, ensureSoloReady, launchInSolo, matchesSoloRuntime, openSolo, selectAgentTool, soloProcessName, verifySoloMcpReady, verifySoloStartup } from '../solo-workspace.mjs';

test('Solo selects the enabled tool matching the verified harness', () => {
  assert.equal(selectAgentTool([
    { id: 1, toolType: 'codex', enabled: false },
    { id: 2, toolType: 'claude', enabled: true },
    { id: 3, toolType: 'codex', enabled: true },
    readableTool,
  ], 'codex').id, 99);
});

test('Every harness uses the checked generic tool, never built-in defaults', () => {
  for (const harness of ['codex', 'claude', 'cursor', 'opencode', 'kimi']) {
    assert.equal(selectAgentTool([readableTool,
      { id: 14, name: harness, command: `${harness} --dangerous`, toolType: harness, enabled: true },
    ], harness).id, 99);
    assert.throws(() => selectAgentTool([], harness), /one-time setup/);
  }
});

test('Solo MCP is merged into OpenCode without replacing existing servers', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orkestar-solo-mcp-'));
  const target = path.join(home, '.config', 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ mcp: { existing: { type: 'remote', url: 'https://example.test/mcp' } } })}\n`);

  const first = configureSoloMcp('opencode', '/verified/opencode', '/verified/solo-mcp', { home });
  const second = configureSoloMcp('opencode', '/verified/opencode', '/verified/solo-mcp', { home });
  const config = JSON.parse(fs.readFileSync(target, 'utf8'));

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(config.mcp.existing.url, 'https://example.test/mcp');
  assert.deepEqual(config.mcp.solo, { type: 'local', command: ['/verified/solo-mcp'], enabled: true });
});

test('Solo MCP uses Codex native JSON configuration to verify the exact enabled server', () => {
  const calls = [];
  const runner = (binary, args) => {
    calls.push({ binary, args });
    return calls.length === 1
      ? { status: 1, stdout: '', stderr: "Error: No MCP server named 'solo' found." }
      : { status: 0, stdout: 'Added solo', stderr: '' };
  };
  const result = configureSoloMcp('codex', '/verified/codex', '/verified/solo-mcp', { runner });
  assert.equal(result.changed, true);
  assert.deepEqual(calls, [
    { binary: '/verified/codex', args: ['mcp', 'get', 'solo', '--json'] },
    { binary: '/verified/codex', args: ['mcp', 'add', 'solo', '--', '/verified/solo-mcp'] },
  ]);
});

test('Solo MCP accepts an existing Codex server only when it is enabled and points to this helper', () => {
  const calls = [];
  const result = configureSoloMcp('codex', '/verified/codex', '/verified/solo-mcp', {
    runner(binary, args) {
      calls.push({ binary, args });
      return {
        status: 0,
        stdout: JSON.stringify({
          name: 'solo',
          enabled: true,
          transport: { type: 'stdio', command: '/verified/solo-mcp', args: [] },
        }),
        stderr: '',
      };
    },
  });
  assert.equal(result.changed, false);
  assert.deepEqual(calls, [{ binary: '/verified/codex', args: ['mcp', 'get', 'solo', '--json'] }]);
});

test('Solo MCP refuses disabled or stale Codex server configuration', () => {
  for (const server of [
    { enabled: false, transport: { type: 'stdio', command: '/verified/solo-mcp', args: [] } },
    { enabled: true, transport: { type: 'stdio', command: '/stale/solo-mcp', args: [] } },
  ]) {
    assert.throws(() => configureSoloMcp('codex', '/verified/codex', '/verified/solo-mcp', {
      runner: () => ({ status: 0, stdout: JSON.stringify(server), stderr: '' }),
    }), /disabled or points to a different command/);
  }
});

test('Solo MCP fails clearly when Codex configuration cannot be read', () => {
  assert.throws(() => configureSoloMcp('codex', '/verified/codex', '/verified/solo-mcp', {
    runner: () => ({ status: 1, stdout: '', stderr: 'permission denied' }),
  }), /could not be verified: permission denied/);
});

test('Solo MCP does not add Claude registration when native details confirm the exact connected helper', () => {
  const calls = [];
  const result = configureSoloMcp('claude', '/verified/claude', '/verified/solo-mcp', {
    runner(binary, args) {
      calls.push({ binary, args });
      return {
        status: 0,
        stdout: 'solo:\n  Scope: User config\n  Status: ✔ Connected\n  Type: stdio\n  Command: /verified/solo-mcp\n  Args:\n  Environment:\n',
        stderr: '',
      };
    },
  });
  assert.equal(result.changed, false);
  assert.deepEqual(calls, [{ binary: '/verified/claude', args: ['mcp', 'get', 'solo'] }]);
});

test('Solo MCP refuses unavailable, disabled, or stale Claude registration', () => {
  for (const output of [
    'solo:\n  Status: ⏸ Pending approval\n  Type: stdio\n  Command: /verified/solo-mcp\n  Args:\n',
    'solo:\n  Status: ✔ Connected\n  Type: stdio\n  Command: /stale/solo-mcp\n  Args:\n',
  ]) {
    assert.throws(() => configureSoloMcp('claude', '/verified/claude', '/verified/solo-mcp', {
      runner: () => ({ status: 0, stdout: output, stderr: '' }),
    }), /unavailable, disabled, or points to a different command/);
  }
});

test('Solo MCP adds Claude registration only when native lookup proves it is absent', () => {
  const calls = [];
  const result = configureSoloMcp('claude', '/verified/claude', '/verified/solo-mcp', {
    runner(binary, args) {
      calls.push({ binary, args });
      return calls.length === 1
        ? { status: 1, stdout: '', stderr: 'No MCP server named "solo".' }
        : { status: 0, stdout: 'Added solo', stderr: '' };
    },
  });
  assert.equal(result.changed, true);
  assert.deepEqual(calls, [
    { binary: '/verified/claude', args: ['mcp', 'get', 'solo'] },
    { binary: '/verified/claude', args: ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'solo', '--', '/verified/solo-mcp'] },
  ]);
});

test('Solo MCP rejects Kimi because this installed CLI cannot verify a registration', () => {
  assert.throws(() => configureSoloMcp('kimi', '/verified/kimi', '/verified/solo-mcp', {
    runner: () => { throw new Error('must not execute'); },
  }), /cannot verify an existing Solo MCP registration/);
});

test('Solo MCP preflight accepts a real initialize response', () => {
  const result = verifySoloMcpReady('/verified/mcp', {
    runner: () => ({
      status: 0,
      stdout: `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'solo' } } })}\n`,
      stderr: '',
    }),
  });
  assert.equal(result.serverInfo.name, 'solo');
});

test('Solo MCP preflight gives the exact one-time recovery step when disabled', () => {
  assert.throws(() => verifySoloMcpReady('/verified/mcp', {
    runner: () => ({ status: 1, stdout: '', stderr: 'socket unavailable' }),
  }), /Solo Settings → MCP, turn on MCP server/);
});

test('Solo Codex launch imports the project and always uses the native interactive conductor', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'orkestar-solo-'));
  const canonicalProject = fs.realpathSync(project);
  const calls = [];
  const opened = [];
  const responses = [
    { ready: true },
    { projects: [] },
    { project: { id: 42, name: 'demo', path: canonicalProject } },
    { processes: [] },
    { agentTools: [readableTool, { id: 7, name: 'Codex', toolType: 'codex', enabled: true }] },
    { process: { id: 99, kind: 'agent' } },
  ];
  const result = launchInSolo({
    harness: 'codex',
    manifest: { primary: { model: 'gpt-example', reasoningEffort: 'medium' } },
  }, { project }, {
    binary: '/verified/solo',
    soloMcp: '/verified/mcp',
    verifyMcp: () => true,
    configureMcp: () => ({ changed: false, target: 'test' }),
    openSolo: (projectId) => { opened.push(projectId); return true; },
    verifyStartup: () => ({ status: 'running' }),
    launcherArgs: () => { throw new Error('Codex must not use legacy launcher arguments'); },
    conductorArgs: (runtime, cwd) => {
      assert.equal(cwd, canonicalProject);
      assert.equal(runtime.manifest.primary.model, 'gpt-example');
      return ['/installed/native-interactive-launcher.mjs', '--model', 'gpt-example', `ORKESTAR_NATIVE_UI_${'b'.repeat(64)}`];
    },
    invoke(binary, args, cwd) {
      calls.push({ binary, args, cwd });
      return { status: 0, stdout: JSON.stringify({ ok: true, data: responses.shift() }), stderr: '' };
    },
  });

  assert.equal(result.process.id, 99);
  assert.deepEqual(calls[2].args, ['projects', 'create', path.basename(canonicalProject), canonicalProject]);
  assert.deepEqual(calls[5].args, [
    'processes', 'spawn', '--project-id', '42', '--kind', 'agent',
    '--agent-tool-id', '99', '--name', 'Lenka — Codex · Solo team',
    '--arg', '/installed/native-interactive-launcher.mjs', '--arg', '--model', '--arg', 'gpt-example',
    '--arg', `ORKESTAR_NATIVE_UI_${'b'.repeat(64)}`,
  ]);
  assert.deepEqual(opened, [42]);
});

test('Solo process names identify the selected AI service', () => {
  assert.equal(soloProcessName('cursor'), 'Lenka — Cursor Agent · Solo team');
  assert.equal(soloProcessName('codex'), 'Lenka — Codex · Solo team');
});

test('Kimi native editor launch does not pretend to configure an unsupported Solo MCP bridge', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-kimi-ui-'));
  const responses = [{ ready: true }, { projects: [{ id: 42, path: project }] },
    { processes: [] }, { agentTools: [readableTool] }, { process: { id: 19, name: soloProcessName('kimi') } }];
  const calls = [];
  const result = launchInSolo({ harness: 'kimi', binary: '/verified/kimi', manifest: { primary: { model: 'fixture' } } }, { project }, {
    binary: '/verified/solo', soloMcp: null, openSolo: () => true,
    verifyMcp: () => { throw new Error('Kimi cannot verify Solo MCP'); },
    configureMcp: () => { throw new Error('Kimi cannot configure Solo MCP'); },
    conductorArgs: () => ['--model', 'fixture', `ORKESTAR_NATIVE_UI_${'a'.repeat(64)}`],
    verifyStartup: () => ({ status: 'running' }),
    invoke(binary, args) { calls.push(args); return { status: 0, stdout: JSON.stringify({ ok: true, data: responses.shift() }) }; },
  });
  assert.equal(result.process.id, 19);
  assert.equal(result.mcp.available, false);
  assert.match(result.mcp.warning, /native editor only/);
  assert.ok(calls.at(-1).includes('spawn'));
  assert.ok(calls.at(-1).includes(String(readableTool.id)));
});

test('Solo reuses an already running matching Lenka process', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'orkestar-solo-reuse-'));
  const opened = [];
  const calls = [];
  const responses = [
    { ready: true },
    { projects: [{ id: 42, name: 'demo', path: project }] },
    { processes: [{ id: 99, projectId: 42, name: 'Lenka — Cursor Agent · Solo team', kind: 'agent', command: `${readableTool.command} --model auto ORKESTAR_NATIVE_UI_${'a'.repeat(64)}`, status: 'running' }] },
    { agentTools: [readableTool] },
  ];
  const runtime = { harness: 'cursor', binary: '/verified/agent', manifest: { primary: { model: 'auto' } } };
  const result = launchInSolo(runtime, { project }, {
    binary: '/verified/solo',
    soloMcp: '/verified/mcp',
    verifyMcp: () => true,
    configureMcp: () => ({ changed: false, target: 'test' }),
    openSolo: (projectId) => { opened.push(projectId); return true; },
    ensureCursorTrust: () => ({ reused: true }),
    conductorArgs: () => ['--model', 'auto', `ORKESTAR_NATIVE_UI_${'a'.repeat(64)}`],
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

test('Solo renames and restarts a stopped process only with current native identity', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'orkestar-solo-restart-'));
  const calls = [];
  const responses = [
    { ready: true },
    { projects: [{ id: 42, name: 'demo', path: project }] },
    { processes: [{ id: 99, projectId: 42, name: 'Lenka — Orkestar', kind: 'agent', command: `${readableTool.command} --model auto ORKESTAR_NATIVE_UI_${'a'.repeat(64)}`, status: 'stopped' }] },
    { agentTools: [readableTool] },
    { process: { id: 99, name: 'Lenka — Cursor Agent · Solo team', status: 'stopped' } },
    { process: { id: 99, status: 'starting' } },
  ];
  const runtime = { harness: 'cursor', binary: '/verified/agent', manifest: { primary: { model: 'auto' } } };
  const result = launchInSolo(runtime, { project }, {
    binary: '/verified/solo',
    soloMcp: '/verified/mcp',
    verifyMcp: () => true,
    configureMcp: () => ({ changed: false, target: 'test' }),
    openSolo: () => true,
    ensureCursorTrust: () => ({ reused: true }),
    conductorArgs: () => ['--model', 'auto', `ORKESTAR_NATIVE_UI_${'a'.repeat(64)}`],
    verifyStartup: () => ({ id: 99, status: 'running' }),
    invoke(binary, args) {
      calls.push(args);
      return { status: 0, stdout: JSON.stringify({ ok: true, data: responses.shift() }), stderr: '' };
    },
  });
  assert.equal(result.process.id, 99);
  assert.equal(result.process.name, 'Lenka — Cursor Agent · Solo team');
  assert.equal(result.reused, true);
  assert.deepEqual(calls[4], ['processes', 'rename', '99', 'Lenka — Cursor Agent · Solo team']);
  assert.deepEqual(calls[5], ['processes', 'start', '99']);
  assert.equal(calls.some((args) => args.includes('spawn')), false);
});

test('Solo runtime matching requires the same harness name, binary, and model', () => {
  const runtime = { harness: 'cursor', binary: '/verified/agent', manifest: { primary: { model: 'auto' } } };
  assert.equal(matchesSoloRuntime({
    kind: 'agent', name: 'Lenka — Cursor Agent · Solo team', command: '/verified/agent --model auto',
  }, runtime), true);
  assert.equal(matchesSoloRuntime({
    kind: 'agent', name: 'Lenka — Codex', command: '/verified/agent --model auto',
  }, runtime), false);
  assert.equal(matchesSoloRuntime({
    kind: 'agent', name: 'Lenka — Orkestar', command: '/verified/agent --model auto',
  }, runtime), true);
  assert.equal(matchesSoloRuntime({
    kind: 'agent', name: 'Lenka — Cursor Agent', command: '/verified/agent --model auto',
  }, runtime), true);
  assert.equal(matchesSoloRuntime({
    kind: 'agent', name: 'Lenka — Codex', command: '/verified/agent --model auto',
  }, runtime), false);
});

test('Solo runtime matching accepts prior names for its selected harness', () => {
  const runtime = { harness: 'codex', binary: '/verified/codex', manifest: { primary: { model: 'gpt-example' } } };
  assert.equal(matchesSoloRuntime({
    kind: 'agent', name: 'Lenka — Codex', command: '/verified/codex --model gpt-example',
  }, runtime), true);
});

test('Solo matches its selected native command instead of a different PATH installation', () => {
  const runtime = { harness: 'codex', binary: '/local/bin/codex', manifest: { primary: { model: 'gpt-example' } } };
  const tool = { id: 4, toolType: 'codex', enabled: true, command: '/Applications/Example.app/Contents/Resources/codex' };
  const process = { id: 166, projectId: 30, kind: 'agent', name: soloProcessName('codex'),
    command: `${tool.command} --model gpt-example --approve-for-me`, status: 'exited' };
  assert.equal(matchesSoloRuntime(process, runtime, process.name, tool, 30), true);
  for (const changed of [
    { projectId: 31 }, { command: `${tool.command} --model gpt-example-other` },
    { command: `/evil/codex --model gpt-example --note '${tool.command}'` },
    { command: `${tool.command}-spoof --model gpt-example` },
    { command: `${tool.command} --model gpt-example --model different` },
  ]) assert.equal(matchesSoloRuntime({ ...process, ...changed }, runtime, process.name, tool, 30), false);
  assert.equal(matchesSoloRuntime(process, runtime, process.name, { ...tool, toolType: 'claude' }, 30), false);
});

test('Solo restarts an exited Codex conductor bound to its distinct bundled binary', () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'solo-native-restart-')));
  const tool = readableTool;
  const marker = `ORKESTAR_NATIVE_UI_${'a'.repeat(64)}`;
  const existing = { id: 166, projectId: 30, name: soloProcessName('codex'), kind: 'agent', status: 'exited', command: `${tool.command} --model gpt-example ${marker}` };
  const responses = [{ ready: true }, { projects: [{ id: 30, path: project }] }, { processes: [existing] },
    { agentTools: [tool] }, { process: { ...existing, status: 'starting' } }];
  const calls = [];
  const result = launchInSolo({ harness: 'codex', binary: '/different/path/codex', manifest: { primary: { model: 'gpt-example' } } }, { project }, {
    binary: '/verified/solo', soloMcp: '/verified/mcp', verifyMcp: () => true, configureMcp: () => ({}), openSolo: () => true,
    conductorArgs: () => ['--model', 'gpt-example', marker], verifyStartup: () => ({ status: 'running' }),
    invoke(binary, args) { calls.push(args); return { status: 0, stdout: JSON.stringify({ ok: true, data: responses.shift() }) }; },
  });
  assert.equal(result.reused, true); assert.equal(result.process.id, 166);
  assert.deepEqual(calls.at(-1), ['processes', 'start', '166']);
  assert.equal(calls.some(args => args.includes('spawn')), false);
});

test('Solo never reuses any harness legacy process or silently stops it', () => {
  for (const harness of ['codex', 'claude', 'cursor', 'opencode', 'kimi']) {
  for (const status of ['running', 'stopped']) {
    const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'solo-stale-conductor-')));
    const tool = readableTool;
    const existing = { id: 166, projectId: 30, name: soloProcessName(harness), kind: 'agent', status,
      command: `/old/native/${harness} --model old-model --enable multi_agent` };
    const marker = `ORKESTAR_NATIVE_UI_${'a'.repeat(64)}`;
    const responses = [{ ready: true }, { projects: [{ id: 30, path: project }] }, { processes: [existing] },
      { agentTools: [tool] }, { process: { id: 167, kind: 'agent', status: 'running' } }];
    const calls = [];
    const run = () => launchInSolo({ harness, binary: `/verified/${harness}`,
      manifest: { primary: { model: 'gpt-example' } } }, { project }, {
      binary: '/verified/solo', soloMcp: '/verified/mcp', verifyMcp: () => true,
      configureMcp: () => ({}), ensureCursorTrust: () => ({}), openSolo: () => true, verifyStartup: () => ({ status: 'running' }),
      conductorArgs: () => ['--model', 'gpt-example', marker],
      invoke(binary, args) { calls.push(args); return { status: 0, stdout: JSON.stringify({ ok: true, data: responses.shift() }) }; },
    });
    if (status === 'running') {
      assert.throws(run, /older Lenka session is still running/);
      assert.equal(calls.some(args => args.includes('spawn')), false);
    } else {
      const result = run();
      assert.equal(result.reused, false);
      assert.equal(result.process.id, 167);
      assert.equal(calls.some(args => args.includes('spawn')), true);
    }
    assert.equal(calls.some(args => args.includes('stop') || args.includes('start') || args.includes('delete')), false);
  }
  }
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
    soloMcp: '/verified/mcp',
    verifyMcp: () => true,
    configureMcp: () => ({ changed: false, target: 'test' }),
    openSolo: () => true,
    verifyStartup: () => ({ status: 'running' }),
    launcherArgs: () => [],
    invoke() {
      return { status: 0, stdout: JSON.stringify({ ok: true, data: responses.shift() }), stderr: '' };
    },
  }), /Readable Solo workers need one-time setup/);
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
