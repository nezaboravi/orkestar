import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Native event streams contain tool results, unlike small configuration files.
export const RAW_OUTPUT_LIMIT = 1024 * 1024;

// Fixed local read-only MCP operation. No model turn or arbitrary command/tool.
const reader = `
const {spawn}=require('node:child_process');
const {StringDecoder}=require('node:string_decoder');
const {helper,projectId,processId}=JSON.parse(process.argv[1]);
const child=spawn(helper,[],{stdio:['pipe','pipe','ignore']});
let buffer='',total=0,done=false;const decoder=new StringDecoder('utf8');
const finish=value=>{if(done)return;done=true;clearTimeout(timer);child.kill();if(value!==undefined)process.stdout.write(JSON.stringify(value));else process.exitCode=1;};
const timer=setTimeout(()=>finish(),10000);
const send=value=>child.stdin.write(JSON.stringify(value)+'\\n');
child.on('error',()=>finish());child.on('exit',()=>finish());child.stdin.on('error',()=>finish());
child.stdout.on('data',chunk=>{try{total+=chunk.length;if(total>2097152)return finish();buffer+=decoder.write(chunk);let end;while((end=buffer.indexOf('\\n'))>=0){const row=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(row.id===1){if(row.error||!row.result?.serverInfo)return finish();send({jsonrpc:'2.0',method:'notifications/initialized'});send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_process_raw_output',arguments:{project_id:projectId,process_id:processId,lines:200}}});}if(row.id===2){if(row.error||row.result?.isError||!Array.isArray(row.result?.content))return finish();const blocks=row.result.content;if(blocks.some(x=>x.type!=='text'||typeof x.text!=='string'))return finish();finish(blocks.map(x=>x.text).join('\\n'));}}}catch{finish();}});
send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'orkestar-worker-output',version:'1'}}});
`;

export function readSoloMcpOutput({ soloBinary, project, projectId, processId }, { invoke = spawnSync } = {}) {
  if (![projectId, processId].every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('Invalid Solo output identity');
  const directory = path.dirname(fs.realpathSync(soloBinary));
  const helper = path.join(directory, process.platform === 'win32' ? 'mcp.exe' : 'mcp');
  const stat = fs.lstatSync(helper);
  if (!stat.isFile() || stat.isSymbolicLink() || path.dirname(fs.realpathSync(helper)) !== directory) throw new Error('Solo bundled output helper is unavailable');
  fs.accessSync(helper, fs.constants.X_OK);
  const result = invoke(process.execPath, ['-e', reader, JSON.stringify({ helper, projectId, processId })],
    { cwd: project, encoding: 'utf8', timeout: 12000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Solo MCP output read failed');
  const output = JSON.parse(result.stdout);
  if (typeof output !== 'string' || Buffer.byteLength(output) > RAW_OUTPUT_LIMIT) throw new Error('Invalid bounded worker output');
  return output;
}
