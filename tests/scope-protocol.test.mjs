import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  buildPlan,
  compareChangeSurface,
  createAgentCharter,
  createPhasePacket,
  createTaskContract,
  validateTaskContract,
  runtimeManifest,
  validateProtocolResult,
} from '../orchestra.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

function contract(overrides = {}) {
  return createTaskContract({
    goal: 'Add recipe CRUD',
    required: [{ id: 'R1', text: 'Users can create, edit, and delete recipes' }],
    localDecisions: ['Use existing Laravel conventions'],
    outOfScope: ['Unrelated refactors'],
    changeSurface: {
      modules: ['recipes'],
      fileKinds: ['model', 'migration', 'controller', 'view', 'test'],
      migrationsAllowed: true,
      dependenciesAllowed: false,
      architectureChangesAllowed: false,
    },
    ...overrides,
  });
}

test('Task Contracts have deterministic identity and reject mutation', () => {
  const first = contract();
  const second = contract();
  assert.deepEqual(first, second);
  assert.match(first.id, /^tc-[a-f0-9]{12}$/);
  assert.match(first.hash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(first.required, [{ id: 'R1', text: 'Users can create, edit, and delete recipes' }]);

  assert.deepEqual(validateTaskContract(first), first);
  assert.throws(() => validateTaskContract({ ...first, hash: 'sha256:' + 'f'.repeat(64) }), /hash does not match/);

  assert.throws(() => createTaskContract({ ...first, goal: 'Different goal' }), /ID does not match/);
  assert.throws(() => createTaskContract({ ...first, hash: 'sha256:' + '0'.repeat(64) }), /hash does not match/);
});

test('phase packets preserve the contract and reject unauthorized artifact types', () => {
  const taskContract = contract();
  const packet = createPhasePacket({ phase: 'build', taskContract, artifacts: [{ type: 'approved-plan', reference: 'plan.json' }] });
  assert.deepEqual(packet.taskContract, taskContract);
  assert.equal(packet.taskContract.id, taskContract.id);
  assert.throws(() => createPhasePacket({ phase: 'build', taskContract, artifacts: [{ type: 'verification-evidence', reference: 'proof.json' }] }), /not allowed/);
  assert.throws(() => createPhasePacket({ phase: 'build', taskContract: { ...taskContract, id: 'tc-wrong' }, artifacts: [] }), /ID does not match/);
  assert.throws(() => createPhasePacket({ phase: 'repair', taskContract, repairOf: 'finding-1', artifacts: [{ type: 'reproduction', reference: 'repro.json' }] }), /accepted-defect artifact and repairOf/);
  const repair = createPhasePacket({ phase: 'repair', taskContract, repairOf: 'finding-1', artifacts: [{ type: 'accepted-defect', reference: 'defect.json' }] });
  assert.equal(repair.repairOf, 'finding-1');
});

test('installed phase-packet schema declares phase-specific artifact and repair gates', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'schemas', 'phase-packet.schema.json'), 'utf8'));
  const phaseRules = schema.allOf.filter((rule) => rule.if?.properties?.phase?.const);
  assert.deepEqual(phaseRules.map((rule) => rule.if.properties.phase.const), ['design', 'plan', 'build', 'verify', 'prove', 'repair', 'repair']);
  const buildRule = phaseRules.find((rule) => rule.if.properties.phase.const === 'build');
  assert.deepEqual(buildRule.then.properties.artifacts.items.properties.type.enum, ['approved-plan', 'design-specification']);
  const repairGate = phaseRules.at(-1);
  assert.deepEqual(repairGate.then.required, ['repairOf']);
  assert.equal(repairGate.then.properties.artifacts.contains.properties.type.const, 'accepted-defect');
  assert.deepEqual(repairGate.else, { not: { required: ['repairOf'] } });
});

