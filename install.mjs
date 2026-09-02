#!/usr/bin/env node
/**
 * agent-orchestra installer — cross-platform (Windows / macOS / Linux).
 *
 * Detects the agent CLIs installed on this machine, converts the
 * source-of-truth agents (agents/*.md, teams/*) into each tool's format,
 * installs the shared skills, and places the Lenka persona (AGENTS.md)
 * where every tool can read it.
 *
 * Usage:  node install.mjs          (run from this repo)
 *
 * What it does:
 *   1. Detect: opencode, claude, codex, cursor, kimi, gemini, aider
 *   2. Agents: OpenCode (direct), Claude Code (converted), Codex (TOML),
 *      Cursor (markdown) — into the user's global agent directory
 *   3. Teams:   into the CURRENT project (.opencode/agents, .claude/agents,
 *      .codex/agents) so band teams exist per project
 *   4. Skills:  shared location ~/.agents/skills (read by every tool)
 *   5. Persona: AGENTS.md / CLAUDE.md / rules per tool
 *
 * No dependencies, no network calls.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Compatibility entrypoint. The original installer is retained below for
// repository history, but every direct invocation now uses the safe portable
// installer.
const portableInstaller = await import('./orchestra.mjs');
process.exit(portableInstaller.main(process.argv.slice(2)));

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const home = os.homedir();
const cwd = process.cwd();
const isWin = process.platform === 'win32';

const SOURCE_AGENTS = path.join(repoRoot, 'agents');
const SOURCE_TEAMS = path.join(repoRoot, 'teams');
const SOURCE_SKILLS = path.join(repoRoot, 'skills');
const PERSONA = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');

const log = (msg) => console.log(msg);

/* ------------------------------------------------------------------ */
/* 1. Detection                                                        */
/* ------------------------------------------------------------------ */

const TOOLS = [
  { id: 'opencode', cmd: 'opencode', hasAgents: true, global: path.join(home, '.config', 'opencode') },
  { id: 'claude', cmd: 'claude', hasAgents: true, global: path.join(home, '.claude') },
  { id: 'codex', cmd: 'codex', hasAgents: true, global: path.join(home, '.codex') },
  { id: 'cursor', cmd: 'cursor', hasAgents: true, global: path.join(home, '.cursor') },
  { id: 'kimi', cmd: 'kimi', hasAgents: false, global: path.join(home, '.kimi') },
  { id: 'gemini', cmd: 'gemini', hasAgents: false, global: path.join(home, '.gemini') },
  { id: 'aider', cmd: 'aider', hasAgents: false, global: path.join(home, '.aider') },
];

