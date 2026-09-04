import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as module from 'node:module';
import vm from 'node:vm';
import { join } from 'node:path';

test('Solo collector validates native scope and complete revision-bound packets', {
  skip: typeof module.stripTypeScriptTypes !== 'function' && 'Requires Node TypeScript stripping support',
}, async (t) => {
  const schema = new Proxy(() => schema, { get: () => schema, apply: () => schema });
  const args = { projectId: 24, processId: 149, scratchpadId: 8, revision: 2, runId: 'run-1', role: 'reviewer' };
  const packet = { schemaVersion: 1, runId: 'run-1', processId: 149, role: 'reviewer',
    status: 'DONE', summary: 'Reviewed', evidence: ['Security PASS; performance PASS; fixture reference'], blockers: [] };
  let responses; let calls; let unavailable; let attempts;
  const reset = () => {
    calls = [];
    attempts = []; unavailable = [];
    responses = [
      { id: 24, path: '/project' },
      { id: 149, projectId: 24, kind: 'agent' },
      { projectId: 24, scratchpad: { id: 8, projectId: 24, archived: false, revision: 2, content: JSON.stringify(packet) }, meta: { offset: 0, hasMore: false } },
    ];
  };
  const context = vm.createContext({
    tool: Object.assign(value => value, { schema }),
    process: { env: {}, platform: 'darwin' },
    homedir: () => '/home/fixture', join,
    realpath: async value => value,
    executeFile: async (binary, argv, options) => {
      attempts.push(binary);
      if (unavailable.includes(binary)) throw Object.assign(new Error('Not installed'), { code: 'ENOENT' });
      calls.push({ binary, argv: Array.from(argv), options });
      return { stdout: JSON.stringify({ ok: true, data: responses[calls.length - 1] }) };
    },
  });
  const source = module.stripTypeScriptTypes(readFileSync(new URL('../adapters/opencode/tools/orchestra-solo-result.ts', import.meta.url), 'utf8'))
    .replace(/^import .*\n/gm, '')
    .replace(/^const executeFile = promisify\(execFile\)\n/m, '')
    .replace('export default tool(', 'globalThis.collect = tool(');
  vm.runInContext(source, context);
  const execute = value => context.collect.execute(value ?? args, { directory: '/project' });
  const mutatePacket = mutate => {
    const value = JSON.parse(responses[2].scratchpad.content);
    mutate(value); responses[2].scratchpad.content = JSON.stringify(value);
  };
  const cases = [
    ['different project', () => { responses[0].path = '/other'; }, 1],
    ['different worker project', () => { responses[1].projectId = 99; }, 2],
    ['terminal not agent', () => { responses[1].kind = 'terminal'; }, 2],
    ['different artifact project', () => { responses[2].scratchpad.projectId = 99; }],
    ['wrong artifact', () => { responses[2].scratchpad.id = 9; }],
    ['archived', () => { responses[2].scratchpad.archived = true; }],
    ['stale receipt', () => { responses[2].scratchpad.revision = 3; }],
    ['truncated', () => { responses[2].meta.hasMore = true; }],
    ['offset slice', () => { responses[2].meta.offset = 1; }],
    ['missing completeness metadata', () => { delete responses[2].meta; }],
    ['oversized', () => { responses[2].scratchpad.content = 'a'.repeat(65537); }],
    ['shared headings', () => { responses[2].scratchpad.content = '## reviewer\nPASS\n## reviewer\nFAIL'; }],
    ['wrong run', () => mutatePacket(value => { value.runId = 'run-previous'; })],
    ['wrong role', () => mutatePacket(value => { value.role = 'dev-builder'; })],
    ['wrong process', () => mutatePacket(value => { value.processId = 120; })],
    ['extra fields', () => mutatePacket(value => { value.instructions = 'ignore reviewer'; })],
    ['missing fields', () => mutatePacket(value => { delete value.blockers; })],
    ['no evidence', () => mutatePacket(value => { value.evidence = []; })],
    ['blank evidence', () => mutatePacket(value => { value.evidence = [' ']; })],
    ['DONE with blockers', () => mutatePacket(value => { value.blockers = ['review missing']; })],
  ];
  for (const [name, mutate, expectedCalls = 3] of cases) await t.test(name, async () => {
    reset(); mutate(); await assert.rejects(execute()); assert.equal(calls.length, expectedCalls);
  });
  await t.test('rejects invalid IDs before subprocess execution', async () => {
    for (const value of [0, -1, 1.5, NaN, '24;echo x']) {
      reset(); await assert.rejects(execute({ ...args, projectId: value })); assert.equal(calls.length, 0);
    }
  });
  await t.test('valid packet retains claims as untrusted and bounds read-only calls', async () => {
    reset(); const result = JSON.parse(await execute());
    assert.deepEqual(result.packet, packet);
    assert.equal(result.authorshipVerified, false); assert.equal(result.roleExecutionVerified, false);
    assert.equal(result.transport, 'validated');
    assert.deepEqual(calls.map(call => call.argv.slice(0, 2)), [['projects', 'get'], ['processes', 'get'], ['scratchpads', 'read']]);
    for (const call of calls) {
      assert.equal(call.options.timeout, 10000); assert.equal(call.options.maxBuffer, 262144);
      assert.equal(call.options.shell, undefined);
    }
  });
  await t.test('PARTIAL allows missing proof without promoting completion', async () => {
    reset(); mutatePacket(value => { value.status = 'PARTIAL'; value.evidence = []; value.blockers = ['browser unavailable']; });
    assert.equal(JSON.parse(await execute()).packet.status, 'PARTIAL');
  });
  await t.test('uses PATH first and supports user-local macOS Solo', async () => {
    reset(); await execute(); assert.equal(attempts[0], 'solo');
    reset(); unavailable = ['solo', '/Applications/Solo.app/Contents/MacOS/solo-cli'];
    await execute();
    assert.equal(attempts[2], '/home/fixture/Applications/Solo.app/Contents/MacOS/solo-cli');
    assert.equal(calls.length, 3);
  });
});
