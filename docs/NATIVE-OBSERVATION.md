# Native Codex and Claude Code observation

`lenka up solo codex` and `lenka up solo claude` install additive project-local
observation hooks before opening Solo. Once the native client loads and trusts
them, real subagent activity is mirrored into a per-run scratchpad and activity
todos. Native children are not separate Solo worker processes.

Every `lenka up`, including `--no-launch`, refreshes project-local role files
from the already verified model routes. It preserves existing `AGENTS.md`,
backs up conflicting generated files, and does not repeat model probes or
change global agent settings. An unchanged team produces no replacement writes.

Codex requires review of the exact hook commands through its native `/hooks`
screen. The installer does not bypass that trust requirement. Existing running
sessions are preserved; start a new native session after a hook update.
Claude loads project hooks through its own project trust flow.

## Evidence adapters

- `native-codex-evidence.mjs` reads explicitly supplied native transcript
  records. It preserves the child's first identity when the transcript embeds
  parent history and uses cumulative usage only once. Cached input and reasoning
  output are subsets, not additional tokens. It has been checked against the
  selected local Codex root and eight actual child transcripts.
- `native-claude-evidence.mjs` accepts explicitly supplied Claude transcript
  records and native child metadata. It deduplicates assistant message IDs.
  Claude cache-read and cache-creation counters are disjoint from uncached
  input: they contribute to normalized input. This adapter currently has
  synthetic schema tests and a real interactive Solo child run.
- `native-audit.mjs` validates exact project and parent/child membership before
  aggregating. It never turns a completed response into acceptance approval.
  Unavailable tokens and costs stay unavailable, not zero. It produces a
  metadata-only scratchpad representation.
- `lenka report last` can display unknown native usage and cost without crashing.
  Automatic collection writes `native-latest.json`, separate from the
  independent acceptance report `latest.json`. The command displays the newer
  snapshot and identifies native activity as distinct from acceptance.

`native-observer.mjs` collects the documented lifecycle hook events using only
the explicitly supplied transcript paths. `native-observer-install.mjs` copies
the observer and dependencies into the project, so hooks do not depend on the
original checkout path. `native-solo-mirror.mjs` validates the Solo project and
CLI binding, serializes writes, and reuses tagged records instead of duplicating
them on every event. No global history scan or API key is needed.

No parser exports prompts, tool output, private reasoning, or raw transcripts.
No adapter searches the user's home directory, reads credentials, or estimates
subscription charges from API prices. Transcript formats can change; missing
identity or unsupported usage must remain unverified.

## Boundaries

Both clients document `SessionStart`, `SubagentStart`, `SubagentStop`, and `Stop`
hooks. `SubagentStop` supplies the child's transcript path and identity. Use
these events to bind a run without global-history scans or replacing the
interactive terminal with print mode.

1. Additive project-local hooks do not replace existing hooks or
   permission settings. Validate installed-version capability and preserve
   the client's own trust/consent flow. Never bypass hook trust globally.
2. Each observed native root has its own tagged records in the exact Solo
   project. A reused process does not reuse an unrelated run's records.
3. Collect bounded, serialized metadata snapshots from explicit transcript
   paths. Handle concurrent children, incomplete writes, resume, interruption,
   schema changes and application restarts without double counting.
4. Real work is mirrored into Solo todos and one run scratchpad with durable identity,
   revision checks and read-back verification. Taskavel remains authoritative;
   never invent Taskavel links or silently complete its tasks.
5. Show native children as native session evidence. Do not spawn empty Solo
   workers to imitate a real team or claim separate processes from display names.
6. Keep the acceptance gate separate: design review where required, behavior
   tests, frontend journeys, independent security/performance review including
   repair/re-review, and auditor evidence are required for DONE.
7. Native task-list tools are client/version dependent. The installed Codex and
   Claude smoke sessions did not expose a usable native plan list. Lenka must
   use Solo MCP for the outcome plan and acceptance checklist in that case.
   Native agent activity todos are not a substitute for the outcome plan.

## Observed compatibility

On macOS, interactive Codex `0.153.0-alpha.5` and Claude Code `2.1.258` both
delegated a real read-only child in an isolated fixture. Each child read the
fixture marker; automatic hooks produced distinct Solo scratchpads and agent
activity todos. The Solo window displayed both lists. This proves the native
observation transport, not an entire Laravel delivery or Taskavel workflow.

Per-agent token counters come from native transcripts. Monetary cost remains
`unavailable`: subscription usage is not an API invoice. Totals cover observed
sessions and include cached input; hooks enabled midway through a run cannot
retroactively prove all earlier children. Unsupported schemas remain unknown.
Final response repetition in the native terminal is outside this observer's
rendering: it does not rewrite or delete terminal output.

The current selected Codex transcript contains one canonical final response,
despite the repeated section observed in Solo. The rendering cause is not yet
established. Do not solve that by deleting arbitrary repeated text.

## Primary references

- [Codex hooks and trust](https://learn.chatgpt.com/docs/hooks)
- [Claude Code hooks and native subagent transcripts](https://code.claude.com/docs/en/hooks#subagentstop)
- [Claude input/cache accounting](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance)

Documentation establishes the supported contract, not the state of a user's
installation. Local observation must still prove the installed client behavior.
