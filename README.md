# Orkestar · Lenka

Lenka coordinates coding agents in your project using your own AI account.
Orkestar provides the launcher, scoped workers, readable progress, and evidence
collection. **Early release: 0.1.7.** Review the result before relying on it.

See the [0.1.7 release notes](CHANGELOG.md) for model defaults, worker reuse
and installation fixes.

Plain `lenka up` asks which AI tool to use on every run and launches it in the
current terminal, including a Solo terminal. Saved service/workspace preferences
do not override this plain command. Use `lenka up solo codex` or `--herdr` when
you explicitly want a workspace launcher.

### Choose models on each computer

OpenCode retains autonomous model routing: Lenka chooses from the verified available
routes. It does not require or apply saved per-role model choices.

`lenka setup` lists the selected tool's models and offers editable recommendations
for Lenka, normal workers, light work, and independent review. Enter accepts the
shown choice. Codex recommends Astra at low for Lenka, Terra for normal workers, Luna for light
work, and Sol for review when listed; Claude proposes Sonnet, Haiku, and Opus.
These are routing preferences, not measured price or account-access guarantees.
Unknown models remain selectable but receive no invented capability ranking.
Cursor and Kimi currently inherit one selected model across their native agents;
setup explains this and asks for one model instead of offering ineffective overrides.

Choices are saved locally per tool and bound to the OS machine identity and home
directory. A different computer, missing choices, or a model no longer listed
requires a new selection. Run `lenka setup` again to change them. A copied project
manifest cannot override these choices. Setup makes no generation requests;
first installation still performs the existing access checks for the selected
models, and a failed selection stops instead of silently choosing another model.
Claude's list contains supported aliases, not a verified account entitlement list.


## Install

You need Git and an authenticated supported AI CLI. Node.js 20+ is required;
the bootstrap can install an isolated runtime. First bootstrap/install access
checks may make model requests using your account. Installation backs up
conflicting configuration when selected.

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

For Codex, Lenka defaults to **GPT-6 Astra at low (light)** when account access is verified. Worker and independent review models keep their separate routes.
Implementation, testing, and review keep their separate model routes.
The main Solo panel runs the selected CLI's **native editor**: Codex, Claude
Code, Cursor Agent, Kimi or OpenCode. That CLI handles multiline paste,
questions, interruption and approval screens. Orkestar does not auto-accept
new hook-trust requests. Follow the controls shown by your selected CLI.
Where the selected adapter supports visible workers, their panels remain
separately selectable, with readable progress.

Give Lenka the outcome and acceptance criteria. For a small change she works
directly and obtains one independent check, including tests, security,
performance and acceptance. Delegated work normally uses one builder and one
checker. Reuse those sessions for repairs. The default ceiling is two child
launches per outcome; extra workers require an explicit budget extension.

The failed meetup run is why this release focuses on readable progress and
proportional work. It does not promise a fixed completion time.

## Know the limits

- Provider capacity can still fail. Readiness checks do not reserve quota.
- Continuation is receipt-bound and adapter-specific; never silently replace a session.
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
