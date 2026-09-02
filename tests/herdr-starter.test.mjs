import assert from 'node:assert/strict';
import test from 'node:test';

import { parse, selectPane } from '../herdr-starter.mjs';

test('Herdr starter parses a provider-neutral launch request', () => {
  const parsed = parse([
    '--herdr', '/bin/herdr', '--session', 'lenka3-app-1234', '--harness', 'codex',
    '--binary', '/bin/codex', '--project', '/work/app', '--model', 'gpt-5.6-terra', '--reasoning', 'medium',
  ]);
  assert.equal(parsed.harness, 'codex');
  assert.equal(parsed.model, 'gpt-5.6-terra');
});

test('Herdr starter chooses the pane belonging to the requested project', () => {
  const snapshot = {
    result: {
      focused_pane_id: 'w1:p1',
      panes: [
        { pane_id: 'w1:p1', cwd: '/work/other' },
        { pane_id: 'w2:p1', cwd: '/work/app' },
      ],
    },
  };
  assert.equal(selectPane(snapshot, '/work/app'), 'w2:p1');
});

test('Herdr starter falls back to the focused pane while the shell resolves its cwd', () => {
  const snapshot = { result: { focused_pane_id: 'w3:p1', panes: [{ pane_id: 'w3:p1' }] } };
  assert.equal(selectPane(snapshot, '/work/app'), 'w3:p1');
});
