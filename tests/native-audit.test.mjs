import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleNativeAudit, renderNativeAudit } from '../native-audit.mjs';

const tokens = { input: 10, output: 2, cacheRead: 8, cacheWrite: 0, reasoning: 1, total: 12 };
const session = (sessionId, parentSessionId = null, extra = {}) => ({
  sessionId, parentSessionId, project: '/project', role: 'reviewer', model: 'fixture', tokens, ...extra,
});
const assemble = (extra = {}) => assembleNativeAudit({ harness: 'codex', project: '/project', root: session('root'), ...extra });

test('assembles exact root and nested children without making completion claims', () => {
  for (const harness of ['codex', 'claude']) {
    const audit = assemble({ harness, root: session('root', null, { state: 'idle', plan: [{ step: 'Build', status: 'completed' }] }),
      children: [session('grandchild', 'child'), session('child', 'root')] });
    assert.equal(audit.status, 'PARTIAL');
    assert.equal(audit.agents.length, 3);
    assert.equal(audit.totals.tokens, 36);
    assert.equal(audit.totals.cost, null);
    assert.deepEqual(audit.verification, []);
    assert.deepEqual(audit.blockers, ['Native session activity is not independent acceptance proof']);
  }
});

test('rejects invalid roots, duplicates, missing lineage, cycles and foreign projects', () => {
  for (const extra of [{ harness: 'opencode' }, { project: '' }, { root: null },
    { root: session(null) }, { root: session('root', 'parent') }, { children: null },
    { children: [session('root', 'root')] },
    { children: [session('a', 'root'), session('a', 'root')] },
    { children: [session('a')] }, { children: [session('a', 'missing')] },
    { children: [session('a', 'b'), session('b', 'a')] },
    { children: [session('a', 'root', { project: '/other' })] }]) {
    assert.throws(() => assemble(extra));
  }
});

test('unknown and invalid tokens produce unavailable totals, never false zero', () => {
  for (const value of [null, {}, { ...tokens, total: -1 }, { ...tokens, output: Infinity },
    { ...tokens, total: 13 }, { ...tokens, input: '10' }, { ...tokens, reasoning: NaN },
    { ...tokens, cacheRead: 11 }, { ...tokens, cacheWrite: 11 }, { ...tokens, reasoning: 3 }]) {
    const audit = assemble({ children: [session('a', 'root', { tokens: value })] });
    assert.equal(audit.totals.tokens, null);
    assert.equal(audit.agents[1].tokens, null);
    assert.match(renderNativeAudit(audit), /Total cumulative tokens: unavailable/);
  }
  const zero = assemble({ root: session('root', null, { tokens: { input: 0, output: 0, total: 0 } }) });
  assert.equal(zero.totals.tokens, 0);
  const overflow = assemble({ root: session('root', null, { tokens: { input: Number.MAX_SAFE_INTEGER, output: 0, total: Number.MAX_SAFE_INTEGER } }), children: [session('a', 'root')] });
  assert.equal(overflow.totals.tokens, null);
});

test('rendering is metadata only and safely separates unknown models and cost', () => {
  const audit = assemble({ root: session('root', null, { role: null, model: null, cost: 100,
    prompt: 'SECRET-PROMPT', reasoning: 'SECRET-THOUGHT', plan: [{ step: 'SECRET-PLAN', status: 'completed' }] }),
    children: [session('a', 'root', { role: '<reviewer>|line' })] });
  const rendered = renderNativeAudit(audit);
  assert.match(rendered, /Independent acceptance: pending/);
  assert.match(rendered, /unavailable \| unavailable/);
  assert.match(rendered, /&lt;reviewer&gt;\\\|line/);
  assert.doesNotMatch(rendered, /SECRET|100|DONE/);
  assert.equal(audit.agents[0].cost, null);
});

test('identity bounds reject control bytes and rendering never emits ANSI controls', () => {
  for (const id of ['a'.repeat(513), '\u001b[31mroot', 'root\nother']) {
    assert.throws(() => assemble({ root: session(id) }));
    assert.throws(() => assemble({ children: [session(id, 'root')] }));
  }
  const audit = assemble({ root: session('root', null, { role: '\u001b[31mreviewer', model: 'm'.repeat(513) }) });
  assert.equal(audit.agents[0].agent, 'unavailable');
  assert.equal(audit.agents[0].model, 'unavailable');
  assert.doesNotMatch(renderNativeAudit(audit), /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
});
