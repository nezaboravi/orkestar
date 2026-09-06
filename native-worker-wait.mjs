import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
/** Bounded wait for one receipt-bound worker; terminal state is not acceptance. */
export async function waitForNativeWorker(options, { status, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => performance.now(), invoke = spawnSync }) {
  const deadline = now() + 20000;
  const boundedInvoke = (binary, args, settings) => {
    const remaining = Math.floor(deadline - now());
    if (remaining <= 0) throw new Error('Worker wait deadline reached');
    return invoke(binary, args, { ...settings, timeout: Math.min(settings?.timeout ?? remaining, remaining) });
  };
  for (let attempt = 0; attempt <= 10; attempt++) {
    let worker;
    try { worker = await status(options, { invoke: boundedInvoke }); }
    catch (error) {
      if (now() >= deadline) return { runId: options.runId, ready: false, acceptance: 'PARTIAL', next: 'Wait deadline reached; retry worker_wait or inspect worker_status.' };
      throw error;
    }
    if (['exited', 'stopped', 'failed'].includes(worker.state)) return { runId: worker.runId, state: worker.state, ready: true, acceptance: 'PARTIAL', next: 'Collect worker_result; exit alone proves nothing.' };
    if (attempt === 10 || now() >= deadline) return { runId: worker.runId, state: worker.state, ready: false, acceptance: 'PARTIAL', next: 'Call worker_wait again while authorized work remains.' };
    await sleep(Math.min(2000, deadline - now()));
  }
}
