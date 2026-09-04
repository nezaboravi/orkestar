import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, mkdir, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeNativeHook } from '../native-observer.mjs';

async function fixture(harness = 'codex') {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'orchestra-observer-')));
  const path = join(project, 'root.jsonl');
  const rows = harness === 'codex' ? [{ type: 'session_meta', payload: { id: 'root', cwd: project, source: 'cli' } }]
    : [{ type: 'user', sessionId: 'root', cwd: project }];
  await writeFile(path, rows.map(JSON.stringify).join('\n') + '\n');
  const event = { hook_event_name: 'SessionStart', session_id: 'root', cwd: project, transcript_path: path };
  return { project, harness, event };
}

test('both native hook paths persist metadata, preserve acceptance and remain PARTIAL', async () => {
  for (const harness of ['codex', 'claude']) {
    const f = await fixture(harness);
    await mkdir(join(f.project, '.agent-orchestra', 'runs'), { recursive: true });
    const acceptance = join(f.project, '.agent-orchestra', 'runs', 'latest.json');
    await writeFile(acceptance, 'existing acceptance');
    let audit = await observeNativeHook(f);
    assert.equal(audit.state, 'running');
    assert.equal(audit.totals.tokens, null);
    audit = await observeNativeHook({ ...f, event: { ...f.event, hook_event_name: 'Stop', secret: 'NEVER-SAVE' } });
    assert.equal(audit.state, 'idle');
    assert.equal(audit.status, 'PARTIAL');
    const saved = await readFile(join(f.project, '.agent-orchestra', 'runs', 'native-latest.json'), 'utf8');
    assert.doesNotMatch(saved, /NEVER-SAVE|transcript_path/);
    assert.equal(await readFile(acceptance, 'utf8'), 'existing acceptance');
  }
});

test('concurrent child starts survive and child stop replaces placeholder with real evidence', async () => {
  const f = await fixture(); await observeNativeHook(f);
  await Promise.all(['one', 'two'].map(agent_id => observeNativeHook({ ...f,
    event: { ...f.event, hook_event_name: 'SubagentStart', agent_id, agent_type: 'reviewer' } })));
  const child = join(f.project, 'child.jsonl');
  await writeFile(child, JSON.stringify({ type: 'session_meta', payload: { id: 'one', cwd: f.project,
    source: { subagent: { thread_spawn: { parent_thread_id: 'root', agent_role: 'reviewer' } } } } }) + '\n');
  const audit = await observeNativeHook({ ...f, event: { ...f.event, hook_event_name: 'SubagentStop',
    agent_id: 'one', agent_type: 'reviewer', agent_transcript_path: child } });
  assert.equal(audit.agents.length, 3);
  assert.equal(audit.agents.find(agent => agent.sessionId === 'one').state, 'idle');
  assert.equal(audit.agents.find(agent => agent.sessionId === 'two').state, 'running');
  assert.equal(audit.totals.tokens, null);
  const late = await observeNativeHook({ ...f, event: { ...f.event, hook_event_name: 'SubagentStart',
    agent_id: 'one', agent_type: 'reviewer' } });
  assert.equal(late.agents.find(agent => agent.sessionId === 'one').state, 'idle', 'Late start must not replace observed stop evidence');
});

test('successful recognized plan hooks persist only safe plan fields; other output is discarded', async () => {
  const f = await fixture();
  const event = { ...f.event, hook_event_name: 'PostToolUse', tool_name: 'update_plan',
    tool_input: { plan: [{ step: 'Verify behavior', status: 'in_progress', secret: 'PRIVATE' }] },
    tool_response: { success: true, content: 'PRIVATE' } };
  const audit = await observeNativeHook({ ...f, event });
  assert.deepEqual(audit.plan, [{ step: 'Verify behavior', status: 'inProgress' }]);
  const failed = await observeNativeHook({ ...f, event: { ...event,
    tool_input: { plan: [] }, tool_response: { is_error: true } } });
  assert.deepEqual(failed.plan, audit.plan);
  assert.doesNotMatch(JSON.stringify(audit), /PRIVATE/);
});

