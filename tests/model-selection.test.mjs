import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chooseModels, recommendedModels, saveModelSelection, loadModelSelection, machineFingerprint, selectionRoutes, runtimeMatchesSelection, validSelection } from '../model-selection.mjs';
import { runtimeManifest, buildPlan, resolveExecutableModels, resolveExecutableFactoryModels } from '../orchestra.mjs';
import { ensureModelSelection, up } from '../lenka.mjs';

const inventory = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const models = { lenka: inventory[0], mid: inventory[2], economy: inventory[3], strongest: inventory[1] };
const selection = { schemaVersion: 1, harness: 'codex', machine: 'machine-a', models };
const temporary = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lenka-model-choice-')));

function scripted(answers) {
  const prompts = [];
  const output = [];
  return { prompts, output, question: async text => { prompts.push(text); assert.ok(answers.length, 'unexpected prompt'); return answers.shift(); }, write: text => output.push(text) };
}

test('recommendations use the listed balanced, economy and review candidates only', () => {
  assert.deepEqual(recommendedModels('codex', inventory), { lenka: inventory[0], mid: inventory[2], economy: inventory[3], strongest: inventory[1] });
  assert.deepEqual(recommendedModels('codex', ['gpt-5.6-terra']), Object.fromEntries(['lenka', 'mid', 'economy', 'strongest'].map(key => [key, 'gpt-5.6-terra'])));
  assert.deepEqual(recommendedModels('claude', ['opus', 'sonnet', 'haiku']), { lenka: 'sonnet', mid: 'sonnet', economy: 'haiku', strongest: 'opus' });
  assert.throws(() => recommendedModels('codex', []), /No models were listed/);
});

test('Enter accepts recommendations and explicit choice overrides Lenka without changing workers', async () => {
  const io = scripted(['1', '', '', '', '']);
  assert.deepEqual(await chooseModels({ harness: 'codex', inventory, ...io }), models);
  assert.match(io.prompts[0], /gpt-6-astra, recommended/);
  assert.match(io.output.join('\n'), /does not guarantee account access/);
  assert.equal(io.prompts.length, 5);
});

test('unknown inventory requires an explicit choice, and cancellation is not acceptance', async () => {
  await assert.rejects(chooseModels({ harness: 'cursor', inventory: ['new-model'], ...scripted(['']) }), /Invalid model selection/);
  const chosen = await chooseModels({ harness: 'cursor', inventory: ['new-model'], ...scripted(['1', 'yes']) });
  assert.equal(chosen.lenka, 'new-model');
  await assert.rejects(chooseModels({ harness: 'codex', inventory, ...scripted(['', '', '', '', 'n']) }), /cancelled/);
  await assert.rejects(chooseModels({ harness: 'codex', inventory, ...scripted(['1x']) }), /Invalid/);
});

test('Claude aliases are not represented as verified account access', async () => {
  const io = scripted(['', '', '', '', '']);
  await chooseModels({ harness: 'claude', inventory: ['sonnet', 'haiku', 'opus'], ...io });
  assert.match(io.output.join('\n'), /account access is not verified/);
});

test('choices survive on this machine and are rejected after a machine change or corrupt data', () => {
  const home = temporary();
  const saved = saveModelSelection(home, 'codex', models, 'machine-a');
  assert.deepEqual(loadModelSelection(home, 'codex', 'machine-a'), saved);
  assert.equal(loadModelSelection(home, 'codex', 'machine-b'), null);
  assert.equal(loadModelSelection(home, 'codex', null), null);
  assert.equal(validSelection(saved, ['gpt-5.6-terra']), false);
  assert.throws(() => saveModelSelection(home, '../elsewhere', models, 'a'), /Unsupported/);
  assert.throws(() => saveModelSelection(home, 'codex', { ...models, lenka: 'a\nmodel = "evil"' }, 'a'), /Invalid/);
  fs.writeFileSync(path.join(home, '.agent-orchestra/model-choices/codex.json'), '{');
  assert.equal(loadModelSelection(home, 'codex', 'machine-a'), null);
});

