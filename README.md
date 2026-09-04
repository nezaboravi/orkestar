# Orkestar

**An opinionated, portable agent team that turns intent into verified behavior.**

Orkestar gives one primary agent, Lenka, a repeatable way to create the smallest
useful team for a task, select models that are actually available on the current
machine, grant the least permissions required, and demand evidence before work
is called complete.

Every code change requires an independent security and performance review.
The reviewer returns evidence-backed findings to Lenka; accepted in-scope
defects go through repair, affected tests, and re-review before final audit.
A passing test suite does not replace this gate. Unsupported checks are
reported as unverified, never silently passed.

It is not a hosted service, a model subscription, or a token broker. It is a
public skeleton you own and adapt. `lenka up` opens the saved workspace and
launches Cursor Agent, Codex, Claude Code, Kimi Code, or OpenCode inside it. Use `--direct`
when you want the selected CLI without Herdr.

> Development is the art of turning intent into verified behavior.

## Why it is opinionated

Orkestar deliberately chooses constraints over agent theatre:

- outcomes matter more than the number of agents;
- agents are created for one job and end when that job is done;
- the cheapest verified capable model is selected after permissions;
- planners and auditors do not edit, and executors do not approve themselves;
- Lenka leads the complete development workflow, dispatches each phase
  directly, and requires an independent dev-auditor verdict;
- destructive operations and external writes stop at a human boundary;
- unavailable providers fall back honestly instead of silently pretending;
- a result without direct evidence is not complete.

## What you get

- **Lenka** — the orchestrator persona. She turns each delegated outcome into
  a new one-run specialist, chooses the cheapest verified capable model, gives
  it the narrowest permission envelope, and requires evidence.
- **Audited permission envelopes** — explorer, implementer, verifier,
  browser-ops, task-manager, and the other installed definitions are reusable
  security boundaries, not a fixed workforce the human has to assemble.
- **Band teams** — domain teams with their own flow:
  - `dev` — Lenka as lead, dev-planner, dev-ticketer, dev-dag, dev-builder,
    product-designer, dev-tester, dev-auditor (design when needed → plan →
    Taskavel tickets → DAG → build → prove)
  - more teams (email, travel, finance...) follow the same template
- **Shared skills** — resend, email best practices, DNS, crash diagnosis, ...
  installed to the portable `~/.agents/skills` source location.

The product designer is not limited to greenfield work. Lenka invokes it for
any material UX/UI decision in a new or existing product, then passes its
read-only specification into planning. It is skipped when an approved design
already defines the work, and for routine backend or small visual fixes.

## Install on any computer

The bootstrap detects the platform, installs an isolated Node.js runtime when
needed, detects an authenticated harness, installs the team, verifies a real
model response, and installs Herdr. On the first plain `lenka up`, a friendly
wizard asks which AI service to use, where Lenka should work, and whether to
connect Taskavel. It saves those choices instead of guessing.
Bootstrap never opens an AI client or workspace by default; installation and
first use are deliberately separate, predictable steps.
It does not depend on Homebrew, Laravel Herd, a particular username, or a
machine-specific project directory.

The installed Lenka CLI is a standalone package under the user's local
directory. It is deliberately not linked to the cloned repository, so the
command continues to work if the clone lives in a protected folder, is moved,
or is removed later.

### macOS

```sh
git clone https://github.com/nezaboravi/orkestar.git
cd orkestar
./bootstrap.sh
```

### Linux, including Arch and Omarchy

```sh
git clone https://github.com/nezaboravi/orkestar.git
cd orkestar
./bootstrap.sh
```

### Windows PowerShell

```powershell
git clone https://github.com/nezaboravi/orkestar.git
Set-Location orkestar
.\bootstrap.ps1
```

On an existing installation, pull the repository and run the same bootstrap
command again. It replaces the installed package from a fresh local archive;
it never leaves the CLI pointing back at the checkout.

