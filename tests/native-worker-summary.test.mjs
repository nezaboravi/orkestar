import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bindSoloObserver } from '../native-solo-mirror.mjs';
import { coordinateNativeSolo } from '../native-worker-coordination.mjs';
import { projectNativeWorkerSummary } from '../native-worker-summary.mjs';

const worker = { project: '/project', harness: 'codex', runId: 'a1234567-1234-4123-8123-123456789012',
  contractId: 'tc-123456789abc',
  complete: true, state: 'stopped', name: 'Recipe designer', role: 'product-designer', model: 'verified-model',
  tokens: { input: 100, output: 20, total: 120 }, cost: null, result: 'Use a clear recipe grid.\n```sh\nrm example\n```\n{"raw":true}\nnpm run build' };

function projectionFixture() {
  const calls = [], pads = new Map();
  const coordinate = async input => {
    calls.push(input);
    const { name, args } = input;
    if (name === 'coord_scratchpad_create') {
      if (!pads.has(args.key)) pads.set(args.key, { id: pads.size + 1, name: args.name, content: args.content, revision: 1 });
      return { ...pads.get(args.key) };
    }
    const pad = [...pads.values()].find(pad => pad.id === args.id);
    if (name === 'coord_scratchpad_read') return { ...pad };
    assert.equal(name, 'coord_scratchpad_append');
    if (args.expectedRevision !== pad.revision) throw Error('revision conflict');
    pad.content += args.content; pad.revision++;
    return { ...pad };
  };
  return { calls, pads, coordinate, content: () => [...pads.values()].map(pad => pad.content).join('\n') };
}

test('recognizable credentials withhold all free prose and are not copied from metadata or structured fields', async () => {
  // These are fake redaction samples assembled at runtime, never issued credentials.
  const syntheticAwsSuffix = 'ABCDEFGHIJKLMNOP';
  const syntheticAwsAccessKey = `AK${'IA'}${syntheticAwsSuffix}`;
  const syntheticAwsSessionKey = `AS${'IA'}${syntheticAwsSuffix}`;
  const credentials = [
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github_pat_abcdefghijklmnopqrstuvwxyz0123456789',
    syntheticAwsAccessKey, syntheticAwsSessionKey, 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
    '-----BEGIN PRIVATE KEY-----\nPRIVATE\n-----END PRIVATE KEY-----',
    '-----BEGIN RSA PRIVATE KEY-----\nPRIVATE\n-----END RSA PRIVATE KEY-----',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nPRIVATE\n-----END OPENSSH PRIVATE KEY-----',
    'Bearer private-value', 'api_key=private-value', 'sk-private-value',
  ];
  for (const credential of credentials) {
    const f = projectionFixture();
    await projectNativeWorkerSummary({ project: '/project', harness: 'codex', worker: { ...worker,
      name: credential, result: `Otherwise benign result.\n${credential}\nMore prose.` } }, f);
    assert.match(f.content(), /Prose result withheld/);
    assert.equal(f.content().includes(credential), false);
    assert.doesNotMatch(f.content(), /Otherwise benign result|More prose|private-value|abcdefghijklmnopqrstuvwxyz/);
    const structured = projectionFixture();
    await projectNativeWorkerSummary({ project: '/project', harness: 'codex', worker: { ...worker,
      result: JSON.stringify({ verdict: 'PARTIAL', blockers: [credential] }) } }, structured);
    assert.equal(structured.content().includes(credential), false);
    assert.match(structured.content(), /detail withheld/);
  }
});