function detectTools() {
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const tool of TOOLS) {
    const exts = isWin ? ['.cmd', '.exe', ''] : [''];
    tool.detected = pathDirs.some((dir) =>
      exts.some((ext) => {
        try {
          fs.accessSync(path.join(dir, tool.cmd + ext), fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      })
    );
  }
  return TOOLS.filter((t) => t.detected);
}

/* ------------------------------------------------------------------ */
/* 2. Parsing source agents (OpenCode markdown frontmatter)            */
/* ------------------------------------------------------------------ */

function parseAgentFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { name: path.basename(filePath, '.md'), frontmatter: {}, body: raw };
  const fm = {};
  const lines = match[1].split('\n');
  let currentKey = null;
  const push = (key, value) => {
    if (!key) return;
    fm[key] = fm[key] ?? [];
    fm[key].push(value);
  };
  for (const line of lines) {
    const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (m) {
      currentKey = m[1];
      push(currentKey, m[2].replace(/^["']|["']$/g, ''));
    } else if (/^\s{2,}/.test(line) && currentKey) {
      push(currentKey, line.trim());
    }
  }
  const flat = {};
  for (const [k, v] of Object.entries(fm)) flat[k] = v.length === 1 ? v[0] : v;
  return {
    name: path.basename(filePath, '.md'),
    frontmatter: flat,
    body: match[2].trim(),
  };
}

function listAgents(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => parseAgentFile(path.join(dir, f)));
}

/* ------------------------------------------------------------------ */
/* 3. Conversions                                                      */
/* ------------------------------------------------------------------ */

const bashPattern = (rules) => {
  if (Array.isArray(rules)) {
    return rules.filter((r) => /^\s*"(.+)"\s*:\s*allow/i.test(r)).map((r) => r.replace(/^\s*"(.+)"\s*:\s*allow/i, '$1').trim());
  }
  return null;
};

function toClaudeAgent(agent) {
  const fm = agent.frontmatter;
  const desc = Array.isArray(fm.description) ? fm.description.join(' ') : (fm.description || '');
  const tools = [];
  const addTool = (t) => { if (!tools.includes(t)) tools.push(t); };
  const perm = fm.permission;

  if (!perm || perm === 'deny') {
    tools.push('Read');
  } else if (typeof perm === 'object') {
    if (perm.read !== 'deny') addTool('Read');
    if (perm.edit !== 'deny') addTool('Edit', 'Write');
    if (perm.bash !== 'deny') {
      const pats = bashPattern(perm.bash);
      if (pats && pats.length) {
        for (const p of pats) addTool(`Bash(${p})`);
      } else {
        addTool('Bash');
      }
    }
    if (perm.webfetch !== 'deny') addTool('WebFetch');
    if (perm.websearch !== 'deny') addTool('WebSearch');
    if (perm.task !== 'deny') addTool('Task');
  } else {
    tools.push('Read', 'Edit', 'Write', 'Bash');
  }

  const out = [
    '---',
    `name: ${agent.name}`,
    `description: ${desc.replace(/\n/g, ' ')}`,
    `tools:`,
    ...tools.map((t) => `  - ${t}`),
    '---',
    '',
    agent.body,
    '',
  ].join('\n');
  return out;
}

function toCodexAgent(agent) {
  const fm = agent.frontmatter;
  const desc = Array.isArray(fm.description) ? fm.description.join(' ') : (fm.description || '');
  const perm = fm.permission || {};
  const editDenied = perm.edit === 'deny';
  const sandbox = editDenied ? 'read-only' : 'workspace-write';
  const model = typeof fm.model === 'string' && fm.model.startsWith('openai/')
    ? fm.model.replace('openai/', '')
    : null;

  const lines = [
    `name = "${agent.name}"`,
    `description = "${desc.replace(/"/g, "'").replace(/\n/g, ' ')}"`,
    `sandbox_mode = "${sandbox}"`,
  ];
  if (model) lines.push(`model = "${model}"`);
  lines.push('', 'developer_instructions = """', agent.body, '"""', '');

  // MCP servers mentioned in permission keys (Taskavel_*, context7_*, playwright_*)
  const mcp = [];
  if (perm && typeof perm === 'object') {
    for (const key of Object.keys(perm)) {
      if (key.startsWith('Taskavel')) mcp.push('Taskavel');
      if (key.startsWith('context7')) mcp.push('Context7');
      if (key.startsWith('playwright')) mcp.push('Playwright');
    }
  }
  if (mcp.length) {
    lines.push('', `# Requires MCP servers: ${[...new Set(mcp)].join(', ')} — register them in config.toml`, '');
  }
  return lines.join('\n');
}

function toCursorAgent(agent) {
  const fm = agent.frontmatter;
  const desc = Array.isArray(fm.description) ? fm.description.join(' ') : (fm.description || '');
  return [
    `# ${agent.name}`,
    '',
    '## When to use',
    '',
    desc || '',
    '',
    '## Instructions',
    '',
    agent.body,
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 4. Installation                                                     */
/* ------------------------------------------------------------------ */

function writeFile(dir, name, content) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

function installAgentsFor(tool) {
  const agents = listAgents(SOURCE_AGENTS);
  const agentDir = path.join(tool.global, 'agents');
  let count = 0;

  for (const agent of agents) {
    if (tool.id === 'opencode') {
      writeFile(agentDir, `${agent.name}.md`, fs.readFileSync(path.join(SOURCE_AGENTS, `${agent.name}.md`), 'utf8'));
    } else if (tool.id === 'claude') {
      writeFile(agentDir, `${agent.name}.md`, toClaudeAgent(agent));
    } else if (tool.id === 'codex') {
      writeFile(agentDir, `${agent.name}.toml`, toCodexAgent(agent));
    } else if (tool.id === 'cursor') {
      writeFile(agentDir, `${agent.name}.md`, toCursorAgent(agent));
    }
    count++;
  }
  return count;
}

function installTeamsFor(tool) {
  // (see note below) (like the core agents), so they exist in
  // every project. Lenka can also create a team on the fly in a project that
  // lacks it (see her persona), but the installer makes them available
  // everywhere from the start.
  if (!tool.hasAgents) return 0;
  const agentDir = path.join(tool.global, 'agents');
  let count = 0;
  for (const teamDir of fs.readdirSync(SOURCE_TEAMS)) {
    const teamPath = path.join(SOURCE_TEAMS, teamDir);
    if (!fs.statSync(teamPath).isDirectory()) continue;
    for (const file of fs.readdirSync(teamPath)) {
      if (!file.endsWith('.md')) continue;
      const agent = parseAgentFile(path.join(teamPath, file));
      if (tool.id === 'opencode') {
        writeFile(agentDir, `${agent.name}.md`, fs.readFileSync(path.join(teamPath, file), 'utf8'));
      } else if (tool.id === 'claude') {
        writeFile(agentDir, `${agent.name}.md`, toClaudeAgent(agent));
      } else if (tool.id === 'codex') {
        writeFile(agentDir, `${agent.name}.toml`, toCodexAgent(agent));
      } else if (tool.id === 'cursor') {
        writeFile(agentDir, `${agent.name}.md`, toCursorAgent(agent));
      }
      count++;
    }
  }
  return count;
}

function installSkills() {
  const dest = path.join(home, '.agents', 'skills');
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const skillDir of fs.readdirSync(SOURCE_SKILLS)) {
    const src = path.join(SOURCE_SKILLS, skillDir);
    if (!fs.statSync(src).isDirectory()) continue;
    fs.cpSync(src, path.join(dest, skillDir), { recursive: true });
    count++;
  }
  return count;
}

function installPersona(tool) {
  if (tool.id === 'opencode') {
    writeFile(tool.global, 'AGENTS.md', PERSONA);
  } else if (tool.id === 'claude') {
    writeFile(tool.global, 'CLAUDE.md', PERSONA);
  } else if (tool.id === 'codex') {
    writeFile(tool.global, 'AGENTS.md', PERSONA);
  } else if (tool.id === 'cursor') {
    writeFile(path.join(tool.global, 'rules'), 'lenka.mdc',
      `---\ndescription: Lenka — the orchestrator persona (always apply)\nalwaysApply: true\n---\n\n${PERSONA}`);
  } else {
    writeFile(tool.global, 'AGENTS.md', PERSONA);
  }
}

/* ------------------------------------------------------------------ */
/* 5. Main                                                             */
/* ------------------------------------------------------------------ */

log('');
log('agent-orchestra installer');
log('========================');
log('');

const detected = detectTools();
const detectedIds = detected.map((t) => t.id);

log(`Detected tools: ${detectedIds.length ? detectedIds.join(', ') : '(none)'}`);
log('');

if (detected.length === 0) {
  log('No supported agent CLI detected on PATH.');
  log('Install one of: opencode, claude (Claude Code), codex, cursor, kimi, gemini, aider.');
  log('Persona and skills were still written to the shared locations:');
}

for (const tool of detected) {
  let summary = `  [${tool.id}] `;
  if (tool.hasAgents) {
    const agents = installAgentsFor(tool);
    const teams = installTeamsFor(tool);
    summary += `agents: ${agents} global + ${teams} project-team agents -> ${path.join(tool.global, 'agents')}`;
  } else {
    summary += 'rules-only tool (AGENTS.md persona installed)';
  }
  installPersona(tool);
  log(summary);
}

// Skills are shared — always install once.
const skillCount = installSkills();
log(`  [shared] ${skillCount} skills -> ${path.join(home, '.agents', 'skills')}`);

// Project AGENTS.md (Lenka persona travels with every repo).
writeFile(cwd, 'AGENTS.md', PERSONA);
log(`  [project] AGENTS.md (Lenka persona) -> ${path.join(cwd, 'AGENTS.md')}`);

log('');
log('Done. Open your agent CLI in any project — Lenka will greet you.');
log('Teams (dev, ...) are installed in the project you ran this from.');
log('');

/* ------------------------------------------------------------------ */
/* Helpers (spread fix for older Node)                                 */
/* ------------------------------------------------------------------ */
void (() => {
  const perm = null;
})();
