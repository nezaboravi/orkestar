#!/usr/bin/env node
/** Portable, dependency-free installer and doctor for agent-orchestra. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceAgents = path.join(repoRoot, 'agents');
const sourceTeams = path.join(repoRoot, 'teams');
const sourceSkills = path.join(repoRoot, 'skills');
const persona = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
const orchestraConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'orchestra.json'), 'utf8'));
const isWindows = process.platform === 'win32';

const tools = {
  opencode: { command: 'opencode', stable: true, agentPath: ['.config', 'opencode', 'agents'], projectAgentPath: ['.opencode', 'agents'] },
  claude: { command: 'claude', stable: true, agentPath: ['.claude', 'agents'], projectAgentPath: ['.claude', 'agents'] },
  codex: { command: 'codex', stable: true, agentPath: ['.codex', 'agents'], projectAgentPath: ['.codex', 'agents'] },
  kimi: { command: 'kimi', stable: true, agentPath: ['.kimi-code', 'agents'], projectAgentPath: ['.kimi-code', 'agents'] },
  cursor: { command: 'cursor', stable: false, agentPath: ['.cursor', 'agents'], projectAgentPath: ['.cursor', 'agents'] },
};

function usage(code = 0) {
  console.log(`agent-orchestra

Usage:
  node orchestra.mjs install [options]
  node orchestra.mjs doctor [options]

Options:
  --tool <id[,id]>       Runtime adapter (default: opencode)
  --home <path>          Override target home (for clean-room tests)
  --project <path>       Also install project-local agents and AGENTS.md
  --project-only         Install only into --project; leave home untouched
  --conflict <policy>    fail, skip, or backup (default: fail)
  --dry-run              Show the complete plan without writing
  --installed            With doctor, require every managed file to match
  --structural           With doctor, verify files/tools without provider models
  --experimental         Enable unverified Claude/Codex/Cursor adapters
  --help                 Show this help
`);
  process.exit(code);
}

function parseArgs(argv) {
  const input = [...argv];
  const command = input[0] && !input[0].startsWith('-') ? input.shift() : 'install';
  if (!['install', 'doctor'].includes(command)) usage(1);
  const options = {
    command,
    selectedTools: [],
    home: os.homedir(),
    project: null,
    projectOnly: false,
    conflict: 'fail',
    dryRun: false,
    installed: false,
    structural: false,
    experimental: false,
  };
  const valueAfter = (flag) => {
    const value = input.shift();
    if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
    return value;
  };
  while (input.length) {
    const arg = input.shift();
    if (arg === '--help' || arg === '-h') usage();
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--installed') options.installed = true;
    else if (arg === '--structural') options.structural = true;
    else if (arg === '--experimental') options.experimental = true;
    else if (arg === '--tool') options.selectedTools.push(...valueAfter(arg).split(',').filter(Boolean));
    else if (arg === '--home') options.home = path.resolve(valueAfter(arg));
    else if (arg === '--project') options.project = path.resolve(valueAfter(arg));
    else if (arg === '--project-only') options.projectOnly = true;
    else if (arg === '--conflict') options.conflict = valueAfter(arg);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.selectedTools.length) options.selectedTools = ['opencode'];
  if (options.projectOnly && !options.project) throw new Error('--project-only requires --project');
  options.selectedTools = [...new Set(options.selectedTools)];
  if (!['fail', 'skip', 'backup'].includes(options.conflict)) throw new Error('--conflict must be fail, skip, or backup');
  for (const tool of options.selectedTools) {
    if (!tools[tool]) throw new Error(`Unsupported tool: ${tool}`);
    if (!tools[tool].stable && !options.experimental) throw new Error(`${tool} is experimental; pass --experimental to use it`);
  }
  return options;
}

function executable(command) {
  const extensions = isWindows ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return null;
}

function version(command) {
  const binary = executable(command);
  if (!binary) return null;
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 });
  return (result.stdout || result.stderr || '').trim().split('\n')[0] || 'installed';
}

function scalar(value) {
  const text = value.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

/** Parse the mapping-only YAML subset used by our agent frontmatter. */
function parseFrontmatter(source, label = 'agent') {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const root = {};
  const stack = [{ indent: -1, value: root }];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^(\s*)(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.*-]+)):\s*(.*)$/);
    if (!match) throw new Error(`${label}: unsupported frontmatter line ${index + 1}: ${line}`);
    const indent = match[1].length;
    const key = match[2] ?? match[3] ?? match[4];
    const raw = match[5];
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1).value;
    if (raw === '>' || raw === '|') {
      const chunks = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        if (next.trim() && next.match(/^\s*/)[0].length <= indent) break;
        index++;
        chunks.push(next.trim());
      }
      parent[key] = raw === '>' ? chunks.filter(Boolean).join(' ') : chunks.join('\n');
    } else if (raw === '') {
      parent[key] = {};
      stack.push({ indent, value: parent[key] });
    } else {
      parent[key] = scalar(raw);
    }
  }
  return root;
}

function parseAgent(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const match = raw.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`${file}: missing YAML frontmatter`);
  return {
    name: path.basename(file, '.md'),
    frontmatter: parseFrontmatter(match[1], file),
    body: match[2].trim(),
    raw,
  };
}

function markdownFiles(directory) {
  return fs.readdirSync(directory).filter((name) => name.endsWith('.md')).sort().map((name) => path.join(directory, name));
}