test('machine binding hashes OS identity and home; unavailable identity fails closed', () => {
  const options = { platform: 'linux', read: () => 'machine-a' };
  const hash = machineFingerprint('/home/user', options);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, machineFingerprint('/home/user', { ...options, read: () => 'machine-b' }));
  assert.notEqual(hash, machineFingerprint('/home/other', options));
  assert.equal(machineFingerprint('/home/user', { ...options, read: () => { throw new Error(); } }), null);
  assert.match(machineFingerprint('/home/user', { platform: 'darwin', run: () => ({ stdout: '"IOPlatformUUID" = "fixture-id"' }) }), /^[a-f0-9]{64}$/);
  assert.match(machineFingerprint('/home/user', { platform: 'win32', run: () => ({ stdout: 'MachineGuid    REG_SZ    fixture-id' }) }), /^[a-f0-9]{64}$/);
});

test('all harnesses apply independent Lenka choice plus worker classes to actual profiles', () => {
  for (const harness of ['codex', 'claude', 'opencode', 'cursor', 'kimi']) {
    const inherited = ['cursor', 'kimi'].includes(harness);
    const expected = inherited ? Object.fromEntries(Object.keys(models).map(key => [key, models.lenka])) : models;
    const chosen = { ...selection, harness, models: expected };
    const { roles, factory } = selectionRoutes(chosen);
    const manifest = JSON.parse(runtimeManifest(harness, factory, roles, chosen));
    assert.equal(manifest.primary.model, expected.lenka);
    assert.equal(manifest.profiles['project-write'].model, expected.mid);
    assert.equal(manifest.profiles['project-test'].model, expected.economy);
    assert.equal(manifest.profiles['code-review'].model, expected.strongest);
    assert.equal(runtimeMatchesSelection(manifest, chosen), true);
    assert.equal(runtimeMatchesSelection(manifest, { ...chosen, machine: 'other-machine' }), false);
    const plan = buildPlan({ home: temporary(), project: temporary(), projectOnly: true, selectedTools: [harness],
      resolvedModelsByTool: { [harness]: roles }, resolvedFactoryModelsByTool: { [harness]: factory }, modelSelectionsByTool: { [harness]: chosen } });
    const output = plan.operations.find(item => item.target.endsWith(path.join('runtime', `${harness}.json`)));
    assert.equal(runtimeMatchesSelection(JSON.parse(output.content), chosen), true);
    const worker = plan.operations.find(item => /dev-builder\.(toml|md)$/.test(item.target));
    if (!inherited) assert.ok(worker.content.includes(expected.mid));
    else if (harness === 'cursor') assert.match(worker.content, /model: inherit/);
  }
});

test('a rejected selected model never falls back to another listed model', () => {
  const probed = [];
  const cache = new Map();
  const probe = (_home, model) => {
    if (!cache.has(model)) { probed.push(model); cache.set(model, { model, ok: model !== models.lenka }); }
    return cache.get(model);
  };
  const roles = resolveExecutableModels('/fixture', inventory, probe, 'codex', selection);
  const factory = resolveExecutableFactoryModels('/fixture', inventory, probe, 'codex', selection);
  assert.equal(roles.routes.lenka, null);
  assert.equal(roles.routes['dev-builder'], models.mid);
  assert.equal(factory.routes.strongest, models.strongest);
  assert.deepEqual(new Set(probed), new Set(Object.values(models)));
});

test('startup reuses locally saved listed choices without prompting or generation', async t => {
  // Containers may have no machine-id; this test uses a stable fixture identity.
  if (process.platform === 'linux') {
    const read = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (file, ...args) => file === '/etc/machine-id' ? 'fixture-machine-id' : read(file, ...args));
  }
  const home = temporary();
  saveModelSelection(home, 'codex', models);
  const result = await ensureModelSelection('codex', { home, inventory, input: { isTTY: false }, output: { isTTY: false }, prompt: { question: () => { throw new Error('unexpected prompt'); } } });
  assert.deepEqual(result.models, models);
  await assert.rejects(ensureModelSelection('codex', { home, inventory: ['gpt-5.6-terra'], input: { isTTY: false }, output: { isTTY: false } }), /lenka setup/);
});

