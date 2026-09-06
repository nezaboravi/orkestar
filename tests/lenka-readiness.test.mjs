import test from 'node:test';
import assert from 'node:assert/strict';
import { launchInstalledRuntime } from '../lenka.mjs';

const runtime = { harness: 'codex', manifest: { primary: { model: 'fixture' } } };
const options = { project: process.cwd(), workspace: 'solo' };
test('Solo readiness is printed only after preparation and verified launch succeed', async () => {
  const original = console.log; const lines = []; console.log = value => lines.push(String(value));
  const dependencies = { refreshProjectRuntime: () => ({ changed: 0 }), prepareNativeSolo: async () => null };
  try {
    for (const stage of ['prepare', 'launch']) {
      lines.length = 0;
      await assert.rejects(launchInstalledRuntime(runtime, options, { ...dependencies,
        ...(stage === 'prepare' ? { prepareNativeSolo: async () => { throw new Error('preparation failed'); } } : {}),
        launchInSolo: () => { throw new Error('launch failed'); },
      }), /failed/);
      assert.match(lines.join('\n'), /Starting Lenka in Solo/);
      assert.doesNotMatch(lines.join('\n'), /Lenka is ready/);
    }
    lines.length = 0;
    await launchInstalledRuntime(runtime, options, { ...dependencies, launchInSolo: () => {
      assert.doesNotMatch(lines.join('\n'), /Lenka is ready/);
      return { project: { name: 'fixture' }, process: { id: 1, name: 'Lenka' }, mcp: { changed: false }, reused: false };
    } });
    assert.equal(lines.filter(line => line === 'Lenka is ready.').length, 1);
  } finally { console.log = original; }
});
