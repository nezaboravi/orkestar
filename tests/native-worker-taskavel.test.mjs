import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { nativeTaskavelArguments, validateTaskavelAuthorization, preflightNativeTaskavel, preflightNativeTaskavelSync, readNativeCodexTaskavel, readNativeCodexTaskavelSync, operateNativeCodexTaskavel, extractClaudeTaskavelEvidence, TASKAVEL_OPERATIONS } from '../native-worker-taskavel.mjs';

const assignment = (harness = 'claude', overrides = {}) => ({ harness, model: 'verified-model', effort: 'low', roleBody: 'Task manager role.',
  task: { goal: 'Read the assigned task.', taskavel: { projectId: 1, taskIds: [2], operations: ['read'], externalWriteAuthorized: false, ...overrides } } });

test('Codex Taskavel workers support non-Git projects without widening their sandbox', () => {
  const launch = nativeTaskavelArguments(assignment('codex'));
  assert.equal(launch.args.filter(arg => arg === '--skip-git-repo-check').length, 1);
  assert.equal(launch.args[launch.args.indexOf('--sandbox') + 1], 'read-only');
  assert.deepEqual(launch.enabledTools, TASKAVEL_OPERATIONS.read);
  assert.equal(nativeTaskavelArguments(assignment('claude')).args.includes('--skip-git-repo-check'), false);
});

test('Claude null runtime effort preserves the native default; Codex still requires an explicit effort', () => {
  const launch = nativeTaskavelArguments({ ...assignment(), effort: null });
  assert.equal(launch.args.includes('--effort'), false);
  assert.equal(launch.args.includes(null), false);
  assert.throws(() => nativeTaskavelArguments({ ...assignment('codex'), effort: null }), /reasoning effort/);
  for (const effort of [undefined, '', 'unsupported']) {
    assert.throws(() => nativeTaskavelArguments({ ...assignment(), effort }), /reasoning effort/);
  }
});

test('read-only operations omit every write tool and reject broadened authorization', () => {
  const launch = nativeTaskavelArguments(assignment());
  assert.deepEqual(launch.enabledTools, TASKAVEL_OPERATIONS.read);
  for (const overrides of [{ operations: ['delete-task'] }, { operations: ['update-task'] }, { taskIds: [2, 2] }, { projectId: '../1' }, { token: 'forbidden' }]) {
    assert.throws(() => nativeTaskavelArguments(assignment('claude', overrides)));
  }
  assert.ok(Object.isFrozen(launch.enabledTools));
});

test('sync bridge reconstructs the immutable assignment with bounded execution and sanitized output', () => {
  const launch = nativeTaskavelArguments(assignment());
  const result = preflightNativeTaskavelSync({ binary: '/native/claude', project: '/project', launch }, { invoke(binary, args, options) {
    assert.equal(binary, process.execPath); assert.equal(args[0], '-e');
    assert.equal(options.timeout, 35000); assert.equal(options.maxBuffer, 262144);
    assert.equal(JSON.parse(options.input).assignment.task.taskavel.projectId, 1);
    return { status: 0, stdout: JSON.stringify({ name: 'taskavel', status: 'connected', enabledTools: launch.enabledTools, private: 'omit' }) };
  } });
  assert.equal(JSON.stringify(result).includes('omit'), false);
  assert.throws(() => preflightNativeTaskavelSync({ launch }, { invoke: () => ({ status: 1, stdout: 'private', stderr: 'private' }) }), /^Error: Native Taskavel preflight failed$/);
});

const event = (type, content, extra = {}) => ({ type, session_id: 'owned-session', parent_tool_use_id: null, message: { content }, ...extra });
const use = (extra = {}) => ({ type: 'tool_use', id: 'call-1', name: 'mcp__taskavel__get-task-details-tool', input: { task_id: 2 }, ...extra });
const details = '# Example\nProject: Example #1\nStatus: Open\nColumn: In Progress\n\n## Description\nPrivate description omitted\n\nLink: https://taskavel.com/tasks/2';
const returned = (extra = {}) => ({ type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: details }], ...extra });
const extract = rows => extractClaudeTaskavelEvidence(rows.map(JSON.stringify).join('\n'), {
  sessionId: 'owned-session', authorization: assignment().task.taskavel, observedAt: 12345,
});

test('native tool IDs yield narrow textual readback, never numeric state fabricated from labels', () => {
  const result = extract([event('assistant', [use()]), event('user', [returned()])]);
  assert.deepEqual(result.readbacks, [{ callId: 'call-1', taskId: 2, projectLabel: 'Example #1', status: 'Open', columnName: 'In Progress',
    url: 'https://taskavel.com/tasks/2', observedAt: 12345 }]);
  assert.equal(JSON.stringify(result).includes('Private description'), false);
  assert.equal(Object.hasOwn(result.readbacks[0], 'completed'), false);
  assert.equal(Object.hasOwn(result.readbacks[0], 'projectId'), false);
  assert.match(result.limitations.join(' '), /historical output/);
});