function agentFiles() {
  const files = [...markdownFiles(sourceAgents)];
  for (const team of fs.readdirSync(sourceTeams).sort()) {
    const directory = path.join(sourceTeams, team);
    if (fs.statSync(directory).isDirectory()) files.push(...markdownFiles(directory));
  }
  return files;
}

function allowedPatterns(rule) {
  if (!rule || typeof rule !== 'object') return [];
  return Object.entries(rule).filter(([, action]) => action === 'allow').map(([pattern]) => pattern);
}

function claudeAgent(agent, selectedModel = null) {
  const permission = agent.frontmatter.permission;
  const allowed = new Set();
  if (permission !== 'deny') {
    if (!permission || permission.read !== 'deny') allowed.add('Read');
    if (permission && permission.edit !== 'deny' && permission.write !== 'deny') {
      allowed.add('Edit');
      allowed.add('Write');
    }
    if (permission && permission.bash !== 'deny') {
      const patterns = allowedPatterns(permission.bash);
      if (patterns.length) patterns.forEach((pattern) => allowed.add(`Bash(${pattern})`));
      else if (permission.bash) allowed.add('Bash');
    }
    if (permission && permission.task !== 'deny') allowed.add('Task');
  }
  const model = selectedModel ? [`model: ${selectedModel}`] : [];
  return ['---', `name: ${agent.name}`, `description: ${agent.frontmatter.description || ''}`, ...model, 'tools:', ...[...allowed].map((tool) => `  - ${tool}`), '---', '', agent.body, ''].join('\n');
}

function codexAgent(agent, selectedModel = null, reasoningEffort = null) {
  const permission = agent.frontmatter.permission;
  const readOnly = permission === 'deny' || (permission && typeof permission === 'object' && (permission.edit === 'deny' || permission.write === 'deny'));
  const lines = [
    `name = "${agent.name}"`,
    `description = "${String(agent.frontmatter.description || '').replace(/"/g, "'")}"`,
    `sandbox_mode = "${readOnly ? 'read-only' : 'workspace-write'}"`,
  ];
  if (selectedModel) lines.push(`model = "${selectedModel}"`);
  if (reasoningEffort) lines.push(`model_reasoning_effort = "${reasoningEffort}"`);
  lines.push('', 'developer_instructions = """', agent.body, '"""', '');
  return lines.join('\n');
}

function kimiAgent(agent) {
  const permission = agent.frontmatter.permission;
  const allowed = new Set();
  if (permission !== 'deny') {
    if (!permission || permission.read !== 'deny') allowed.add('Read');
    if (!permission || permission.grep !== 'deny') allowed.add('Grep');
    if (!permission || permission.glob !== 'deny') allowed.add('Glob');
    if (permission && permission.edit !== 'deny' && permission.write !== 'deny') {
      allowed.add('Edit');
      allowed.add('Write');
    }
    if (permission && permission.bash !== 'deny') allowed.add('Bash');
    if (permission && permission.task !== 'deny') {
      allowed.add('Agent');
      allowed.add('AgentSwarm');
    }
  }
  const taskRules = permission && typeof permission === 'object' ? allowedPatterns(permission.task) : [];
  const subagents = taskRules.length ? [`subagents: ${taskRules.join(', ')}`] : [];
  const basePrompt = agent.name === 'lenka' ? '${base_prompt}\n\n' : '';
  return [
    '---',
    `name: ${agent.name}`,
    `description: ${agent.frontmatter.description || ''}`,
    'tools:',
    ...[...allowed].map((tool) => `  - ${tool}`),
    ...subagents,
    '---',
    '',
    `${basePrompt}${agent.body}`,
    '',
  ].join('\n');
}

function cursorAgent(agent) {
  return `# ${agent.name}\n\n## When to use\n\n${agent.frontmatter.description || ''}\n\n## Instructions\n\n${agent.body}\n`;
}

function opencodeAgent(agent, selectedModel) {
  if (!selectedModel) return agent.raw;
  if (/^model:\s*.+$/m.test(agent.raw)) return agent.raw.replace(/^model:\s*.+$/m, `model: ${selectedModel}`);
  return agent.raw.replace(/^(mode:\s*.+)$/m, `$1\nmodel: ${selectedModel}`);
}

function convert(agent, tool, selectedModel = null, reasoningEffort = null) {
  if (tool === 'opencode') return opencodeAgent(agent, selectedModel);
  if (tool === 'claude') return claudeAgent(agent, selectedModel);
  if (tool === 'codex') return codexAgent(agent, selectedModel, reasoningEffort);
  if (tool === 'kimi') return kimiAgent(agent);
  if (tool === 'cursor') return cursorAgent(agent);
  throw new Error(`No converter for ${tool}`);
}

function targetEnvironment(home) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    CODEX_HOME: path.join(home, '.codex'),
  };
}

function modelInventory(home, tool = 'opencode') {
  if (tool === 'codex') return codexModelInventory(home);
  if (tool === 'claude') return declaredModels('claude');
  if (tool === 'kimi') return kimiModelInventory(home);
  const binary = executable('opencode');
  if (!binary) return [];
  const result = spawnSync(binary, ['models'], { encoding: 'utf8', timeout: 15000, env: targetEnvironment(home) });
  if (result.status !== 0) return [];
  return [...new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[^\s/]+\/[^\s]+$/.test(line)))];
}

