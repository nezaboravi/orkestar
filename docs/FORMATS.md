# Agent formats — the map

One source of truth (OpenCode-format markdown in `agents/` and `teams/`) is
installed by `orchestra.mjs`. Codex, Claude Code, Kimi Code, and OpenCode have
independent model routes and credentials.

These files are durable permission envelopes. Lenka creates one-run specialist
roles at dispatch time by combining an outcome charter, one envelope, and one
live adapter-specific model. A file name is not a permanent team member.

## Runtime routing manifest

- Location: `.agent-orchestra/runtime/<harness>.json`
- Generated per project after live installer probes; ignored by Git
- Contains: harness, lifecycle, fail-closed policy, capability profile,
  permission envelope, model class, selected live model, write flags, and
  independent-proof requirement; Codex manifests also contain the selected
  reasoning effort
- Never contains provider credentials, tokens, or copied authentication state
- Lenka reads this file directly and does not repeat model discovery during a
  task

## OpenCode

- Location: `~/.config/opencode/agents/*.md` (global), `.opencode/agents/` (project)
- Frontmatter: `description`, `mode` (primary/subagent), `model`, `permission`
  (allow/ask/deny per tool: read, edit, bash, task, skill, ...), `steps`
- Permission model: explicit allowlists, glob patterns, `"*": deny` default

## Claude Code

- Location: `~/.claude/agents/*.md` (global), `.claude/agents/` (project)
- Frontmatter: `name` (required), `description`, `tools` (allowlist), `model`
- Conversion: `permission:` → `tools:` list; Bash rules become `Bash(pattern)`
  where possible; `task` → `Task`; the selected Claude model is written only
  after its live probe succeeds

## Codex CLI

- Location: `~/.codex/agents/*.toml` (personal), `.codex/agents/` (project)
- Keys: `name`, `description`, `developer_instructions` (required), optional
  `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config`
- Conversion: `edit: deny` → `sandbox_mode = "read-only"`; otherwise
  `"workspace-write"`; the model slug comes from Codex's own visible catalog
  and is written only after a live probe succeeds; `model_reasoning_effort`
  is generated from the orchestra policy (`low` economy, `medium` mid,
  `high` strongest)

## Kimi Code CLI

- Location: `~/.kimi-code/agents/*.md` (global), `.kimi-code/agents/` (project)
- Frontmatter: `name`, `description`, `tools`, optional `subagents`
- Conversion: the permission envelope becomes a case-sensitive Kimi tool
  allowlist; Lenka embeds `${base_prompt}` so Kimi retains workspace and skill
  instructions; project launch uses `--agent-file` and the verified configured
  Kimi model
- Model routing: without a configured Kimi subagent model pool, every role uses
  the same verified configured model and the manifest reports that limitation
  honestly
- Probe usage: Kimi's text probe does not expose token or cost totals, so the
  doctor reports them as unavailable rather than as zero

## Cursor (experimental)

- Location: `~/.cursor/agents/*.md` (user), `.cursor/agents/` (project)
- Format: Markdown describing when to use the agent and its instructions
  (no strict frontmatter schema); rules in `.cursor/rules/*.mdc` with
  `alwaysApply`; skills auto-discovered from `.cursor/skills/`,
  `~/.agents/skills/`, `.claude/skills/`, `.codex/skills/`

## Skills

- Skills are installed into `~/.agents/skills/` as one portable source. A
  client is claimed as supported only after its adapter proves discovery and
  execution from that location. A skill is a folder with `SKILL.md`
  (frontmatter: `name`, `description`; optional `references/` and scripts).