test('startup will not launch a copied or previously selected runtime', async () => {
  const project = temporary();
  let launches = 0;
  let bootstraps = 0;
  const { roles, factory } = selectionRoutes(selection);
  const refreshed = JSON.parse(runtimeManifest('codex', factory, roles, selection));
  await up({ project, workspace: 'direct', workspaceExplicit: true, harness: 'codex', noLaunch: true, conflict: 'backup' }, {
    loadPreferences: () => ({ harness: 'codex', workspace: 'direct' }), ensureHarnessAuthentication: async () => {},
    ensureModelSelection: async () => selection,
    selectInstalledRuntime: () => ({ harness: 'codex', manifest: bootstraps ? refreshed : { primary: { model: models.lenka } } }),
    launchInstalledRuntime: () => { launches++; }, run: () => { bootstraps++; return 0; },
  });
  assert.equal(launches, 0);
  assert.equal(bootstraps, 1);
});

 test('direct install and doctor reject foreign or corrupt saved choices instead of defaults', () => {
  const home = temporary();
  const file = path.join(home, '.agent-orchestra/model-choices/codex.json');
  for (const corrupt of [false, true]) {
    saveModelSelection(home, 'codex', models, 'foreign-machine');
    if (corrupt) fs.writeFileSync(file, '{');
    for (const command of ['install', 'doctor']) {
      const result = spawnSync(process.execPath, ['orchestra.mjs', command, '--home', home, '--tool', 'codex', '--structural', '--dry-run'], {
        cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, PATH: '/nonexistent' }, encoding: 'utf8', timeout: 10000,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Saved model choices.*lenka setup/);
      assert.equal(fs.existsSync(path.join(home, '.codex')), false);
    }
  }
});

test('unsafe parent is rejected before any outside directory is created', { skip: process.platform === 'win32' }, () => {
  const home = temporary();
  const outside = temporary();
  fs.symlinkSync(outside, path.join(home, '.agent-orchestra'));
  assert.throws(() => saveModelSelection(home, 'codex', models, 'fixture'), /Unsafe/);
  assert.equal(fs.existsSync(path.join(outside, 'model-choices')), false);
});

test('strict load rejects both symlinked choice files and parent directories', { skip: process.platform === 'win32' }, () => {
  const outside = temporary();
  saveModelSelection(outside, 'codex', models, 'fixture');
  const home = temporary();
  fs.mkdirSync(path.join(home, '.agent-orchestra/model-choices'), { recursive: true });
  fs.symlinkSync(path.join(outside, '.agent-orchestra/model-choices/codex.json'), path.join(home, '.agent-orchestra/model-choices/codex.json'));
  assert.throws(() => loadModelSelection(home, 'codex', 'fixture', { strict: true }), /invalid/);
  const second = temporary();
  fs.symlinkSync(path.join(outside, '.agent-orchestra'), path.join(second, '.agent-orchestra'));
  assert.throws(() => loadModelSelection(second, 'codex', 'fixture', { strict: true }), /invalid/);
  assert.equal(loadModelSelection(outside, 'codex', 'fixture', { strict: true }).models.lenka, models.lenka);
});

test('OpenCode startup keeps autonomous routing without requiring saved model choices', async () => {
  let launches = 0;
  await up({ project: temporary(), workspace: 'direct', workspaceExplicit: true, harness: 'opencode', conflict: 'backup' }, {
    loadPreferences: () => ({ harness: 'opencode', workspace: 'direct' }),
    ensureHarnessAuthentication: async () => {},
    ensureModelSelection: async () => { throw new Error('OpenCode must not require manual model choices'); },
    selectInstalledRuntime: () => ({ harness: 'opencode', manifest: {} }),
    launchInstalledRuntime: () => { launches++; return 0; },
    run: () => { throw new Error('unexpected bootstrap'); },
  });
  assert.equal(launches, 1);
});