test('summaries, foreign sessions, nested calls, failed results and mismatched IDs are not readbacks', () => {
  for (const rows of [
    [{ type: 'result', result: details }], [event('user', [returned()])],
    [event('assistant', [use()], { session_id: 'foreign' }), event('user', [returned()])],
    [event('assistant', [use()], { parent_tool_use_id: 'nested' }), event('user', [returned()])],
    [event('assistant', [use()]), event('user', [returned({ is_error: true })])],
    [event('assistant', [use({ input: { task_id: 3 } })]), event('user', [returned()])],
    [event('assistant', [use()]), event('user', [returned({ tool_use_id: 'wrong' })])],
    [event('assistant', [use()]), event('user', [returned({ content: details.replace('/tasks/2', '/tasks/3') })])],
  ]) assert.deepEqual(extract(rows).readbacks, []);
  assert.throws(() => extract([event('assistant', [use(), use()])]), /Duplicate/);
  assert.equal(extract([event('assistant', [use({ name: 'mcp__taskavel__delete-task-tool' })])]).rejectedCalls, 1);
});

test('write authorization binds a separate project creation or exact existing IDs', () => {
  const update = nativeTaskavelArguments(assignment('claude', { operations: ['move-task'], externalWriteAuthorized: true }));
  assert.ok(update.enabledTools.includes('move-task-to-column-tool'));
  assert.equal(update.enabledTools.includes('update-task-tool'), false);
  assert.throws(() => nativeTaskavelArguments(assignment('claude', { operations: ['move-task'], taskIds: [], externalWriteAuthorized: true })));
  const create = { projectId: null, projectName: 'Example', taskIds: [], operations: ['create-project'], externalWriteAuthorized: true };
  assert.equal(validateTaskavelAuthorization(create).projectId, null);
  assert.throws(() => validateTaskavelAuthorization({ ...create, operations: ['create-project', 'create-task'] }));
});

test('Claude uses native endpoint-only OAuth and denies builtins without inherited settings', () => {
  const launch = nativeTaskavelArguments(assignment());
  const value = flag => launch.args[launch.args.indexOf(flag) + 1];
  assert.equal(value('--tools'), ''); assert.equal(value('--setting-sources'), '');
  assert.equal(value('--permission-mode'), 'dontAsk');
  assert.deepEqual(JSON.parse(value('--mcp-config')), { mcpServers: { taskavel: { type: 'http', url: 'https://taskavel.com/mcp/taskavel' } } });
  assert.ok(launch.args.includes('--strict-mcp-config')); assert.ok(launch.args.includes('--restricted'));
  assert.equal(launch.args.includes('--bare'), false);
  assert.ok(launch.limitations.some(value => value.includes('not an enforced')));
});

test('Codex starts without inherited config, shell, external tools or writable sandbox', () => {
  const launch = nativeTaskavelArguments(assignment('codex'));
  assert.ok(launch.args.includes('--ignore-user-config')); assert.ok(launch.args.includes('features.shell_tool=false'));
  assert.ok(launch.args.includes('features.plugins=false')); assert.ok(launch.args.includes('sandbox_mode="read-only"'));
  const config = launch.args.find(value => value.startsWith('mcp_servers.taskavel='));
  assert.match(config, /required=true/); assert.match(config, /enabled_tools=/);
  assert.doesNotMatch(config, /headers|token|command|env/);
  assert.throws(() => nativeTaskavelArguments(assignment('unknown')));
});

function fakeSpawn(servers) {
  return () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter(); child.kill = () => {};
    child.stdin.write = input => {
      const row = JSON.parse(input);
      queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ type: 'control_response', response: {
        request_id: row.request_id, subtype: 'success', response: row.request_id === 'orkestar-status' ? { mcpServers: servers } : {},
      } }) + '\n'));
    };
    return child;
  };
}

