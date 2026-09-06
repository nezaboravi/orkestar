import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseCodexEvidence } from './native-codex-evidence.mjs';

export const RECOVERY_LIMIT = 32 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const json = value => { try { return JSON.parse(value); } catch { throw new Error('Invalid recovery JSON'); } };
// Fixed protocol: no resume, turn/start, model request, config/auth read or shell.
const probe = `
const {spawn}=require('node:child_process');
const {binary,project,threadId}=JSON.parse(process.argv[1]);
const p=spawn(binary,['app-server','--stdio'],{cwd:project,stdio:['pipe','pipe','ignore']});
let buffer='',bytes=0,done=false;const decoder=new TextDecoder('utf-8',{fatal:true});
const finish=value=>{if(done)return;done=true;clearTimeout(timer);if(value)process.stdout.write(JSON.stringify(value));else process.exitCode=1;p.kill();};
const timer=setTimeout(()=>finish(),29000);
p.on('error',()=>finish());p.on('exit',()=>finish());p.stdin.on('error',()=>finish());
const send=value=>p.stdin.write(JSON.stringify(value)+'\\n');
p.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>33554432)return finish();let end;try{buffer+=decoder.decode(chunk,{stream:true});while((end=buffer.indexOf('\\n'))>=0){const row=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(row.id===1){if(row.error)return finish();send({method:'initialized'});send({id:2,method:'thread/read',params:{threadId,includeTurns:true}});}if(row.id===2)return finish(row.error?null:row.result);}}catch{finish();}});
send({id:1,method:'initialize',params:{clientInfo:{name:'orkestar-recovery',version:'1'},capabilities:{experimentalApi:true}}});
`;

function boundedFile(file) {
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Unsafe recovery path');
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > RECOVERY_LIMIT) throw new Error('Recovery file exceeds bound');
    const buffer = Buffer.alloc(stat.size + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size !== stat.size) throw new Error('Recovery file changed');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
  } finally { fs.closeSync(fd); }
}

/** Caller supplies verified terminal completion and immutable launch bytes.
 * Returns separate evidence; never replaces a receipt, capture, or verdict.
 */
export function recoverCodexWorker({ project, receipt, launchEncoded, rawPrefix, exitCode }, { invoke = spawnSync, now = Date.now } = {}) {
  if (!path.isAbsolute(project ?? '') || fs.realpathSync(project) !== project || receipt?.project !== project
    || receipt.harness !== 'codex' || !['Exited', 'exited'].includes(receipt.state) || exitCode !== 0 || !uuid.test(receipt.runId ?? '')
    || typeof launchEncoded !== 'string' || Buffer.byteLength(launchEncoded) > 262144 || hash(launchEncoded) !== receipt.liveLaunchHash
    || typeof rawPrefix !== 'string' || Buffer.byteLength(rawPrefix) > 1048576) throw new Error('Invalid recovery binding');
  const launch = json(launchEncoded);
  if (launch.project !== project || launch.runId !== receipt.runId || launch.harness !== 'codex' || launch.model !== receipt.model
    || launch.role !== receipt.role || !Array.isArray(launch.args) || launch.args.some(arg => typeof arg !== 'string')
    || hash(JSON.stringify(launch.args)) !== receipt.argumentsHash || !path.isAbsolute(launch.binary ?? '')
    || !['codex', 'codex.exe'].includes(path.basename(launch.binary))) throw new Error('Invalid recovery launch');
  fs.accessSync(launch.binary, fs.constants.X_OK);
  const first = json(rawPrefix.split(/\r?\n/, 1)[0]);
  const threadId = first.thread_id;
  if (first.type !== 'thread.started' || !uuid.test(threadId ?? '')) throw new Error('Missing exact recovery thread');
  const response = invoke(process.execPath, ['-e', probe, JSON.stringify({ binary: launch.binary, project, threadId })],
    { cwd: project, encoding: 'utf8', timeout: 30000, maxBuffer: RECOVERY_LIMIT });
  if (response.error || response.status !== 0 || typeof response.stdout !== 'string' || Buffer.byteLength(response.stdout) > RECOVERY_LIMIT) throw new Error('Native recovery read failed');
  const thread = json(response.stdout).thread;
  if (thread?.id !== threadId || thread.cwd !== project || !Array.isArray(thread.turns) || thread.turns.length !== 1
    || thread.turns[0].status !== 'completed' || !uuid.test(thread.turns[0].id ?? '')) throw new Error('Recovery thread is mismatched or incomplete');
  const turn = thread.turns[0];
  const finals = (turn.items ?? []).filter(item => item.type === 'agentMessage' && item.phase === 'final_answer');
  if (finals.length !== 1 || typeof finals[0].text !== 'string' || !finals[0].text.trim() || Buffer.byteLength(finals[0].text) > 262144) throw new Error('Recovery final answer is missing or ambiguous');
  let tokens = null, rolloutHash = null;
  if (thread.path != null) {
    if (!path.isAbsolute(thread.path) || !new RegExp(`[/\\\\]sessions[/\\\\]\\d{4}[/\\\\]\\d{2}[/\\\\]\\d{2}[/\\\\]rollout-[0-9T-]+-${threadId}\\.jsonl$`).test(thread.path)) throw new Error('Invalid native recovery rollout path');
    const raw = boundedFile(thread.path);
    const records = raw.split(/\r?\n/).filter(Boolean).map(json);
    const meta = records[0];
    if (meta?.type !== 'session_meta' || meta.payload?.id !== threadId || meta.payload.cwd !== project) throw new Error('Recovery rollout identity mismatch');
    const starts = records.filter(row => row.type === 'event_msg' && row.payload?.type === 'task_started');
    const terminals = records.filter(row => row.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(row.payload?.type));
    if (starts.length !== 1 || starts[0].payload.turn_id !== turn.id || terminals.length !== 1
      || terminals[0].payload.type !== 'task_complete' || terminals[0].payload.turn_id !== turn.id) throw new Error('Recovery rollout turn mismatch');
    const rolloutFinals = records.filter(row => row.type === 'response_item' && row.payload?.type === 'message'
      && row.payload.role === 'assistant' && row.payload.phase === 'final_answer');
    if (rolloutFinals.length !== 1 || !Array.isArray(rolloutFinals[0].payload.content)
      || rolloutFinals[0].payload.content.some(item => item.type !== 'output_text' || typeof item.text !== 'string')
      || rolloutFinals[0].payload.content.map(item => item.text).join('') !== finals[0].text) throw new Error('Recovery final evidence mismatch');
    const usage = parseCodexEvidence(records).tokens;
    tokens = usage && { input: usage.input, output: usage.output, total: usage.total,
      ...(usage.cacheRead !== null ? { cachedInput: usage.cacheRead, uncachedInput: usage.input - usage.cacheRead } : {}),
      ...(usage.reasoning !== null ? { reasoning: usage.reasoning } : {}) };
    rolloutHash = hash(raw);
  }
  const provenance = { schemaVersion: 1, method: 'thread/read', runId: receipt.runId, threadId, turnId: turn.id,
    project, launchHash: receipt.liveLaunchHash, originalPrefixHash: hash(rawPrefix), responseHash: hash(response.stdout), rolloutHash, recoveredAt: now() };
  return { sessionId: threadId, result: finals[0].text, tokens, cost: null, complete: true,
    recoveryProvenance: { ...provenance, hash: hash(JSON.stringify(provenance)) } };
}
