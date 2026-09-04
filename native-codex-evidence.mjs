const text = value => typeof value === 'string' && value.trim() ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function tokensFrom(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const total = count(usage.total_tokens);
  const cacheRead = count(usage.cached_input_tokens);
  const cacheWrite = count(usage.cache_write_input_tokens);
  const reasoning = count(usage.reasoning_output_tokens);
  if (input === null || output === null || total === null
    || !Number.isSafeInteger(input + output) || total !== input + output
    || (cacheRead !== null && cacheRead > input)
    || (cacheWrite !== null && cacheWrite > input)
    || (reasoning !== null && reasoning > output)) return null;
  for (const key of ['cached_input_tokens', 'cache_write_input_tokens', 'reasoning_output_tokens']) {
    if (usage[key] !== undefined && count(usage[key]) === null) return null;
  }
  return { input, output, cacheRead, cacheWrite, reasoning, total };
}

/** Pure metadata-only projection. Never returns prompts, tool output or reasoning.
 * Native totals include cached input and reasoning output; those are not added again.
 * A finished turn is idle, never proof that the application's acceptance passed.
 */
export function parseCodexEvidence(records) {
  const rows = Array.isArray(records) ? records.filter(row => row && typeof row === 'object') : [];
  // Forked transcripts embed the parent's session_meta after their own header.
  const meta = rows.find(row => row.type === 'session_meta')?.payload;
  const sessionId = text(meta?.id);
  const spawn = meta?.source?.subagent?.thread_spawn;
  const result = {
    sessionId, parentSessionId: text(spawn?.parent_thread_id),
    project: text(meta?.cwd), role: text(meta?.agent_role) ?? text(spawn?.agent_role),
    model: null, tokens: null, cost: null, plan: [], state: 'unknown', finalMessageCount: 0,
    provenance: { metadataRecord: null, modelRecord: null, tokenRecord: null, stateRecord: null },
  };
  if (!sessionId) return result;
  result.provenance.metadataRecord = rows.findIndex(row => row.type === 'session_meta');
  const ownTurns = new Set(rows.filter(row => row.type === 'token_usage_record'
    && row.payload?.thread_id === sessionId).map(row => text(row.payload.turn_id)).filter(Boolean));
  const child = Boolean(spawn || meta?.source?.subagent);
  const finals = new Set();
  const models = new Set();
  const modelTurns = new Set();
  const requiredTurns = new Set(ownTurns);
  let missingModel = false;
  let currentTurn = null;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const p = row.payload;
    if (!p || typeof p !== 'object') continue;
    if (row.type === 'event_msg' && p.type === 'task_started') currentTurn = text(p.turn_id);
    const own = !child || ownTurns.has(text(p.turn_id) ?? currentTurn);
    if (row.type === 'turn_context' && own) {
      if (text(p.model)) {
        models.add(p.model);
        if (text(p.turn_id)) modelTurns.add(p.turn_id);
        result.provenance.modelRecord = index;
      } else missingModel = true;
    }
    if (row.type === 'token_usage_record' && p.thread_id === sessionId) {
      result.tokens = tokensFrom(p.thread_token_usage);
      result.provenance.tokenRecord = index;
    } else if (row.type === 'event_msg' && p.type === 'token_count' && own) {
      // Last cumulative snapshot wins, including invalid data becoming unavailable.
      result.tokens = tokensFrom(p.info?.total_token_usage);
      result.provenance.tokenRecord = index;
    }
    if (!own) continue;
    if (row.type === 'event_msg' && p.type === 'task_started' && text(p.turn_id)) requiredTurns.add(p.turn_id);
    if (row.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(p.type)) {
      result.state = p.type === 'task_started' ? 'running' : 'idle';
      result.provenance.stateRecord = index;
    }
    // item_completed and task_complete can repeat a final message in other shapes.
    // Count only canonical response items explicitly marked final_answer.
    if (row.type === 'response_item' && p.type === 'message'
      && p.role === 'assistant' && p.phase === 'final_answer') {
      const key = text(p.id) ?? `record:${index}`;
      finals.add(key);
    }
  }
  if (!missingModel && models.size === 1 && [...requiredTurns].every(turn => modelTurns.has(turn))) {
    result.model = [...models][0];
  } else result.provenance.modelRecord = null;
  result.finalMessageCount = finals.size;
  return result;
}