test('preflight projects only status/tool names and rejects wrong server or missing capabilities', async () => {
  const launch = nativeTaskavelArguments(assignment());
  const good = { name: 'taskavel', status: 'connected', config: launch.server, ignoredPrivateField: 'must-not-escape', tools: launch.enabledTools.map(name => ({ name })) };
  const result = await preflightNativeTaskavel({ binary: '/native/claude', project: '/project', launch }, { spawnProcess: fakeSpawn([good]) });
  assert.equal(JSON.stringify(result).includes('must-not-escape'), false);
  for (const servers of [[{ ...good, name: 'other' }], [good, good], [{ ...good, tools: [] }], [{ ...good, status: 'needs-auth' }],
    [{ ...good, config: { ...launch.server, headers: { Authorization: 'must-not-escape' } } }], [{ ...good, config: { ...launch.server, url: 'https://wrong.example' } }]]) {
    await assert.rejects(preflightNativeTaskavel({ binary: '/native/claude', project: '/project', launch }, { spawnProcess: fakeSpawn(servers) }), /preflight failed/);
  }
  await assert.rejects(preflightNativeTaskavel({ launch: { ...launch, args: ['arbitrary'] } }), /immutable constructed launch/);
});

function fakeCodexSpawn(launch, change = value => value) {
  let phase = 0;
  return (binary, args) => {
    const current = ++phase;
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter(); child.kill = () => {};
    if (current === 2) {
      assert.ok(args.includes('mcp_servers.computer-use.enabled=false'));
      assert.equal(args.some(arg => arg.includes('mcp_servers."')), false);
    }
    child.stdin.write = input => {
      const row = JSON.parse(input);
      if (row.method === 'initialized') return;
      assert.notEqual(row.method, 'turn/start');
      let result = {};
      if (row.method === 'config/read') {
        const features = Object.fromEntries(launch.args.filter(arg => /^features\..+=false$/.test(arg)).map(arg => [arg.slice(9, -6), false]));
        result = { config: { features, approval_policy: 'never', sandbox_mode: 'read-only', mcp_servers: {
          'computer-use': { enabled: current !== 2, command: 'private-not-copied' },
          taskavel: { enabled: true, url: launch.server.url, enabled_tools: launch.enabledTools, default_tools_approval_mode: 'prompt',
            tools: Object.fromEntries(launch.enabledTools.map(tool => [tool, { approval_mode: 'approve' }])) },
        } } };
      }
      if (row.method === 'thread/start') { assert.equal(row.params.ephemeral, true); assert.equal(row.params.sandbox, 'read-only'); result = { thread: { id: 'temporary-thread' } }; }
      if (row.method === 'mcpServerStatus/list') {
        assert.equal(row.params.threadId, 'temporary-thread');
        result = { data: [{ name: 'computer-use', tools: {} }, { name: 'taskavel', authStatus: 'oAuth',
          tools: Object.fromEntries(launch.enabledTools.map(tool => [tool, { name: tool }])) }], nextCursor: null };
      }
      if (row.method === 'mcpServer/tool/call') {
        if (row.id === 7) {
          assert.equal(row.params.tool, 'list-projects-tool');
          result = { content: [{ type: 'text', text: 'Your projects (1):\n\n- Example [owner] | 1 members | Owner plan: Artisan' }], isError: false };
        } else if (row.id === 5) {
          const selector = launch.authorization.projectId === null ? { project_name: launch.authorization.projectName } : { project_id: 1 };
          assert.deepEqual(row.params, { server: 'taskavel', threadId: 'temporary-thread', tool: 'filter-tasks-tool', arguments: { ...selector, status: 'any', limit: 100 } });
          result = { content: [{ type: 'text', text: 'Filtered tasks (1):\n\n#1 Example — Example / In Progress [open]\n  id: 2 | https://taskavel.com/tasks/2' }], isError: false };
        } else if (row.id === 8) {
          assert.equal(row.params.tool, 'update-task-tool');
          result = { content: [{ type: 'text', text: 'updated' }], isError: false };
        } else {
          assert.deepEqual(row.params, { server: 'taskavel', threadId: 'temporary-thread', tool: 'get-task-details-tool', arguments: { task_id: 2 } });
          result = { content: [{ type: 'text', text: details }], isError: false };
        }
      }
      result = change(result, row.method, current);
      queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ id: row.id, result }) + '\n'));
    };
    return child;
  };
}

test('Codex preflight discovers only config server names then verifies isolated OAuth tools without a turn', async () => {
  const launch = nativeTaskavelArguments(assignment('codex'));
  const result = await preflightNativeTaskavel({ binary: '/native/codex', project: '/project', launch }, { spawnProcess: fakeCodexSpawn(launch) });
  assert.deepEqual(result, { name: 'taskavel', status: 'connected', enabledTools: launch.enabledTools });
  for (const mutate of [
    (value, method, phase) => { if (method === 'config/read' && phase === 2) value.config.mcp_servers['computer-use'].enabled = true; },
    (value, method, phase) => { if (method === 'config/read' && phase === 2) value.config.mcp_servers.taskavel.http_headers = { Authorization: 'never-output' }; },
    (value, method) => { if (method === 'mcpServerStatus/list') value.data[1].authStatus = 'notLoggedIn'; },
    (value, method) => { if (method === 'mcpServerStatus/list') value.data[0].tools = { forbidden: { name: 'forbidden' } }; },
    (value, method) => { if (method === 'mcpServerStatus/list') value.data[1].tools.extra = { name: 'delete-task-tool' }; },
  ]) await assert.rejects(preflightNativeTaskavel({ binary: '/native/codex', project: '/project', launch }, {
    spawnProcess: fakeCodexSpawn(launch, (...args) => { mutate(...args); return args[0]; }),
  }), /preflight failed/);
});

