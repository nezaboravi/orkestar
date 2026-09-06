import { createHash } from 'node:crypto';

export const NATIVE_EVENT_LIMIT = 8 * 1024 * 1024;
export const NATIVE_FINAL_LIMIT = 64 * 1024;
/** Validate the entire stream; retain only bounded native result evidence. */
export function createNativeEvidenceStream(harness) {
  if (!['codex', 'claude'].includes(harness)) throw new Error('Invalid native stream harness');
  const digest = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', bytes = 0, start = null, final = null, terminal = null;
  let streamInvalid = false, evidenceTruncated = false, sessionId = null;
  const row = line => {
    if (!line.trim() || streamInvalid) return;
    if (Buffer.byteLength(line) > NATIVE_EVENT_LIMIT) { streamInvalid = true; evidenceTruncated = true; return; }
    let value; try { value = JSON.parse(line); } catch { streamInvalid = true; return; }
    if (!value || typeof value !== 'object' || Array.isArray(value) || terminal) { streamInvalid = true; return; }
    const isStart = harness === 'codex' ? value.type === 'thread.started' : value.type === 'system' && value.subtype === 'init';
    if (!start) {
      sessionId = harness === 'codex' ? value.thread_id : value.session_id;
      if (!isStart || typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || Buffer.byteLength(line) > NATIVE_FINAL_LIMIT) { streamInvalid = true; return; }
      start = value; return;
    }
    if (isStart || (Object.hasOwn(value, 'session_id') && value.session_id !== sessionId) || (Object.hasOwn(value, 'thread_id') && value.thread_id !== sessionId)
      || ['error', 'turn.failed'].includes(value.type)) { streamInvalid = true; return; }
    if (harness === 'codex' && value.type === 'item.completed' && value.item?.type === 'agent_message') {
      if (typeof value.item.text !== 'string' || Buffer.byteLength(line) > NATIVE_FINAL_LIMIT) { evidenceTruncated = true; return; }
      final = value;
    }
    if (harness === 'codex' ? value.type === 'turn.completed' : value.type === 'result') {
      if (Buffer.byteLength(line) > NATIVE_FINAL_LIMIT) { evidenceTruncated = true; return; }
      terminal = value;
    }
  };
  const drain = () => {
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      row(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (streamInvalid) { buffer = ''; return; }
    }
    if (Buffer.byteLength(buffer) > NATIVE_EVENT_LIMIT) { evidenceTruncated = true; streamInvalid = true; buffer = ''; }
  };
  return {
    write(chunk) {
      digest.update(chunk); bytes += chunk.length;
      if (streamInvalid) return;
      try { buffer += decoder.decode(chunk, { stream: true }); drain(); } catch { streamInvalid = true; buffer = ''; }
    },
    finish() {
      if (!streamInvalid) try { buffer += decoder.decode(); drain(); if (buffer.trim()) row(buffer); } catch { streamInvalid = true; }
      if (!start || !terminal) streamInvalid = true;
      const compact = [start, final, terminal].filter(Boolean).map(JSON.stringify).join('\n') + '\n';
      return { compact, fullStreamHash: digest.digest('hex'), fullStreamBytes: bytes, streamInvalid, evidenceTruncated };
    },
  };
}
