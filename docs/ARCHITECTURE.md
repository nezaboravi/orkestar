# Architecture

Orkestar separates the team's behavior from the tools that execute it.
The public repository is the source of truth; no machine-specific setup is an
implicit dependency.

## Layers

1. **Intent** — the human states the outcome in ordinary language.
2. **Orchestra** — `orchestra.json`, agent definitions, and team rules define
   roles, workflow, permissions, model classes, evidence, and escalation.
3. **Launcher** — `lenka up` reuses a verified route and starts the selected
   CLI in a stable Herdr workspace; `lenka up solo` uses Solo as an optional
   visual control plane, while `--direct` bypasses a workspace.
4. **Harness** — Cursor Agent, Codex, Claude Code, Kimi Code, or OpenCode executes the same
   team rules.
5. **Proof** — acceptance-criterion evidence, negative and boundary checks,
   visual/browser evidence when relevant, independent audit, cost records, and
   the project handoff turn activity into verified behavior. General test,
   migration, routing, formatting, and static-analysis commands are supporting
   health checks rather than proof by themselves.

## Scope protocol

For each non-trivial outcome, Lenka creates one immutable Task Contract. It
separates required behavior, local implementation decisions, explicit
out-of-scope work, report-only discoveries, and a semantic change surface. The
contract is stored with the run, has an ID and hash, and is the only scope
authority for designer, planner, builder, tester, reviewer, debugger, and
auditor.

Every phase receives the same contract and only its allowed artifacts. A plan,
builder report, reviewer finding, or test output is evidence rather than a new
specification. Findings and failures are typed: scoped failures and verified
in-scope defects may receive a narrow repair packet; unrelated discoveries and
speculation remain report-only. Before verification, the team compares the
actual semantic change surface against the planned modules, file kinds,
dependency, migration, and architecture allowances.

The schemas and template are installed project-locally at
`.agent-orchestra/protocol/`. They are dependency-free validation primitives
and role instructions. They are **not** a shared cross-harness dispatcher or
state machine: enforcement depends on the selected harness preserving the
phase packet, and a harness that cannot do so must report that limitation.

## Dynamic agent factory

An agent has two separate parts:

1. **Ephemeral role charter** — a one-run identity, one outcome, model class,
   forbidden adjacent work, evidence contract, and lifecycle.
2. **Durable permission envelope** — an audited harness definition that grants
   only a known capability such as project read, project write, verification,
   Taskavel, or browser operation.

Lenka creates the first part for every non-trivial delegation and selects the
narrowest second part that can complete it. Installed names such as `explorer`
and `implementer` are therefore security profiles, not required members of a
fixed team. If no exact envelope exists, dispatch fails closed; a broader
profile is never an implicit fallback.

Model choice happens after permission choice. Each adapter declares ordered
`economy`, `mid`, and `strongest` candidates. The first live authenticated
candidate capable of the role is used. Project and external writes always
produce a second, read-only proof task, and the final report records the real
model, result, verification, tokens, and cost available from the harness.

Codex reasoning is part of routing rather than an inherited UI preference.
Economy profiles use `low`, mid profiles and the conductor use `medium`, and
the strongest/final-audit route uses `high`. Both the launcher and generated
Codex role files carry the selected value, so a prior session cannot change the
orchestra's cost and depth policy.

Each project install materializes that adapter decision in
`.agent-orchestra/runtime/<harness>.json`. This ignored manifest contains no
credentials. It prevents the primary orchestrator from spending tokens on
model inventory and agent-definition discovery during ordinary work; route
probing remains an installer and doctor responsibility.

Desktop clients are optional views and manual workspaces. Solo is a first-class
optional execution control plane: it imports the current project and launches
the already verified harness/model as `Lenka — Orkestar`. It does not choose a
provider or replace adapter permissions. The autonomous path still works
without a desktop application so the same repository can be tested on macOS,
Linux, and Windows.

Taskavel is the durable coordination system of record when its authenticated
tools are available. Solo scratchpads hold session working memory; Solo todos
mirror the currently executing Taskavel work with the full Taskavel URL and add
local process ownership, blockers, locks, and handoffs. A Solo completion never
silently closes Taskavel. When Taskavel is unavailable, Solo is an explicitly
unsynced local fallback rather than a second hidden source of truth.
When the conductor's harness lacks Taskavel but Solo is present, Lenka may
dispatch the Taskavel envelope through another harness only after both its
economy model route and Taskavel authentication are proven on that machine.

