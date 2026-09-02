import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildPlan, classify, codexAgent, codexModelInventory, codexModelProbe, createAgentCharter, kimiAgent, kimiModelInventory, kimiModelProbe, main, modelProbe, parseAgent, parseFrontmatter, resolveExecutableFactoryModels, resolveExecutableModels, resolveFactoryModels, resolveModels, runtimeManifest } from '../orchestra.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

function silently(callback) {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return callback();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test('frontmatter parser preserves nested permission maps', () => {
  const parsed = parseFrontmatter(`description: test
permission:
  edit: deny
  bash:
    "*": deny
    "php artisan test*": allow`);

  assert.deepEqual(parsed.permission, {
    edit: 'deny',
    bash: {
      '*': 'deny',
      'php artisan test*': 'allow',
    },
  });
});

test('Codex conversion keeps auditors read-only and builders writable', () => {
  const auditor = parseAgent(path.join(repoRoot, 'teams', 'dev', 'dev-auditor.md'));
  const builder = parseAgent(path.join(repoRoot, 'teams', 'dev', 'dev-builder.md'));

  assert.match(codexAgent(auditor), /sandbox_mode = "read-only"/);
  assert.match(codexAgent(builder), /sandbox_mode = "workspace-write"/);
  const generated = codexAgent(builder, 'gpt-5.6-luna', 'medium');
  assert.match(generated, /model = "gpt-5.6-luna"/);
  assert.match(generated, /model_reasoning_effort = "medium"/);
});

test('Codex inventory and live probe use Codex-native model slugs', () => {
  const inventoryRunner = () => ({
    status: 0,
    stdout: JSON.stringify({ models: [
      { slug: 'gpt-5.6-luna', visibility: 'list' },
      { slug: 'hidden-model', visibility: 'hide' },
    ] }),
  });
  assert.deepEqual(codexModelInventory('/fake/home', inventoryRunner, '/fake/codex'), ['gpt-5.6-luna']);

  const probeRunner = () => ({
    status: 0,
    stdout: [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ORCHESTRA_CODEX_OK' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 40, output_tokens: 2 } }),
    ].join('\n'),
    stderr: '',
  });
  const result = codexModelProbe('/fake/home', 'gpt-5.6-luna', probeRunner, '/fake/codex');
  assert.equal(result.ok, true);
  assert.equal(result.tokens, 42);
});

test('Kimi conversion preserves the main orchestrator and least-privilege role tools', () => {
  const lenka = parseAgent(path.join(repoRoot, 'agents', 'lenka.md'));
  const builder = parseAgent(path.join(repoRoot, 'teams', 'dev', 'dev-builder.md'));
  const auditor = parseAgent(path.join(repoRoot, 'teams', 'dev', 'dev-auditor.md'));

  assert.match(kimiAgent(lenka), /\$\{base_prompt\}/);
  assert.match(kimiAgent(lenka), /^  - Agent$/m);
  assert.doesNotMatch(kimiAgent(lenka), /^  - (Write|Edit|Bash)$/m);
  assert.match(kimiAgent(builder), /^  - (Write|Edit)$/m);
  assert.match(kimiAgent(builder), /^  - Bash$/m);
  assert.match(kimiAgent(auditor), /^  - Bash$/m);
  assert.doesNotMatch(kimiAgent(auditor), /^  - (Write|Edit)$/m);
});

test('Kimi inventory prioritizes the configured default without exposing provider configuration', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestra-kimi-home-'));
  fs.mkdirSync(path.join(home, '.kimi-code'), { recursive: true });
  fs.writeFileSync(path.join(home, '.kimi-code', 'config.toml'), 'default_model = "kimi-code/k3"\n');
  const runner = () => ({
    status: 0,
    stdout: JSON.stringify({ models: { 'kimi-code/kimi-for-coding': { provider: 'secret-provider-data' }, 'kimi-code/k3': {} } }),
  });
  assert.deepEqual(kimiModelInventory(home, runner, '/fake/kimi'), ['kimi-code/k3', 'kimi-code/kimi-for-coding']);
});

