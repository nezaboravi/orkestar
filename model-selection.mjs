import { validTeam } from './team-routing.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const config = JSON.parse(fs.readFileSync(new URL('./orchestra.json', import.meta.url), 'utf8'));
const purposes = ['lenka', 'mid', 'economy', 'strongest'];
const labels = { lenka: 'Lenka — everyday coordination and implementation', mid: 'Workers — normal implementation', economy: 'Light work — focused checks and simple tasks', strongest: 'Independent review — careful judgment' };
const validModel = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/.test(value);

// Store only a digest, never a raw hardware identifier. Unknown identity cannot reuse choices.
export function machineFingerprint(home = os.homedir(), { platform = process.platform, read = fs.readFileSync, run = spawnSync } = {}) {
  let identity;
  try {
    if (platform === 'linux') identity = read('/etc/machine-id', 'utf8').trim();
    else if (platform === 'darwin') identity = run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 3000 }).stdout?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1];
    else if (platform === 'win32') identity = run('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', timeout: 3000 }).stdout?.match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1];
  } catch { return null; }
  return identity ? createHash('sha256').update(JSON.stringify([platform, identity, path.resolve(home)])).digest('hex') : null;
}

function selectionPath(home, harness) {
  if (!Object.hasOwn(config.modelPolicy.adapters, harness)) throw new Error('Unsupported model selection harness');
  return path.join(home, '.agent-orchestra', 'model-choices', `${harness}.json`);
}

export function validSelection(selection, inventory) {
  return selection?.schemaVersion === 1 && purposes.every(key => validModel(selection.models?.[key])
    && (!inventory || inventory.includes(selection.models[key])))
    && (!selection.externalWorkers || validTeam(selection.externalWorkers, selection.models.lenka))
    && (selection.primaryEffort == null || ['low', 'medium', 'high'].includes(selection.primaryEffort))
    && (!['cursor', 'kimi'].includes(selection.harness) || purposes.every(key => selection.models[key] === selection.models.lenka));
}

export function loadModelSelection(home, harness, fingerprint = machineFingerprint(home), { strict = false } = {}) {
  const target = selectionPath(home, harness);
  let exists = false;
  try {
    for (const current of [path.dirname(path.dirname(target)), path.dirname(target)]) {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe model choices directory');
    }
    const stat = fs.lstatSync(target);
    exists = true;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe model choices file');
    const selection = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (fingerprint && selection.machine === fingerprint && selection.harness === harness && validSelection(selection)) return selection;
  } catch (error) {
    if (error.code !== 'ENOENT') exists = true;
  }
  if (strict && exists) throw new Error('Saved model choices are invalid or belong to another computer. Run lenka setup to choose again.');
  return null;
}

export function saveModelSelection(home, harness, models, fingerprint = machineFingerprint(home), extras = {}) {
  if (!fingerprint) throw new Error('Cannot identify this machine safely; model choices were not saved.');
  const selection = { schemaVersion: 1, harness, machine: fingerprint, models, ...(extras.primaryEffort != null ? { primaryEffort: extras.primaryEffort } : {}), ...(extras.externalWorkers ? { externalWorkers: extras.externalWorkers } : {}) };
  if (!validSelection(selection)) throw new Error('Invalid model choices');
  const target = selectionPath(home, harness);
  const directory = path.dirname(target);
  for (const current of [path.dirname(directory), directory]) {
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe model choices directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(current, { mode: 0o700 });
    }
  }
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(selection, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, target);
  return selection;
}

export function recommendedModels(harness, inventory) {
  const adapter = config.modelPolicy.adapters[harness];
  const available = [...new Set(inventory.filter(validModel))];
  if (!adapter || !available.length) throw new Error('No models were listed. Check the selected tool and account, then run lenka setup again.');
  return Object.fromEntries(purposes.map(key => {
    const candidates = key === 'lenka' ? adapter.roles.lenka || adapter.classes.mid : adapter.classes[key];
    return [key, candidates.find(model => available.includes(model)) || null];
  }));
}

