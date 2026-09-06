import fs from 'node:fs';
import path from 'node:path';

const validName = value => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
export function taskavelProjectNames(response) {
  const text = typeof response === 'string' ? response : response?.isError !== true && response?.content?.length === 1 && response.content[0].type === 'text' ? response.content[0].text : null;
  if (typeof text !== 'string' || Buffer.byteLength(text) > 262144) throw new Error('Invalid Taskavel project listing');
  const lines = text.trimEnd().split('\n');
  const header = lines.shift()?.match(/^Your projects \((\d+)\):$/);
  if (!header || lines.shift() !== '' || lines.length !== Number(header[1])) throw new Error('Invalid Taskavel project listing');
  return lines.map(line => {
    const match = line.match(/^- (.+) \[(owner|admin|member|guest)\] \| \d+ members \| Owner plan: .+$/);
    if (!match || !validName(match[1])) throw new Error('Invalid Taskavel project listing');
    return match[1];
  });
}

export function assertUniqueTaskavelProject(names, name, creating = false) {
  if (!validName(name) || !Array.isArray(names) || names.some(value => !validName(value))) throw new Error('Invalid Taskavel project name');
  const matches = names.filter(value => value.toLowerCase().includes(name.toLowerCase()));
  if (creating ? matches.length !== 0 : matches.length !== 1 || matches[0] !== name) throw new Error('Taskavel project name is absent, existing, or ambiguous for this operation');
}

function bindingFile(project) {
  if (!path.isAbsolute(project ?? '') || fs.realpathSync(project) !== project) throw new Error('Invalid Taskavel workspace binding');
  let current = project;
  for (const segment of ['.agent-orchestra', 'runtime']) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe Taskavel binding directory');
  }
  return path.join(current, 'taskavel-binding.json');
}
export function readTaskavelBinding(project) {
  const file = bindingFile(project);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16384) throw new Error('Invalid Taskavel binding file');
  const binding = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (binding.schemaVersion !== 1 || binding.workspace !== project || !validName(binding.projectName)
    || typeof binding.contractId !== 'string' || typeof binding.contractHash !== 'string'
    || binding.projectId !== `name:${binding.projectName}`) throw new Error('Invalid Taskavel workspace binding');
  return binding;
}

/** Native authenticated preflight supplies names, never the model. First binding
 * is only for explicit new-project creation; existing projects are never guessed.
 * This checks launch scope, not arguments subsequently emitted by a native model.
 */
export function bindTaskavelAssignment({ project, contract, authorization, names }) {
  if (!contract?.id || !contract?.hash || authorization.projectId !== null || !validName(authorization.projectName)) throw new Error('Taskavel requires an explicit name-bound project');
  const creating = authorization.operations.includes('create-project');
  assertUniqueTaskavelProject(names, authorization.projectName, creating);
  const expected = { schemaVersion: 1, workspace: project, contractId: contract.id, contractHash: contract.hash,
    projectName: authorization.projectName, projectId: `name:${authorization.projectName}` };
  try {
    const current = readTaskavelBinding(project);
    if (['schemaVersion', 'workspace', 'projectName', 'projectId'].some(key => current[key] !== expected[key])) throw new Error('Taskavel project binding mismatch');
    return current;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!creating) throw new Error('Taskavel project must be created and bound before task writes');
    fs.writeFileSync(bindingFile(project), JSON.stringify(expected), { flag: 'wx', mode: 0o600 });
    return expected;
  }
}