After installation, enter any project and start Lenka. These absolute command
paths also work when the local executable directory is not on `PATH`:

macOS or Linux:

```sh
cd /path/to/project
"$HOME/.local/bin/lenka" up
```

Windows PowerShell:

```powershell
Set-Location C:\path\to\project
& "$HOME\.local\lenka.cmd" up
```

After the first bootstrap, the same repository installs a small `lenka`
command into the user's local executable directory. When that directory is on
`PATH`, the shorter commands are available from any project:

```sh
lenka setup
lenka up
lenka up cursor
lenka up solo
lenka up solo codex
lenka up codex
lenka up claude
lenka up kimi
lenka up opencode
lenka up codex --direct
lenka up --ask
lenka status
lenka doctor
lenka connect taskavel
```

The first plain `lenka up` detects installed CLIs, their login state where the
CLI exposes it, and existing live-verified runtime manifests. It asks which AI
subscription to use and whether to open Lenka in Solo, Herdr, or the current
terminal, then continues directly into Lenka. Run `lenka setup` at any time to
repeat the same questions and change the saved choices. Preferences contain no
credentials and live at `~/.agent-orchestra/preferences.json`.

`lenka up` reuses that saved harness and workspace. An explicit harness keeps
all routing inside that service. The conductor uses the verified `mid`
coordination model; one-run workers independently use economy, mid, or
strongest routes according to their capability profile. Each absolute project
path gets its own stable Herdr session. Add `--direct` to bypass Herdr without
changing the selected harness, model routes, or orchestration rules.

The **Cursor Agent** service choice uses Cursor's official `agent` CLI and the
user's Cursor subscription. It is not the same as opening the Cursor desktop
editor. Orkestar does not currently claim that it can start Lenka inside the
desktop editor's Agent panel; use Cursor Agent directly, or run it inside Solo
or Herdr.

Use `lenka up solo` to start Solo when needed, import the current directory,
show that exact project in the Solo window, and launch a clearly named process
such as `Lenka — Cursor Agent · Solo team` or `Lenka — Codex · Solo team`
there with the same verified harness and model route. Before launch, Orkestar
registers Solo's bundled MCP helper in the selected AI client without replacing
other MCP servers. Solo holds the outcome plan and coordination scratchpads.
Codex and Claude Code use native subagents: project-local observation hooks
mirror their actual session identities, models and supported token counters
into Solo scratchpads and activity todos, not fake worker processes. Codex asks
you to review the exact hooks once through its native hook trust screen.
Monetary cost remains `unavailable` when the client supplies no billing evidence.
See [native observation](docs/NATIVE-OBSERVATION.md) for limits and verification.
Repeating the command
reuses the matching running session, or restarts its newest stopped session,
instead of adding another duplicate process.
Solo is a workspace, not a provider: `lenka up solo codex` still uses only the
authenticated Codex route from that machine. Solo's HTTP API must be enabled;
Orkestar starts the installed desktop app and waits for that API automatically.
Its CLI can be on `PATH`; on macOS Orkestar also detects the bundled CLI in the
standard Solo application location.

Normal agent work is project-local. Lenka and her workers must not search the
home directory, other repositories, or application settings to discover their
team or model route. The launcher writes the verified route into the current
project before the session starts. macOS may still request one-time access to
the selected project folder when that folder is protected by the operating
system.

Solo 0.10 does not classify Cursor Agent as a built-in tool. Add it once in
**Solo → Settings → Agents → Add tool** with the name `Cursor` and the command
reported by `command -v agent` (`where.exe agent` on Windows). Orkestar accepts
that generic Solo entry, verifies the signed-in Cursor model route, establishes
workspace trust once without an interactive prompt, and then opens the exact
Solo project. The trust marker contains only the harness name and absolute
project path; it contains no credentials.

When an explicitly selected harness is installed but signed out, `lenka up`
offers to open that harness's native login before any model probe. It never
reports a misleading missing-model error for a known signed-out CLI.

