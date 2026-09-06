import { StringDecoder } from 'node:string_decoder';

export const CONDUCTOR_PROTOCOL_VERSION = 1;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 12 * 1024;
const MAX_PARAGRAPH_BYTES = 16 * 1024;

const redact = (value, redactIds = true) => {
  let text = String(value)
  .replace(/\r\n?/g, '\n')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ')
  .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[redacted]')
  .replace(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g, '[redacted]')
  .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted]')
  .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[redacted]')
  .replace(/((?:token|secret|password|api[_-]?key)\s*[":=]\s*)[^\s,}"\]]+/gi, '$1[redacted]');
  if (redactIds) text = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[id]');
  return text;
};

function utf8Prefix(value, limit) {
  let result = ''; let bytes = 0;
  for (const character of String(value)) {
    const size = Buffer.byteLength(character);
    if (bytes + size > limit) break;
    result += character; bytes += size;
  }
  return result;
}

export function safeConductorText(value, limit = MAX_TEXT_BYTES) {
  const text = redact(value).replace(/\n{3,}/g, '\n\n').trim();
  return Buffer.byteLength(text) <= limit ? text : `${utf8Prefix(text, limit).trimEnd()}…`;
}

export function safeConductorFragment(value, limit = MAX_TEXT_BYTES) {
  const text = redact(value);
  return Buffer.byteLength(text) <= limit ? text : utf8Prefix(text, limit);
}

export function safeEvidenceRecord(value, key = '') {
  if (key && /(?:token|secret|password|authorization|api[_-]?key)/i.test(key)) return '[redacted]';
  if (typeof value === 'string') return redact(value, false);
  if (Array.isArray(value)) return value.map(entry => safeEvidenceRecord(entry));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, safeEvidenceRecord(entry, name)]));
  return value;
}

/** Hold incomplete text so credentials split across chunks are redacted together. */
export function createParagraphRenderer(output) {
  const messages = new Map();
  const state = itemId => {
    const id = itemId || '__legacy__';
    if (!messages.has(id)) messages.set(id, { buffer: '', sawDelta: false, suppressUntilBoundary: false });
    return messages.get(id);
  };
  const emit = paragraph => { const text = safeConductorText(paragraph, MAX_TEXT_BYTES); if (text) output(text); };
  const append = (itemId, delta) => {
    const current = state(itemId); current.sawDelta = true;
    let incoming = String(delta);
    if (current.suppressUntilBoundary) {
      const boundary = incoming.search(/\r?\n[ \t]*\r?\n/);
      if (boundary < 0) return;
      const match = incoming.slice(boundary).match(/^\r?\n[ \t]*\r?\n/);
      incoming = incoming.slice(boundary + (match?.[0].length || 2)); current.suppressUntilBoundary = false;
    }
    current.buffer += incoming;
    let match;
    while ((match = /\r?\n[ \t]*\r?\n/.exec(current.buffer))) {
      emit(current.buffer.slice(0, match.index)); current.buffer = current.buffer.slice(match.index + match[0].length);
    }
    if (Buffer.byteLength(current.buffer) > MAX_PARAGRAPH_BYTES) {
      output('[MESSAGE] A very long paragraph was omitted from the normal view.');
      current.buffer = ''; current.suppressUntilBoundary = true;
    }
  };
  const complete = (itemId, finalText) => {
    const id = itemId || '__legacy__'; const current = messages.get(id);
    if (!current?.sawDelta) { emit(finalText); messages.delete(id); return false; }
    if (!current.suppressUntilBoundary) emit(current.buffer);
    messages.delete(id); return true;
  };
  return { append, complete, clear: () => messages.clear() };
}

