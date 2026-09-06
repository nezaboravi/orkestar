import { installNativeObserver } from './native-observer-install.mjs';
import { installNativeWorker } from './native-worker-install.mjs';
import { installNativeWorkerBrowser } from './native-worker-browser.mjs';

/** Prepare the selected project's native transport before the conductor starts. */
export async function prepareNativeSolo(input, dependencies = {}) {
  if (!['codex', 'claude'].includes(input.harness)) return null;
  const observer = await (dependencies.observer ?? installNativeObserver)(input);
  const worker = await (dependencies.worker ?? installNativeWorker)(input);
  // Pinned, project-local dependency only. Existing installation is reused;
  // missing browser or failed integrity checks stop setup, never widen tools.
  const browser = await (dependencies.browser ?? installNativeWorkerBrowser)({ project: input.project });
  return { observer, worker, browser };
}