On Linux, including Arch/Omarchy, Orkestar opens Solo through its registered
`solo:` desktop URL handler. Herdr and `--direct` remain available when a Linux
desktop does not register that handler. The orchestra, agents, model routing,
Taskavel policy, verification, and audit contract remain the same.

Solo and the selected CLI must be allowed to read the project directory. On
macOS, a checkout inside a protected folder such as `Documents` can require
Files and Folders permission for Solo; Orkestar detects an agent that exits
during startup and reports its real terminal output instead of claiming READY.

Taskavel remains Orkestar's durable system of record when its authenticated MCP
tools are available. Inside Solo, scratchpads hold temporary working context
and todos mirror active Taskavel work for process ownership, blockers, locks,
and handoffs. Every mirrored todo includes the full Taskavel task URL. If a
public user has no Taskavel access, Solo todos are an explicitly unsynced local
fallback and the tracker adapter can be replaced in `orchestra.json`.
The setup wizard can start the selected harness's native browser authorization.
Orkestar registers `https://taskavel.com/mcp/taskavel` under the exact name
`taskavel`, invokes that client's native OAuth command, and then continues in
the same project. It never asks for a client ID, copies a token, or inspects a
credential. `lenka connect taskavel` repeats that step later.
If optional Taskavel setup cannot be completed, Lenka reports the exact problem
and still opens the selected workspace. Existing invalid MCP configuration is
left untouched instead of being overwritten.

Codex launches are deterministic in both dimensions: the verified model and
the reasoning effort are pinned by the orchestra. Coordination, planning, and
normal implementation use `medium`; economy workers use `low`; final audit
uses `high`. A previous Codex session or machine-wide default cannot silently
turn an ordinary run into a high-reasoning run.

Autonomy is translated by the selected adapter rather than hard-coded as a
Codex policy: Codex uses workspace-write with automatic review, Claude Code
uses its automatic permission mode, Cursor uses its project-write automatic
mode with MCP approval, and Kimi Code and OpenCode use their own
automatic modes. The shared Orkestar rules still deny destructive actions and
unrequested external effects.

Native Windows currently has a complete OpenCode bootstrap. The shared Lenka
CLI and Cursor adapter are platform-neutral, but authenticated Windows proofs
for Cursor, Codex, Claude Code, and Kimi Code remain pending.

The automated Linux matrix covers Ubuntu and a clean Arch Linux container.
Arch is the closest reproducible base for Omarchy, but it is not a substitute
for the physical Omarchy acceptance run. The portable Node and Herdr binaries
target mainstream glibc-based Linux distributions. Alpine and other musl-only
systems are not yet claimed as supported.

The one-command bootstrap defaults to the recoverable `backup` conflict policy:
existing differing files are preserved in a timestamped recovery directory
before Orkestar replaces them. Use `--conflict fail` on macOS/Linux or
`-Conflict fail` on Windows when you want any difference to stop installation
without a write. The lower-level `orchestra.mjs install` command also defaults
to `fail` for manual inspection and controlled integration.

Credentials are never copied between tools. The wizard owns the durable choice.
During bootstrap, Unix may probe Cursor, Codex, Claude Code, Kimi Code, and
OpenCode to establish which routes really work. That discovery does not become
the user's preference: the first plain `lenka up` asks before choosing which
subscription future runs should spend. A harness is considered executable only
after a minimal live response succeeds. If none works, verification stops and
asks the user to sign in; it never claims READY from a model list alone.

Choose a harness explicitly when wanted:

```sh
./bootstrap.sh --harness codex
./bootstrap.sh --harness claude
./bootstrap.sh --harness kimi
./bootstrap.sh --harness opencode
```

Codex itself can also be launched directly from any project after bootstrap:

```sh
cd /path/to/project
codex
```