test('benign prose remains readable but Markdown images, links, reference markup and HTML cannot be projected', async () => {
  const f = projectionFixture();
  await projectNativeWorkerSummary({ project: '/project', harness: 'codex', worker: { ...worker,
    result: 'Button behavior verified. ![proof](https://attacker.example/pixel) [click](https://attacker.example/page) <img src="https://attacker.example/image">\n![reference][img]\n[img]: https://attacker.example/ref\nEnd of report.' } }, f);
  assert.match(f.content(), /Button behavior verified/); assert.match(f.content(), /End of report/);
  assert.doesNotMatch(f.content(), /attacker\.example|https:\/\/|!\[|<img|\]\(/);
});

test('completed worker summary is bounded readable and retry-idempotent by run identity', async () => {
  const { calls, coordinate } = projectionFixture();
  const input = { project: '/project', harness: 'codex', worker };
  assert.deepEqual(await projectNativeWorkerSummary(input, { coordinate }), { scratchpadId: 1, state: 'published' });
  await projectNativeWorkerSummary(input, { coordinate }); assert.deepEqual(calls[0], calls[2]);
  assert.equal(calls.filter(call => call.name === 'coord_scratchpad_append').length, 1);
  const { args } = calls[1]; assert.equal(calls[0].name, 'coord_scratchpad_create');
  assert.equal(calls[0].args.key, `team-overview:codex:${worker.contractId}`); assert.match(args.content, /120 total/);
  assert.match(args.content, /unavailable cached \/ unavailable uncached/); assert.match(args.content, /not unique prompt size/);
  assert.match(args.content, /Cost: unavailable/); assert.match(args.content, /Use a clear recipe grid/);
  for (const forbidden of ['PRIVATE', 'rm example', '"raw"', 'npm run']) assert.equal(args.content.includes(forbidden), false);
  assert.ok(args.content.length < 4000); assert.match(args.content, /does not approve/);
});

test('readable Codex summary distinguishes verified cached input without calculating price', async () => {
  const f = projectionFixture();
  await projectNativeWorkerSummary({ project: '/project', harness: 'codex', worker: { ...worker,
    tokens: { input: 100, output: 20, total: 120, cachedInput: 80, uncachedInput: 20 } } },
  f);
  assert.match(f.content(), /80 cached \/ 20 uncached/); assert.match(f.content(), /Cost: unavailable/);
});

test('projection failure is separate and incomplete workers produce no writes', async () => {
  const input = { project: '/project', harness: 'codex', worker };
  const result = await projectNativeWorkerSummary(input, { coordinate: async () => { throw new Error('private'); } });
  assert.equal(result.state, 'unavailable'); assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(worker.complete, true); assert.equal(worker.result.startsWith('Use'), true);
  assert.equal(await projectNativeWorkerSummary({ ...input, worker: { ...worker, complete: false } }, { coordinate: () => { throw new Error('must not write'); } }), null);
});

test('structured reviewer and auditor results render useful bounded untrusted fields only', async () => {
  let content;
  const show = async result => {
    const f = projectionFixture();
    await projectNativeWorkerSummary({project:'/project',harness:'codex',worker:{...worker,result:JSON.stringify(result)}}, f);
    content = f.content();
  };
  await show({verdict:'APPROVED',reviewedRunIds:['PRIVATE-ID'],security:{status:'PASS',evidence:['Authorization rejects other owners.']},performance:{status:'PASS',evidence:['Bounded query count.']},arbitrary:'PRIVATE RAW'});
  assert.match(content,/Worker verdict: APPROVED \(untrusted\)/);assert.match(content,/Security: PASS/);assert.match(content,/Bounded query count/);
  assert.match(content,/Requested model: verified-model/);assert.doesNotMatch(content,/PRIVATE/);
  await show({verdict:'CHANGES_REQUIRED',security:{status:'UNVERIFIED',evidence:['Authorization journey was not executed.']},performance:{status:'UNVERIFIED',evidence:['Query count was not measured.']}});
  assert.match(content,/Security: UNVERIFIED/);assert.match(content,/Performance: UNVERIFIED/);
  assert.match(content,/Authorization journey was not executed/);assert.match(content,/Query count was not measured/);
  await show({verdict:'PARTIAL',proof:[{criterionId:'R1',result:'passed',method:'Independent browser journey'}],blockers:['Screenshot unavailable','token=PRIVATE','[click](https://evil.test) <img src=x>']});
  assert.match(content,/R1 — passed.*Independent browser journey/);assert.match(content,/Blocker: Screenshot unavailable/);
  assert.doesNotMatch(content,/PRIVATE|evil.test|<img/);assert.match(content,/does not approve/);
  await show({arbitrary:'PRIVATE RAW'});assert.doesNotMatch(content,/PRIVATE RAW/);
  await show({verdict:'DONE',proof:Array.from({length:100},()=>({criterion:'Long'.repeat(1000),result:'passed',method:'Test'.repeat(1000)}))});
  assert.ok(content.length<4000);
});

test('parallel completions share one contract overview without lost sections or duplicate retries', async () => {
  const f = projectionFixture();
  const second = { ...worker, runId: 'b1234567-1234-4123-8123-123456789012', displayName: 'Codex Luna · Tester' };
  const inputs = [worker, second].map(worker => ({ project: '/project', harness: 'codex', worker }));
  const results = await Promise.all(inputs.map(input => projectNativeWorkerSummary(input, f)));
  assert.equal(f.pads.size, 1);
  assert.ok(results.every(result => result.state === 'published'));
  for (const input of inputs) await projectNativeWorkerSummary(input, f);
  for (const input of inputs) assert.equal(f.content().split(`<!-- worker-result:${input.worker.runId} -->`).length, 2);
  assert.match(f.content(), /Codex Luna · Tester/);
  assert.equal([...f.pads.values()][0].revision, 3);
});

test('different contracts and harnesses cannot overwrite each other, and unbound legacy workers do not create more pads', async () => {
  const f = projectionFixture();
  for (const next of [worker, { ...worker, contractId: 'tc-abcdef123456' }, { ...worker, harness: 'claude' }]) {
    await projectNativeWorkerSummary({ project: '/project', harness: next.harness, worker: next }, f);
  }
  assert.equal(f.pads.size, 3);
  const calls = f.calls.length;
  assert.equal(await projectNativeWorkerSummary({ project: '/project', harness: 'codex', worker: { ...worker, contractId: undefined } }, f), null);
  assert.equal(f.calls.length, calls);
});

test('ambiguous append completion reads before retry and does not duplicate the report', async () => {
  const f = projectionFixture();
  let thrown = false;
  const coordinate = async input => {
    const result = await f.coordinate(input);
    if (input.name === 'coord_scratchpad_append' && !thrown) { thrown = true; throw Error('readback unavailable'); }
    return result;
  };
  const result = await projectNativeWorkerSummary({ project: '/project', harness: 'codex', worker }, { coordinate });
  assert.equal(result.state, 'published');
  assert.equal(f.content().split(`<!-- worker-result:${worker.runId} -->`).length, 2);
});

test('real coordination ownership and revision locks aggregate concurrent workers and preserve previous notes', async t => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'solo-overview-')));
  const bin = path.join(project, 'bin'); fs.mkdirSync(bin);
  const binary = path.join(bin, process.platform === 'win32' ? 'solo.exe' : 'solo');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const original = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${original}`;
  t.after(() => { process.env.PATH = original; });
  bindSoloObserver({ project, projectId: 29, soloBinary: binary, harness: 'codex' });
  const records = [];
  const invoke = (_binary, args, options) => {
    const respond = data => ({ status: 0, stdout: JSON.stringify({ ok: true, data }) });
    if (args[0] === 'projects') return respond({ id: 29, path: project });
    assert.equal(args[0], 'scratchpads');
    const flag = name => args[args.indexOf(name) + 1];
    assert.equal(flag('--project-id'), '29');
    if (args[1] === 'create') {
      const record = { id: records.length + 1, projectId: 29, name: flag('--name'), content: options.input, revision: 1 };
      records.push(record); return respond(record);
    }
    const record = records.find(item => item.id === Number(args[2])); assert.ok(record);
    if (args[1] === 'append') {
      assert.equal(flag('--expected-revision'), String(record.revision));
      record.content += options.input; record.revision++;
    } else assert.equal(args[1], 'read');
    return respond(record);
  };
  const coordinate = input => coordinateNativeSolo(input, { invoke });
  await coordinate({ project, harness: 'codex', name: 'coord_scratchpad_create', args: { key: 'old-report', name: 'Old report', content: 'Preserved history' } });
  const inputs = ['a', 'b', 'c'].map(prefix => ({ project, harness: 'codex', worker: { ...worker, project, runId: prefix + worker.runId.slice(1) } }));
  for (const result of await Promise.all(inputs.map(input => projectNativeWorkerSummary(input, { coordinate })))) assert.equal(result.state, 'published');
  await projectNativeWorkerSummary(inputs[0], { coordinate });
  assert.equal(records.length, 2); assert.equal(records[0].content, 'Preserved history');
  for (const input of inputs) assert.equal(records[1].content.split(`<!-- worker-result:${input.worker.runId} -->`).length, 2);
  assert.equal(records[1].revision, 4);
});
