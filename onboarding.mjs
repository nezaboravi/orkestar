#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const harnessOrder = ['cursor', 'codex', 'claude', 'kimi', 'opencode'];

const harnessCommands = {
  cursor: 'agent',
  codex: 'codex',
  claude: 'claude',
  kimi: 'kimi',
  opencode: 'opencode',
};

const harnessLabels = {
  cursor: 'Cursor Agent (uses your Cursor subscription)',
  codex: 'Codex (uses your ChatGPT/OpenAI account)',
  claude: 'Claude Code',
  kimi: 'Kimi Code',
  opencode: 'OpenCode',
};

const workspaceLabels = {
  solo: 'Solo desktop',
  herdr: 'Herdr terminal workspace',
  direct: 'Current terminal',
};

function preferencesPath(home = os.homedir()) {
  return path.join(home, '.agent-orchestra', 'preferences.json');
}

function loadPreferences(home = os.homedir()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(preferencesPath(home), 'utf8'));
    return parsed?.schemaVersion === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function savePreferences(preferences, home = os.homedir()) {
  const target = preferencesPath(home);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, ...preferences }, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch { /* Windows has no POSIX mode. */ }
  return target;
}

function commandForHarness(harness) {
  return harnessCommands[harness] || harness;
}

function defaultCapture(binary, args, cwd = process.cwd()) {
  return spawnSync(binary, args, { cwd, encoding: 'utf8', timeout: 15000 });
}

function authenticatedFromOutput(harness, result) {
  const output = `${result?.stdout || ''}\n${result?.stderr || ''}`;
  if (result?.status !== 0) return false;
  try {
    const parsed = JSON.parse(String(result?.stdout || '{}'));
    if (typeof parsed.authenticated === 'boolean') return parsed.authenticated;
    if (typeof parsed.loggedIn === 'boolean') return parsed.loggedIn;
    if (typeof parsed.isLoggedIn === 'boolean') return parsed.isLoggedIn;
    if (typeof parsed.isAuthenticated === 'boolean') return parsed.isAuthenticated;
  } catch { /* Fall back to stable human-readable output. */ }
  if (/not logged in|unauthenticated|needs approval|no models available/i.test(output)) return false;
  if (harness === 'cursor') return /logged.?in|authenticated|account|email/i.test(output);
  if (harness === 'codex' || harness === 'claude') return /logged.?in|authenticated|account|email/i.test(output);
  return null;
}

function inspectHarness(harness, locate, capture = defaultCapture, cwd = process.cwd()) {
  const command = commandForHarness(harness);
  const binary = locate(command);
  if (!binary) return { harness, command, installed: false, authenticated: false, evidence: 'not installed' };
  const checks = {
    cursor: ['status', '--format', 'json'],
    codex: ['login', 'status'],
    claude: ['auth', 'status'],
  };
  if (!checks[harness]) return { harness, command, binary, installed: true, authenticated: null, evidence: 'authentication verified by model probe' };
  const result = capture(binary, checks[harness], cwd);
  const authenticated = authenticatedFromOutput(harness, result);
  return {
    harness,
    command,
    binary,
    installed: true,
    authenticated,
    evidence: authenticated ? 'CLI reports an authenticated account' : 'CLI is installed but not authenticated',
  };
}

function inspectHarnesses(locate, capture = defaultCapture, cwd = process.cwd()) {
  return harnessOrder.map((harness) => inspectHarness(harness, locate, capture, cwd));
}

function recommendHarness(statuses, preferences = null, verifiedHarnesses = []) {
  const usable = new Set([
    ...verifiedHarnesses,
    ...statuses.filter((status) => status.authenticated === true).map((status) => status.harness),
  ]);
  if (preferences?.harness && usable.has(preferences.harness)) return preferences.harness;
  return usable.size === 1 ? [...usable][0] : null;
}

function workspaceChoices({ platform = process.platform, soloInstalled = false, herdrInstalled = false } = {}) {
  return [
    { id: 'solo', available: soloInstalled, reason: soloInstalled ? 'installed' : 'not installed' },
    { id: 'herdr', available: herdrInstalled, reason: herdrInstalled ? 'installed' : 'will be installed by Orkestar' },
    { id: 'direct', available: true, reason: 'uses the current terminal' },
  ];
}