test('Kimi live probe requires the exact marker response', () => {
  const runner = () => ({ status: 0, stdout: '• ORCHESTRA_KIMI_OK\n', stderr: '' });
  const result = kimiModelProbe('/fake/home', 'kimi-code/k3', runner, '/fake/kimi');
  assert.equal(result.ok, true);
  assert.equal(result.tokens, null);
  assert.equal(result.cost, null);
});

test('unattended builder keeps destructive and external operations denied', () => {
  const builder = parseAgent(path.join(repoRoot, 'teams', 'dev', 'dev-builder.md'));
  const permission = builder.frontmatter.permission;

  assert.equal(permission.edit, 'allow');
  assert.equal(permission.external_directory, 'deny');
  for (const command of ['git push*', 'git reset*', 'rm *', 'sudo *', 'ssh *', 'curl *', 'gh *', 'php artisan db:wipe*']) {
    assert.equal(permission.bash[command], 'deny', `${command} must stay denied`);
  }
});

test('explicit start instruction dispatches without redundant confirmation', () => {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'orchestra.json'), 'utf8'));
  const lenka = fs.readFileSync(path.join(repoRoot, 'agents', 'lenka.md'), 'utf8');

  assert.equal(config.modelPolicy.humanConfirmationBeforeFirstDispatch, false);
  assert.match(lenka, /user's explicit instruction to start the job is dispatch authorization/);
  assert.doesNotMatch(lenka, /Announce and ask before dispatch/);
});

test('clean-room plan omits machine-specific symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestra-plan-'));
  const plan = buildPlan({
    selectedTools: ['opencode'],
    home: path.join(root, 'home'),
    project: path.join(root, 'project'),
  });

  assert.equal(plan.agentCount, 21);
  assert.ok(plan.warnings.some((warning) => warning.includes('skills/omarchy')));
  assert.equal(plan.operations.some((operation) => operation.target.includes(`${path.sep}omarchy${path.sep}`)), false);
});

test('project-only scope never plans a write into home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestra-project-only-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const plan = buildPlan({
    selectedTools: ['opencode'],
    home,
    project,
    projectOnly: true,
    resolvedModels: {},
  });

  assert.ok(plan.operations.length > 0);
  assert.ok(plan.operations.every((operation) => operation.target.startsWith(`${project}${path.sep}`)));
  assert.equal(plan.operations.some((operation) => operation.target.startsWith(`${home}${path.sep}`)), false);
  assert.ok(plan.operations.some((operation) => operation.target === path.join(project, '.agent-orchestra', '.gitignore')));
});

test('project-only recovery data stays inside the project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestra-project-recovery-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');

  assert.equal(silently(() => main(['install', '--home', home, '--project', project, '--project-only', '--structural'])), 0);
  assert.equal(fs.existsSync(path.join(home, '.agent-orchestra')), false);
  assert.ok(fs.existsSync(path.join(project, '.agent-orchestra', '.gitignore')));
  assert.ok(fs.existsSync(path.join(project, '.agent-orchestra', 'backups')));
});

test('project-only scope preserves existing project instructions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestra-project-rules-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'AGENTS.md'), 'framework-owned instructions\n');
  const plan = buildPlan({
    selectedTools: ['opencode'],
    home: path.join(root, 'home'),
    project,
    projectOnly: true,
    resolvedModels: {},
  });

  assert.equal(plan.operations.some((operation) => operation.target === path.join(project, 'AGENTS.md')), false);
  assert.ok(plan.warnings.some((warning) => warning.includes('Preserved existing project instructions')));
});

test('declared workflow resolves to real team agents', () => {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'orchestra.json'), 'utf8'));
  const declared = [config.team.entrypoint, ...config.team.workflow.map((step) => step.role)];

  for (const role of declared) {
    assert.ok(fs.existsSync(path.join(repoRoot, 'teams', 'dev', `${role}.md`)), `${role} must exist`);
  }
  assert.deepEqual(config.team.workflow.map((step) => step.phase), ['plan', 'build', 'verify', 'prove']);
  assert.equal(config.modelPolicy.humanConfirmationBeforeFirstDispatch, false);
});

