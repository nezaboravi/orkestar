import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { herdrSessionName } from '../session-name.mjs';

test('Herdr session names are stable for one project and isolated by path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lenka-sessions-'));
  const first = path.join(root, 'one', 'agents');
  const second = path.join(root, 'two', 'agents');
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });

  const firstName = herdrSessionName(first);
  assert.equal(firstName, herdrSessionName(first));
  assert.notEqual(firstName, herdrSessionName(second));
  assert.match(firstName, /^lenka-agents-[a-f0-9]{8}$/);
  assert.ok(firstName.length <= 32);
});
