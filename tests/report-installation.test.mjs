import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPlan } from '../orchestra.mjs';

for (const harness of ['codex', 'claude']) test(`${harness} installs its structured native report protocol`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-report-protocol-'));
  const plan = buildPlan({ selectedTools: [harness], home: root, project: root, projectOnly: true,
    resolvedModelsByTool: { [harness]: {} }, resolvedFactoryModelsByTool: { [harness]: {} } });
  const protocol = plan.operations.find(item => item.target.endsWith('/protocol/native-report.md'));
  assert.ok(protocol);
  assert.match(protocol.content.toString(), /reviewedRunIds/);
  assert.match(protocol.content.toString(), /worker_report/);
});

for (const scope of ['project', 'global']) test(`${scope} installed report resolves and executes its tracker gate`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-installed-'));
  const home = path.join(root, 'home'), project = path.join(root, 'project');
  fs.mkdirSync(home); fs.mkdirSync(project);
  const plan = buildPlan({ selectedTools: ['opencode'], home,
    ...(scope === 'project' ? { project, projectOnly: true } : { projectOnly: false }),
    resolvedModelsByTool: { opencode: {} }, resolvedFactoryModelsByTool: { opencode: {} } });
  const report = plan.operations.find(item => item.target.endsWith('/tools/orchestra-report.ts'));
  const specifier = report.content.toString().match(/from ["']([^"']*report-tracker-gate\.mjs)["']/)[1];
  for (const operation of plan.operations.filter(item => /\/(report-tracker-gate|tracker-reconciliation)\.mjs$/.test(item.target))) {
    fs.mkdirSync(path.dirname(operation.target), { recursive: true });
    fs.writeFileSync(operation.target, operation.content);
  }
  const gateFile = path.resolve(path.dirname(report.target), specifier);
  assert.ok(gateFile.startsWith(root + path.sep));
  const { reportTrackerGate } = await import(pathToFileURL(gateFile).href);
  assert.throws(() => reportTrackerGate({ status: 'DONE', taskavel: 'synced' }), /requires fresh/);
  assert.equal(reportTrackerGate({ status: 'PARTIAL', taskavel: 'unavailable' }), null);
});