function workerActivity(item) {
  const tool = String(item.tool || '');
  if (item.status === 'failed') return `Worker operation failed${item.error?.message ? `: ${safeConductorText(item.error.message, 500)}` : '.'}`;
  if (/dispatch_wave|dispatch$/i.test(tool)) return item.status === 'inProgress' ? 'Starting worker assignments.' : 'Worker assignments started.';
  if (/worker_(?:status|wait)|wait_threads/i.test(tool)) return 'Checking worker progress.';
  if (/worker_result|read_thread/i.test(tool)) return 'Collecting a worker result.';
  if (/worker_report/i.test(tool)) return 'Validating the workflow evidence.';
  if (/tracker|taskavel/i.test(tool)) return 'Updating the authorized task record.';
  return item.status === 'inProgress' ? 'Using a connected project tool.' : 'Connected project tool finished.';
}

function itemSummary(item, completed) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'agentMessage' && typeof item.text === 'string') return completed ? { type: 'message', itemId: item.id, phase: item.phase ?? null, text: item.text } : null;
  if (item.type === 'commandExecution') return { type: 'activity', text: item.status === 'failed' ? 'A project command failed.' : item.status === 'inProgress' ? 'Running a project command.' : 'Project command finished.' };
  if (item.type === 'fileChange') return { type: 'activity', text: item.status === 'failed' ? 'A file change failed.' : item.status === 'inProgress' ? 'Updating project files.' : 'Project files updated.' };
  if (item.type === 'mcpToolCall') return { type: 'activity', text: workerActivity(item) };
  if (item.type === 'collabAgentToolCall') {
    if (item.status === 'failed') return { type: 'activity', text: 'A worker operation failed.' };
    if (item.tool === 'spawnAgent') return { type: 'activity', text: item.status === 'inProgress' ? 'Starting a worker.' : 'Worker started.' };
    if (item.tool === 'wait') return { type: 'activity', text: 'Checking worker progress.' };
    return { type: 'activity', text: 'Worker activity updated.' };
  }
  if (item.type === 'subAgentActivity') return { type: 'activity', text: item.kind === 'started' ? 'A worker started.' : item.kind === 'completed' ? 'A worker completed its assignment.' : 'Worker activity updated.' };
  if (item.type === 'webSearch') return { type: 'activity', text: 'Searching the web.' };
  if (item.type === 'contextCompaction') return { type: 'activity', text: 'Condensing earlier context.' };
  return null;
}

function hasRequired(params, names) { return params && typeof params === 'object' && names.every(name => Object.hasOwn(params, name)); }

function exactKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key));
}

function permissionPathLabel(permissionPath) {
  if (permissionPath.type === 'path') {
    return exactKeys(permissionPath, ['type', 'path']) && typeof permissionPath.path === 'string' && permissionPath.path ? permissionPath.path : null;
  }
  if (permissionPath.type === 'glob_pattern') {
    return exactKeys(permissionPath, ['type', 'pattern']) && typeof permissionPath.pattern === 'string' && permissionPath.pattern ? `glob ${permissionPath.pattern}` : null;
  }
  if (permissionPath.type !== 'special' || !exactKeys(permissionPath, ['type', 'value'])
    || !exactKeys(permissionPath.value, ['kind', 'subpath', 'path'])) return null;
  const special = permissionPath.value;
  if (special.kind === 'root' && Object.keys(special).length === 1) return '/ (filesystem root)';
  if (special.kind === 'minimal' && Object.keys(special).length === 1) return 'minimal system paths';
  if (special.kind === 'tmpdir' && Object.keys(special).length === 1) return 'system temporary directory';
  if (special.kind === 'slash_tmp' && Object.keys(special).length === 1) return '/tmp';
  if (special.kind === 'project_roots' && (special.subpath === undefined || special.subpath === null || typeof special.subpath === 'string')) {
    return special.subpath ? `project roots, subpath ${special.subpath}` : 'project roots';
  }
  if (special.kind === 'unknown' && typeof special.path === 'string' && special.path
    && (special.subpath === undefined || special.subpath === null || typeof special.subpath === 'string')) {
    return special.subpath ? `${special.path}, subpath ${special.subpath}` : special.path;
  }
  return null;
}