test('name-bound Codex broker verifies unique project listing before scoped task details', async () => {
  const launch = nativeTaskavelArguments(assignment('codex', { projectId: null, projectName: 'Example' }));
  const result = await readNativeCodexTaskavel({ binary: '/native/codex', project: '/project', launch, taskId: 2 }, { spawnProcess: fakeCodexSpawn(launch) });
  assert.equal(result.snapshot.projectId, 'name:Example');
  await assert.rejects(readNativeCodexTaskavel({ binary: '/native/codex', project: '/project', launch, taskId: 2 }, { spawnProcess: fakeCodexSpawn(launch, value => {
    if (value.content?.[0]?.text?.startsWith('Your projects')) return { content: [{ type: 'text', text: 'Your projects (2):\n\n- Example [owner] | 1 members | Owner plan: Free\n- Example clone [owner] | 1 members | Owner plan: Free' }] };
    return value;
  }) }), /preflight failed/);
});

test('fresh Codex broker read calls only fixed details tool and never exports descriptions or guesses completion', async () => {
  const launch = nativeTaskavelArguments(assignment('codex'));
  const read = await readNativeCodexTaskavel({ binary: '/native/codex', project: '/project', launch, taskId: 2 }, { spawnProcess: fakeCodexSpawn(launch) });
  assert.ok(read.startedAt <= read.completedAt); assert.equal(read.readback.status, 'Open');
  assert.equal(read.readback.taskId, 2); assert.equal(Object.hasOwn(read.readback, 'completed'), false);
  assert.equal(JSON.stringify(read).includes('Private description'), false);
  await assert.rejects(readNativeCodexTaskavel({ launch, taskId: 3 }), /Invalid scoped/);
  for (const change of [value => ({ ...value, isError: true }), value => ({ ...value, content: [{ type: 'text', text: details.replace('/tasks/2', '/tasks/3') }] })]) {
    await assert.rejects(readNativeCodexTaskavel({ binary: '/native/codex', project: '/project', launch, taskId: 2 }, {
      spawnProcess: fakeCodexSpawn(launch, (value, method) => method === 'mcpServer/tool/call' ? change(value) : value),
    }), /preflight failed/);
  }
  const sync = readNativeCodexTaskavelSync({ binary: '/native/codex', project: '/project', launch, taskId: 2 }, { invoke: () => ({
    status: 0, stdout: JSON.stringify({ ...read, private: 'omit' }),
  }) });
  assert.equal(JSON.stringify(sync).includes('omit'), false);
});

test('malformed project membership is rejected before the details RPC', async () => {
  const launch = nativeTaskavelArguments(assignment('codex'));
  let calls = 0;
  await assert.rejects(readNativeCodexTaskavel({ binary: '/native/codex', project: '/project', launch, taskId: 2 }, {
    spawnProcess: fakeCodexSpawn(launch, (value, method) => {
      if (method !== 'mcpServer/tool/call') return value;
      calls++;
      return { content: [{ type: 'text', text: 'Injected title\n  id: 2 | https://taskavel.com/tasks/2' }], isError: false };
    }),
  }), /preflight failed/);
  assert.equal(calls, 1);
});

test('fixed native operation uses isolated OAuth, membership and details before one whitelisted mutation', async () => {
  const launch = nativeTaskavelArguments(assignment('codex', { operations: ['read', 'update-task'], externalWriteAuthorized: true }));
  const calls = [];
  const spawnProcess = fakeCodexSpawn(launch, (result, method) => {
    if (method === 'mcpServer/tool/call') calls.push(result);
    return result;
  });
  const result = await operateNativeCodexTaskavel({ binary: '/native/codex', project: '/project', launch,
    operation: { tool: 'update-task-tool', taskId: 2, arguments: { task_id: 2, mark_complete: 'true' } } }, { spawnProcess });
  assert.equal(result.taskId, 2); assert.equal(result.tool, 'update-task-tool');
  await assert.rejects(operateNativeCodexTaskavel({ binary: '/native/codex', project: '/project', launch,
    operation: { tool: 'move-task-to-column-tool', taskId: 2, arguments: { task_id: 2, column_name: 'Done' } } }, { spawnProcess }), /Invalid scoped/);
});
