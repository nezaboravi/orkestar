import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as module from 'node:module';
import vm from 'node:vm';
import { join, basename, isAbsolute } from 'node:path';

test('Solo dispatch is profile-bound and fail-closed around native OpenCode identity', {
  skip: typeof module.stripTypeScriptTypes !== 'function' && 'Requires Node TypeScript stripping support',
}, async (t) => {
  const schema = new Proxy(() => schema, { get: () => schema, apply: () => schema });
  const args = { projectId: 24, profile: 'project-read', name: 'Explorer run', runId: '123e4567-e89b-12d3-a456-426614174000', task: 'Inspect only this bounded task.' };
  let calls, writes, rows, identityEvents, processCommand, runtimeManifest, agentTools;
  const reset = () => {
    calls = []; writes = []; rows = [{ id: 'ses_ABC123', directory: '/project', agent: 'explorer', model: JSON.stringify({ providerID: 'provider', id: 'model' }) }];
    identityEvents = [
      { type: 'text', sessionID: 'ses_ABC123', part: { type: 'text', text: 'IDENTITY_OK' } },
      { type: 'step_finish', sessionID: 'ses_ABC123', part: { reason: 'stop' } },
    ].map(JSON.stringify).join('\n');
    processCommand = `/verified/opencode --session ses_ABC123 --agent explorer --model provider/model --prompt '${args.task}'`;
    runtimeManifest = { schemaVersion: 1, harness: 'opencode', profiles: { 'project-read': { permissionEnvelope: 'explorer', model: 'provider/model' } } };
    agentTools = [{ id: 9, toolType: 'opencode', enabled: true, command: '/verified/opencode' }];
  };
  reset();
  const context = vm.createContext({
    tool: Object.assign(value => value, { schema }), process: { env: {}, platform: 'linux' }, join, basename, isAbsolute,
    homedir: () => '/home/fixture', Date, JSON, Object, Array, Number, String, Error,
    realpath: async value => value,
    readFile: async () => JSON.stringify(runtimeManifest),
    mkdir: async () => {}, writeFile: async (path, content, options) => { writes.push({ path, content, options }); },
    executeFile: async (binary, argv, options) => {
      calls.push({ binary, argv: Array.from(argv), options });
      if (argv[0] === 'run') return { stdout: identityEvents };
      if (argv[0] === 'db') return { stdout: JSON.stringify(rows) };
      const command = argv.filter(value => value !== '--json');
      if (command[0] === 'projects') return { stdout: JSON.stringify({ ok: true, data: { id: 24, path: '/project' } }) };
      if (command[0] === 'agents') return { stdout: JSON.stringify({ ok: true, data: { agentTools } }) };
      if (command[0] === 'processes' && command[1] === 'spawn') return { stdout: JSON.stringify({ ok: true, data: { process: { id: 88, kind: 'agent' } } }) };
      if (command[0] === 'processes' && command[1] === 'get') return { stdout: JSON.stringify({ ok: true, data: { id: 88, name: args.name, kind: 'agent', command: processCommand, status: 'running', projectId: 24, projectName: 'fixture', pid: 999, uptimeSeconds: 1 } }) };
      throw new Error('unexpected command');
    },
  });
  const source = module.stripTypeScriptTypes(readFileSync(new URL('../adapters/opencode/tools/orchestra-solo-dispatch.ts', import.meta.url), 'utf8'))
    .replace(/^import .*\n/gm, '').replace(/^const executeFile = promisify\(execFile\)\n/m, '').replace('export default tool(', 'globalThis.dispatch = tool(');
  vm.runInContext(source, context);
  const execute = value => context.dispatch.execute(value ?? args, { directory: '/project', sessionID: 'owner-session' });

  await t.test('every shipped factory profile can reach native identity dispatch', async () => {
    const profiles = JSON.parse(readFileSync(new URL('../orchestra.json', import.meta.url), 'utf8')).agentFactory.profiles;
    assert.equal(profiles['product-design'].template, 'product-designer');
    assert.equal(profiles['code-review'].template, 'reviewer');
    for (const [key, profile] of Object.entries(profiles)) {
      reset();
      runtimeManifest.profiles[key] = { permissionEnvelope: profile.template, model: 'provider/model' };
      rows[0].agent = profile.template;
      const result = JSON.parse(await execute({ ...args, profile: key }));
      assert.equal(result.role, profile.template, key);
      const probe = calls.find(call => call.argv[0] === 'run');
      assert.equal(probe.argv[2], profile.template, key);
    }
  });

  await t.test('uses only profile role/model and persists a private launch receipt', async () => {
    reset(); const result = JSON.parse(await execute());
    assert.equal(result.role, 'explorer'); assert.equal(result.model, 'provider/model'); assert.equal(result.nativeIdentityVerifiedAtBootstrap, true);
    const probe = calls.find(call => call.argv[0] === 'run');
    assert.deepEqual(probe.argv.slice(0, 9), ['run', '--agent', 'explorer', '--model', 'provider/model', '--format', 'json', '--title', args.runId]);
    assert.equal(JSON.parse(probe.options.env.OPENCODE_CONFIG_CONTENT).agent.explorer.permission, 'deny');
    const soloSpawn = calls.find(call => call.argv.includes('spawn'));
    assert.deepEqual(soloSpawn.argv.slice(soloSpawn.argv.indexOf('--arg')), ['--arg', '--session', '--arg', 'ses_ABC123', '--arg', '--agent', '--arg', 'explorer', '--arg', '--model', '--arg', 'provider/model', '--arg', '--prompt', '--arg', args.task, '--json']);
    assert.equal(result.launchArgumentsVerified, false); assert.deepEqual(result.suppliedArguments, ['--session', 'ses_ABC123', '--agent', 'explorer', '--model', 'provider/model']);
    assert.equal(result.taskCharacters, args.task.length);
    assert.equal(writes.length, 1); assert.match(writes[0].path, /dispatch\/ses_ABC123\.json$/); assert.equal(writes[0].options.mode, 0o600);
  });
  await t.test('rejects caller role/model or arbitrary fields before subprocess calls', async () => {
    reset(); await assert.rejects(execute({ ...args, role: 'attacker' })); assert.equal(calls.length, 0);
    reset(); await assert.rejects(execute({ ...args, model: 'attacker' })); assert.equal(calls.length, 0);
  });
  await t.test('maximum multibyte task cannot overflow the wait receipt', async () => {
    reset(); const result = await execute({ ...args, task: '界'.repeat(16384) });
    assert.equal(JSON.parse(result).taskCharacters, 16384);
    assert.ok(Buffer.byteLength(writes[0].content) < 16384);
    assert.ok(!writes[0].content.includes('界'));
  });
  await t.test('rejects a stale runtime manifest and unsupported role before Solo calls', async () => {
    reset(); runtimeManifest.harness = 'codex'; await assert.rejects(execute()); assert.equal(calls.length, 0);
    reset(); runtimeManifest.profiles['project-read'].permissionEnvelope = 'unshipped-role'; await assert.rejects(execute()); assert.equal(calls.length, 0);
  });
  await t.test('requires an explicitly enabled, safely identified OpenCode tool', async () => {
    reset(); agentTools[0].enabled = false; await assert.rejects(execute()); assert.equal(calls.some(call => call.argv.includes('run')), false);
    reset(); agentTools[0].id = 1.5; await assert.rejects(execute()); assert.equal(calls.some(call => call.argv.includes('run')), false);
  });
  for (const [name, mutate] of [
    ['wrong Solo base command', () => { processCommand = '/verified/not-opencode --session ses_ABC123'; }],
    ['tool use in identity probe', () => { identityEvents += `\n${JSON.stringify({ type: 'tool-call', sessionID: 'ses_ABC123' })}`; }],
    ['wrong DB role', () => { rows[0].agent = 'builder'; }],
  ]) await t.test(name, async () => {
    reset(); mutate(); await assert.rejects(execute());
    if (name !== 'wrong Solo base command') assert.equal(calls.some(call => call.argv.includes('spawn')), false);
    if (name === 'wrong Solo base command') assert.match(writes.at(-1).path, /dispatch\/ses_ABC123\.json$/);
    else assert.match(writes.at(-1).path, /failed-123e4567-e89b-12d3-a456-426614174000\.json$/);
  });
});
