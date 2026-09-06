#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  CONDUCTOR_PROTOCOL_VERSION, createJsonLineReader, createParagraphRenderer,
  readableConductorEvent, safeConductorText, safeEvidenceRecord,
} from './native-conductor-protocol.mjs';

const MAX_EVIDENCE = 1024 * 1024;
const RPC_TIMEOUT_MS = 15_000;
const INPUT_TIMEOUT_MS = 120_000;
const usage = 'Usage: native-conductor-live.mjs --project <absolute-path> --codex <binary> --model <model> --instructions-base64 <base64> --marker <marker> [--effort <effort>]\n';
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1] || null; };
const project = arg('--project'); const binary = arg('--codex'); const model = arg('--model'); const marker = arg('--marker');
const effort = arg('--effort'); const instructionBytes = arg('--instructions-base64');
const isMain = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;

function write(line = '') { process.stdout.write(`${line}\n`); }

function assertCanonicalDirectory(directory) {
  if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Invalid conductor project');
  const parsed = path.parse(directory); let current = parsed.root;
  for (const part of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Unsafe symlink in conductor project path');
  }
}

function ensurePrivateDirectory(directory) {
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe conductor evidence path');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(directory, { mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe conductor evidence path');
  }
}

export function openPrivateEvidence(projectPath, evidenceMarker) {
  assertCanonicalDirectory(projectPath);
  const orchestra = path.join(projectPath, '.agent-orchestra'); ensurePrivateDirectory(orchestra);
  const base = path.join(orchestra, 'conductor'); ensurePrivateDirectory(base);
  if (fs.realpathSync(base) !== base || !fs.realpathSync(base).startsWith(`${projectPath}${path.sep}`)) throw new Error('Unsafe conductor evidence path');
  const digest = createHash('sha256').update(`${evidenceMarker}:${Date.now()}:${process.pid}`).digest('hex').slice(0, 20);
  const file = path.join(base, `app-server-${digest}.jsonl`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
  return { fd: fs.openSync(file, flags, 0o600), file };
}

export function appServerArgs(projectPath) {
  return ['app-server', '--stdio', '--config', `projects={${JSON.stringify(projectPath)}={trust_level="trusted"}}`, '--disable', 'apps', '--disable', 'multi_agent'];
}

export function createConductor({
  child, output = write, evidenceFd = null, projectPath = project, modelName = model,
  reasoningEffort = effort, instructionsBase64 = instructionBytes, rpcTimeoutMs = RPC_TIMEOUT_MS,
  inputTimeoutMs = INPUT_TIMEOUT_MS, onExit = () => {},
}) {
  let sequence = 1; let initialized = false; let threadId = null; let activeTurnId = null; let startingThread = false; let startingTurn = false;
  let pending = null; let pendingTimer = null; let details = false; let hasFinal = false; let hasLegacyMessage = false;
  let lastActivity = null; let retryVisible = false; let rawBytes = 0; let evidenceFull = false; let exited = false; let closed = false; let stopping = false;
  let interruptRequested = false; let interruptWhenStarted = false; let cancelPendingStart = false;
  let queuedBeforeReady = []; let queuedFocus = []; let followups = []; let shutdownTimer = null;
  let evidenceClosed = false; let childFinalized = false; let terminalFailure = false;
  const rpc = new Map(); const paragraphs = createParagraphRenderer(output);
  const knownInteractive = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput']);

  const clearRpc = () => { for (const request of rpc.values()) clearTimeout(request.timer); rpc.clear(); };
  const writeFrame = frame => {
    if (closed) return false;
    if (child.stdin?.destroyed || child.stdin?.writable === false) { transportFailure('Lenka could not send a request to Codex.'); return false; }
    try { child.stdin.write(`${JSON.stringify(frame)}\n`); return true; }
    catch { transportFailure('Lenka could not send a request to Codex.'); return false; }
  };
  const transportFailure = message => {
    if (closed) return; terminalFailure = true; closed = true; stopping = true; clearRpc(); clearTimeout(pendingTimer); clearTimeout(shutdownTimer);
    output(`[FAILED] ${message}`); child.kill?.();
  };
  const request = (method, params, handlers = {}) => {
    const id = sequence++;
    if (!writeFrame({ jsonrpc: '2.0', id, method, params })) return null;
    const timer = setTimeout(() => {
      const entry = rpc.get(id); if (!entry) return; rpc.delete(id);
      const error = { code: -32000, message: `${method} timed out` };
      if (entry.onError) entry.onError(error); else output(`[FAILED] Codex did not answer ${safeConductorText(method, 120)} in time.`);
    }, rpcTimeoutMs); timer.unref?.(); rpc.set(id, { method, timer, ...handlers }); return id;
  };
  const respond = (id, result) => writeFrame({ jsonrpc: '2.0', id, result });
  const rejectRequest = (id, code, message) => writeFrame({ jsonrpc: '2.0', id, error: { code, message } });
  const resetTurnPresentation = () => { hasFinal = false; hasLegacyMessage = false; lastActivity = null; retryVisible = false; paragraphs.clear(); };
  const runFollowup = () => {
    if (stopping || !initialized || startingThread || startingTurn || activeTurnId || pending || !followups.length) return;
    const text = followups.shift(); beginTurn(text);
  };
  const finishTurn = status => {
    activeTurnId = null; startingTurn = false; interruptRequested = false; interruptWhenStarted = false;
    if (pending) { pending = null; clearTimeout(pendingTimer); }
    if (status === 'completed') output(hasFinal || hasLegacyMessage ? '[READY] Turn finished. Task and audit completion still require their own evidence.' : '[FAILED] Codex completed without a final answer.');
    else if (status === 'interrupted') output('[INTERRUPTED] Current turn stopped. Type a new message to continue.');
    if (stopping) { child.kill?.(); return; }
    runFollowup();
  };
  const show = event => {
    if (!event) return;
    if (event.type !== 'retrying') retryVisible = false;
    if (event.type === 'message') {
      paragraphs.complete(event.itemId, event.text);
      if (event.phase === 'final_answer') hasFinal = true;
      else if (event.phase === null) hasLegacyMessage = true;
      return;
    }
    if (event.type === 'delta') { paragraphs.append(event.itemId, event.text); return; }
    if (event.type === 'phase') { output(`[WORKING] ${event.text}`); return; }
    if (event.type === 'activity') { if (lastActivity === event.text) return; lastActivity = event.text; output(`[ACTIVITY] ${event.text}`); return; }
    if (event.type === 'retrying') { if (!retryVisible) output(`[RETRYING] ${event.text}`); retryVisible = true; return; }
    if (event.type === 'completed') { finishTurn('completed'); return; }
    if (event.type === 'interrupted') { finishTurn('interrupted'); return; }
    if (event.type === 'failure') { output(`[FAILED] Lenka could not finish: ${event.text}`); if (event.terminal) finishTurn('failed'); return; }
    if (event.type === 'approval' || event.type === 'question') {
      if (event.type === 'question' && event.secret) {
        rejectRequest(event.id, -32002, 'Secure secret input is unavailable in this terminal');
        output('[FAILED] Lenka cannot safely accept a secret in this terminal. The request was denied before input was accepted.'); return;
      }
      if (pending) { rejectRequest(event.id, -32001, 'Another interactive request is already pending'); output('[FAILED] Codex requested overlapping input; the later request was denied.'); return; }
      pending = event; clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => {
        if (pending !== event) return; pending = null; rejectRequest(event.id, -32000, 'Interactive request timed out');
        output('[FAILED] Required input expired without a response.');
      }, inputTimeoutMs); pendingTimer.unref?.();
      output(event.type === 'approval' ? '[APPROVAL] Approval required' : '[NEEDS INPUT] Lenka needs your answer'); output(event.text); return;
    }
    if (event.type === 'warning') output(`[WARNING] ${event.text}`);
  };
  const onTurnStartError = error => {
    startingTurn = false; activeTurnId = null; interruptRequested = false; interruptWhenStarted = false;
    output(`[FAILED] Lenka could not start the turn: ${safeConductorText(error?.message || 'unknown RPC error', 500)}`);
  };
  const beginTurn = text => {
    if (!threadId) { startThread(text); return; }
    resetTurnPresentation(); startingTurn = true; output('[WORKING] Lenka is working…');
    request('turn/start', {
      threadId, input: [{ type: 'text', text }], cwd: projectPath, model: modelName,
      ...(reasoningEffort ? { effort: reasoningEffort } : {}), summary: 'concise',
    }, {
      onResult: result => {
        if (result?.turn?.id && !activeTurnId) activateTurn(result.turn.id);
      }, onError: onTurnStartError,
    });
  };
  const startThread = text => {
    if (startingThread) { queuedFocus.push(text); return; }
    startingThread = true;
    request('thread/start', {
      cwd: projectPath, model: modelName,
      developerInstructions: Buffer.from(instructionsBase64 || '', 'base64').toString('utf8'),
    }, {
      onResult: result => {
        startingThread = false;
        if (!result?.thread?.id) { output('[FAILED] Codex started no usable conversation.'); return; }
        threadId = result.thread.id;
        if (cancelPendingStart) { cancelPendingStart = false; output('[INTERRUPTED] Conversation start stopped. Type a new message to continue.'); return; }
        beginTurn(text);
      },
      onError: error => { startingThread = false; output(`[FAILED] Lenka could not start a conversation: ${safeConductorText(error?.message || 'unknown RPC error', 500)}`); },
    });
  };
  const steer = text => {
    const expectedTurnId = activeTurnId;
    request('turn/steer', { threadId, expectedTurnId, input: [{ type: 'text', text }] }, {
      onError: error => {
        followups.push(text);
        output(`[WORKING] The current turn could not accept that update (${safeConductorText(error?.message || 'turn changed', 300)}). It is queued for the next turn.`);
        runFollowup();
      },
    });
  };
  const flushQueuedFocus = () => { const values = queuedFocus; queuedFocus = []; for (const text of values) steer(text); };
  function activateTurn(id) {
    activeTurnId = id; startingTurn = false;
    if (interruptWhenStarted) {
      interruptWhenStarted = false; followups.push(...queuedFocus); queuedFocus = []; requestInterrupt();
    } else flushQueuedFocus();
  }
  function requestInterrupt() {
    if (interruptRequested) return;
    if (startingThread) { cancelPendingStart = true; output('[WORKING] Conversation start will stop before the first turn.'); return; }
    if (startingTurn && !activeTurnId) { interruptWhenStarted = true; output('[WORKING] The turn will be interrupted as soon as Codex acknowledges it.'); return; }
    if (!activeTurnId) { output('[READY] No active turn.'); return; }
    interruptRequested = true;
    request('turn/interrupt', { threadId, turnId: activeTurnId }, {
      onError: error => { interruptRequested = false; output(`[FAILED] Could not interrupt the turn: ${safeConductorText(error?.message || 'unknown RPC error', 300)}`); },
    });
  }
  const recordEvidence = row => {
    if (evidenceFd === null || evidenceFull) return;
    const evidenceRow = row?.method === 'item/agentMessage/delta'
      ? { ...row, params: { ...row.params, delta: '[streamed text omitted]' } }
      : row;
    const encoded = JSON.stringify(safeEvidenceRecord(evidenceRow)); const size = Buffer.byteLength(encoded) + 1;
    if (rawBytes + size > MAX_EVIDENCE) { evidenceFull = true; return; }
    fs.writeSync(evidenceFd, `${encoded}\n`); rawBytes += size;
  };
  const receive = row => {
    recordEvidence(row);
    if (row && row.id !== undefined && typeof row.method !== 'string') {
      const entry = rpc.get(row.id); if (!entry) return;
      rpc.delete(row.id); clearTimeout(entry.timer);
      if (row.error) entry.onError?.(row.error); else entry.onResult?.(row.result);
      return;
    }
    if (row?.id !== undefined && typeof row.method === 'string') {
      const event = readableConductorEvent(row);
      if (!event) {
        const known = knownInteractive.has(row.method);
        output(`[FAILED] ${known ? 'Invalid' : 'Unsupported'} Codex request: ${safeConductorText(row.method, 160)}`);
        rejectRequest(row.id, known ? -32602 : -32601, known ? 'Invalid interactive request' : 'Unsupported interactive request'); return;
      }
      show({ ...event, id: row.id }); return;
    }
    if (row?.method === 'thread/started' && row.params?.thread?.id) threadId = row.params.thread.id;
    if (row?.method === 'turn/started' && row.params?.turn?.id) activateTurn(row.params.turn.id);
    const event = readableConductorEvent(row); show(event);
    if (details && row?.method && !['item/agentMessage/delta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta'].includes(row.method)) output(`[DETAILS] ${safeConductorText(row.method, 120)}`);
  };
  const reader = createJsonLineReader(receive, show);
  child.stdout.on('data', reader.write); child.stdout.on('end', reader.end);
  child.on('error', () => transportFailure('Lenka could not start or lost the Codex app-server.'));
  child.stdin.on?.('error', () => transportFailure('Lenka could not send a request to Codex.'));
  child.stdin.on?.('close', () => { if (!exited && !stopping) transportFailure('The Codex app-server input channel closed unexpectedly.'); });
  const finalizeChild = (code, signal) => {
    if (childFinalized) return; childFinalized = true;
    exited = true; clearRpc(); clearTimeout(pendingTimer); clearTimeout(shutdownTimer);
    if (evidenceFd !== null && !evidenceClosed) { evidenceClosed = true; try { fs.closeSync(evidenceFd); } catch {} }
    const expected = stopping && !terminalFailure;
    if (!closed && !expected) {
      const detail = signal ? `signal ${safeConductorText(signal, 40)}` : `exit ${code ?? 'unknown'}`;
      output(activeTurnId || startingTurn || startingThread
        ? `[FAILED] Lenka stopped before completing the turn (app-server ${detail}).`
        : `[FAILED] The Codex app-server stopped unexpectedly (${detail}).`);
    }
    closed = true;
    onExit({ code, signal, expected });
  };
  child.on('exit', finalizeChild);
  child.on('close', finalizeChild);
  const line = raw => {
    const text = String(raw);
    if (text === '/help') return output('Enter starts or steers work. /stop interrupts. /details toggles diagnostics. /approve, /decline, or /answer respond to a request.');
    if (text === '/details') { details = !details; return output(`[DETAILS] ${details ? 'on' : 'off'}`); }
    if (text === '/stop') { requestInterrupt(); return; }
    if (text === '/quit') { if (activeTurnId) return output('[WORKING] Use /stop before quitting.'); stopping = true; child.kill?.(); return; }
    if (pending) {
      const current = pending; const decision = text === '/approve' || text === '/approve-turn' ? 'accept' : text === '/approve-session' ? 'acceptForSession' : text === '/decline' ? 'decline' : text === '/cancel' ? 'cancel' : null;
      if (current.kind === 'command' || current.kind === 'file') {
        if (!decision) return output('[NEEDS INPUT] Choose one of the listed approval decisions.');
        pending = null; clearTimeout(pendingTimer); respond(current.id, { decision }); return;
      }
      if (current.kind === 'permissions') {
        if (!decision) return output('[NEEDS INPUT] Choose /approve-turn, /approve-session, /decline, or /cancel.');
        pending = null; clearTimeout(pendingTimer);
        const granted = decision === 'accept' || decision === 'acceptForSession' ? current.params.permissions : {};
        respond(current.id, { permissions: granted, scope: decision === 'acceptForSession' ? 'session' : 'turn' }); return;
      }
      if (current.kind === 'userinput') {
        const questions = current.params.questions;
        const match = text.match(/^\/answer(?:\s+|$)/i);
        if (!match) return output('[NEEDS INPUT] Reply with /answer followed by your response.');
        const index = current.answerIndex || 0; const question = questions[index]; let answer = text.slice(match[0].length);
        if (questions.length > 1) {
          const separator = answer.indexOf('='); const suppliedId = separator < 0 ? '' : answer.slice(0, separator).trim();
          if (suppliedId !== question.id) return output(`[NEEDS INPUT] Reply /answer ${safeConductorText(question.id, 120)}=your response. Only the current question is accepted.`);
          answer = answer.slice(separator + 1);
        } else if (answer.startsWith(`${question.id}=`)) answer = answer.slice(question.id.length + 1);
        answer = answer.trim(); if (!answer) return output('[NEEDS INPUT] The answer cannot be empty.');
        current.answers ||= {}; current.answers[question.id] = { answers: [answer] }; current.answerIndex = index + 1;
        if (current.answerIndex < questions.length) {
          const next = questions[current.answerIndex];
          output(`[NEEDS INPUT] ${current.prompts[current.answerIndex]}\nReply /answer ${safeConductorText(next.id, 120)}=your response.`); return;
        }
        pending = null; clearTimeout(pendingTimer); respond(current.id, { answers: current.answers }); output('[WORKING] Answer received.'); return;
      }
      return output('[FAILED] Unsupported pending request remains unresolved.');
    }
    if (!text.trim()) return;
    if (!initialized) { queuedBeforeReady.push(text); return output('[WORKING] Connecting to Codex…'); }
    if (startingThread || startingTurn) { output('[WORKING] Your update is queued until the turn starts.'); queuedFocus.push(text); return; }
    if (activeTurnId && interruptRequested) { output('[WORKING] Your message is queued for the next turn.'); followups.push(text); return; }
    if (activeTurnId) { output('[WORKING] Sending your update to the active turn…'); steer(text); return; }
    beginTurn(text);
  };
  return {
    initialize() {
      request('initialize', { clientInfo: { name: 'orkestar-solo-conductor', version: String(CONDUCTOR_PROTOCOL_VERSION) }, capabilities: { optOutNotificationMethods: ['item/reasoning/textDelta', 'item/reasoning/summaryTextDelta'] } }, {
        onResult: () => {
          initialized = true; writeFrame({ jsonrpc: '2.0', method: 'initialized', params: {} });
          output('[READY] Lenka is ready. Type your request. /help for controls.');
          const values = queuedBeforeReady; queuedBeforeReady = []; values.forEach(line);
        },
        onError: error => transportFailure(`Lenka could not connect: ${safeConductorText(error?.message || 'initialize failed.', 500)}`),
      });
    },
    receive, line,
    interrupt() { requestInterrupt(); },
    shutdown() {
      if (closed) return; stopping = true;
      if (activeTurnId) {
        request('turn/interrupt', { threadId, turnId: activeTurnId });
        shutdownTimer = setTimeout(() => child.kill?.(), 2_000); shutdownTimer.unref?.();
      } else child.kill?.();
    },
    exited: () => exited,
  };
}

export function main() {
  if (!project || !binary || !model || !marker || !instructionBytes || !path.isAbsolute(project)) { process.stderr.write(usage); process.exitCode = 2; return; }
  assertCanonicalDirectory(project); const evidence = openPrivateEvidence(project, marker);
  const child = spawn(binary, appServerArgs(project), { cwd: project, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
  let terminal;
  const conductor = createConductor({ child, evidenceFd: evidence.fd, onExit: status => {
    terminal?.close(); process.stdin.pause(); process.exitCode = status.expected ? 0 : 1;
  } });
  write(`[STARTING] Lenka route: ${safeConductorText(model, 160)}${effort ? ` (${safeConductorText(effort, 40)} effort)` : ''}.`);
  conductor.initialize();
  terminal = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  terminal.on('line', conductor.line).on('SIGINT', () => conductor.interrupt()).on('close', () => conductor.shutdown());
  process.on('SIGINT', () => conductor.interrupt());
  process.on('SIGTERM', () => conductor.shutdown());
  process.on('SIGHUP', () => conductor.shutdown());
  process.on('exit', () => { if (!conductor.exited()) child.kill(); });
}

if (isMain) main();
