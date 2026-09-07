# Orkestar · Lenka

Lenka coordinates coding agents in your project using your own AI account.
Orkestar provides the launcher, scoped workers, readable progress, and evidence
collection. **Early release: 0.1.3.** Review the result before relying on it.

## Install

You need Git and an authenticated supported AI CLI. Node.js 20+ is required;
the bootstrap can install an isolated runtime. Setup may make model requests
using your account and backs up conflicting configuration when selected.

```sh
git clone https://github.com/nezaboravi/orkestar.git
cd orkestar
./bootstrap.sh
```

On Windows, run `.\bootstrap.ps1`. See [platform limits](docs/PORTABILITY.md).
Then open your project folder and run:

```sh
lenka up
```

## Use with Solo

Install [Solo](https://soloterm.com/) separately and sign in to Codex or Claude Code:

```sh
lenka up solo codex
# Alternative: lenka up solo claude
```

First launch may request one **Orkestar Worker** custom-tool registration.
The launcher prints the command; [setup instructions](docs/VISIBLE-WORKERS.md)
explain where to paste it.

For Codex, Lenka prefers **Astra at medium** when the account verifies access.
Implementation, testing, and review keep their separate model routes.
The main Solo panel runs the selected CLI's **native editor**: Codex, Claude
Code, Cursor Agent, Kimi or OpenCode. That CLI handles multiline paste,
questions, interruption and approval screens. Orkestar does not auto-accept
new hook-trust requests. Follow the controls shown by your selected CLI.
Where the selected adapter supports visible workers, their panels remain
separately selectable, with readable progress.

Give Lenka the outcome and acceptance criteria. A small change uses a builder,
parallel focused testing and independent review, then an auditor. Accepted
existing Taskavel cards can be closed through authenticated runtime operations,
without another AI worker or another audit solely for bookkeeping.

The failed meetup run is why this release focuses on readable progress and
proportional work. It does not promise a fixed completion time.

## Know the limits

- Provider capacity can still fail. Readiness checks do not reserve quota.
- Native Solo workers cannot resume an interrupted session.
- Taskavel closeout requires explicit project/task authorization and fresh
  readback. It does not create projects or cards through this new runtime path.
- Missing verification remains **PARTIAL**. A worker exiting is not acceptance.
- Native editor launching is shared across the five supported CLIs. Worker
  orchestration and reporting capabilities still vary by adapter; native UI
  support does not imply identical worker, hook or billing support.
- Cursor support means **Cursor Agent CLI**, not the desktop Agent panel.
- Kimi opens its native editor in Solo; automatic Solo MCP and visible-worker
  integration are not verified for that CLI and are reported as unavailable.

## Update

Pull this repository and rerun the bootstrap. Editing the clone alone does
not update installed Lenka. Restart sessions to load updated code and routing.
Stop the old Lenka process in Solo before relaunching after an update. Orkestar
preserves active sessions and refuses to restart incompatible saved commands.
Use `lenka setup` to change service/workspace choices, or
`lenka up codex --direct` to work in a terminal.

[Worker setup](docs/VISIBLE-WORKERS.md) · [Architecture](docs/ARCHITECTURE.md) ·
[Portability](docs/PORTABILITY.md)

MIT license.
