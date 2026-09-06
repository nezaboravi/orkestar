import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareNativeSolo } from '../native-solo-setup.mjs';

test('native Solo setup prepares observer, visible workers and browser before launch', async () => {
  for (const harness of ['codex', 'claude']) {
    const calls = [];
    const input = { harness, project: '/fixture', sourceRoot: '/source', nodeBinary: '/node' };
    const result = await prepareNativeSolo(input, Object.fromEntries(['observer', 'worker', 'browser'].map(name =>
      [name, async value => { calls.push(name); assert.equal(value.project, input.project); return { name }; }])));
    assert.deepEqual(calls, ['observer', 'worker', 'browser']);
    assert.equal(result.worker.name, 'worker');
  }
});
test('unsupported harness remains unchanged and native setup failure stops launch', async () => {
  assert.equal(await prepareNativeSolo({ harness: 'opencode' }), null);
  let browserCalled = false;
  await assert.rejects(prepareNativeSolo({ harness: 'codex' }, {
    observer: async () => ({}), worker: async () => { throw new Error('Preserved conflict'); },
    browser: async () => { browserCalled = true; },
  }), /Preserved conflict/);
  assert.equal(browserCalled, false);
});