An explicit user instruction to start work authorizes normal team dispatch.
The orchestra offers one compact plan choice, then continues without routine
approval prompts. Each harness adapter expresses this behavior using its own
native controls: Codex uses workspace-write with automatic review, Claude Code
uses automatic permission mode, and Kimi Code and OpenCode use their automatic
modes. Those flags are adapters, not the cross-harness security policy.

Explicit agent-level denials remain the boundary. Destructive Git, deletion,
database resets, credential changes, and unrequested external effects require
the human. A non-destructive external write explicitly named in the requested
outcome may proceed unattended and must still receive independent proof.

Development execution has an additional structural boundary: Lenka is the lead
and directly dispatches the planner, builder, tester, and auditor envelopes.
This flat phase graph avoids nested-agent depth limits while preserving role
separation. The builder cannot declare its own work complete; a recorded
`dev-auditor` session supplies the final independent verdict. Material UI work
also requires the design and frontend QA phases. The OpenCode report tool
enforces these requirements before it accepts `DONE`. With OpenCode inside Solo,
the phases use identity-checked visible sibling processes and native session
records plus dedicated result artifacts. Codex instead uses native named
subagents; they are not promised to appear as separate Solo processes.

Taskavel setup is adapter-native. Each supported client registers the same
public streamable HTTP endpoint under the exact `taskavel` name, invokes its
own OAuth command, and returns control to the original project. No adapter asks
the user for client credentials or copies authentication state between tools.

OpenCode handoff and run state use the tool execution session's active
directory, not its Git worktree. This matters for fresh Laravel projects that
do not yet have `.git`: their worktree may resolve to `/`, while the session
directory still identifies the real project. Root-level persistence is denied.

## Portable installation contract

The installer must:

- support a no-write dry run;
- refuse silent overwrites;
- preserve existing symbolic links instead of replacing their targets;
- back up replaced files only when explicitly requested;
- create a recovery manifest;
- finish transactionally or roll back completed writes;
- reject or omit absolute, machine-specific symlinks;
- support an isolated target home for clean-room tests;
- install into a project only when `--project` is provided;
- provide a project-only proof mode that leaves the user's home untouched;
- preserve project-owned instructions such as Laravel Boost `AGENTS.md`;
- validate nested permissions before generating another tool's format.

Codex and Claude Code have authenticated model and generated-format proofs;
their full team behavior proofs are still pending. Kimi Code has a native
agent-format adapter and direct launcher. Cursor uses the official `agent` CLI
and `.cursor/agents/*.md` frontmatter; its authenticated end-to-end behavior
proof is still pending.

Model names and credentials belong to an adapter. The Unix bootstrap tries the
declared harness order (`cursor`, `codex`, `claude`, `kimi`, `opencode`) and requires a minimal
live response before selecting one. Codex uses its ChatGPT sign-in and own model
catalog; Claude Code uses its own sign-in and starts with Haiku; Kimi Code uses
its own provider configuration; OpenCode tests its own declared provider
candidates. Tokens are
never copied between authentication stores. A failed candidate is skipped; if
all candidates fail, installation stops without claiming READY.

Kimi Code inherits its configured main model for subagents when no subagent
model pool exists. In that state the runtime manifest records the same verified
model for every class instead of inventing economy, mid, and strongest routes.

## Cross-machine acceptance test

The supported entrypoints are `bootstrap.sh` on macOS/Linux and
`bootstrap.ps1` on Windows. They provide the prerequisite installation and run
the lower-level sequence below. See `docs/PORTABILITY.md` for the platform
matrix and the difference between structural, authenticated, and behavioral
proof.

The same commit must pass this sequence on every test computer:

```sh
node orchestra.mjs doctor
node orchestra.mjs install --dry-run
node orchestra.mjs install --conflict backup
node orchestra.mjs doctor --installed
```

Then the selected CLI must run the same small Laravel task through PLAN, BUILD,
VERIFY, and PROVE. The result is accepted only when the trace names the actual agents
and models, records available token and cost data, includes independent test
and audit evidence, and saves a handoff.

Machine-specific fixes are not acceptance-test exceptions. They must become a
portable repository change and the sequence must be repeated from the start.
