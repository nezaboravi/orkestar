const controls = /[\u0000-\u001f\u007f-\u009f]/;
const string = (value, limit = 512) => typeof value === 'string' && value.trim()
  && value.length <= limit && !controls.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0;
const tokenKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total'];

function normalizeTokens(tokens) {
  if (!tokens || !count(tokens.total) || !count(tokens.input) || !count(tokens.output)) return null;
  if (!Number.isSafeInteger(tokens.input + tokens.output) || tokens.total !== tokens.input + tokens.output) return null;
  if (tokenKeys.some(key => tokens[key] != null && !count(tokens[key]))) return null;
  if (tokens.cacheRead > tokens.input || tokens.cacheWrite > tokens.input || tokens.reasoning > tokens.output) return null;
  return Object.fromEntries(tokenKeys.map(key => [key, tokens[key] ?? null]));
}

/** Assemble only the explicitly supplied, lineage-verified native session tree. */
export function assembleNativeAudit({ harness, project, root, children = [] } = {}) {
  if (!['codex', 'claude'].includes(harness)) throw new Error('Unsupported native audit harness');
  if (!string(project, 4096) || !string(root?.sessionId) || root.project !== project || root.parentSessionId != null) {
    throw new Error('Native audit requires an exact project root session without a parent');
  }
  if (!Array.isArray(children)) throw new Error('Native audit children must be an array');
  const sessions = [root, ...children];
  const byId = new Map();
  for (const session of sessions) {
    if (!string(session?.sessionId) || session.project !== project) throw new Error('Invalid or foreign-project native session');
    if (byId.has(session.sessionId)) throw new Error('Duplicate native session identity');
    byId.set(session.sessionId, session);
  }
  // Walk each parent chain iteratively: no recursive stack growth on long trees.
  const connected = new Set([root.sessionId]);
  for (const child of children) {
    const visiting = new Set();
    let current = child;
    while (!connected.has(current.sessionId)) {
      if (visiting.has(current.sessionId)) throw new Error('Cyclic native session ancestry');
      visiting.add(current.sessionId);
      const parent = string(current.parentSessionId);
      if (!parent || !byId.has(parent)) throw new Error('Unproven native session ancestry');
      current = byId.get(parent);
    }
    for (const id of visiting) connected.add(id);
  }
  const agents = sessions.map(session => ({
    sessionId: session.sessionId, parentSessionId: session.parentSessionId ?? null,
    agent: string(session.role) ?? 'unavailable', model: string(session.model) ?? 'unavailable',
    tokens: normalizeTokens(session.tokens), cost: null,
  }));
  let total = 0;
  for (const agent of agents) {
    if (!agent.tokens || !Number.isSafeInteger(total + agent.tokens.total)) { total = null; break; }
    total += agent.tokens.total;
  }
  return {
    status: 'PARTIAL', harness, project, sessionId: root.sessionId, agents,
    totals: { tokens: total, cost: null },
    plan: Array.isArray(root.plan) ? root.plan.filter(item => string(item?.step)
      && ['pending', 'inProgress', 'in_progress', 'completed'].includes(item.status))
      .map(item => ({ step: item.step, status: item.status })) : [],
    verification: [], blockers: ['Native session activity is not independent acceptance proof'],
  };
}

const cell = value => String(value).slice(0, 4096).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\|/g, '\\|')
  .replace(/[<>]/g, character => character === '<' ? '&lt;' : '&gt;');

/** Metadata-only scratchpad, not a transcript or a fabricated acceptance report. */
export function renderNativeAudit(audit) {
  const number = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : 'unavailable';
  const state = value => value === 'running' ? 'Working' : value === 'idle' ? 'Response returned; review pending' : 'Not reported';
  const lines = ['# Team activity', '', 'Independent acceptance: pending.',
    'This is activity evidence, not a completed-task checklist. Follow the outcome checklist and Taskavel for delivery status.', '',
    '| Agent role | Model | Activity | Tokens processed |',
    '| --- | --- | --- | ---: |'];
  for (const agent of audit.agents) lines.push(`| ${cell(agent.parentSessionId ? agent.agent : 'Conductor')} | ${cell(agent.model)} | ${state(agent.state)} | ${number(agent.tokens?.total)} |`);
  lines.push('', `Total cumulative tokens: ${number(audit.totals.tokens)}`,
    'Cost: unavailable — the client did not report monetary billing.', '',
    'Tokens processed include repeated and cached input, not just newly written text. Cached input and reasoning are already included; do not add them again.',
    'A returned response still needs verification. This evidence does not approve acceptance or complete Taskavel tasks.',
    '', '## Technical details', '', `Client: ${cell(audit.harness)}`, `Project: ${cell(audit.project)}`,
    `Root session: ${cell(audit.sessionId)}`);
  for (const agent of audit.agents) lines.push(`- ${cell(agent.agent)}: ${cell(agent.sessionId)}; parent: ${cell(agent.parentSessionId ?? 'root')}`);
  return lines.join('\n');
}