function permissionSummary(permissions) {
  if (!exactKeys(permissions, ['fileSystem', 'network'])) return null;
  const lines = [];
  if (permissions.fileSystem !== undefined && permissions.fileSystem !== null) {
    const fileSystem = permissions.fileSystem;
    if (!exactKeys(fileSystem, ['entries', 'globScanMaxDepth', 'read', 'write'])) return null;
    if (fileSystem.entries !== undefined && fileSystem.entries !== null) {
      if (!Array.isArray(fileSystem.entries) || fileSystem.entries.length > 32) return null;
      for (const entry of fileSystem.entries) {
        if (!exactKeys(entry, ['access', 'path']) || !['read', 'write', 'deny'].includes(entry.access)) return null;
        const label = permissionPathLabel(entry.path); if (!label) return null;
        lines.push(`Filesystem ${entry.access}: ${safeConductorText(label, 500)}`);
      }
    }
    for (const access of ['read', 'write']) {
      const paths = fileSystem[access];
      if (paths === undefined || paths === null) continue;
      if (!Array.isArray(paths) || paths.length > 32 || paths.some(value => typeof value !== 'string' || !value)) return null;
      for (const value of paths) lines.push(`Filesystem ${access}: ${safeConductorText(value, 500)}`);
    }
    if (fileSystem.globScanMaxDepth !== undefined && fileSystem.globScanMaxDepth !== null) {
      if (!Number.isInteger(fileSystem.globScanMaxDepth) || fileSystem.globScanMaxDepth < 1) return null;
      lines.push(`Filesystem glob scan depth: ${fileSystem.globScanMaxDepth}`);
    }
  }
  if (permissions.network !== undefined && permissions.network !== null) {
    if (!exactKeys(permissions.network, ['enabled']) || typeof permissions.network.enabled !== 'boolean') return null;
    lines.push(`Network access: ${permissions.network.enabled ? 'enabled' : 'disabled'}`);
  }
  if (!lines.length || Buffer.byteLength(lines.join('\n')) > 12 * 1024) return null;
  return lines.join('\n');
}

function approvalEvent(method, params) {
  if (method === 'item/commandExecution/requestApproval') {
    if (!hasRequired(params, ['itemId', 'startedAtMs', 'threadId', 'turnId'])) return null;
    const action = params.kind === 'writeStdin' ? 'input to a running command' : `this command: ${safeConductorText(params.command || 'Command details unavailable.', 1000)}`;
    return { type: 'approval', kind: 'command', request: method, params, text: `Approval is required for ${action}.${params.cwd ? `\nWorking directory: ${safeConductorText(params.cwd, 500)}` : ''}${params.reason ? `\nReason: ${safeConductorText(params.reason, 500)}` : ''}\nReply with /approve, /approve-session, /decline, or /cancel.` };
  }
  if (method === 'item/fileChange/requestApproval') {
    if (!hasRequired(params, ['itemId', 'startedAtMs', 'threadId', 'turnId'])) return null;
    return { type: 'approval', kind: 'file', request: method, params, text: `Approval is required for a file change.${params.reason ? `\nReason: ${safeConductorText(params.reason, 500)}` : ''}${params.grantRoot ? `\nRequested root: ${safeConductorText(params.grantRoot, 500)}` : ''}\nReply with /approve, /approve-session, /decline, or /cancel.` };
  }
  if (method === 'item/permissions/requestApproval') {
    if (!hasRequired(params, ['cwd', 'itemId', 'permissions', 'startedAtMs', 'threadId', 'turnId'])) return null;
    const scope = permissionSummary(params.permissions); if (!scope) return null;
    return { type: 'approval', kind: 'permissions', request: method, params, text: `Approval is required for these additional permissions:\n${scope}\nWorking directory: ${safeConductorText(params.cwd, 500)}${params.reason ? `\nReason: ${safeConductorText(params.reason, 500)}` : ''}\nReply with /approve-turn, /approve-session, /decline, or /cancel.` };
  }
  if (method === 'item/tool/requestUserInput') {
    if (!hasRequired(params, ['isBlocking', 'itemId', 'questions', 'threadId', 'turnId']) || !Array.isArray(params.questions) || !params.questions.length) return null;
    if (params.questions.some(question => !hasRequired(question, ['header', 'id', 'question']) || typeof question.id !== 'string' || !question.id)) return null;
    const prompts = params.questions.map(question => `${safeConductorText(question.header || question.id, 120)}: ${safeConductorText(question.question, 600)}${Array.isArray(question.options) ? `\n${question.options.map((option, index) => `${index + 1}. ${safeConductorText(option.label, 120)} — ${safeConductorText(option.description, 300)}`).join('\n')}` : ''}${question.isSecret ? '\nYour answer will be hidden from the transcript.' : ''}`);
    const reply = params.questions.length === 1 ? 'Reply /answer your response.' : `Reply /answer ${params.questions[0].id}=your response. Questions are asked one at a time.`;
    return { type: 'question', kind: 'userinput', request: method, params, prompts, secret: params.questions.some(question => question.isSecret === true), text: `${prompts[0]}\n${reply}` };
  }
  return null;
}