function missingHarnessMessage(harness) {
  if (harness === 'cursor') return 'Cursor Agent is not installed. Install Cursor from https://cursor.com/downloads, enable its CLI, then run: lenka up cursor';
  if (harness === 'codex') return 'Codex CLI is not installed. Install or sign in to Codex, then run: lenka up codex';
  if (harness === 'claude') return 'Claude Code is not installed. Install or sign in to Claude Code, then run: lenka up claude';
  if (harness === 'kimi') return 'Kimi Code CLI is not installed. Install or sign in to Kimi Code, then run: lenka up kimi';
  return 'OpenCode is not installed. Run the Orkestar bootstrap again, then run: lenka up opencode';
}

function signInArgs(harness) {
  if (harness === 'cursor') return ['login'];
  if (harness === 'codex') return ['login'];
  if (harness === 'claude') return ['auth', 'login'];
  if (harness === 'kimi') return ['login'];
  if (harness === 'opencode') return ['auth', 'login'];
  return null;
}

function configureCursorTaskavel(home = os.homedir()) {
  const target = path.join(home, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let config = {};
  if (fs.existsSync(target)) {
    try { config = JSON.parse(fs.readFileSync(target, 'utf8')); }
    catch { throw new Error(`Cursor MCP configuration is not valid JSON: ${target}`); }
  }
  config.mcpServers ||= {};
  config.mcpServers.taskavel ||= { url: 'https://taskavel.com/mcp/taskavel' };
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return target;
}

function connectTaskavel(harness, { home = os.homedir(), locate, run, capture = defaultCapture, cwd = process.cwd() }) {
  const binary = locate(commandForHarness(harness));
  if (!binary) throw new Error(missingHarnessMessage(harness));
  const endpoint = 'https://taskavel.com/mcp/taskavel';
  if (harness === 'cursor') {
    configureCursorTaskavel(home);
    const status = run(binary, ['mcp', 'login', 'taskavel'], cwd);
    return { configured: true, loginStarted: status === 0, verification: 'Run `agent mcp list` after browser authorization.' };
  }
  if (harness === 'codex') {
    const listed = capture(binary, ['mcp', 'list'], cwd);
    if (!/\btaskavel\b/i.test(`${listed.stdout || ''}\n${listed.stderr || ''}`)) {
      const added = run(binary, ['mcp', 'add', 'taskavel', '--url', endpoint], cwd);
      if (added !== 0) throw new Error('Codex could not add the Taskavel MCP server');
    }
    const status = run(binary, ['mcp', 'login', 'taskavel'], cwd);
    return { configured: true, loginStarted: status === 0, verification: 'Run `codex mcp list` after browser authorization.' };
  }
  if (harness === 'claude') {
    const listed = capture(binary, ['mcp', 'list'], cwd);
    if (!/\btaskavel\b/i.test(`${listed.stdout || ''}\n${listed.stderr || ''}`)) {
      const added = run(binary, ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'taskavel', endpoint], cwd);
      if (added !== 0) throw new Error('Claude Code could not add the Taskavel MCP server');
    }
    const status = run(binary, ['mcp', 'login', 'taskavel'], cwd);
    return { configured: true, loginStarted: status === 0, verification: 'Run `claude mcp list` after browser authorization.' };
  }
  if (harness === 'opencode') {
    const status = run(binary, ['mcp', 'add'], cwd);
    if (status !== 0) throw new Error('OpenCode did not complete its interactive MCP setup');
    const login = run(binary, ['mcp', 'auth', 'taskavel'], cwd);
    return { configured: true, loginStarted: login === 0, verification: 'Run `opencode mcp list` after browser authorization.' };
  }
  return { configured: false, loginStarted: false, verification: 'Kimi Code does not expose a verified Taskavel MCP setup command in this adapter. Use Codex, Claude Code, Cursor, or OpenCode for Taskavel work.' };
}

export {
  commandForHarness,
  configureCursorTaskavel,
  connectTaskavel,
  harnessOrder,
  harnessLabels,
  inspectHarness,
  inspectHarnesses,
  loadPreferences,
  missingHarnessMessage,
  preferencesPath,
  recommendHarness,
  savePreferences,
  signInArgs,
  workspaceLabels,
  workspaceChoices,
};
