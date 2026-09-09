import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkerSessionBudget } from '../native-worker-budget.mjs';

const contractId = 'tc-123456789abc';
const fixture = () => fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'worker-budget-')));

function seedReceipts(project, count) {
  const directory = path.join(project, '.agent-orchestra', 'dispatch');
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 1; index <= count; index++) {
    const runId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    fs.writeFileSync(path.join(directory, `native-${runId}.json`), JSON.stringify({ project, contractId, runId }), { mode: 0o600 });
  }
}

function childReservation(project) {
  const moduleUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../native-worker-budget.mjs')).href;
  const source = `
    import { createWorkerSessionBudget } from ${JSON.stringify(moduleUrl)};
    const budget = createWorkerSessionBudget({ project: process.argv[1], contractId: process.argv[2], lockTimeoutMs: 2000, pollMs: 2 });
    try {
      const reservation = await budget.reserve(1);
      process.stdout.write('reserved\\n');
      await new Promise(resolve => setTimeout(resolve, 200));
      reservation.release();
    } catch (error) {
      process.stdout.write((error.code ?? 'error') + '\\n');
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, project, contractId], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`child ${code}: ${stderr}`)));
  });
}

test('two independent Node processes racing for slot two produce exactly one reservation', async () => {
  const project = fixture();
  seedReceipts(project, 1);
  const outcomes = await Promise.all([childReservation(project), childReservation(project)]);
  assert.deepEqual(outcomes.sort(), ['SESSION_BUDGET_EXCEEDED', 'reserved']);
});

test('a stale dead lock is recovered but an old live lock is never stolen', async () => {
  const project = fixture();
  const directory = path.join(project, '.agent-orchestra', 'session-budget', contractId);
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, 'reserve.lock');
  const old = Date.now() - 60000;
  fs.writeFileSync(lock, JSON.stringify({ schemaVersion: 1, token: 'dead-owner', pid: 2147483647, createdAt: old, project, contractId }), { mode: 0o600 });

  const recovered = await createWorkerSessionBudget({ project, contractId, staleMs: 10, lockTimeoutMs: 500, pollMs: 2 }).reserve();
  assert.equal(recovered.count, 1);
  assert.equal(recovered.release(), true);

  fs.writeFileSync(lock, JSON.stringify({ schemaVersion: 1, token: 'live-owner', pid: process.pid, createdAt: old, project, contractId }), { flag: 'wx', mode: 0o600 });
  await assert.rejects(
    createWorkerSessionBudget({ project, contractId, staleMs: 10, lockTimeoutMs: 30, pollMs: 2 }).reserve(),
    error => error.code === 'BUDGET_LOCK_TIMEOUT',
  );
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'live-owner');
});

test('project-local budget paths reject symlinked managed directories', () => {
  const project = fixture();
  const outside = fixture();
  fs.symlinkSync(outside, path.join(project, '.agent-orchestra'));
  assert.throws(() => createWorkerSessionBudget({ project, contractId }), error => error.code === 'UNSAFE_BUDGET_PATH');
});

test('withReservation releases the temporary slot after a failed launch attempt', async () => {
  const project = fixture();
  const budget = createWorkerSessionBudget({ project, contractId });
  await assert.rejects(budget.withReservation(2, async () => { throw new Error('launch failed'); }), /launch failed/);
  const fullBudget = await budget.reserve(2);
  assert.equal(fullBudget.count, 2);
  fullBudget.release();
});


test('concurrent continuations reserve the final turn even without a new worker slot', async () => {
  const project = fixture(); seedReceipts(project, 11);
  const directory = path.join(project, '.agent-orchestra', 'dispatch');
  const files = fs.readdirSync(directory);
  files.forEach((file, index) => {
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, file)));
    receipt.workerSessionRunId = index % 2 ? 'worker-b' : 'worker-a';
    fs.writeFileSync(path.join(directory, file), JSON.stringify(receipt));
  });
  let launches = 0;
  const launch = async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    launches++;
    const runId = '00000000-0000-4000-8000-000000000012';
    fs.writeFileSync(path.join(directory, `native-${runId}.json`), JSON.stringify({ project, contractId, runId, workerSessionRunId: 'worker-a' }));
  };
  const first = createWorkerSessionBudget({ project, contractId });
  const second = createWorkerSessionBudget({ project, contractId });
  const results = await Promise.allSettled([first.withReservation(0, launch), second.withReservation(0, launch)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'SESSION_BUDGET_EXCEEDED');
  assert.equal(launches, 1); assert.equal(fs.readdirSync(directory).length, 12);
  await assert.rejects(first.reserve(0), error => error.code === 'SESSION_BUDGET_EXCEEDED');
});