function kimiModelInventory(home, runner = spawnSync, binary = executable('kimi')) {
  if (!binary) return [];
  const result = runner(binary, ['provider', 'list', '--json'], { encoding: 'utf8', timeout: 15000, env: targetEnvironment(home) });
  if (result?.status !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    const models = Array.isArray(parsed.models)
      ? parsed.models.map((model) => model.alias || model.name || model.id).filter(Boolean)
      : Object.keys(parsed.models || {});
    const configPath = path.join(home, '.kimi-code', 'config.toml');
    const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const configured = config.match(/^default_model\s*=\s*["']([^"']+)["']/m)?.[1] || null;
    return [...new Set([configured, ...models].filter(Boolean))];
  } catch {
    return [];
  }
}

function declaredRoles(tool) {
  return orchestraConfig.modelPolicy.adapters?.[tool]?.roles || {};
}

function declaredClasses(tool) {
  return orchestraConfig.modelPolicy.adapters?.[tool]?.classes || {};
}

function declaredModels(tool) {
  return [...new Set(Object.values(declaredRoles(tool)).flat())];
}

function codexModelInventory(home, runner = spawnSync, binary = executable('codex')) {
  if (!binary) return [];
  const result = runner(binary, ['debug', 'models'], { encoding: 'utf8', timeout: 15000, env: targetEnvironment(home) });
  if (result?.status !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    return [...new Set((parsed.models || []).filter((model) => model.visibility !== 'hide').map((model) => model.slug).filter(Boolean))];
  } catch {
    return [];
  }
}

function resolveModels(inventory, tool = 'opencode') {
  if (tool === 'kimi') {
    const selected = inventory[0] || null;
    return Object.fromEntries(Object.keys(declaredRoles(tool)).map((role) => [role, selected]));
  }
  const available = new Set(inventory);
  return Object.fromEntries(Object.entries(declaredRoles(tool)).map(([role, candidates]) => [
    role,
    candidates.find((candidate) => available.has(candidate)) || null,
  ]));
}

function resolveFactoryModels(inventory, tool = 'opencode') {
  if (tool === 'kimi') {
    const selected = inventory[0] || null;
    return Object.fromEntries(Object.keys(declaredClasses(tool)).map((modelClass) => [modelClass, selected]));
  }
  const available = new Set(inventory);
  return Object.fromEntries(Object.entries(declaredClasses(tool)).map(([modelClass, candidates]) => [
    modelClass,
    candidates.find((candidate) => available.has(candidate)) || null,
  ]));
}

function createAgentCharter(request, tool, factoryModels) {
  const goal = String(request?.goal || '').trim();
  const capability = String(request?.capability || '').trim();
  if (!goal) throw new Error('Dynamic agent goal is required');
  if (!capability) throw new Error('Dynamic agent capability is required');
  const factory = orchestraConfig.agentFactory;
  const profile = factory?.profiles?.[capability];
  if (!factory?.enabled || !profile) throw new Error(`No exact permission envelope exists for capability: ${capability}`);
  if (profile.externalWrites && request.externalWriteAuthorized !== true) {
    throw new Error(`Capability ${capability} requires explicit authorization for the requested external write`);
  }
  const model = factoryModels?.[profile.modelClass] || null;
  if (!model) throw new Error(`No verified ${tool} model is available for class: ${profile.modelClass}`);
  const slug = goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'specialist';
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ tool, capability, goal })).digest('hex').slice(0, 8);
  const evidence = [...new Set((request.evidence || []).map((item) => String(item).trim()).filter(Boolean))];
  if (!evidence.length) evidence.push('Return direct evidence that the requested outcome exists and works');
  return {
    schemaVersion: 1,
    name: `orchestra-${slug}-${fingerprint}`,
    lifecycle: factory.lifecycle,
    goal,
    capability,
    permissionEnvelope: profile.template,
    modelClass: profile.modelClass,
    model,
    ...(reasoningForClass(tool, profile.modelClass) ? { reasoningEffort: reasoningForClass(tool, profile.modelClass) } : {}),
    writes: profile.writes,
    externalWrites: profile.externalWrites,
    independentProofRequired: Boolean(factory.requireIndependentProofAfterWrites && (profile.writes || profile.externalWrites)),
    evidence,
  };
}

function modelProbe(home, model, runner = spawnSync, binary = executable('opencode')) {
  const marker = 'ORCHESTRA_MODEL_OK';
  if (!binary) return { model, ok: false, reason: 'OpenCode CLI not found', authFailure: false, tokens: 0, cost: 0 };
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestra-model-'));
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestra-config-'));
  const environment = {
    ...targetEnvironment(home),
    XDG_CONFIG_HOME: configDirectory,
    OPENCODE_CONFIG_CONTENT: '{"mcp":{},"instructions":[]}',
  };
  let result;
  try {
    result = runner(binary, [
      'run', '--pure', '--format', 'json', '--dir', workingDirectory,
      '--model', model, `Reply with exactly ${marker}. Do not use tools.`,
    ], { encoding: 'utf8', timeout: 45000, env: environment });
  } finally {
    fs.rmSync(workingDirectory, { recursive: true, force: true });
    fs.rmSync(configDirectory, { recursive: true, force: true });
  }
  const stdout = result?.stdout || '';
  const stderr = result?.stderr || '';
  let verified = false;
  let tokens = 0;
  let cost = 0;
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'text' && event.part?.text?.trim() === marker) verified = true;
      if (event.type === 'step_finish') {
        tokens += Number(event.part?.tokens?.total || 0);
        cost += Number(event.part?.cost || 0);
      }
    } catch {
      // Non-JSON diagnostics are classified below without echoing provider output.
    }
  }
  const diagnostic = `${stdout}\n${stderr}`;
  const authFailure = /(?:\b401\b|unauthori[sz]ed|invalid\s+(?:auth(?:entication)?\s+)?token|token\s+(?:is\s+)?invalid)/i.test(diagnostic);
  if (verified && result?.status === 0) return { model, ok: true, reason: 'verified response', authFailure: false, tokens, cost };
  if (authFailure) return { model, ok: false, reason: 'HTTP 401 or rejected provider token', authFailure: true, tokens, cost };
  if (result?.error?.code === 'ETIMEDOUT') return { model, ok: false, reason: 'model probe timed out', authFailure: false, tokens, cost };
  if (result?.status !== 0) return { model, ok: false, reason: `OpenCode exited with status ${result?.status ?? 'unknown'}`, authFailure: false, tokens, cost };
  return { model, ok: false, reason: 'empty or unverified model response', authFailure: false, tokens, cost };
}

