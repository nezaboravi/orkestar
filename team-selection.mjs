import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadModelSelection, saveModelSelection, validSelection, machineFingerprint, selectionDigest} from './model-selection.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = project => fs.realpathSync(project);
function location(home, kind, key, create = false) {
  let directory = home;
  for (const part of ['.agent-orchestra','teams',kind]) {
    directory = path.join(directory,part);
    if (create && !fs.existsSync(directory)) fs.mkdirSync(directory,{mode:0o700});
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe team directory');
  }
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid team identifier');
  return path.join(directory,key+'.json');
}
function read(home,kind,key) {
  try {
    const file = location(home,kind,key), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) throw new Error('Unsafe team file');
    return JSON.parse(fs.readFileSync(file,'utf8'));
  } catch(error) { if(error.code === 'ENOENT') return null; throw error; }
}
function write(home,kind,key,value) {
  const file = location(home,kind,key,true);
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Unsafe team file');
  // A scoped file contains only selected model names and a machine-bound identity.
  const temporary = file + '.tmp-' + process.pid;
  fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  fs.renameSync(temporary,file);
}
function valid(value,project,harness,home) {
  return value?.project === project && value.selection?.harness === harness
    && value.selection.machine === machineFingerprint(home) && validSelection(value.selection);
}
export function resolveTeam(home,harness,project,{active = true, environment = process.env, strict = true} = {}) {
  if (!project) return loadModelSelection(home,harness,undefined,{strict});
  project = canonical(project);
  if (active && environment.LENKA_TEAM_RUN) return loadTeamRun(home,harness,project,environment.LENKA_TEAM_RUN);
  const value = read(home,'projects',hash(project+'\0'+harness));
  if (value) {
    if (!valid(value,project,harness,home)) {
      if (strict) throw new Error('Project team is invalid or belongs to another machine. Run lenka setup.');
      return null;
    }
    return {...value.selection, scope:'project'};
  }
  const selection = loadModelSelection(home,harness,undefined,{strict});
  return selection ? {...selection,scope:'default'} : null;
}
export function saveTeam(home,harness,project,models,extras,scope) {
  project = canonical(project);
  if (!['once','project','default'].includes(scope)) throw new Error('Invalid team save scope');
  let selection = {schemaVersion:1,harness,machine:machineFingerprint(home),models,...(extras.primaryEffort != null ? {primaryEffort:extras.primaryEffort} : {}),...(extras.externalWorkers ? {externalWorkers:extras.externalWorkers} : {})};
  if (!selection.machine || !validSelection(selection)) throw new Error('Invalid team selection');
  if (scope === 'default') selection = saveModelSelection(home,harness,models,selection.machine,extras);
  if (scope === 'project') write(home,'projects',hash(project+'\0'+harness),{project,selection});
  return {...selection,scope};
}
export function snapshotTeam(home,project,selection) {
  project = canonical(project);
  const run = hash(project+'\0'+selectionDigest(selection));
  write(home,'runs',run,{project,selection});
  return {...selection,teamRun:run};
}
export function loadTeamRun(home,harness,project,run) {
  project = canonical(project);
  const value = read(home,'runs',run);
  if (!value || !valid(value,project,harness,home) || hash(project+'\0'+selectionDigest(value.selection)) !== run) throw new Error('Team session does not match this project or machine');
  return {...value.selection,teamRun:run};
}