export async function chooseModels({ harness, inventory, question, write = console.log, previous = null, primaryOnly = false }) {
  const available = [...new Set(inventory.filter(validModel))];
  const defaults = recommendedModels(harness, available);
  write(harness === 'claude'
    ? '\nClaude aliases are supported choices; account access is not verified by this list.'
    : '\nModels reported by your tool; listing does not guarantee account access.');
  write('No generation requests are made while choosing. Recommendations balance everyday work and review; prices are not measured.');
  if (primaryOnly) write('  0. Auto — use the recommended or current CLI model');
  available.forEach((model, index) => write(`  ${index + 1}. ${model}`));
  const inherited = ['cursor', 'kimi'].includes(harness);
  if (inherited) write(primaryOnly ? 'Native children inherit Lenka’s model. Select separate CLI workers next.' : 'This adapter inherits one model for native workers.');
  const models = {};
  for (const key of (inherited || primaryOnly ? ['lenka'] : purposes)) {
    const prior = previous?.models?.[key];
    const recommended = defaults[key];
    const selected = available.includes(prior) ? prior : recommended;
    const defaultIndex = selected ? available.indexOf(selected) + 1 : null;
    const description = selected === prior ? 'saved choice' : 'recommended';
    const answer = (await question(`${labels[key]}${primaryOnly ? ' [0: Auto]' : selected ? ` [${defaultIndex}: ${selected}, ${description}]` : ' (choose a number; no known recommendation)'}: `)).trim();
    const index = primaryOnly && ['', '0'].includes(answer) ? (defaultIndex || 1) : answer === '' ? defaultIndex : (/^\d+$/.test(answer) ? Number(answer) : null);
    if (!index || !available[index - 1]) throw new Error('Invalid model selection; no choices were saved.');
    models[key] = available[index - 1];
  }
  if (inherited) for (const key of purposes) models[key] = models.lenka;
  else if (primaryOnly) for (const key of purposes) models[key] ??= defaults[key] || models.lenka;
  write('\nSelected models:');
  (inherited || primaryOnly ? ['lenka'] : purposes).forEach(key => write(`- ${labels[key]}: ${models[key]}`));
  if (primaryOnly) return models;
  const confirmation = (await question('Save these choices for this computer? [Y/n]: ')).trim().toLowerCase();
  if (!['', 'y', 'yes'].includes(confirmation)) throw new Error('Model selection cancelled; previous choices are unchanged.');
  return models;
}

export function selectionRoutes(selection) {
  if (!validSelection(selection) || (['cursor', 'kimi'].includes(selection.harness) && purposes.some(key => selection.models[key] !== selection.models.lenka))) throw new Error('Invalid model choices for an inheriting adapter');
  const factory = { economy: selection.models.economy, mid: selection.models.mid, strongest: selection.models.strongest };
  const roles = { lenka: selection.models.lenka, 'dev-lead': factory.mid };
  for (const profile of Object.values(config.agentFactory.profiles)) roles[profile.template] = factory[profile.modelClass];
  return { roles, factory };
}

export function selectionDigest(selection) {
  return createHash('sha256').update(JSON.stringify([selection.machine, selection.harness, ...purposes.map(key => selection.models[key]), selection.primaryEffort ?? null, selection.externalWorkers ?? null])).digest('hex');
}

export function runtimeMatchesSelection(manifest, selection) {
  if (!validSelection(selection) || manifest?.modelSelection !== selectionDigest(selection)) return false;
  const { roles } = selectionRoutes(selection);
  return (!selection.primaryEffort || manifest.primary?.reasoningEffort === selection.primaryEffort)
    && JSON.stringify(manifest.externalWorkers ?? null) === JSON.stringify(selection.externalWorkers ?? null)
    && manifest.primary?.model === roles.lenka && Object.entries(config.agentFactory.profiles)
    .every(([key, profile]) => manifest.profiles?.[key]?.model === roles[profile.template]);
}
