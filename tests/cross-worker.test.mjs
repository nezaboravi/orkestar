import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseTeam, validTeam } from '../team-routing.mjs';
import { runCrossWorker } from '../cross-worker.mjs';
const route = (model, effort = 'high', harness = 'codex') => ({ harness, model, effort, mode: 'auto' });
const team = { schemaVersion: 1, mid: route('gpt-5.6-terra','medium'), economy: route('gpt-5.6-luna','low'), strongest: route('gpt-5.6-sol') };
const selection = { schemaVersion: 1, harness: 'kimi', models: { lenka: 'kimi-code/k3' }, externalWorkers: team };
const catalog = ['gpt-5.6-terra','gpt-5.6-luna','gpt-5.6-sol'].map(model => ({ harness:'codex',model,efforts:['low','medium','high'] }));
test('Auto selects actual separate CLI routes and effort for each responsibility', async () => {
  const answers=['','','','','','','y'], output=[];
  assert.deepEqual(await chooseTeam({catalog,primary:'kimi-code/k3',question:async()=>answers.shift(),write:text=>output.push(text)}),team);
  assert.ok(output.some(line=>line.includes('codex / gpt-5.6-sol / high')));
});
test('manual reviewer cannot select the primary or builder model', async () => {
  assert.equal(validTeam({...team,strongest:team.mid},'kimi-code/k3'),false);
  assert.equal(validTeam(team,'gpt-5.6-sol'),false);

});
function fixture() {
  const project=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cross-worker-')));
  fs.writeFileSync(path.join(project,'task.json'),JSON.stringify({goal:'Review the fixture',required:['Report the observed marker']}));
  return project;
}
function deps(calls, chosen=selection) {
  return {selection:chosen,find:tool=>tool,inventory:()=>catalog.map(x=>x.model).concat('opus'),invoke:(_binary,args,options)=>{
    calls.push({args,options});
    if(args[0]==='mcp')return{status:0,stdout:'[{"name":"example"}]'};
    return{status:0,stdout:[{type:'thread.started',thread_id:'fixture-session'},{type:'item.completed',item:{type:'agent_message',text:'Reviewed fixture'}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}].map(x=>JSON.stringify(x)).join('\n')};
  }};
}
test('a Kimi conductor launches the selected Codex reviewer with read-only scope and captures evidence',()=>{
  const calls=[],project=fixture();
  const result=runCrossWorker({project,harness:'kimi',role:'strongest',taskFile:'task.json'},deps(calls));
  assert.equal(result.complete,true);assert.equal(result.acceptance,'PARTIAL');
  const launch=calls.at(-1);assert.equal(launch.options.cwd,project);
  assert.ok(launch.args.includes('gpt-5.6-sol'));assert.ok(launch.args.includes('read-only'));
  assert.ok(launch.args.includes('model_reasoning_effort="high"'));
  assert.ok(launch.args.includes('mcp_servers={}'));
  assert.equal(fs.existsSync(result.outputFile),true);
});
test('two-launch budget persists and a third call never invokes the paid worker',()=>{
  const calls=[],project=fixture(),d=deps(calls),input={project,harness:'kimi',role:'strongest',taskFile:'task.json'};
  runCrossWorker(input,d);runCrossWorker(input,d);
  assert.throws(()=>runCrossWorker(input,d),/budget reached/);
  assert.equal(calls.filter(c=>c.args[0]==='exec').length,2);
});
test('missing ownership, unsafe task path and identical reviewer fail before paid launch',()=>{
  const calls=[],project=fixture(),input={project,harness:'kimi',role:'mid',taskFile:'task.json'};
  assert.throws(()=>runCrossWorker(input,deps(calls)),/owned paths/);
  assert.throws(()=>runCrossWorker({...input,role:'strongest',taskFile:'../task.json'},deps(calls)),/escapes/);
  assert.throws(()=>runCrossWorker({...input,role:'strongest'},deps(calls,{...selection,externalWorkers:{...team,strongest:team.mid}})),/explicit cross-CLI/);
  assert.equal(calls.length,0);
});

test('Codex catalog preserves only reported supported efforts', async () => {
  const {codexModelCatalog} = await import('../orchestra.mjs');
  const result = codexModelCatalog('/fixture', () => ({status:0,stdout:JSON.stringify({models:[{slug:'known',supported_reasoning_levels:[{effort:'low'},{effort:'xhigh'}]},{slug:'hidden',visibility:'hide'}]})}), 'codex');
  assert.deepEqual(result,[{harness:'codex',model:'known',efforts:['low']}]);
});
test('saved external routes and Lenka effort survive runtime projection', async () => {
  const {runtimeManifest} = await import('../orchestra.mjs');
  const {selectionRoutes, runtimeMatchesSelection} = await import('../model-selection.mjs');
  const {refreshProjectRuntime} = await import('../project-runtime-refresh.mjs');
  const selected={...selection,harness:'codex',machine:'fixture',models:{lenka:'gpt-6-astra',mid:'gpt-5.6-terra',economy:'gpt-5.6-luna',strongest:'gpt-5.6-sol'},primaryEffort:'medium'};
  const routes=selectionRoutes(selected), manifest=JSON.parse(runtimeManifest('codex',routes.factory,routes.roles,selected));
  assert.equal(runtimeMatchesSelection(manifest,selected),true);
  const project=fixture(); refreshProjectRuntime({project,harness:'codex',manifest,selection:selected});
  const body=fs.readFileSync(path.join(project,'.codex','agents','lenka.toml'),'utf8');
  assert.match(body,/lenka delegate/);assert.match(body,/model_reasoning_effort = "medium"/);
  assert.equal(runtimeMatchesSelection({...manifest,externalWorkers:undefined},selected),false);
});
test('Claude reviewer has only read tools, isolated settings and an explicit role',()=>{
  const calls=[],project=fixture(),chosen={...selection,externalWorkers:{...team,strongest:route('opus','high','claude')}};
  const d=deps(calls,chosen);d.invoke=(_binary,args,options)=>{calls.push({args,options});return{status:0,stdout:[{type:'system',subtype:'init',session_id:'claude-fixture',model:'opus'},{type:'result',subtype:'success',result:'Reviewed',usage:{input_tokens:1,output_tokens:1}}].map(JSON.stringify).join('\n')};};
  const result=runCrossWorker({project,harness:'kimi',role:'strongest',taskFile:'task.json'},d);
  const args=calls[0].args;assert.equal(args[args.indexOf('--tools')+1],'Read,Grep,Glob');
  assert.equal(args[args.indexOf('--setting-sources')+1],'');assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(JSON.parse(args[args.indexOf('--agents')+1]).reviewer);assert.equal(result.complete,true);
});
test('legacy Kimi choices migrate to the actual team picker and save all external routes',async t=>{
  if (process.platform === 'linux') {
    const read = fs.readFileSync.bind(fs);
    t.mock.method(fs, 'readFileSync', (file, ...args) => file === '/etc/machine-id' ? 'fixture-machine-id' : read(file, ...args));
  }
  const {ensureModelSelection} = await import('../lenka.mjs');
  const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cross-picker-'))),answers=['0','0','auto','0','auto','0','auto','2'];
  const selected=await ensureModelSelection('kimi',{home,inventory:['kimi-code/k3'],teamCatalog:catalog,prompt:{question:async()=>answers.shift()},output:{write:()=>{}}});
  assert.deepEqual(selected.externalWorkers,team);assert.equal(selected.models.lenka,'kimi-code/k3');assert.equal(answers.length,0);
});