test('model routing selects real candidates and degrades honestly', () => {
  const resolved = resolveModels([
    'openai/gpt-5.6-luna',
    'opencode-go/deepseek-v4-flash',
    'openai/gpt-5.6-sol',
  ]);

  assert.equal(resolved['dev-lead'], 'openai/gpt-5.6-luna');
  assert.equal(resolved['dev-planner'], 'openai/gpt-5.6-luna');
  assert.equal(resolved['dev-builder'], 'openai/gpt-5.6-luna');
  assert.equal(resolved['dev-tester'], 'opencode-go/deepseek-v4-flash');
  assert.equal(resolved['dev-auditor'], 'openai/gpt-5.6-sol');
  assert.ok(Object.values(resolveModels([])).every((model) => model === null));
});

test('model routing is adapter-specific', () => {
  const codex = resolveModels(['gpt-5.6-luna', 'gpt-5.6-sol'], 'codex');
  const claude = resolveModels(['haiku', 'sonnet', 'opus'], 'claude');
  const kimi = resolveModels(['kimi-code/k3', 'kimi-code/kimi-for-coding'], 'kimi');
  const opencode = resolveModels(['opencode-go/deepseek-v4-flash', 'opencode-go/kimi-k2.7-code'], 'opencode');

  assert.equal(codex['dev-lead'], 'gpt-5.6-luna');
  assert.equal(codex['dev-auditor'], 'gpt-5.6-sol');
  assert.equal(claude['dev-lead'], 'haiku');
  assert.equal(claude['dev-auditor'], 'haiku');
  assert.ok(Object.values(kimi).every((model) => model === 'kimi-code/k3'));
  assert.equal(opencode['dev-tester'], 'opencode-go/kimi-k2.7-code');
});

test('Codex fixed workflow roles follow their declared model classes', () => {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'orchestra.json'), 'utf8'));
  const codex = config.modelPolicy.adapters.codex;
  assert.equal(codex.roles['dev-lead'][0], codex.classes.mid[0]);
  assert.equal(codex.roles['dev-planner'][0], codex.classes.mid[0]);
  assert.equal(codex.roles['dev-builder'][0], codex.classes.mid[0]);
  assert.equal(codex.roles['dev-tester'][0], codex.classes.economy[0]);
  assert.equal(codex.roles['dev-auditor'][0], codex.classes.strongest[0]);
});

