# Orkestar · Lenka

Lenka coordinates coding agents in your project using your own AI account.
Orkestar provides the launcher, scoped workers, readable progress, and evidence
collection. **Early release: 0.1.10.** Review the result before relying on it.

See the [0.1.10 release notes](CHANGELOG.md) for model defaults, worker reuse
and installation fixes.

Plain `lenka up` asks which AI tool to use on every run and launches it in the
current terminal, including a Solo terminal. Saved service/workspace preferences
do not override this plain command. Use `lenka up solo codex` or `--herdr` when
you explicitly want a workspace launcher.

### Choose models on each computer

OpenCode retains autonomous model routing: Lenka chooses from the verified available
routes. It does not require or apply saved per-role model choices.

`lenka setup` offers Auto or an explicit model for Lenka, then a separate CLI,
model and supported effort for implementation, light checks and independent
review. Auto displays its resolved choice before saving. Codex Lenka defaults
to Astra / low; the worker preferences are Terra / medium, Luna / low and
Sol / high when listed. The reviewer must differ from both Lenka and the builder.

External workers currently target authenticated Codex or Claude CLIs using their
existing account login. These are routing preferences, not measured prices or
account-access guarantees. Kimi and Cursor native children still inherit their
conductor model; their selected external workers are separate processes.
Kimi/Cursor conductor effort stays in the native CLI configuration because this
adapter has no verified per-launch effort override for them.

Lenka invokes `lenka delegate --harness kimi --role strongest --task review.json`
from the project. The JSON contains `goal`, `required` acceptance strings and,
for implementation, `ownership` relative paths. Use identical goal/criteria for
the builder and reviewer: the local record limits that contract to two launches.
Workers cannot delegate, results remain untrusted evidence, and completion does
not automatically approve the task. Codex uses its native read-only/workspace-write
sandbox; Claude reviewers have no shell or write tools. Claude tool permissions
are not an OS filesystem sandbox. Native worker continuation is not yet exposed
by this cross-CLI command; it must not silently replace a failed worker.

At each interactive start, Lenka shows the active team and offers `1. Start` or
`2. Change team`. Type a model name such as `grok` to search; results are shown
in pages of twelve. Use a result number, `/next`, `/back`, or `/all`. Effort uses
vertical numbered options: Auto, Low, Medium, High (only supported levels are
shown). Invalid answers repeat the current question without losing earlier choices.

After choosing a team, select one of three save scopes:

1. **This run only** — changes no saved team. In standalone setup, this option
   starts Lenka after the remaining setup questions.
2. **Save for this project** — applies to this tool in this canonical project
   directory, without changing other projects.
3. **Set as default** — used in projects without an explicit project team.
   Existing project overrides keep precedence on later launches.

Legacy computer-wide choices become defaults. Project overrides and private run
snapshots are stored under the machine's `.agent-orchestra/teams` directory,
not in product repositories. Every launch binds its external workers to that
run's team snapshot, so changing another project's team does not change it.
Snapshots are local audit records, not future startup defaults. Choices remain
bound to this machine and home directory; a new machine requires new selection.
Use `lenka up` and choose `2` at the active-team question to change a team, or
run `lenka setup --project PATH`. OpenCode retains autonomous routing.
Setup makes no generation requests; first installation can still perform the
existing model access checks. Claude aliases do not prove account entitlement.


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
