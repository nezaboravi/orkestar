import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {saveTeam, resolveTeam, snapshotTeam, loadTeamRun} from '../team-selection.mjs';
import {searchableChoice,chooseEffort} from '../searchable-choice.mjs';
import {ensureModelSelection} from '../lenka.mjs';
const models={lenka:'kimi-code/k3',mid:'kimi-code/k3',economy:'kimi-code/k3',strongest:'kimi-code/k3'};
const route=(model,effort)=>({harness:'codex',model,effort,mode:'auto'});
const externalWorkers={schemaVersion:1,mid:route('gpt-5.6-terra','medium'),economy:route('gpt-5.6-luna','low'),strongest:route('gpt-5.6-sol','high')};
const extras={externalWorkers};
function fixture(t) {
 if(process.platform==='linux'){const read=fs.readFileSync.bind(fs);t.mock.method(fs,'readFileSync',(file,...args)=>file==='/etc/machine-id'?'fixture-machine':read(file,...args));}
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'team-scope-')));
 const first=path.join(home,'one'),second=path.join(home,'two');fs.mkdirSync(first);fs.mkdirSync(second);return{home,first,second};
}
test('search is paged and text filters a large inventory before numeric choice',async()=>{
 const items=Array.from({length:200},(_,i)=>`model-${i}`).concat('cursor-grok-low','cursor-grok-high');const output=[],answers=['grok','9','2'];
 const selected=await searchableChoice({items,recommended:items[0],question:async()=>answers.shift(),write:x=>output.push(x)});
 assert.equal(selected.item,'cursor-grok-high');assert.ok(!output.some(x=>x.includes('model-150')));assert.ok(output.some(x=>x.includes('Invalid')||x.includes('Choose a number')));
});
test('efforts are vertical numbered options and invalid input preserves the question',async()=>{
 const output=[],answers=['typo','99','2'];
 assert.equal(await chooseEffort({levels:['low','medium','high'],fallback:'low',question:async()=>answers.shift(),write:x=>output.push(x)}),'medium');
 assert.ok(output.includes('  1. low'));assert.ok(output.includes('  2. medium'));assert.ok(output.includes('  3. high'));
 assert.equal(await chooseEffort({levels:['low','medium','high'],fallback:'low',question:async()=> 'm',write:()=>{}}),'medium');
});
test('project choices isolate projects and once does not change either saved choice',t=>{
 const {home,first,second}=fixture(t);
 saveTeam(home,'kimi',first,models,extras,'default');
 const changed={externalWorkers:{...externalWorkers,economy:route('gpt-5.6-terra','low')}};
 saveTeam(home,'kimi',first,models,changed,'project');
 assert.equal(resolveTeam(home,'kimi',first,{active:false}).externalWorkers.economy.model,'gpt-5.6-terra');
 assert.equal(resolveTeam(home,'kimi',second,{active:false}).externalWorkers.economy.model,'gpt-5.6-luna');
 const once=saveTeam(home,'kimi',first,models,extras,'once'),snap=snapshotTeam(home,first,once);
 assert.equal(loadTeamRun(home,'kimi',first,snap.teamRun).externalWorkers.economy.model,'gpt-5.6-luna');
 assert.equal(resolveTeam(home,'kimi',first,{active:false}).externalWorkers.economy.model,'gpt-5.6-terra');
 assert.throws(()=>loadTeamRun(home,'kimi',second,snap.teamRun),/does not match/);
 assert.equal(resolveTeam(home,'kimi',first,{environment:{LENKA_TEAM_RUN:snap.teamRun}}).scope,'once');
});
test('snapshot keeps its team after defaults change and rejects tampering',t=>{
 const {home,first}=fixture(t),selected=saveTeam(home,'kimi',first,models,extras,'default'),snap=snapshotTeam(home,first,selected);
 saveTeam(home,'kimi',first,models,{externalWorkers:{...externalWorkers,economy:route('gpt-5.6-terra','medium')}},'default');
 assert.equal(loadTeamRun(home,'kimi',first,snap.teamRun).externalWorkers.economy.model,'gpt-5.6-luna');
 assert.throws(()=>loadTeamRun(home,'kimi',first,'../bad'),/Invalid team/);
});
test('startup displays active team, retries invalid action and offers change without overwriting saved team',async t=>{
 const {home,first}=fixture(t);saveTeam(home,'kimi',first,models,extras,'project');
 const output=[],answers=['oops','1'];
 const selected=await ensureModelSelection('kimi',{home,project:first,inventory:['kimi-code/k3'],prompt:{question:async()=>answers.shift()},output:{write:x=>output.push(x)}});
 assert.equal(selected.scope,'project');assert.ok(output.join('').includes('2. Change team'));assert.ok(output.join('').includes('gpt-5.6-sol'));
});
test('team storage rejects symlinked directories and modified run routes',t=>{
 const {home,first}=fixture(t),selected=saveTeam(home,'kimi',first,models,extras,'once'),snap=snapshotTeam(home,first,selected);
 const file=path.join(home,'.agent-orchestra','teams','runs',snap.teamRun+'.json'),data=JSON.parse(fs.readFileSync(file));
 data.selection.externalWorkers.economy.effort='high';fs.writeFileSync(file,JSON.stringify(data));
 assert.throws(()=>loadTeamRun(home,'kimi',first,snap.teamRun),/does not match/);
 const other=path.join(home,'other-home');fs.mkdirSync(other);fs.mkdirSync(path.join(other,'.agent-orchestra'));
 try{fs.symlinkSync(path.join(home,'.agent-orchestra','teams'),path.join(other,'.agent-orchestra','teams'),'dir');}catch(error){if(error.code==='EPERM')return;throw error;}
 assert.throws(()=>saveTeam(other,'kimi',first,models,extras,'project'),/Unsafe team directory/);
});
