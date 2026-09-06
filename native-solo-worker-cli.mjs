import fs from 'node:fs';
import path from 'node:path';

export async function workerCli(args, dependencies = {}) {
  const [action, ...rest] = args;
  if (!['dispatch', 'status', 'result'].includes(action)) throw new Error('Use lenka worker dispatch|status|result');
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    if (!['--project', '--contract', '--run-id'].includes(key) || Object.hasOwn(options, key)
      || typeof rest[index + 1] !== 'string' || rest[index + 1].startsWith('--')) throw new Error('Invalid worker arguments');
    options[key] = rest[index + 1];
  }
  const project = fs.realpathSync(path.resolve(options['--project'] ?? process.cwd()));
  const api = dependencies.api ?? await import('./native-solo-worker.mjs');
  let result;
  if (action === 'dispatch') {
    if (!options['--contract'] || options['--run-id']) throw new Error('Dispatch requires --contract PROJECT_FILE');
    const file = path.resolve(project, options['--contract']);
    const relative = path.relative(project, file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || fs.realpathSync(file) !== file || !fs.statSync(file).isFile() || fs.statSync(file).size > 32768) throw new Error('Worker contract must be a regular project-local file');
    const contract = JSON.parse(fs.readFileSync(file, 'utf8'));
    const keys = ['harness', 'profile', 'name', 'runId', 'task', 'ownerSessionId'];
    if (!contract || Object.keys(contract).length !== keys.length || keys.some(key => !Object.hasOwn(contract, key))) throw new Error('Invalid worker contract fields');
    result = await api.dispatchNativeSoloWorker({ ...contract, project });
  } else {
    if (!options['--run-id'] || options['--contract']) throw new Error('Status/result requires --run-id ID');
    const method = action === 'status' ? api.nativeSoloWorkerStatus : api.collectNativeSoloWorkerResult;
    result = await method({ project, runId: options['--run-id'] });
  }
  (dependencies.print ?? console.log)(JSON.stringify(result, null, 2));
  // Process termination is not task success, and worker success is not acceptance.
  return action === 'result' && result?.complete !== true ? 1 : 0;
}