test('typed protocol results enforce repair eligibility and evidence', () => {
  const taskContract = contract();
  assert.throws(() => validateProtocolResult({ category: 'finding', classification: 'VERIFIED_DEFECT', scopeRelation: 'REQUIRED', summary: 'missing authority', evidence: ['output'] }), /Immutable task contract/);
  const eligibleFinding = validateProtocolResult({ taskContract, category: 'finding', classification: 'VERIFIED_DEFECT', scopeRelation: 'REQUIRED', summary: 'broken behavior', evidence: ['test output'], repairAuthorized: true });
  const eligibleFailure = validateProtocolResult({ taskContract, category: 'failure', classification: 'SCOPED_FAILURE', scopeRelation: 'LOCAL_DECISION', summary: 'scoped failure', evidence: ['exact command'], repairAuthorized: true });
  assert.equal(eligibleFinding.repairEligible, true);
  assert.equal(eligibleFailure.repairEligible, true);
  assert.equal(eligibleFinding.taskContractId, taskContract.id);

  for (const input of [
    { category: 'failure', classification: 'UNRELATED_EXISTING_FAILURE', scopeRelation: 'OUT_OF_SCOPE', evidence: ['existing failure'] },
    { category: 'finding', classification: 'OUT_OF_SCOPE_DISCOVERY', scopeRelation: 'OUT_OF_SCOPE', evidence: ['found elsewhere'] },
    { category: 'finding', classification: 'SCOPED_RISK', scopeRelation: 'REQUIRED', evidence: ['risk only'] },
    { category: 'finding', classification: 'SPECULATION', scopeRelation: 'REQUIRED', evidence: ['unconfirmed hypothesis'] },
    { category: 'failure', classification: 'AMBIGUOUS', scopeRelation: 'REQUIRED', evidence: ['unclear'] },
  ]) {
    const result = validateProtocolResult({ ...input, taskContract, summary: 'recorded result' });
    assert.equal(result.repairEligible, false);
    assert.equal(result.repairAuthorized, undefined);
  }
});

test('repairAuthorized cannot override an out-of-scope or unproven result', () => {
  const taskContract = contract();
  assert.throws(() => validateProtocolResult({ taskContract, category: 'finding', classification: 'SPECULATION', scopeRelation: 'REQUIRED', summary: 'unproven', repairAuthorized: true }), /may authorize repair/);
  assert.throws(() => validateProtocolResult({ taskContract, category: 'failure', classification: 'UNRELATED_EXISTING_FAILURE', scopeRelation: 'OUT_OF_SCOPE', summary: 'existing failure', evidence: ['existing failure'], repairAuthorized: true }), /may authorize repair/);
});

test('installed agent-result schema declares scope and repair eligibility invariants', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'schemas', 'agent-result.schema.json'), 'utf8'));
  const eligibleRule = schema.allOf.find((rule) => rule.if?.properties?.classification?.enum?.includes('VERIFIED_DEFECT') && rule.then?.properties?.repairEligible);
  assert.deepEqual(eligibleRule.if.properties.classification.enum, ['VERIFIED_DEFECT', 'SCOPED_FAILURE']);
  assert.equal(eligibleRule.then.properties.evidence.minItems, 1);
  assert.equal(eligibleRule.then.properties.repairEligible.const, true);
  assert.equal(eligibleRule.else.properties.repairEligible.const, false);

  const outOfScopeRule = schema.allOf.find((rule) => rule.if?.properties?.classification?.enum?.includes('REPORT_ONLY'));
  assert.equal(outOfScopeRule.then.properties.scopeRelation.const, 'OUT_OF_SCOPE');
  const authorizedRule = schema.allOf.find((rule) => rule.if?.properties?.repairAuthorized?.const === true);
  assert.equal(authorizedRule.then.properties.repairEligible.const, true);
});

