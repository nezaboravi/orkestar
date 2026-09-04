// Local Claude transcript evidence only. No transcript content is exported.
// Cache fields are disjoint inputs in Claude, unlike Codex's cached-input subset.
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.trim() ? value : null;

export function parseClaudeEvidence(records, metadata = {}) {
  const rows = Array.isArray(records) ? records : [];
  const sessionIds = new Set(rows.map(row => text(row?.sessionId)).filter(Boolean));
  const nativeSession = sessionIds.size === 1 ? [...sessionIds][0] : null;
  const child = text(metadata.agentId);
  const validChild = child && nativeSession && metadata.parentSessionId === nativeSession;
  const sessionId = child ? (validChild ? child : null) : nativeSession;
  const projects = new Set(rows.map(row => text(row?.cwd)).filter(Boolean));
  const project = projects.size === 1 ? [...projects][0] : null;
  const messages = new Map();
  let malformed = !sessionId;
  let modelUnproven = false;
  const fingerprint = message => JSON.stringify([
    message.model, message.stop_reason, message.usage?.input_tokens,
    message.usage?.output_tokens, message.usage?.cache_read_input_tokens,
    message.usage?.cache_creation_input_tokens,
  ]);
  for (const row of rows) {
    if (row?.type !== 'assistant' || row.sessionId !== nativeSession) continue;
    // Hook metadata must identify the exact child's transcript, not the parent.
    if ((child && row.agentId !== child) || (!child && row.agentId)) {
      malformed = true;
      continue;
    }
    const message = row.message;
    if (!text(message?.id)) { malformed = true; continue; }
    if (!text(message.model)) modelUnproven = true;
    const previous = messages.get(message.id);
    if (previous && fingerprint(previous) !== fingerprint(message)) {
      // Without a verified streaming sequence, conflicting snapshots are not
      // an authoritative final usage record. Refuse to choose arbitrarily.
      malformed = true;
      if (previous.model !== message.model) modelUnproven = true;
    }
    messages.set(message.id, message);
  }
  const models = new Set([...messages.values()].map(message => text(message.model)).filter(Boolean));
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null, total: 0 };
  let finalMessageCount = 0;
  for (const message of messages.values()) {
    const usage = message.usage;
    const values = [usage?.input_tokens, usage?.output_tokens, usage?.cache_read_input_tokens, usage?.cache_creation_input_tokens];
    if (!values.every(count)) { malformed = true; continue; }
    const [input, output, cacheRead, cacheWrite] = values;
    totals.input += input + cacheRead + cacheWrite;
    totals.output += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
    totals.total += input + cacheRead + cacheWrite + output;
    if (message.stop_reason === 'end_turn') finalMessageCount += 1;
  }
  if (!Object.values(totals).filter(value => value !== null).every(count)) malformed = true;
  return {
    sessionId, parentSessionId: validChild ? nativeSession : null, project,
    role: text(metadata.role), model: !modelUnproven && models.size === 1 ? [...models][0] : null,
    tokens: !malformed && messages.size ? totals : null,
    cost: null, plan: [], state: 'unknown', finalMessageCount,
  };
}