function codexModelProbe(home, model, runner = spawnSync, binary = executable('codex')) {
  const marker = 'ORCHESTRA_CODEX_OK';
  if (!binary) return { model, ok: false, reason: 'Codex CLI not found', authFailure: false, tokens: 0, cost: 0 };
  const result = runner(binary, [
    'exec', '--ephemeral', '--ignore-user-config', '--json', '--skip-git-repo-check',
    '-C', os.tmpdir(), '--model', model, `Reply with exactly ${marker}. Do not use tools.`,
  ], { encoding: 'utf8', timeout: 45000, env: targetEnvironment(home), input: '' });
  let verified = false;
  let tokens = 0;
  for (const line of (result?.stdout || '').split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.text?.trim() === marker) verified = true;
      if (event.type === 'turn.completed') tokens += Number(event.usage?.input_tokens || 0) + Number(event.usage?.output_tokens || 0);
    } catch {
      // Diagnostics are classified below without exposing credentials.
    }
  }
  const diagnostic = `${result?.stdout || ''}\n${result?.stderr || ''}`;
  const authFailure = /(?:\b401\b|unauthori[sz]ed|not logged in|invalid\s+(?:auth(?:entication)?\s+)?token|token\s+(?:is\s+)?invalid)/i.test(diagnostic);
  if (verified && result?.status === 0) return { model, ok: true, reason: 'verified response', authFailure: false, tokens, cost: 0 };
  if (authFailure) return { model, ok: false, reason: 'Codex authentication rejected', authFailure: true, tokens, cost: 0 };
  if (result?.error?.code === 'ETIMEDOUT') return { model, ok: false, reason: 'model probe timed out', authFailure: false, tokens, cost: 0 };
  return { model, ok: false, reason: `Codex returned no verified response${result?.status ? ` (status ${result.status})` : ''}`, authFailure: false, tokens, cost: 0 };
}

function claudeModelProbe(home, model, runner = spawnSync, binary = executable('claude')) {
  const marker = 'ORCHESTRA_CLAUDE_OK';
  if (!binary) return { model, ok: false, reason: 'Claude CLI not found', authFailure: false, tokens: 0, cost: 0 };
  const result = runner(binary, [
    '--print', '--model', model, '--output-format', 'json', '--no-session-persistence',
    `Reply with exactly ${marker}. Do not use tools.`,
  ], { encoding: 'utf8', timeout: 45000, env: targetEnvironment(home), input: '' });
  let parsed = {};
  try { parsed = JSON.parse(result?.stdout || '{}'); } catch { /* Classify below. */ }
  const text = String(parsed.result || parsed.text || '').trim();
  const usage = parsed.usage || {};
  const tokens = Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0);
  const cost = Number(parsed.total_cost_usd || 0);
  const diagnostic = `${result?.stdout || ''}\n${result?.stderr || ''}`;
  const authFailure = /(?:\b401\b|unauthori[sz]ed|not logged in|invalid\s+(?:auth(?:entication)?\s+)?token|token\s+(?:is\s+)?invalid)/i.test(diagnostic);
  if (text === marker && result?.status === 0) return { model, ok: true, reason: 'verified response', authFailure: false, tokens, cost };
  if (authFailure) return { model, ok: false, reason: 'Claude authentication rejected', authFailure: true, tokens, cost };
  if (result?.error?.code === 'ETIMEDOUT') return { model, ok: false, reason: 'model probe timed out', authFailure: false, tokens, cost };
  return { model, ok: false, reason: `Claude returned no verified response${result?.status ? ` (status ${result.status})` : ''}`, authFailure: false, tokens, cost };
}

function kimiModelProbe(home, model, runner = spawnSync, binary = executable('kimi')) {
  const marker = 'ORCHESTRA_KIMI_OK';
  if (!binary) return { model, ok: false, reason: 'Kimi Code CLI not found', authFailure: false, tokens: null, cost: null };
  const result = runner(binary, [
    '--model', model, '--prompt', `Reply with exactly ${marker}. Do not use tools.`, '--output-format', 'text',
  ], { encoding: 'utf8', timeout: 45000, env: targetEnvironment(home), input: '' });
  const output = String(result?.stdout || '').replace(/^\s*[•*-]\s*/gm, '').trim();
  const diagnostic = `${result?.stdout || ''}\n${result?.stderr || ''}`;
  const authFailure = /(?:\b401\b|unauthori[sz]ed|not logged in|invalid\s+(?:auth(?:entication)?\s+)?token|token\s+(?:is\s+)?invalid)/i.test(diagnostic);
  if (output === marker && result?.status === 0) return { model, ok: true, reason: 'verified response', authFailure: false, tokens: null, cost: null };
  if (authFailure) return { model, ok: false, reason: 'Kimi authentication rejected', authFailure: true, tokens: null, cost: null };
  if (result?.error?.code === 'ETIMEDOUT') return { model, ok: false, reason: 'model probe timed out', authFailure: false, tokens: null, cost: null };
  return { model, ok: false, reason: `Kimi returned no verified response${result?.status ? ` (status ${result.status})` : ''}`, authFailure: false, tokens: null, cost: null };
}

