import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
const WAIT_LIMIT_MS = 60000;
const POLL_DELAYS_MS = [1000, 3000, 6000, 10000, 10000, 10000, 10000, 10000];

function cancelled(options) {
  return options.signal?.aborted === true;
}

function defaultSleep(ms, signal) {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  return new Promise(resolve => {
    let timer;
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    signal.addEventListener('abort', finish, { once: true });
    timer = setTimeout(finish, ms);
    if (signal.aborted) finish();
  });
}

/** Bounded wait for one receipt-bound worker; terminal state is not acceptance. */
export async function waitForNativeWorker(options, { status, sleep = defaultSleep, now = () => performance.now(), invoke = spawnSync } = {}) {
  const deadline = now() + WAIT_LIMIT_MS;
  const timeout = (worker = {}) => ({ runId: worker.runId ?? options.runId, state: worker.state, ready: false,
    acceptance: 'PARTIAL', next: 'Worker wait window elapsed; repeat worker_wait only if authorized work remains.' });
  const aborted = (worker = {}) => ({ runId: worker.runId ?? options.runId, state: worker.state, ready: false,
    cancelled: true, acceptance: 'PARTIAL', next: 'Worker wait was cancelled; inspect worker_status before resuming coordination.' });
  const expired = () => Math.floor(deadline - now()) <= 0;
  const boundedInvoke = (binary, args, settings) => {
    const remaining = Math.floor(deadline - now());
    if (remaining <= 0) throw new Error('Worker wait deadline reached');
    return invoke(binary, args, { ...settings, timeout: Math.min(settings?.timeout ?? remaining, remaining) });
  };
  for (let attempt = 0; ; attempt++) {
    if (cancelled(options)) return aborted();
    if (expired()) return timeout();
    let worker;
    try { worker = await status(options, { invoke: boundedInvoke }); }
    catch (error) {
      if (cancelled(options)) return aborted();
      if (expired()) return timeout();
      throw error;
    }
    if (['exited', 'stopped', 'failed'].includes(worker.state)) return { runId: worker.runId, state: worker.state, ready: true, acceptance: 'PARTIAL', next: 'Collect worker_result; exit alone proves nothing.' };
    if (cancelled(options)) return aborted(worker);
    if (expired()) return timeout(worker);
    await sleep(Math.min(POLL_DELAYS_MS[attempt] ?? 10000, deadline - now()), options.signal);
    if (cancelled(options)) return aborted(worker);
  }
}