Codex loads Lenka from `AGENTS.md` and discovers the installed team in
`~/.codex/agents/`. A ChatGPT-authenticated Codex user does not need OpenCode,
DeepSeek, Kimi, or a Claude subscription for that path.

## Install into one project

macOS or Linux:

```sh
./bootstrap.sh --project /path/to/project --project-only
```

Windows PowerShell:

```powershell
.\bootstrap.ps1 -Project C:\path\to\project -ProjectOnly
```

Project-only mode leaves global agent and persona configuration untouched. It
also preserves an existing project `AGENTS.md`, including Laravel Boost rules.
It writes an ignored, credential-free routing map to
`.agent-orchestra/runtime/<harness>.json`. Lenka reads that single file before
delegation instead of scanning the project, global configuration, or provider
credentials. The map names the exact permission envelope and live model
selected for every factory profile on that machine.
For Codex, it also records the exact reasoning effort for the conductor and
every dynamic permission profile.

## Inspect the installer manually

```sh
git clone https://github.com/nezaboravi/orkestar
cd orkestar
node orchestra.mjs doctor
node orchestra.mjs install --dry-run
node orchestra.mjs install --conflict backup
node orchestra.mjs doctor --installed
```

The doctor command checks Node.js, the selected harness, agent definitions, and
permission invariants; it reports Herdr only as an optional tool. The dry run shows every target before anything changes.
The explicit `backup` policy preserves replaced files and writes a recovery
manifest. By default, a conflict stops the entire installation before the first
write. Existing symbolic links are protected and never replaced, including
links to a user's canonical persona file.

Install into one project only when you ask for it:

```sh
node orchestra.mjs install --project /path/to/laravel-app --project-only --conflict backup
node orchestra.mjs doctor --project /path/to/laravel-app --project-only --installed
```

`--project-only` is the safe proof mode: it leaves the user's global persona,
agents, and shared skills untouched. If the project already has `AGENTS.md`
(for example, Laravel Boost guidelines), those instructions are preserved.
Its ignored recovery manifests stay inside `.agent-orchestra/` in that project.

## See what the orchestra actually did

For every non-trivial OpenCode run, Lenka must finish by writing an audit from
OpenCode's own session records. The final answer and the saved audit distinguish:

- `DONE` — the requested outcome and every promised verification succeeded
- `PARTIAL` — useful work landed, but a promised check failed, was skipped, or was unavailable
- `FAILED` — the requested outcome was not delivered

The audit lists the root conductor and every child session with its actual
agent name, provider/model, token totals, recorded cost, verification evidence,
and blockers. Missing values are never estimated.

Read the most recent audit at any time:

```sh
lenka report last
```

The in-session report is captured immediately before Lenka's final answer.
Running `lenka report last` after the session refreshes the same session tree,
so it also includes the final answer's recorded usage.

Run audits live under `.agent-orchestra/runs/` and are ignored by Git. OpenCode
is the first adapter with an exact per-agent collector because its local session
store exposes the required lineage and usage fields. Codex, Claude Code, and
Kimi Code must say `unavailable` for fields their current adapter cannot prove;
they must not borrow OpenCode numbers or display zero as if it meant no usage.

Codex, Claude Code, and Cursor have authenticated adapter proofs; their complete
PLAN → BUILD → VERIFY → PROVE behavior proofs are still pending. OpenCode is
the original adapter. Kimi Code has an authenticated direct-adapter proof; its
complete behavior proof is still pending. Cursor's official agent format, CLI
invocation, live account model inventory, one-time workspace trust, Solo launch,
and Taskavel OAuth adapter are implemented.

