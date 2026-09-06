const LIMIT = 262144;
const numericId = value => Number.isSafeInteger(value) && value > 0;
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 200
  && value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/.test(value);

function responseText(value) {
  if (typeof value !== 'string') {
    if (!value || value.isError === true || !Array.isArray(value.content) || value.content.length !== 1
      || value.content[0]?.type !== 'text') throw new Error('Expected one successful text response');
    value = value.content[0].text;
  }
  if (typeof value !== 'string' || Buffer.byteLength(value) > LIMIT
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)) throw new Error('Invalid bounded response');
  return value.replace(/\r\n/g, '\n');
}

/**
 * Pure parser, NOT transport authentication. The trusted broker must freshly call
 * filter-tasks-tool with this exact project_id, status:any, limit:100, followed by
 * get-task-details-tool with this exact task_id. Caller supplies collection time.
 * Absence from the bounded first page is a blocker, never evidence of membership.
 * Project labels contain a task number and cannot supply numeric project identity.
 * Column identity is explicitly name:<label>, not a fabricated numeric column ID.
 */
export function taskavelMembershipContains(membership, taskId) {
  if (!numericId(taskId)) return false;
  let lines;
  try { lines = responseText(membership).trimEnd().split('\n'); } catch { return false; }
  const header = lines.shift()?.match(/^Filtered tasks \((\d+)\):$/);
  if (!header || Number(header[1]) < 1 || Number(header[1]) > 100 || lines.shift() !== ''
    || lines.length !== Number(header[1]) * 2) return false;
  const ids = new Set();
  for (let index = 0; index < lines.length; index += 2) {
    const pair = lines.slice(index, index + 2);
    const identity = pair[1]?.match(/^  id: ([1-9]\d*) \| https:\/\/taskavel\.com\/tasks\/([1-9]\d*)$/);
    // Taskavel may append bounded display labels after its canonical status
    // marker (for example a priority or agent label). The status marker stays
    // required and first; arbitrary unbracketed suffixes are still rejected.
    if (pair.length !== 2 || !/^#[1-9]\d* .+ — .+ \/ .+ \[(open|completed)\](?: \[[^\]\r\n]{1,200}\])*$/.test(pair[0])
      || !identity || identity[1] !== identity[2] || !numericId(Number(identity[1])) || ids.has(identity[1])) {
      return false;
    }
    ids.add(identity[1]);
  }
  return ids.has(String(taskId));
}

/** Normalize only after broker-owned membership and task reads; see boundary above. */
export function normalizeTaskavelReadback({ taskId, projectId, projectName, details, membership, readAt } = {}) {
  const blocked = reason => ({ snapshot: null, observed: null, blockers: [reason] });
  if (!numericId(taskId) || !(numericId(projectId) || projectId === null && label(projectName)) || !Number.isSafeInteger(readAt) || readAt < 1) {
    return blocked('A resolved numeric task/project scope and trusted collection time are required.');
  }
  let detailText;
  try { detailText = responseText(details); } catch { return blocked('Taskavel returned an unsuccessful or unsupported bounded text response.'); }
  if (!taskavelMembershipContains(membership, taskId)) return blocked('The task is absent from a valid fresh project membership listing.');
  const detailLines = detailText.trimEnd().split('\n');
  if (!/^# .+/.test(detailLines[0] ?? '')) return blocked('Taskavel task details have an unsupported header.');
  const headerEnd = detailLines.findIndex(line => line === '');
  const metadata = detailLines.slice(1, headerEnd < 0 ? detailLines.length : headerEnd);
  const field = key => {
    const matches = metadata.filter(line => line.startsWith(`${key}: `));
    return matches.length === 1 ? matches[0].slice(key.length + 2) : null;
  };
  const projectLabel = field('Project'), status = field('Status'), columnName = field('Column');
  const url = `https://taskavel.com/tasks/${taskId}`;
  if (projectId === null && !new RegExp(`^${projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} #[1-9]\\d*$`).test(projectLabel ?? '')) return blocked('Task details do not match the bound exact project name.');
  if (!label(projectLabel) || !label(columnName) || !['Open', 'Completed'].includes(status)
    || detailLines.at(-1) !== `Link: ${url}`) return blocked('Taskavel task identity, column, or completion status is missing or unsupported.');
  return { snapshot: { projectId: projectId === null ? `name:${projectName}` : String(projectId), taskId: String(taskId), columnId: `name:${columnName}`,
    completed: status === 'Completed', readAt },
  observed: { taskId, projectLabel, status, columnName, url, readAt }, blockers: [] };
}