function probeForTool(tool) {
  if (tool === 'codex') return codexModelProbe;
  if (tool === 'claude') return claudeModelProbe;
  if (tool === 'kimi') return kimiModelProbe;
  return modelProbe;
}

function resolveExecutableCandidates(home, inventory, candidatesByKey, probeModel = modelProbe, tool = 'opencode') {
  const available = new Set(inventory);
  const probes = new Map();
  const blockedProviders = new Set();
  const routes = {};
  for (const [key, candidates] of Object.entries(candidatesByKey)) {
    routes[key] = null;
    for (const candidate of candidates) {
      if (!available.has(candidate)) continue;
      const provider = tool === 'opencode' ? candidate.split('/')[0] : tool;
      if (blockedProviders.has(provider)) continue;
      if (!probes.has(candidate)) probes.set(candidate, probeModel(home, candidate));
      const probe = probes.get(candidate);
      if (probe.authFailure) blockedProviders.add(provider);
      if (probe.ok) {
        routes[key] = candidate;
        break;
      }
    }
  }
  return { routes, probes: [...probes.values()], blockedProviders: [...blockedProviders] };
}

function resolveExecutableModels(home, inventory, probeModel = modelProbe, tool = 'opencode') {
  const candidates = tool === 'kimi'
    ? Object.fromEntries(Object.keys(declaredRoles(tool)).map((role) => [role, inventory]))
    : declaredRoles(tool);
  return resolveExecutableCandidates(home, inventory, candidates, probeModel, tool);
}

function resolveExecutableFactoryModels(home, inventory, probeModel = modelProbe, tool = 'opencode') {
  const candidates = tool === 'kimi'
    ? Object.fromEntries(Object.keys(declaredClasses(tool)).map((modelClass) => [modelClass, inventory]))
    : declaredClasses(tool);
  return resolveExecutableCandidates(home, inventory, candidates, probeModel, tool);
}

function printModelProbes(resolution, tool = 'opencode') {
  console.log(`INFO ${tool} live model smoke check — ${resolution.probes.length} minimal request(s)`);
  for (const probe of resolution.probes) console.log(`${probe.ok ? 'PASS' : 'FAIL'} executable model ${probe.model} — ${probe.reason}`);
  const hasCompleteUsage = resolution.probes.every((probe) => Number.isFinite(probe.tokens) && Number.isFinite(probe.cost));
  if (hasCompleteUsage) {
    const tokens = resolution.probes.reduce((sum, probe) => sum + probe.tokens, 0);
    const cost = resolution.probes.reduce((sum, probe) => sum + probe.cost, 0);
    console.log(`INFO model smoke usage — ${tokens} tokens; $${cost.toFixed(6)}`);
  } else {
    console.log(`INFO model smoke usage — unavailable from ${tool} probe output`);
  }
  for (const provider of resolution.blockedProviders) console.log(`WARN provider ${provider} rejected authentication; remaining ${provider} candidates were skipped`);
}

function portableFiles(root, excludedPaths = []) {
  const files = [];
  const skipped = [];
  const excluded = new Set(excludedPaths.map((entry) => entry.split(/[\\/]/).join(path.sep)));
  const visit = (directory, relative = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const child = path.join(relative, name);
      const stat = fs.lstatSync(absolute);
      if (excluded.has(child)) {
        skipped.push({
          path: absolute,
          target: stat.isSymbolicLink() ? fs.readlinkSync(absolute) : 'declared non-portable source',
        });
      } else if (stat.isSymbolicLink()) skipped.push({ path: absolute, target: fs.readlinkSync(absolute) });
      else if (stat.isDirectory()) visit(absolute, child);
      else if (stat.isFile()) files.push({ source: absolute, relative: child });
    }
  };
  visit(root);
  return { files, skipped };
}

function repoLabel(absolutePath) {
  return path.relative(repoRoot, absolutePath).split(path.sep).join('/');
}

function personaTarget(tool, home) {
  if (tool === 'opencode') return path.join(home, '.config', 'opencode', 'AGENTS.md');
  if (tool === 'claude') return path.join(home, '.claude', 'CLAUDE.md');
  if (tool === 'codex') return path.join(home, '.codex', 'AGENTS.md');
  if (tool === 'kimi') return path.join(home, '.kimi-code', 'AGENTS.md');
  return path.join(home, '.cursor', 'rules', 'lenka.mdc');
}

function selectedAgentModel(agentName, resolvedRoles = {}, resolvedFactory = {}) {
  if (resolvedRoles[agentName]) return resolvedRoles[agentName];
  const profile = Object.values(orchestraConfig.agentFactory?.profiles || {}).find((candidate) => candidate.template === agentName);
  return profile ? resolvedFactory[profile.modelClass] || null : null;
}

function reasoningPolicy(tool) {
  return orchestraConfig.modelPolicy.adapters?.[tool]?.reasoningEffort || {};
}