| Tool | Status | Agents (global) | Teams (explicit project install) | Persona |
|---|---|---|---|---|
| OpenCode | Supported | `~/.config/opencode/agents/*.md` | `.opencode/agents/` | `~/.config/opencode/AGENTS.md` |
| Claude Code | Authenticated adapter; full behavior proof pending | `~/.claude/agents/*.md` | `.claude/agents/` | `~/.claude/CLAUDE.md` |
| Codex | Authenticated adapter; full behavior proof pending | `~/.codex/agents/*.toml` | `.codex/agents/` | `~/.codex/AGENTS.md` |
| Kimi Code | Authenticated direct adapter; full behavior proof pending | `~/.kimi-code/agents/*.md` | `.kimi-code/agents/` | `~/.kimi-code/AGENTS.md` |
| Cursor | Authenticated adapter and Solo launch proven on macOS; full behavior proof pending | `~/.cursor/agents/*.md` | `.cursor/agents/` | `~/.cursor/rules/lenka.mdc` |

Shared skills are installed into `~/.agents/skills`. Project files are never
written merely because the installer was launched from that directory.

## Herdr workspace and direct mode

The normal path starts Lenka in a stable Herdr workspace:

```sh
cd /path/to/project
lenka up codex
```

Use direct mode when persistent panes are not useful:

```sh
lenka up opencode --direct
```

The default path derives a stable session name from the absolute project path,
so different projects cannot attach to the same persisted panes. Herdr does
not choose the model, grant permissions, or perform orchestration; the selected
CLI adapter still does that work. Desktop clients remain optional.

Orkestar leaves Herdr's interactive shell configuration untouched. It opens the
project session, then starts Lenka once through Herdr's native agent command.
If an adapter cannot start, the pane remains a usable shell and the diagnostic
is recorded under `~/.local/share/agent-orchestra/` instead of entering a
terminal restart loop.

Running `lenka up` from a shell that is already inside Herdr reuses that pane
and starts the selected CLI there. It never attempts to nest a second Herdr
session.

For a Codex launch, Orkestar trusts only the exact active project for that
invocation. This removes Codex's first-run confirmation without changing the
user's global Codex trust settings.

Codex reads Lenka's installed global instructions and the active project's own
`AGENTS.md` through its normal instruction discovery. Orkestar does not paste a
second copy of the full persona into the terminal command line.

The user's explicit instruction to start work authorizes normal agent dispatch.
The orchestra offers one compact plan choice, then continues without routine
approval prompts. A non-destructive external write named in the request, such
as a Laravel Cloud deployment, is already authorized. Destructive operations
and unrequested external effects still stop at a human boundary.

For development work, Lenka cannot directly substitute a generic implementer
or verifier when a team phase fails. The development lead must coordinate the
required design, plan, build, verification, visual QA, and independent audit
roles. A run cannot report `DONE` unless the audit trail records the lead and
auditor, plus product design and frontend QA whenever the acceptance criteria
require material UI work.

`php artisan migrate:fresh --seed`, `php artisan test --compact`,
`php artisan route:list`, Pint, and static analysis are useful supporting
checks. They do not prove the requested behavior on their own. Real proof maps
every acceptance criterion to an independent method, the observed result, and
direct evidence. For a shop, for example, that includes customer journeys,
validation and authorization failures, persisted data and stock invariants,
and visual/browser evidence on the relevant viewports.

## Acceptance status

The current revision is an acceptance-test candidate, not a claim that every
harness has completed the full application workflow. Automated regressions and
clean-room package installation are separate from live application proof.
Use [the recipe notebook meetup brief](proofs/recipe-notebook-meetup.md) for the
next Codex-in-Solo run. Codex uses native named subagents; they are not promised
to appear as separate Solo processes. The identity-checked Solo worker adapter
currently applies to OpenCode only. Live resumed permissions, complete workflow
execution, and Taskavel board transitions must still be observed in that run.
Automatic Solo MCP registration is not currently implemented for Kimi Code;
that combination stops with an explicit error rather than claiming a connection.

## Dynamic agent factory

The human describes the outcome; Lenka constructs the team. Before a
non-trivial delegation she creates an internal charter containing a one-run
agent name, one goal, the minimum capability profile, the cheapest live model
class capable of the work, forbidden adjacent actions, and required evidence.

