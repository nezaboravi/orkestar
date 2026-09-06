# Visible native workers — acceptance candidate

This transport is an unreleased acceptance candidate. The current source launcher
prepares it when Codex or Claude is explicitly launched in Solo. Solo remains an
optional workspace adapter, not a requirement for terminal use. Do not use the
isolated proofs below as a claim that the full meetup workflow passes.

Unlike native child observation, each invocation launches a real independent
Codex or Claude process in Solo. The display name describes its assignment;
the dispatcher separately binds the installed role instructions, runtime model,
permissions, project and receipt. Dispatch correlation is not native parent/child
lineage. A successful worker response is evidence, not an acceptance verdict.

## One-time readable worker registration

For Codex or Claude workers in Solo, `lenka up` verifies a dedicated custom tool
before starting the conductor. If it is absent, the error prints the exact Node
command for this installation. Follow Solo's supported
[custom agent setup](https://soloterm.com/docs/agents/adding-custom-agents):

1. Open Settings → Agents → Add tool.
2. Name it **Orkestar Worker** and paste the exact quoted Command from the error.
3. Leave Default arguments empty. Choose Set manually and the Generic tool type.
4. Save and retry `lenka up solo codex` (or `lenka up solo claude`).

This additive tool is reused across projects; existing Codex, Claude and other
tools are not modified. If the installed Node path changes, update only this
owned tool's Command to the new value printed by the launcher. No database edits
or machine-specific bundled paths are required. Registration is currently guided,
not automatic, because the verified public Solo API has no tool-creation endpoint.

Each worker panel shows its assignment, requested model, readable progress and
final prose. Raw command output is not printed in the panel. Native JSONL is
captured in a private, receipt-bound project file for independent collection.
The raw diagnostic prefix is bounded to 1 MiB; exceeding it does not interrupt
paid work. The wrapper hashes and validates the entire stream while separately
retaining native session start, final response and terminal usage evidence.
Each event is bounded to 8 MiB and each retained evidence event to 64 KiB.
Raw truncation alone does not invalidate a complete compact result. Malformed
streams, oversized evidence, missing terminal events and nonzero exits remain
incomplete. Versioned metadata binds both files to the dispatched receipt;
older raw-only captures remain readable. Native diagnostics remain explicit warnings;
Claude Taskavel collection keeps full raw tool evidence when it fits the bound;
truncated tool evidence remains incomplete even if final prose is available.
An exited, successful legacy Codex worker with truncated raw-only capture may
recover its exact completed native session through a read-only `thread/read`.
Original capture files remain unchanged and recovery provenance is stored
separately. Invalid compact captures never use this legacy recovery route.
process completion never means acceptance. Recorded prose is untrusted agent
output and basic credential filtering is not a guarantee against arbitrary secrets.

## Narrow conductor interface

The project-local MCP server exposes `worker_ready`, `worker_contract`, `worker_dispatch`,
`worker_status`, `worker_result` and `worker_report`, plus seven bounded
coordination tools documented in [Native coordination](NATIVE-COORDINATION.md).
The conductor does not need shell or file
editing permission to use these tools. Project and harness come from the
reviewed server launch configuration, never from tool input. Model and role
come from the verified project runtime profile, never an arbitrary command.

Contracts are immutable, project-local records. Repeated dispatch with the same
run ID cannot silently launch another worker. A failed launch receipt is retained
for diagnosis; a stopped process alone never means the task succeeded.

The installer copies its dependency closure into the project and adds only its
owned MCP entry. It preserves other entries and refuses conflicts or modified
managed files. Native client trust remains required; it is not bypassed.

## Verified so far

- One real Codex read-only Solo worker read an isolated fixture and returned its
  exact marker through native JSONL. Result collection included 34,609 processed
  tokens. Billing cost and actual model identity absent from that stream remained
  unavailable; the receipt separately records the requested runtime model.
- A real Codex browser worker used the copied project-local gateway to verify
  desktop and mobile interactions in an isolated local fixture, save screenshots,
  and check console and network failures. This proves that path on the tested
  macOS installation, not Linux or Windows browser compatibility.
- The copied MCP dependency closure exposes five worker/report tools and seven
  coordination tools; protocol tests verify multiline content without permitting
  control characters in identities or names.
- Real project-owned Solo todo and scratchpad creation, updates, and readback
  have been exercised separately from the end-to-end conductor workflow.
- Unit tests cover role arguments, inherited MCP isolation, duplicate launch
  reservation, project/process checks, immutable contracts, bounded messages,
  unknown accounting and preservation of existing project settings.

## Still required before release

- A conductor must invoke the installed bridge through the actual native client.
- All required workflow envelopes, including browser QA and requested Taskavel
  coordination, need verified routes. Unsupported roles must fail before work
  begins, not silently receive broader tools or a hidden replacement worker.
- The tester route is currently stricter read-only; it cannot edit tests.
  Read-only Claude workers cannot run shell commands. Do not claim full role
  equivalence from this narrower transport.
- The readable wrapper requires actual Solo UI verification after registration;
  unit tests alone do not prove a successful cross-platform launch.
- Complete the independent security/performance review, repair/re-review,
  auditor and a timed end-to-end rehearsal before calling the meetup ready.

## Tracker completion

Reconcile each scoped task independently. Read back both its board column and
completion state after authorized updates. Preserve checklist/dependency guards.
An accepted individual task can finish while other tasks keep the run PARTIAL;
an unfinished application must never become DONE by mass-moving its cards.

`tracker-reconciliation.mjs` validates a normalized packet containing the exact
project/task identities, accepted evidence references, completion flags, Done
column IDs, and readback timestamps. Readbacks must follow the latest update
attempt and fall within the bounded freshness window. Missing, duplicate,
foreign, or stale records fail closed. A passing tracker check is not application
acceptance.

The OpenCode final-report tool now calls `report-tracker-gate.mjs` before
reading telemetry or persisting a report. `DONE` with Taskavel marked `synced`
requires a passing packet; runtime time prevents replaying stale readbacks by
backdating the packet. Project and global installers both include the helper
modules outside OpenCode's auto-loaded tool directory. Reports retain the
validated per-task packet and its evidence boundary.

`lenka report` labels this tracker evidence as a saved snapshot, not a live
tracker read. OpenCode telemetry refresh accepts only the exact rooted session
tree: duplicate IDs, missing parents, cycles, unrelated roots and oversized
results are rejected. Missing or invalid token/cost fields stay unavailable;
an invalid refresh preserves the saved report rather than attributing another
session's activity to this run.

This is not a Taskavel client: it cannot authenticate a reviewer or prove that
model-supplied snapshots came from Taskavel. The collecting adapter must obtain
actual authenticated readbacks. Native Codex/Claude `worker_report` now validates
receipts, independent review and auditor evidence, but automatic authenticated
tracker collection and reconciliation still require implementation and live
acceptance testing. Do not advertise them as completed by packet validation.

## Portability boundary

Installers copy repository-owned runtime dependencies into the selected project;
they must not depend on the developer's checkout, home path, or private settings.
Browser installation validates a pinned package and resolves its package manager
without executing arbitrary PATH shims. Tests cover supported macOS, Linux and
Windows path layouts; those fixtures are not substitutes for live OS acceptance.
Credentials remain outside the distributable package. Missing authentication or
unsupported capabilities must be reported explicitly, never silently inherited
from the author's machine.


## Readable worker windows (0.1.1)

Worker windows show a short assignment header, readable activity updates, and
the worker-reported result with checks and blockers. Paragraphs and lists are
preserved. Structured native results and diagnostic streams remain in private
evidence files; the displayed summary does not approve the work.

After updating the installed package, `lenka up` refreshes the project worker
files for subsequent launches. Already-finished Solo windows retain their
historical output; installing an update cannot rewrite those recorded panes.

## Local readiness (0.1.1)

Before dispatch, Lenka calls `worker_ready` with the planned profiles and any
required browser/Taskavel checks. It does not start an AI worker. Browser checks
initialize the installed managed gateway, open `about:blank`, capture a PNG, and
return its project-relative path, SHA-256 and byte count. Managed screenshots
are stored under `.agent-orchestra/browser/evidence`, so project-scoped readers
can access them. This is capture readiness, not application acceptance.

Readiness is an explicit tool and conductor instruction, not a mandatory
dispatch gate. It does not reserve provider capacity or future worker slots.
Native Solo workers cannot resume a prior session; requesting continuation
readiness returns BLOCKED. Existing running sessions need restarting after an
update to load the new bridge and instructions.

## Readable Codex conductor

The Codex MAIN process in Solo uses the documented app-server protocol through the same registered **Orkestar Worker** generic tool. It renders ordinary Lenka prose, concise state changes, interactive questions and approvals in the existing Solo panel; raw JSON, MCP arguments/results and reasoning are not shown by default. Recognizable credential patterns are redacted; this is not a guarantee against arbitrary secret content. `/details` is explicit opt-in and remains sanitized.

Enter starts or steers a turn. `/stop` sends a turn interrupt. Approval and question responses are accepted only while the corresponding request is pending. A completed turn or worker response is never an acceptance verdict.

Ctrl-C or `/stop` interrupts the active turn; a follow-up continues the same conversation. Steering is sent to the active turn, but the provider may finish an already-streaming response before acting on it. `/quit` exits. Secret-input requests are rejected before prompting because this plain terminal cannot safely hide typed credentials. Authenticate through the native CLI instead.
