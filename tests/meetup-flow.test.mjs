import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('source delivery instructions retain repair and independent re-review before acceptance', () => {
  const rules = fs.readFileSync(new URL('../agents/lenka.md', import.meta.url), 'utf8');
  assert.match(rules, /Repair is part of delivery/);
  assert.match(rules, /repair assignment/i);
  assert.match(rules, /re-review/);
  assert.match(rules, /Time-boxed demonstrations/);
  assert.match(rules, /do not kill processes/);
  assert.match(rules, /column\s+AND completion state/);
  assert.match(rules, /completed individually/);
  assert.match(rules, /prevents overall DONE/);
});

test('meetup rehearsal has a bounded scope and honest deadline, not a speed guarantee', () => {
  const brief = fs.readFileSync(new URL('../proofs/meetup-board-15-minutes.md', import.meta.url), 'utf8');
  assert.match(brief, /15/);
  assert.match(brief, /PARTIAL/);
  assert.match(brief, /Taskavel/);
  assert.match(brief, /security/i);
  assert.match(brief, /performance/i);
  assert.match(brief, /seed/i);
});

test('small-feature guidance formats before review and retains independent acceptance', () => {
  const leader = fs.readFileSync(new URL('../agents/lenka.md', import.meta.url), 'utf8');
  const builder = fs.readFileSync(new URL('../teams/dev/dev-builder.md', import.meta.url), 'utf8');
  const reviewer = fs.readFileSync(new URL('../agents/reviewer.md', import.meta.url), 'utf8');
  assert.match(leader, /tracker setup before\n  coding/);
  assert.match(leader, /formatting in the builder's handoff,\n  before independent checks/);
  assert.match(leader, /mandatory review gates/);
  assert.match(builder, /formatting before handing off/);
  assert.match(reviewer, /exact diff/);
  assert.match(reviewer, /mandatory security\/performance/);
});