The durable profiles in `orchestra.json` are permission envelopes. A new
specialist may use the read-only `explorer` envelope, for example, without
becoming "the explorer" as a permanent team member. Project and external
writes require a separate read-only proof. Unknown capabilities fail closed;
Lenka must never widen permissions merely to keep a workflow moving.

This distinction keeps the orchestra dynamic without asking a language model
to improvise security policy. Model routes remain adapter-specific and are
live-probed, so an unavailable or unauthorized provider falls through to the
next declared candidate.

## Make it yours

Fork the repository before changing the defaults. The important customization
points are intentionally plain files:

| What to change | Where | Why |
|---|---|---|
| Orchestrator behavior and voice | `AGENTS.md`, `agents/lenka.md` | Defines how the primary agent reasons, delegates, verifies, and communicates |
| Harness order and model candidates | `orchestra.json` → `runtime` and `modelPolicy.adapters` | Chooses Codex, Claude, Kimi, or OpenCode routes without sharing credentials |
| Workflow phases and roles | `orchestra.json` → `team`, plus `teams/` | Changes PLAN → BUILD → VERIFY → PROVE or adds a domain team |
| Permission envelopes | `agents/*.md`, `orchestra.json` → `agentFactory.profiles` | Controls exactly what a specialist may read, write, execute, or access externally |
| Reusable capabilities | `skills/` | Adds documentation, scripts, and repeatable operating knowledge |
| Completion rules | `orchestra.json` → `evidence` and `safety` | Decides which proof is mandatory and which operations always stop |

Start with behavior, not models. Describe how your orchestrator should make
decisions in `AGENTS.md`; then keep or remove the supplied roles and skills.
Only after that, order the model candidates you already pay for inside each
adapter. Model identifiers are adapter-specific: a Codex model name must never
be copied into an OpenCode or Claude route.

To add a reusable permission profile:

1. Create or adapt an agent definition in `agents/` with the narrowest useful
   permissions.
2. Register it under `agentFactory.profiles` in `orchestra.json` and assign an
   `economy`, `mid`, or `strongest` model class.
3. Add regression coverage under `tests/` for its permissions, generated
   formats, and required evidence.
4. Run `npm test`, followed by a structural bootstrap in a disposable project.
5. Run an authenticated `lenka doctor` on every harness you claim to support.

Never commit tokens, API keys, provider configuration, machine-specific paths,
or generated `.agent-orchestra/runtime/` manifests. Each machine discovers and
records its own authenticated routes locally.

If you rename Lenka or the `lenka` command, also update the executable mapping
in `package.json`, the CLI copy in `lenka.mjs`, and launcher defaults. Changing
only the display name is not enough.

## Configuration model

- **Rules are portable** — repository files are the source of truth.
- **Agents are generated safely** — nested permissions are parsed and checked;
  unverified adapters are opt-in.
- **Skills have one source** — adapters expose the shared location when their
  client supports it.
- **Models are adapter-specific** — Codex, Claude, Kimi, and OpenCode never
  share credentials or model identifiers. Availability is checked with a real
  response, and actual usage is reported after the run. Without a configured
  Kimi subagent model pool, Kimi workers inherit its verified configured model.
- **Roles are ephemeral** — Lenka creates them for one outcome; reusable agent
  files provide tested permission envelopes rather than a fixed org chart.

## See also

- [`docs/FORMATS.md`](docs/FORMATS.md) — the format map
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — direct CLI layers and portability contract
- [`docs/PORTABILITY.md`](docs/PORTABILITY.md) — platform support, verification levels, and test matrix
- [`proofs/laravel-intent-proof.md`](proofs/laravel-intent-proof.md) — the repeatable first Laravel acceptance task

## License

MIT. Use it, fork it, change the team, and make the orchestra yours.
