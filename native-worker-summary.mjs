import { coordinateNativeSolo } from './native-worker-coordination.mjs';

const clean = (value, limit = 200) => String(value ?? 'unavailable').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/[<>]/g, '').slice(0, limit);
// Conservative recognizable-credential filter, not a claim that arbitrary
// secrets can be detected. Never project credential-bearing free prose.
const sensitive = value => /(?:token|password|secret|authorization|api[_ -]?key)\s*["']?\s*[:=]|Bearer\s|sk-[A-Za-z0-9]|\bgh[pousr]_[A-Za-z0-9_]+|\bgithub_pat_[A-Za-z0-9_]+|\b(?:AKIA|ASIA)[A-Z0-9]{12,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|https?:\/\/\S+[?&]/i.test(value);
function plain(value, limit = 200) {
  if (typeof value !== 'string' || sensitive(value)) return 'detail withheld';
  return clean(value.replace(/<[^>]*>/g, '').replace(/!?\[[^\]]*\]\([^)]*\)/g, '').replace(/https?:\/\/\S+/g, '').replace(/[`*_#~|\[\]()!]/g, ''), limit);
}
function structuredExcerpt(value) {
  let data;
  try { data = JSON.parse(value.replace(/^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/, '$1')); } catch { return null; }
  if (!data || Array.isArray(data) || !['APPROVED', 'CHANGES_REQUIRED', 'DONE', 'PARTIAL', 'FAILED', 'BLOCKED'].includes(data.verdict)) return 'No recognized human-readable result fields.';
  const lines = [`Worker verdict: ${data.verdict} (untrusted).`];
  for (const category of ['security', 'performance']) {
    const detail = data[category];
    if (!['PASS', 'FAIL', 'NOT_APPLICABLE', 'BLOCKED', 'UNAVAILABLE', 'UNVERIFIED'].includes(detail?.status)) continue;
    lines.push(`${category === 'security' ? 'Security' : 'Performance'}: ${detail.status}.`);
    if (Array.isArray(detail.evidence)) for (const item of detail.evidence.slice(0, 2)) if (typeof item === 'string') lines.push(`  Evidence: ${plain(item, 200)}`);
  }
  if (Array.isArray(data.proof)) for (const item of data.proof.slice(0, 8)) {
    if (!item || !['passed', 'failed', 'blocked', 'unavailable', 'not_applicable'].includes(item.result)) continue;
    lines.push(`Check: ${plain(item.criterion ?? item.criterionId, 120)} — ${item.result}. Method: ${plain(item.method, 200)}`);
  }
  if (Array.isArray(data.blockers)) for (const item of data.blockers.slice(0, 5)) if (typeof item === 'string') lines.push(`Blocker: ${plain(item, 200)}`);
  return lines.join('\n').slice(0, 1800);
}
function excerpt(value) {
  if (typeof value !== 'string') return 'No prose summary available.';
  if (Buffer.byteLength(value) > 262144) return 'Result exceeds the readable summary bound.';
  const structured = structuredExcerpt(value);
  if (structured !== null) return structured;
  if (/^\s*[\[{]/.test(value)) return 'No recognized human-readable result fields.';
  if (sensitive(value)) return 'Prose result withheld because it contains credential-like content.';
  let fenced = false;
  const lines = value.split(/\r?\n/).filter(line => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return false; }
    return !fenced && !/^\s*[\[{]/.test(line)
      && !/^\s*(?:[$>]\s|(?:php|npm|npx|pnpm|yarn|git|curl|node|sudo|rm|composer|vendor\/)\b)/.test(line);
  });
  return plain(lines.join('\n'), 1800) || 'No prose summary available.';
}

/** Result presentation is a projection, never an acceptance or evidence source. */
export async function projectNativeWorkerSummary({ project, harness, worker }, { coordinate = coordinateNativeSolo } = {}) {
  if (!worker || worker.project !== project || worker.harness !== harness || worker.complete !== true
    || !['stopped', 'exited'].includes(worker.state)
    || !/^[a-f0-9-]{36}$/.test(worker.runId ?? '')
    || !/^tc-[a-f0-9]{12}$/.test(worker.contractId ?? '')) return null;
  const name = plain(worker.displayName ?? worker.name);
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : 'unavailable';
  const content = [`# ${name}`, '', `Role: ${plain(worker.role)}`, `${worker.actualModel ? 'Reported model' : 'Requested model'}: ${plain(worker.actualModel || worker.model)} (${plain(harness)})`,
    'State: response received; independent acceptance still required.',
    `Tokens: ${count(worker.tokens?.total)} total (${count(worker.tokens?.input)} input / ${count(worker.tokens?.output)} output)`,
    ...(harness === 'codex' ? [`Input detail: ${count(worker.tokens?.cachedInput)} cached / ${count(worker.tokens?.uncachedInput)} uncached. Aggregate input is not unique prompt size or a full-price charge.`] : []),
    `Cost: ${typeof worker.cost === 'number' && Number.isFinite(worker.cost) && worker.cost >= 0 ? '$' + worker.cost.toFixed(6) : 'unavailable'}`,
    '', '## Worker-reported result (untrusted excerpt)', excerpt(worker.result), '',
    'This summary does not approve the work. Review and audit evidence remain separate.'].join('\n');
  try {
    const header = '# Team overview\n\nCompleted worker responses appear below. Live work and full detail are in the individual agent panels. This overview is not acceptance proof.\n';
    const request = (name, args) => coordinate({ project, harness, name, args });
    let pad = await request('coord_scratchpad_create', {
      key: `team-overview:${harness}:${worker.contractId}`,
      name: `Team overview — ${harness === 'codex' ? 'Codex' : 'Claude Code'} · ${worker.contractId.slice(-6)}`, content: header,
    });
    const marker = `\n<!-- worker-result:${worker.runId} -->\n`;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (typeof pad.content !== 'string' || !Number.isSafeInteger(pad.revision)) throw new Error('Unreadable overview');
      if (pad.content.includes(marker)) return { scratchpadId: pad.id, state: 'published' };
      if (pad.content.length > 64000) throw new Error('Overview bound reached');
      try {
        await request('coord_scratchpad_append', { id: pad.id, expectedRevision: pad.revision, content: marker + '\n---\n\n' + content + '\n' });
        return { scratchpadId: pad.id, state: 'published' };
      } catch {
        // Another result may have appended concurrently, or readback may have
        // failed after a successful append. Read before retrying either case.
        pad = await request('coord_scratchpad_read', { id: pad.id });
      }
    }
    if (pad.content?.includes(marker)) return { scratchpadId: pad.id, state: 'published' };
    throw new Error('Overview revision remained busy');
  } catch { return { state: 'unavailable', warning: 'Readable Solo summary could not be published; native worker evidence is unchanged.' }; }
}
