import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { createNativeEvidenceStream, NATIVE_EVENT_LIMIT } from './native-worker-stream.mjs';

const LIMIT = 1024 * 1024;
const hash = text => createHash('sha256').update(text).digest('hex');
export const liveWorkerCommand = (node = process.execPath, platform = process.platform) => platform === 'win32'
  ? `"${node.replaceAll('"', '')}"` : `'${node.replaceAll("'", "'\\''")}'`;
const safe = text => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/(?:Bearer\s+\S+|sk-[\w-]+|(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+)/gi, '[redacted]').slice(0, 2400);
const TRUST_ERROR = Buffer.from('Not inside a trusted directory and --skip-git-repo-check was not specified.');
const TRUST_DIAGNOSTIC = Object.freeze({ code: 'CODEX_TRUSTED_DIRECTORY_REQUIRED',
  message: 'Codex refused to start outside a trusted Git directory. The Orkestar launcher must handle the approved project explicitly; no agent work was verified.' });

/** Recognize only fixed startup text; retain no stderr and inspect at most 64 KiB. */
export function createStartupDiagnosticClassifier(harness, onDiagnostic = () => {}) {
  let inspected = 0, matched = 0, found = false;
  return {
    write(chunk) {
      if (harness !== 'codex' || found || inspected >= 65536) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const count = Math.min(bytes.length, 65536 - inspected);
      inspected += count;
      for (let index = 0; index < count; index++) {
        // This fixed pattern has no repeated initial byte, so no prefix table is needed.
        matched = bytes[index] === TRUST_ERROR[matched] ? matched + 1 : bytes[index] === TRUST_ERROR[0] ? 1 : 0;
        if (matched === TRUST_ERROR.length) { found = true; onDiagnostic({ ...TRUST_DIAGNOSTIC }); break; }
      }
    },
    result: () => found ? { ...TRUST_DIAGNOSTIC } : null,
  };
}
export function liveWorkerTool(tools, node = process.execPath) {
  const found = tools.filter(tool => Number.isSafeInteger(tool.id) && tool.id > 0 && tool.name === 'Orkestar Worker' && tool.toolType === 'generic' && tool.enabled === true && [node, liveWorkerCommand(node)].includes(tool.command));
  if (found.length !== 1) throw new Error(`Readable Solo workers need one-time setup: Settings > Agents > Add tool. Name: Orkestar Worker; Command: ${liveWorkerCommand(node)}; Default arguments: empty; Tool type mode: Set manually; Tool type: Generic. Do not modify existing tools. Then retry lenka up.`);
  return found[0];
}
function checked(project, file) {
  if (fs.realpathSync(project) !== project || !path.isAbsolute(project)) throw new Error('Invalid live worker project');
  const relative = path.relative(project, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid live worker path');
  let current = project;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Unsafe live worker path');
  }
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > LIMIT) throw new Error('Invalid live worker file');
  return fs.readFileSync(file, 'utf8');
}
export function readLiveWorkerOutput(project, receipt) {
  const base = path.join(project, '.agent-orchestra/dispatch', `native-${receipt.runId}`);
  const raw = checked(project, `${base}.raw`);
  const done = JSON.parse(checked(project, `${base}.output.json`));
  if (done.runId !== receipt.runId || done.launchHash !== receipt.liveLaunchHash || done.rawHash !== hash(raw)) throw new Error('Live worker evidence identity mismatch');
  if (typeof done.diagnostic !== 'boolean' || typeof done.truncated !== 'boolean' || !Number.isSafeInteger(done.exitCode) || done.exitCode < 0 || done.exitCode > 255) throw new Error('Invalid live worker completion');
  if (done.startupDiagnostic !== undefined && (done.diagnostic !== true || !done.startupDiagnostic
    || Object.keys(done.startupDiagnostic).length !== 2 || done.startupDiagnostic.code !== TRUST_DIAGNOSTIC.code
    || done.startupDiagnostic.message !== TRUST_DIAGNOSTIC.message)) throw new Error('Invalid startup diagnostic');
  const startup = done.startupDiagnostic ? { startupDiagnostic: { ...TRUST_DIAGNOSTIC } } : {};
  if (done.schemaVersion === 2) {
    const compact = checked(project, `${base}.evidence.jsonl`);
    if (done.evidenceHash !== hash(compact) || !/^[a-f0-9]{64}$/.test(done.fullStreamHash) || !Number.isSafeInteger(done.fullStreamBytes) || done.fullStreamBytes < 0
      || !['rawTruncated', 'evidenceTruncated', 'streamInvalid'].every(key => typeof done[key] === 'boolean')
      || (done.rawTruncated && (done.fullStreamBytes <= LIMIT || fs.statSync(`${base}.raw`).size !== LIMIT))
      || (!done.rawTruncated && (done.fullStreamHash !== hash(raw) || done.fullStreamBytes !== Buffer.byteLength(raw)))
      || done.truncated !== (done.evidenceTruncated || done.streamInvalid)) throw new Error('Invalid compact native evidence');
    return { raw: done.rawTruncated ? compact : raw, diagnostic: done.diagnostic, truncated: done.truncated, exitCode: done.exitCode, rawTruncated: done.rawTruncated, evidenceTruncated: done.evidenceTruncated, streamInvalid: done.streamInvalid, ...startup };
  }
  if (done.schemaVersion !== undefined && done.schemaVersion !== 1) throw new Error('Unsupported native evidence version');
  return { raw, diagnostic: done.diagnostic, truncated: done.truncated, exitCode: done.exitCode, ...startup };
}
export function createLiveRenderer(write) {
  let buffer = '', count = 0; const decoder = new StringDecoder('utf8');
  return chunk => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > NATIVE_EVENT_LIMIT) throw new Error('Live event exceeds bound');
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row.type === 'thread.started' || (row.type === 'system' && row.subtype === 'init')) write('Session started.\n');
      const item = row.item;
      if (row.type === 'item.completed' && item?.type === 'agent_message') write(`${safe(item.text)}\n\n`);
      else if (row.type === 'item.completed') { count++; write(`Step ${count}: ${safe(item?.type ?? 'operation')} finished.\n`); }
      if (row.type === 'result' && typeof row.result === 'string') write(`${safe(row.result)}\n`);
      if (row.type === 'turn.completed' || row.type === 'result') {
        const usage = row.usage;
        if (Number.isSafeInteger(usage?.input_tokens) && usage.input_tokens >= 0 && Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0) {
          const cost = typeof row.total_cost_usd === 'number' && Number.isFinite(row.total_cost_usd) && row.total_cost_usd >= 0 ? `$${row.total_cost_usd}` : 'unavailable';
          write(`Reported input: ${usage.input_tokens}; output: ${usage.output_tokens}. Cost: ${cost}.\n`);
          if (Number.isSafeInteger(usage.cached_input_tokens) && usage.cached_input_tokens >= 0 && usage.cached_input_tokens <= usage.input_tokens) write(`Cached input: ${usage.cached_input_tokens}. Input is cumulative, not a full-price charge.\n`);
        }
        write('Response received. Independent review is still required.\n');
      }
    }
  };
}
export async function runLiveWorker(project, runId, expectedHash) {
  if (!/^[a-f0-9-]{36}$/.test(runId) || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Invalid live worker identity');
  const base = path.join(project, '.agent-orchestra/dispatch', `native-${runId}`);
  const encoded = checked(project, `${base}.launch.json`);
  if (hash(encoded) !== expectedHash) throw new Error('Live worker launch changed');
  const spec = JSON.parse(encoded);
  if (spec.project !== project || spec.runId !== runId || !['codex', 'claude'].includes(spec.harness)
    || !Array.isArray(spec.args) || spec.args.some(x => typeof x !== 'string') || typeof spec.binary !== 'string') throw new Error('Invalid live worker launch');
  const fd = fs.openSync(`${base}.raw`, 'wx', 0o600);
  const render = createLiveRenderer(text => process.stdout.write(text));
  const evidenceStream = createNativeEvidenceStream(spec.harness);
  const startup = createStartupDiagnosticClassifier(spec.harness, diagnostic => process.stdout.write(`${diagnostic.code}: ${diagnostic.message}\n`));
  process.stdout.write(`${safe(spec.name)}\nRole: ${safe(spec.role)} | Requested model: ${safe(spec.model)}\n\n`);
  let bytes = 0, failed = false, truncated = false, renderFailed = false, exitCode = 0;
  const child = spawn(spec.binary, spec.args, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = () => child.kill();
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  child.stderr.on('data', chunk => { if (!failed) process.stdout.write('Native diagnostic received; inspect the final result before accepting work.\n'); failed = true; startup.write(chunk); });
  child.stdout.on('data', chunk => {
    const remaining = LIMIT - bytes;
    evidenceStream.write(chunk);
    if (chunk.length > remaining && !truncated) { truncated = true; process.stdout.write('Raw diagnostic capture limit reached. Work continues; compact result evidence is still being validated.\n'); }
    const captured = chunk.subarray(0, Math.max(0, remaining));
    fs.writeSync(fd, captured); bytes += captured.length;
    if (!renderFailed) try { render(chunk); } catch { renderFailed = true; failed = true; process.stdout.write('An oversized live event could not be displayed. Work continues.\n'); }
  });
  await new Promise(resolve => { child.on('error', () => { failed = true; }); child.on('close', code => { exitCode = code ?? 1; if (exitCode !== 0) failed = true; resolve(); }); });
  fs.closeSync(fd); process.off('SIGTERM', stop); process.off('SIGINT', stop);
  const raw = checked(project, `${base}.raw`);
  const stream = evidenceStream.finish();
  fs.writeFileSync(`${base}.evidence.jsonl`, stream.compact, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(`${base}.output.json`, JSON.stringify({ schemaVersion: 2, runId, launchHash: expectedHash, rawHash: hash(raw), evidenceHash: hash(stream.compact),
    fullStreamHash: stream.fullStreamHash, fullStreamBytes: stream.fullStreamBytes, streamInvalid: stream.streamInvalid, evidenceTruncated: stream.evidenceTruncated,
    diagnostic: failed, truncated: stream.evidenceTruncated || stream.streamInvalid, rawTruncated: truncated, exitCode,
    ...(startup.result() ? { startupDiagnostic: startup.result() } : {}) }), { flag: 'wx', mode: 0o600 });
  if (stream.evidenceTruncated || stream.streamInvalid) process.stdout.write('Complete native result evidence is unavailable. Acceptance remains partial.\n');
  process.stdout.write(failed ? 'Worker exited with a diagnostic. Acceptance is pending.\n' : 'Worker exited. Acceptance is pending.\n');
  return exitCode;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--version') process.stdout.write('Orkestar Worker 1\n');
  else runLiveWorker(...process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => { process.stderr.write('Orkestar Worker failed safely; inspect the bound result.\n'); process.exitCode = 1; });
}