function selectedAgentReasoning(agentName, tool) {
  if (tool !== 'codex') return null;
  const policy = reasoningPolicy(tool);
  if (policy.roles?.[agentName]) return policy.roles[agentName];
  const profile = Object.values(orchestraConfig.agentFactory?.profiles || {}).find((candidate) => candidate.template === agentName);
  return profile ? policy.classes?.[profile.modelClass] || null : null;
}

function reasoningForClass(tool, modelClass) {
  return tool === 'codex' ? reasoningPolicy(tool).classes?.[modelClass] || null : null;
}

function runtimeManifest(tool, resolvedFactoryModels = {}) {
  const factory = orchestraConfig.agentFactory || {};
  const primaryModelClass = orchestraConfig.modelPolicy?.classes?.coordination || 'mid';
  const profiles = Object.fromEntries(Object.entries(factory.profiles || {}).map(([name, profile]) => {
    const reasoningEffort = reasoningForClass(tool, profile.modelClass);
    return [name, {
      permissionEnvelope: profile.template,
      modelClass: profile.modelClass,
      model: resolvedFactoryModels[profile.modelClass] || null,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      writes: Boolean(profile.writes),
      externalWrites: Boolean(profile.externalWrites),
      independentProofRequired: Boolean(factory.requireIndependentProofAfterWrites && (profile.writes || profile.externalWrites)),
    }];
  }));
  const primaryReasoningEffort = reasoningForClass(tool, primaryModelClass);
  return `${JSON.stringify({
    schemaVersion: 1,
    harness: tool,
    lifecycle: factory.lifecycle,
    unknownCapabilityPolicy: factory.unknownCapabilityPolicy,
    primary: {
      role: 'coordination',
      modelClass: primaryModelClass,
      model: resolvedFactoryModels[primaryModelClass] || null,
      ...(primaryReasoningEffort ? { reasoningEffort: primaryReasoningEffort } : {}),
    },
    profiles,
  }, null, 2)}\n`;
}

function buildPlan(options) {
  const operations = [];
  const warnings = [];
  const agents = agentFiles().map(parseAgent);
  for (const tool of options.selectedTools) {
    const resolvedModels = options.resolvedModelsByTool?.[tool] || options.resolvedModels || {};
    const resolvedFactoryModels = options.resolvedFactoryModelsByTool?.[tool] || options.resolvedFactoryModels || {};
    if (!options.projectOnly) {
      const globalAgents = path.join(options.home, ...tools[tool].agentPath);
      for (const agent of agents) {
        const extension = tool === 'codex' ? '.toml' : '.md';
        const selectedModel = selectedAgentModel(agent.name, resolvedModels, resolvedFactoryModels);
        const reasoningEffort = selectedAgentReasoning(agent.name, tool);
        operations.push({ target: path.join(globalAgents, `${agent.name}${extension}`), content: convert(agent, tool, selectedModel, reasoningEffort), kind: `${tool} agent` });
      }
      const personaContent = tool === 'cursor'
        ? `---\ndescription: Lenka orchestrator persona\nalwaysApply: true\n---\n\n${persona}`
        : persona;
      operations.push({ target: personaTarget(tool, options.home), content: personaContent, kind: `${tool} persona` });
      operations.push({
        target: path.join(options.home, '.agent-orchestra', 'runtime', `${tool}.json`),
        content: runtimeManifest(tool, resolvedFactoryModels),
        kind: `${tool} global runtime manifest`,
      });
    }
    if (options.project) {
      const projectAgents = path.join(options.project, ...tools[tool].projectAgentPath);
      for (const agent of agents) {
        const extension = tool === 'codex' ? '.toml' : '.md';
        const selectedModel = selectedAgentModel(agent.name, resolvedModels, resolvedFactoryModels);
        const reasoningEffort = selectedAgentReasoning(agent.name, tool);
        operations.push({ target: path.join(projectAgents, `${agent.name}${extension}`), content: convert(agent, tool, selectedModel, reasoningEffort), kind: `${tool} project agent` });
      }
      operations.push({
        target: path.join(options.project, '.agent-orchestra', 'runtime', `${tool}.json`),
        content: runtimeManifest(tool, resolvedFactoryModels),
        kind: `${tool} runtime manifest`,
      });
    }
  }
  if (!options.projectOnly) {
    const skills = portableFiles(sourceSkills, orchestraConfig.portability?.excludedSkillPaths || []);
    for (const file of skills.files) {
      operations.push({ target: path.join(options.home, '.agents', 'skills', file.relative), content: fs.readFileSync(file.source), kind: 'shared skill' });
    }
    for (const link of skills.skipped) warnings.push(`Skipped non-portable source: ${repoLabel(link.path)} -> ${link.target}`);
  }
  for (const tool of options.selectedTools) {
    const resolvedModels = options.resolvedModelsByTool?.[tool] || options.resolvedModels || {};
    for (const [role, selectedModel] of Object.entries(resolvedModels)) {
      if (!selectedModel) warnings.push(`No available ${tool} model matched ${role}; it will inherit the harness default`);
    }
  }
  if (options.project) {
    const projectInstructions = path.join(options.project, 'AGENTS.md');
    if (options.projectOnly && targetStat(projectInstructions)) {
      warnings.push(`Preserved existing project instructions: ${projectInstructions}`);
    } else {
      operations.push({ target: projectInstructions, content: persona, kind: 'project persona' });
    }
    if (options.projectOnly) {
      operations.push({
        target: path.join(options.project, '.agent-orchestra', '.gitignore'),
        content: '*\n!.gitignore\n',
        kind: 'project recovery ignore',
      });
    }
  }
  return { operations, warnings, agentCount: agents.length };
}