test('dynamic model classes are adapter-specific and ordered by cost policy', () => {
  const codex = resolveFactoryModels(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'], 'codex');
  const claude = resolveFactoryModels(['opus', 'sonnet', 'haiku'], 'claude');
  const opencode = resolveFactoryModels(['opencode-go/deepseek-v4-flash', 'opencode-go/kimi-k2.7-code'], 'opencode');
  const kimi = resolveFactoryModels(['kimi-code/k3', 'kimi-code/kimi-for-coding'], 'kimi');

  assert.deepEqual(codex, { economy: 'gpt-5.6-luna', mid: 'gpt-5.6-terra', strongest: 'gpt-5.6-sol' });
  assert.deepEqual(claude, { economy: 'haiku', mid: 'sonnet', strongest: 'opus' });
  assert.equal(opencode.economy, 'opencode-go/kimi-k2.7-code');
  assert.deepEqual(kimi, { economy: 'kimi-code/k3', mid: 'kimi-code/k3', strongest: 'kimi-code/k3' });
});

test('agent factory creates a one-run charter from the narrowest declared envelope', () => {
  const charter = createAgentCharter({
    goal: 'Inspect the recipe migration and report its fields',
    capability: 'project-read',
    evidence: ['Cite the migration path and field names'],
  }, 'codex', { economy: 'gpt-5.6-luna' });

  assert.match(charter.name, /^orchestra-inspect-the-recipe-migration-and-rep-[a-f0-9]{8}$/);
  assert.equal(charter.lifecycle, 'one-run');
  assert.equal(charter.permissionEnvelope, 'explorer');
  assert.equal(charter.modelClass, 'economy');
  assert.equal(charter.model, 'gpt-5.6-luna');
  assert.equal(charter.reasoningEffort, 'low');
  assert.equal(charter.writes, false);
  assert.equal(charter.independentProofRequired, false);
  assert.deepEqual(charter.evidence, ['Cite the migration path and field names']);
});

test('agent factory requires independent proof after project writes', () => {
  const charter = createAgentCharter({
    goal: 'Implement recipe CRUD',
    capability: 'project-write',
  }, 'claude', { mid: 'sonnet' });

  assert.equal(charter.permissionEnvelope, 'dev-builder');
  assert.equal(charter.independentProofRequired, true);
});

test('agent factory fails closed for unknown capabilities and unauthorized external writes', () => {
  assert.throws(
    () => createAgentCharter({ goal: 'Provision infrastructure', capability: 'cloud-admin' }, 'codex', { economy: 'gpt-5.6-luna' }),
    /No exact permission envelope exists/,
  );
  assert.throws(
    () => createAgentCharter({ goal: 'Create a Taskavel project', capability: 'taskavel' }, 'codex', { economy: 'gpt-5.6-luna' }),
    /requires explicit authorization/,
  );

  const authorized = createAgentCharter({
    goal: 'Create a Taskavel project',
    capability: 'taskavel',
    externalWriteAuthorized: true,
  }, 'codex', { economy: 'gpt-5.6-luna' });
  assert.equal(authorized.externalWrites, true);
  assert.equal(authorized.independentProofRequired, true);
});

test('live dynamic routing uses a verified fallback after an authentication failure', () => {
  const seen = [];
  const probe = (_home, model) => {
    seen.push(model);
    if (model.startsWith('opencode-go/')) return { model, ok: false, authFailure: true, reason: 'HTTP 401', tokens: 0, cost: 0 };
    return { model, ok: true, authFailure: false, reason: 'verified response', tokens: 1, cost: 0 };
  };
  const inventory = ['opencode-go/kimi-k2.7-code', 'opencode-go/deepseek-v4-flash', 'openai/gpt-5.6-luna', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-sol'];
  const result = resolveExecutableFactoryModels('/fake/home', inventory, probe, 'opencode');

  assert.equal(result.routes.economy, 'openai/gpt-5.6-luna');
  assert.equal(result.routes.mid, 'openai/gpt-5.6-luna');
  assert.equal(result.routes.strongest, 'openai/gpt-5.6-sol');
  assert.equal(seen.filter((model) => model.startsWith('opencode-go/')).length, 1);
});

test('Lenka primary remains provider-neutral', () => {
  const lenka = fs.readFileSync(path.join(repoRoot, 'agents', 'lenka.md'), 'utf8');
  const parsed = parseAgent(path.join(repoRoot, 'agents', 'lenka.md'));
  assert.doesNotMatch(lenka, /^model:/m);
  assert.match(lenka, /Codex, Claude Code, Kimi Code, and OpenCode use separate adapter-specific model routes/);
  assert.match(lenka, /Kimi Code has no configured subagent model pool/);
  assert.match(lenka, /Preserve every spawned agent identifier byte-for-byte/);
  assert.match(lenka, /Dynamic agent factory protocol/);
  assert.match(lenka, /Never ask the human to author this agent/);
  assert.match(lenka, /separate read-only\s+verifier/);
  assert.doesNotMatch(lenka, /create a project-local agent file \(`\.opencode/);
  assert.equal(parsed.frontmatter.permission.read['*'], 'deny');
  assert.equal(parsed.frontmatter.permission.read['.agent-orchestra/runtime/*.json'], 'allow');
  assert.equal(parsed.frontmatter.permission.glob, 'deny');
  assert.equal(parsed.frontmatter.permission.grep, 'deny');
});

test('source permission envelopes do not pin any provider model', () => {
  for (const directory of [path.join(repoRoot, 'agents'), path.join(repoRoot, 'teams', 'dev')]) {
    for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith('.md'))) {
      const source = fs.readFileSync(path.join(directory, name), 'utf8');
      assert.doesNotMatch(source, /^model:\s*.+$/m, `${name} must receive its model from the active harness manifest`);
    }
  }
});

test('live model probe requires a verified text response and records usage', () => {
  const runner = () => ({
    status: 0,
    stdout: [
      JSON.stringify({ type: 'text', part: { text: 'ORCHESTRA_MODEL_OK' } }),
      JSON.stringify({ type: 'step_finish', part: { tokens: { total: 42 }, cost: 0.001 } }),
    ].join('\n'),
    stderr: '',
  });
  const result = modelProbe(os.homedir(), 'provider/model', runner, '/fake/opencode');

  assert.equal(result.ok, true);
  assert.equal(result.tokens, 42);
  assert.equal(result.cost, 0.001);
});

test('live routing blocks a provider after 401 and uses a declared provider fallback', () => {
  const seen = [];
  const probe = (_home, model) => {
    seen.push(model);
    if (model.startsWith('openai/')) return { model, ok: false, authFailure: true, reason: 'HTTP 401', tokens: 0, cost: 0 };
    return { model, ok: true, authFailure: false, reason: 'verified response', tokens: 1, cost: 0 };
  };
  const inventory = [
    'openai/gpt-5.6-luna',
    'openai/gpt-5.6-terra',
    'openai/gpt-5.6-sol',
    'opencode-go/kimi-k2.7-code',
    'opencode-go/deepseek-v4-flash',
  ];
  const result = resolveExecutableModels(os.homedir(), inventory, probe);

  assert.equal(result.routes['dev-lead'], 'opencode-go/kimi-k2.7-code');
  assert.equal(result.routes['dev-planner'], 'opencode-go/kimi-k2.7-code');
  assert.equal(result.routes['dev-auditor'], 'opencode-go/kimi-k2.7-code');
  assert.equal(seen.filter((model) => model.startsWith('openai/')).length, 1);
  assert.deepEqual(result.blockedProviders, ['openai']);
});

test('resolved models are written only into generated role agents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestra-models-'));
  const plan = buildPlan({
    selectedTools: ['opencode'],
    home: path.join(root, 'home'),
    project: null,
    resolvedModels: { 'dev-lead': 'openai/gpt-5.6-luna' },
  });
  const lead = plan.operations.find((operation) => operation.target.endsWith(`${path.sep}dev-lead.md`));
  const planner = plan.operations.find((operation) => operation.target.endsWith(`${path.sep}dev-planner.md`));

  assert.match(lead.content, /^model: openai\/gpt-5\.6-luna$/m);
  assert.doesNotMatch(planner.content, /^model:/m);
});

test('dynamic permission envelopes receive the live factory model instead of a source pin', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestra-factory-models-'));
  const plan = buildPlan({
    selectedTools: ['opencode'],
    home: path.join(root, 'home'),
    project: null,
    resolvedModels: {},
    resolvedFactoryModels: { economy: 'opencode-go/kimi-k2.7-code', mid: 'openai/gpt-5.6-terra' },
  });
  const explorer = plan.operations.find((operation) => operation.target.endsWith(`${path.sep}explorer.md`));
  const builder = plan.operations.find((operation) => operation.target.endsWith(`${path.sep}dev-builder.md`));

  assert.match(explorer.content, /^model: opencode-go\/kimi-k2\.7-code$/m);
  assert.match(builder.content, /^model: openai\/gpt-5\.6-terra$/m);
  assert.doesNotMatch(explorer.content, /^model: opencode-go\/deepseek-v4-flash$/m);
});

test('project runtime manifest gives Lenka exact adapter-local routes without credentials', () => {
  const manifest = JSON.parse(runtimeManifest('opencode', {
    economy: 'opencode-go/kimi-k2.7-code',
    mid: 'openai/gpt-5.6-terra',
    strongest: 'openai/gpt-5.6-sol',
  }));

  assert.equal(manifest.harness, 'opencode');
  assert.deepEqual(manifest.primary, {
    role: 'coordination',
    modelClass: 'mid',
    model: 'openai/gpt-5.6-terra',
  });
  assert.deepEqual(manifest.profiles['project-read'], {
    permissionEnvelope: 'explorer',
    modelClass: 'economy',
    model: 'opencode-go/kimi-k2.7-code',
    writes: false,
    externalWrites: false,
    independentProofRequired: false,
  });
  assert.equal(JSON.stringify(manifest).match(/token|secret|credential/gi), null);
});

test('Codex runtime and generated roles pin reasoning effort by responsibility', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestra-codex-reasoning-'));
  const project = path.join(root, 'project');
  const models = {
    economy: 'gpt-5.6-luna',
    mid: 'gpt-5.6-terra',
    strongest: 'gpt-5.6-sol',
  };
  const plan = buildPlan({
    selectedTools: ['codex'],
    home: path.join(root, 'home'),
    project,
    projectOnly: true,
    resolvedModelsByTool: {
      codex: {
        'dev-lead': 'gpt-5.6-terra',
        'dev-planner': 'gpt-5.6-terra',
        'dev-builder': 'gpt-5.6-terra',
        'dev-tester': 'gpt-5.6-luna',
        'dev-auditor': 'gpt-5.6-sol',
      },
    },
    resolvedFactoryModelsByTool: { codex: models },
  });
  const role = (name) => plan.operations.find((operation) => operation.target.endsWith(`${path.sep}${name}.toml`)).content;
  assert.match(role('dev-lead'), /model_reasoning_effort = "medium"/);
  assert.match(role('dev-tester'), /model_reasoning_effort = "low"/);
  assert.match(role('dev-auditor'), /model_reasoning_effort = "high"/);
  const manifestOperation = plan.operations.find((operation) => operation.target.endsWith(`${path.sep}codex.json`));
  const manifest = JSON.parse(manifestOperation.content);
  assert.equal(manifest.primary.reasoningEffort, 'medium');
  assert.equal(manifest.profiles['project-read'].reasoningEffort, 'low');
  assert.equal(manifest.profiles['project-write'].reasoningEffort, 'medium');
});

test('project plan installs one ignored runtime manifest per selected harness', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestra-runtime-'));
  const project = path.join(root, 'project');
  const plan = buildPlan({
    selectedTools: ['opencode', 'codex'],
    home: path.join(root, 'home'),
    project,
    projectOnly: true,
    resolvedFactoryModelsByTool: {
      opencode: { economy: 'opencode-go/kimi-k2.7-code' },
      codex: { economy: 'gpt-5.6-luna' },
    },
  });

  const opencode = plan.operations.find((operation) => operation.target === path.join(project, '.agent-orchestra', 'runtime', 'opencode.json'));
  const codex = plan.operations.find((operation) => operation.target === path.join(project, '.agent-orchestra', 'runtime', 'codex.json'));
  assert.equal(JSON.parse(opencode.content).profiles['project-read'].model, 'opencode-go/kimi-k2.7-code');
  assert.equal(JSON.parse(codex.content).profiles['project-read'].model, 'gpt-5.6-luna');
  assert.equal(JSON.parse(codex.content).primary.model, null);
});

test('doctor does not call a CLI-only clean room ready without models', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestra-no-models-'));
  assert.equal(silently(() => main(['doctor', '--home', home])), 1);
});

test('clean-room install is repeatable and creates a recovery manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestra-install-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const args = ['install', '--home', home, '--project', project, '--structural'];

  assert.equal(silently(() => main(args)), 0);
  assert.ok(fs.existsSync(path.join(home, '.config', 'opencode', 'agents', 'dev-lead.md')));
  assert.ok(fs.existsSync(path.join(project, '.opencode', 'agents', 'dev-auditor.md')));
  assert.ok(fs.existsSync(path.join(project, 'AGENTS.md')));

  const repeatedPlan = buildPlan({ selectedTools: ['opencode'], home, project });
  assert.ok(classify(repeatedPlan, 'fail').every((operation) => operation.action === 'unchanged'));
  assert.equal(silently(() => main(args)), 0);

  const backupRoot = path.join(home, '.agent-orchestra', 'backups');
  assert.ok(fs.readdirSync(backupRoot).some((directory) => fs.existsSync(path.join(backupRoot, directory, 'manifest.json'))));
});

test('default conflict policy refuses every write transactionally', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestra-conflict-'));
  const home = path.join(root, 'home');
  const personaPath = path.join(home, '.config', 'opencode', 'AGENTS.md');
  fs.mkdirSync(path.dirname(personaPath), { recursive: true });
  fs.writeFileSync(personaPath, 'existing personal configuration\n');

  assert.equal(silently(() => main(['install', '--home', home, '--structural'])), 2);
  assert.equal(fs.readFileSync(personaPath, 'utf8'), 'existing personal configuration\n');
  assert.equal(fs.existsSync(path.join(home, '.config', 'opencode', 'agents', 'dev-lead.md')), false);
});

test('dry-run reports conflicts without failing or writing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestra-dry-run-'));
  const home = path.join(root, 'home');
  const personaPath = path.join(home, '.config', 'opencode', 'AGENTS.md');
  fs.mkdirSync(path.dirname(personaPath), { recursive: true });
  fs.writeFileSync(personaPath, 'keep me\n');

  assert.equal(silently(() => main(['install', '--home', home, '--dry-run'])), 0);
  assert.equal(fs.readFileSync(personaPath, 'utf8'), 'keep me\n');
  assert.equal(fs.existsSync(path.join(home, '.config', 'opencode', 'agents', 'dev-lead.md')), false);
});

test('existing persona symlinks are protected under every conflict policy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestra-symlink-'));
  const home = path.join(root, 'home');
  const canonical = path.join(root, 'PERSONALITY.md');
  const personaPath = path.join(home, '.config', 'opencode', 'AGENTS.md');
  fs.mkdirSync(path.dirname(personaPath), { recursive: true });
  fs.writeFileSync(canonical, 'canonical personality\n');
  fs.symlinkSync(canonical, personaPath);

  assert.equal(silently(() => main(['install', '--home', home, '--conflict', 'backup', '--structural'])), 0);
  assert.equal(fs.lstatSync(personaPath).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(personaPath), canonical);
  assert.equal(fs.readFileSync(canonical, 'utf8'), 'canonical personality\n');
});

test('backup conflict policy preserves replaced content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestra-backup-'));
  const home = path.join(root, 'home');
  const personaPath = path.join(home, '.config', 'opencode', 'AGENTS.md');
  fs.mkdirSync(path.dirname(personaPath), { recursive: true });
  fs.writeFileSync(personaPath, 'configuration before orchestra\n');

  assert.equal(silently(() => main(['install', '--home', home, '--conflict', 'backup', '--structural'])), 0);
  const backupRoot = path.join(home, '.agent-orchestra', 'backups');
  const manifests = fs.readdirSync(backupRoot).map((directory) => path.join(backupRoot, directory, 'manifest.json'));
  const manifest = JSON.parse(fs.readFileSync(manifests[0], 'utf8'));
  const replaced = manifest.files.find((file) => file.target === personaPath);

  assert.equal(replaced.action, 'replace');
  assert.equal(fs.readFileSync(replaced.backup, 'utf8'), 'configuration before orchestra\n');
  assert.equal(fs.readFileSync(personaPath, 'utf8'), fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8'));
});
