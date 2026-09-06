import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readSoloMcpOutput } from '../native-solo-output.mjs';

function fixture() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'solo-output-')));
  const soloBinary = path.join(project, 'solo');
  const helper = path.join(project, process.platform === 'win32' ? 'mcp.exe' : 'mcp');
  fs.writeFileSync(soloBinary, '', { mode: 0o700 }); fs.writeFileSync(helper, '', { mode: 0o700 });
  return { project, soloBinary, helper, projectId: 32, processId: 175 };
}

test('bundled MCP output reader invokes only bounded local read for exact process', () => {
  const f = fixture();
  const output = readSoloMcpOutput(f, { invoke: (binary, args, options) => {
    assert.equal(binary, process.execPath); assert.equal(args[0], '-e');
    assert.deepEqual(JSON.parse(args[2]), { helper: f.helper, projectId: 32, processId: 175 });
    assert.match(args[1], /get_process_raw_output/); assert.equal(options.cwd, f.project);
    assert.equal(options.timeout, 12000); assert.equal(options.maxBuffer, 2097152);
    return { status: 0, stdout: JSON.stringify('native output') };
  } });
  assert.equal(output, 'native output');
});

test('reader rejects invalid identities and unsafe or oversized output', () => {
  const f = fixture();
  assert.throws(() => readSoloMcpOutput({ ...f, processId: -1 }), /identity/);
  assert.throws(() => readSoloMcpOutput(f, { invoke: () => ({ status: 0, stdout: JSON.stringify('x'.repeat(1048577)) }) }), /bounded/);
  assert.throws(() => readSoloMcpOutput(f, { invoke: () => ({ status: 1, stderr: 'private' }) }), /read failed/);
  assert.throws(() => readSoloMcpOutput(f, { invoke: () => ({ status: 0, stdout: '{}' }) }), /bounded/);
});
