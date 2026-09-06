import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const instructions = fs.readFileSync(new URL('../agents/lenka.md', import.meta.url), 'utf8');
test('build prerequisites bind dev-server ownership to the target project without widening authority', () => {
  assert.match(instructions, /process working directory and the target project's `public\/hot`/);
  assert.match(instructions, /listener on port 5173 alone does not identify/);
  assert.match(instructions, /Never stop an unrelated dev server/);
  assert.match(instructions, /does not authorize a build or\noverride project rules/);
  assert.match(instructions, /do not inspect unrelated projects or stop their servers/);
});
test('browser-only QA receives authorized authentication prerequisites without credential discovery', () => {
  assert.match(instructions, /permitted target URL, required\njourneys, and an authorized authentication mechanism/);
  assert.match(instructions, /disposable seeded test account/);
  assert.match(instructions, /workers cannot read seed files or invent credentials/);
  assert.match(instructions, /Resolve missing access\nbefore dispatch/);
  assert.match(instructions, /Never put real\ncredentials in logs, public reports, Taskavel tasks, or shared scratchpads/);
  assert.match(instructions, /do not\nwiden browser permissions/);
});