test('semantic change-surface anomalies cover unplanned categories and allowed cases', () => {
  const taskContract = contract();
  const clean = compareChangeSurface(taskContract, { modules: ['recipes'], fileKinds: ['model', 'view'], migrations: true });
  assert.equal(clean.anomalous, false);

  const anomalous = compareChangeSurface(taskContract, { modules: ['recipes', 'billing'], fileKinds: ['model', 'generated'], migrations: true, dependencies: true, architectureChanges: true });
  assert.equal(anomalous.anomalous, true);
  assert.deepEqual(anomalous.anomalies.map(({ kind }) => kind), ['module', 'fileKind', 'dependency', 'architecture']);
});

test('multi-tool project install emits protocol assets once and runtime paths are explicit', () => {
  const project = '/tmp/example-project';
  const plan = buildPlan({ selectedTools: ['opencode', 'codex', 'claude'], project, projectOnly: true, resolvedModelsByTool: {}, resolvedFactoryModelsByTool: {} });
  const protocolTargets = plan.operations.filter((operation) => operation.target.includes(`${path.sep}.agent-orchestra${path.sep}protocol${path.sep}`));
  assert.equal(protocolTargets.length, 4);
  assert.deepEqual(protocolTargets.map((operation) => path.basename(operation.target)).sort(), ['agent-result.schema.json', 'phase-packet.schema.json', 'task-contract.schema.json', 'task-contract.template.json']);

  const manifest = JSON.parse(runtimeManifest('codex', { mid: 'gpt-5.6-terra' }));
  assert.equal(manifest.scopeProtocol.contract, '.agent-orchestra/protocol/task-contract.schema.json');
  assert.equal(manifest.scopeProtocol.phasePacket, '.agent-orchestra/protocol/phase-packet.schema.json');
  assert.equal(manifest.scopeProtocol.result, '.agent-orchestra/protocol/agent-result.schema.json');
});

test('dynamic charters carry the immutable contract without weakening permissions', () => {
  const taskContract = contract();
  const charter = createAgentCharter({ goal: 'Implement recipe form', capability: 'project-write', taskContract }, 'codex', { mid: 'gpt-5.6-terra' });
  assert.deepEqual(charter.taskContract, taskContract);
  assert.equal(charter.permissionEnvelope, 'dev-builder');
  assert.equal(charter.independentProofRequired, true);
});

test('shipped prompts state contract, classification, report-only, and repair constraints', () => {
  const prompts = [
    fs.readFileSync(path.join(repoRoot, 'agents', 'lenka.md'), 'utf8'),
    fs.readFileSync(path.join(repoRoot, 'teams', 'dev', 'dev-lead.md'), 'utf8'),
    fs.readFileSync(path.join(repoRoot, 'teams', 'dev', 'dev-tester.md'), 'utf8'),
    fs.readFileSync(path.join(repoRoot, 'agents', 'reviewer.md'), 'utf8'),
  ].join('\n');
  for (const phrase of ['Task Contract', 'OUT_OF_SCOPE', 'report-only', 'repair']) assert.match(prompts, new RegExp(phrase, 'i'));
  assert.match(prompts, /SCOPED_FAILURE/);
  assert.match(prompts, /VERIFIED_DEFECT/);
});

test('Lenka up parsing remains compatible with existing workspace and harness forms', async () => {
  const { parse } = await import('../lenka.mjs');
  assert.equal(parse(['up']).command, 'up');
  assert.equal(parse(['up']).workspace, 'herdr');
  assert.equal(parse(['up']).harness, null);
  assert.equal(parse(['up.']).command, 'up');
  assert.equal(parse(['up', 'solo', 'codex']).workspace, 'solo');
  assert.equal(parse(['up', 'solo', 'codex']).harness, 'codex');
  assert.equal(parse(['up', 'codex', '--solo']).workspace, 'solo');
  assert.equal(parse(['up', 'cursor']).harness, 'cursor');
  assert.equal(parse(['up', '--ask']).ask, true);
  assert.equal(parse(['up', 'codex', '--direct']).herdr, false);
});