function sameContent(target, content) {
  if (!fs.existsSync(target)) return false;
  const desired = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return fs.readFileSync(target).equals(desired);
}

function targetStat(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function classify(plan, conflict) {
  return plan.operations.map((operation) => {
    const stat = targetStat(operation.target);
    if (!stat) return { ...operation, action: 'create' };
    if (stat.isSymbolicLink()) return { ...operation, action: 'protected-symlink' };
    if (sameContent(operation.target, operation.content)) return { ...operation, action: 'unchanged' };
    if (conflict === 'skip') return { ...operation, action: 'skip' };
    if (conflict === 'backup') return { ...operation, action: 'replace' };
    return { ...operation, action: 'conflict' };
  });
}

function backupPath(root, target) {
  const relative = path.resolve(target).replace(/^[A-Za-z]:/, (drive) => drive[0]).replace(/^[/\\]+/, '').replace(/:/g, '_');
  return path.join(root, relative);
}

function atomicWrite(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.agent-orchestra-${process.pid}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, target);
}

function apply(classified, options) {
  if (options.dryRun) return 0;
  const conflicts = classified.filter((item) => item.action === 'conflict');
  if (conflicts.length) {
    console.error('\nConflicts detected; nothing was written:');
    conflicts.forEach((item) => console.error(`  ${item.target}`));
    console.error('\nChoose --conflict backup or --conflict skip explicitly.');
    return 2;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const recoveryBase = options.projectOnly
    ? path.join(options.project, '.agent-orchestra')
    : path.join(options.home, '.agent-orchestra');
  const backupRoot = path.join(recoveryBase, 'backups', stamp);
  const completed = [];
  const manifest = [];
  try {
    for (const item of classified) {
      if (!['create', 'replace'].includes(item.action)) continue;
      let backup = null;
      if (item.action === 'replace') {
        backup = backupPath(backupRoot, item.target);
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(item.target, backup);
      }
      atomicWrite(item.target, item.content);
      completed.push({ ...item, backup });
      manifest.push({ target: item.target, action: item.action, backup });
    }
    if (manifest.length) {
      fs.mkdirSync(backupRoot, { recursive: true });
      fs.writeFileSync(path.join(backupRoot, 'manifest.json'), `${JSON.stringify({ createdAt: new Date().toISOString(), files: manifest }, null, 2)}\n`);
      console.log(`\nRecovery manifest: ${path.join(backupRoot, 'manifest.json')}`);
    }
  } catch (error) {
    for (const item of completed.reverse()) {
      if (item.backup) fs.copyFileSync(item.backup, item.target);
      else if (fs.existsSync(item.target)) fs.unlinkSync(item.target);
    }
    throw new Error(`Install failed and completed writes were rolled back: ${error.message}`);
  }
  return 0;
}

function printPlan(items, plan, options) {
  console.log('\nagent-orchestra installation plan');
  console.log('================================');
  console.log(`Mode: ${options.dryRun ? 'dry-run' : 'write'}`);
  console.log(`Tools: ${options.selectedTools.join(', ')}`);
  console.log(`Home: ${options.home}`);
  console.log(`Project: ${options.project || '(global only)'}`);
  console.log(`Scope: ${options.projectOnly ? 'project only' : 'global and requested project'}`);
  console.log(`Conflict policy: ${options.conflict}`);
  console.log(`Source agents: ${plan.agentCount}`);
  const counts = {};
  items.forEach((item) => counts[item.action] = (counts[item.action] || 0) + 1);
  console.log(`Files: ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(', ')}`);
  plan.warnings.forEach((warning) => console.log(`WARNING: ${warning}`));
  items.forEach((item) => console.log(`  ${item.action.padEnd(9)} ${item.target}`));
}

function doctor(options) {
  console.log('\nagent-orchestra doctor');
  console.log('======================');
  let failures = 0;
  const check = (passed, label, detail = '') => {
    console.log(`${passed ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!passed) failures++;
  };
  try {
    const agents = agentFiles().map(parseAgent);
    check(agents.length > 0, 'source agents parse', `${agents.length} agents`);
    const auditor = agents.find((agent) => agent.name === 'dev-auditor');
    check(auditor?.frontmatter.permission?.edit === 'deny', 'nested permissions', 'dev-auditor edit=deny');
    check(codexAgent(auditor).includes('sandbox_mode = "read-only"'), 'read-only conversion invariant');
    const agentNames = new Set(agents.map((agent) => agent.name));
    const profiles = Object.entries(orchestraConfig.agentFactory?.profiles || {});
    check(profiles.length > 0, 'dynamic agent permission envelopes', `${profiles.length} profiles`);
    for (const [name, profile] of profiles) {
      check(agentNames.has(profile.template), `factory profile ${name}`, `template=${profile.template}`);
    }
  } catch (error) {
    check(false, 'source validation', error.message);
  }
  const nodeVersion = version('node');
  check(Boolean(nodeVersion), 'Node.js', nodeVersion || 'not found');
  const herdrVersion = version('herdr');
  console.log(`INFO optional Herdr runtime — ${herdrVersion || 'not installed'}`);
  for (const tool of options.selectedTools) {
    const toolVersion = version(tools[tool].command);
    check(Boolean(toolVersion), `${tool} CLI`, toolVersion || 'not found');
  }
  options.resolvedModelsByTool = {};
  options.resolvedFactoryModelsByTool = {};
  for (const tool of options.selectedTools.filter((candidate) => Object.keys(declaredRoles(candidate)).length)) {
    const inventory = options.structural && tool === 'claude' ? declaredModels(tool) : modelInventory(options.home, tool);
    const probeCache = new Map();
    const probe = (home, model) => {
      if (!probeCache.has(model)) probeCache.set(model, probeForTool(tool)(home, model));
      return probeCache.get(model);
    };
    const resolution = options.structural ? null : resolveExecutableModels(options.home, inventory, probe, tool);
    const factoryResolution = options.structural ? null : resolveExecutableFactoryModels(options.home, inventory, probe, tool);
    const resolved = resolution ? resolution.routes : resolveModels(inventory, tool);
    const resolvedFactory = factoryResolution ? factoryResolution.routes : resolveFactoryModels(inventory, tool);
    options.resolvedModelsByTool[tool] = resolved;
    options.resolvedFactoryModelsByTool[tool] = resolvedFactory;
    if (options.structural) {
      const matchedRoutes = Object.values(resolved).filter(Boolean).length;
      console.log(`INFO ${tool} model declarations — ${inventory.length} visible; ${matchedRoutes}/${Object.keys(resolved).length} role routes matched`);
    } else {
      check(inventory.length > 0, `${tool} model inventory`, inventory.length ? `${inventory.length} models` : 'no provider models found');
      printModelProbes(resolution, tool);
      for (const [role, selectedModel] of Object.entries(resolved)) {
        check(Boolean(selectedModel), `${tool} executable model route ${role}`, selectedModel || 'no working candidate available');
      }
      for (const [modelClass, selectedModel] of Object.entries(resolvedFactory)) {
        check(Boolean(selectedModel), `${tool} dynamic model class ${modelClass}`, selectedModel || 'no working candidate available');
      }
    }
  }
  if (!options.projectOnly) {
    const skills = portableFiles(sourceSkills, orchestraConfig.portability?.excludedSkillPaths || []);
    if (skills.skipped.length) skills.skipped.forEach((link) => console.log(`WARN non-portable source omitted — ${repoLabel(link.path)} -> ${link.target}`));
    else console.log('PASS skill sources are portable');
  }
  const planned = buildPlan(options);
  const installationState = classify(planned, 'skip');
  const protectedCount = installationState.filter((item) => item.action === 'protected-symlink').length;
  const installed = installationState.filter((item) => item.action === 'unchanged').length;
  const expected = installationState.length - protectedCount;
  console.log(`INFO matching installed files — ${installed}/${expected}${protectedCount ? ` (${protectedCount} existing symlink(s) protected)` : ''}`);
  if (options.installed) check(installed === expected, 'managed installation matches source', `${installed}/${expected} files`);
  console.log(failures ? `\nDoctor found ${failures} blocking problem(s).` : '\nDoctor passed all blocking checks.');
  return failures ? 1 : 0;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'doctor') return doctor(options);
  options.resolvedModelsByTool = {};
  options.resolvedFactoryModelsByTool = {};
  for (const tool of options.selectedTools.filter((candidate) => Object.keys(declaredRoles(candidate)).length)) {
    const inventory = options.structural && tool === 'claude' ? declaredModels(tool) : modelInventory(options.home, tool);
    if (options.structural || options.dryRun) {
      options.resolvedModelsByTool[tool] = resolveModels(inventory, tool);
      options.resolvedFactoryModelsByTool[tool] = resolveFactoryModels(inventory, tool);
    }
    else {
      const probeCache = new Map();
      const probe = (home, model) => {
        if (!probeCache.has(model)) probeCache.set(model, probeForTool(tool)(home, model));
        return probeCache.get(model);
      };
      const resolution = resolveExecutableModels(options.home, inventory, probe, tool);
      const factoryResolution = resolveExecutableFactoryModels(options.home, inventory, probe, tool);
      printModelProbes(resolution, tool);
      options.resolvedModelsByTool[tool] = resolution.routes;
      options.resolvedFactoryModelsByTool[tool] = factoryResolution.routes;
      const missing = Object.entries(resolution.routes).filter(([, model]) => !model).map(([role]) => role);
      if (missing.length) throw new Error(`No executable ${tool} model candidate for: ${missing.join(', ')}`);
      const missingClasses = Object.entries(factoryResolution.routes).filter(([, model]) => !model).map(([modelClass]) => modelClass);
      if (missingClasses.length) throw new Error(`No executable ${tool} dynamic model candidate for: ${missingClasses.join(', ')}`);
    }
  }
  const plan = buildPlan(options);
  const items = classify(plan, options.conflict);
  printPlan(items, plan, options);
  const result = apply(items, options);
  if (result === 0) console.log(options.dryRun ? '\nDry-run complete. Nothing was written.' : '\nInstall complete. Run `node orchestra.mjs doctor` to verify the machine.');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

export { parseFrontmatter, parseAgent, codexAgent, kimiAgent, buildPlan, classify, modelInventory, modelProbe, codexModelInventory, codexModelProbe, claudeModelProbe, kimiModelInventory, kimiModelProbe, resolveModels, resolveFactoryModels, resolveExecutableModels, resolveExecutableFactoryModels, createAgentCharter, runtimeManifest, main };