test('foreign identity, symlink output and unmanaged existing files fail closed', async () => {
  const f = await fixture();
  await assert.rejects(observeNativeHook({ ...f, event: { ...f.event, session_id: 'other' } }));
  await assert.rejects(observeNativeHook({ ...f, event: { ...f.event, cwd: '/foreign' } }));
  await mkdir(join(f.project, '.agent-orchestra', 'runs'), { recursive: true });
  const path = join(f.project, '.agent-orchestra', 'runs', 'native-latest.json');
  await writeFile(path, '{"user":"preserve"}');
  await assert.rejects(observeNativeHook(f), /Unmanaged/);
  assert.equal(await readFile(path, 'utf8'), '{"user":"preserve"}');
  const linked = await fixture();
  const target = join(linked.project, 'other'); await mkdir(target);
  try { await symlink(target, join(linked.project, '.agent-orchestra'), 'dir'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  await assert.rejects(observeNativeHook(linked), /Unsafe/);
  assert.equal((await lstat(join(linked.project, '.agent-orchestra'))).isSymbolicLink(), true);
});

test('Claude child transcript counters and identified task updates survive collection', async () => {
  const f = await fixture('claude');
  const create = { ...f.event, hook_event_name: 'PostToolUse', tool_name: 'TaskCreate',
    tool_input: { subject: 'Independent review' }, tool_response: { task: { id: '1' } } };
  await observeNativeHook({ ...f, event: create });
  const updated = await observeNativeHook({ ...f, event: { ...create, tool_name: 'TaskUpdate',
    tool_input: { taskId: '1', status: 'in_progress' }, tool_response: {} } });
  assert.deepEqual(updated.plan, [{ step: 'Independent review', status: 'inProgress' }]);
  const child = join(f.project, 'claude-child.jsonl');
  await writeFile(child, JSON.stringify({ type: 'assistant', sessionId: 'root', agentId: 'worker', cwd: f.project,
    message: { id: 'msg1', model: 'claude-fixture', stop_reason: 'end_turn', usage: {
      input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 3,
    } } }));
  const audit = await observeNativeHook({ ...f, event: { ...f.event, hook_event_name: 'SubagentStop',
    agent_id: 'worker', agent_type: 'reviewer', agent_transcript_path: child } });
  assert.equal(audit.agents[1].model, 'claude-fixture');
  assert.equal(audit.agents[1].tokens.total, 20);
  assert.equal(audit.agents[1].parentSessionId, 'root');
  assert.equal(audit.totals.tokens, null, 'Root counters are unknown, not zero');
});

test('early SessionStart defers missing transcript metadata without accepting foreign identity', async () => {
  for (const harness of ['codex', 'claude']) {
    const f = await fixture(harness);
    const absent = { ...f.event, transcript_path: join(f.project, 'not-created.jsonl') };
    assert.equal(await observeNativeHook({ ...f, event: absent }), null);
    await assert.rejects(observeNativeHook({ ...f, event: { ...absent, hook_event_name: 'Stop' } }));
    await writeFile(f.event.transcript_path, '');
    assert.equal(await observeNativeHook(f), null);
    await assert.rejects(observeNativeHook({ ...f, event: { ...f.event, hook_event_name: 'PostToolUse' } }));
    const foreign = harness === 'codex' ? { type: 'session_meta', payload: { id: 'foreign' } }
      : { type: 'user', sessionId: 'foreign' };
    await writeFile(f.event.transcript_path, JSON.stringify(foreign) + '\n');
    await assert.rejects(observeNativeHook(f), /identity/);
    const known = harness === 'codex' ? { type: 'session_meta', payload: { id: 'root', cwd: f.project } }
      : { type: 'user', sessionId: 'root', cwd: f.project };
    await writeFile(f.event.transcript_path, JSON.stringify(known) + '\n');
    const audit = await observeNativeHook({ ...f, event: { ...f.event, hook_event_name: 'PostToolUse' } });
    assert.equal(audit.sessionId, 'root');
    assert.equal(audit.status, 'PARTIAL');
  }
});