export function readableConductorEvent(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  if (row.type === 'failure' && typeof row.text === 'string') return { type: 'failure', text: safeConductorText(row.text) };
  const method = row.method; const params = row.params || {};
  if (row.id !== undefined && typeof method === 'string') return approvalEvent(method, params);
  if (method === 'item/started' || method === 'item/completed') return itemSummary(params.item, method === 'item/completed');
  if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') return { type: 'delta', itemId: params.itemId, text: params.delta };
  if (method === 'item/mcpToolCall/progress') return { type: 'activity', text: 'Worker operation is still running.' };
  if (method === 'turn/plan/updated' && Array.isArray(params.plan)) {
    const active = params.plan.find(step => step?.status === 'inProgress') || params.plan.find(step => step?.status === 'pending');
    return active && typeof active.step === 'string' ? { type: 'phase', text: safeConductorText(active.step, 240) } : null;
  }
  if (method === 'turn/completed') {
    const turn = params.turn || {};
    if (turn.status === 'completed') return { type: 'completed', text: 'Turn completed.' };
    if (turn.status === 'interrupted') return { type: 'interrupted', text: 'Turn interrupted.' };
    return { type: 'failure', terminal: true, text: safeConductorText(turn.error?.message || 'Turn failed.') };
  }
  if (method === 'error') return params.willRetry ? { type: 'retrying', text: 'Connection problem. Codex is retrying…' } : { type: 'failure', text: safeConductorText(params.error?.message || 'Codex reported an error.') };
  if (method === 'warning' || method === 'configWarning') return { type: 'warning', text: safeConductorText(params.message || params.summary || 'Codex reported a warning.') };
  return null;
}

export function createJsonLineReader(onRecord, onFailure = onRecord) {
  const decoder = new StringDecoder('utf8'); let buffered = ''; let failed = false;
  const fail = message => { if (failed) return; failed = true; buffered = ''; onFailure({ type: 'failure', text: message }); };
  return {
    write(chunk) {
      if (failed) return;
      buffered += decoder.write(chunk);
      let offset;
      while ((offset = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, offset); buffered = buffered.slice(offset + 1);
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > MAX_EVENT_BYTES) { fail('Codex app-server event exceeds the safety limit.'); return; }
        let value; try { value = JSON.parse(line); } catch { onRecord({ type: 'failure', text: 'Codex app-server sent an invalid protocol record.' }); continue; }
        onRecord(value);
      }
      if (Buffer.byteLength(buffered) > MAX_EVENT_BYTES) fail('Codex app-server event exceeds the safety limit.');
    },
    end() {
      if (failed) return;
      const remaining = `${buffered}${decoder.end()}`.trim(); buffered = '';
      if (remaining) { try { onRecord(JSON.parse(remaining)); } catch { onRecord({ type: 'failure', text: 'Codex app-server ended with an invalid protocol record.' }); } }
    },
  };
}
