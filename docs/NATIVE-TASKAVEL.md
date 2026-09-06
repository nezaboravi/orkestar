# Native Taskavel worker boundary — work in progress

The visible-worker bridge accepts the `taskavel` profile only when the runtime
binds it to the installed `task-manager` envelope. The assignment declares one
project, exact existing task IDs, allowed operations, and whether the user has
authorized external writes. Project creation is a separate assignment.

Only the official endpoint `https://taskavel.com/mcp/taskavel` is configured.
Credentials remain in the native client's OAuth storage; Orkestar does not read,
copy, export, or create another credential store. The helper has no Solo dependency;
the visible dispatcher is its Solo-specific caller.

Claude uses an endpoint-only strict MCP configuration, disabled built-in tools,
no nested agents, and selected Taskavel tools. A bounded no-model preflight must
confirm the exact endpoint, connected status, and required capabilities before
any visible worker is started. No shell or local file edits are granted.
Project/task IDs are charter restrictions, not server-enforced authorization.
Do not describe this as a hard per-project remote access boundary.

Native Taskavel tool-use IDs are correlated with tool-result IDs. The collector
keeps only task links, textual project/status/column fields and operation status.
Assistant summaries, foreign sessions, nested calls and failed results cannot
become tracker readbacks. Historical output collection time is not the time of
the remote read. Text labels are not numeric project or column IDs.

Codex uses a bounded native app-server preflight. Configuration discovery does
not start a model turn. Inherited MCP servers are disabled by their verified
configuration names before an ephemeral read-only thread is created. The probe
requires native OAuth and the exact selected tool set. An installed Codex binary
or ChatGPT subscription alone does not establish a Taskavel OAuth session.
After explicit OAuth consent on September 4, the local adapter successfully
read an existing task without a model turn or Taskavel mutation.

The final report rejects model-supplied synchronization snapshots. Its Codex
collector performs a fresh project-scoped membership query before each exact
task-details read. Missing tasks, truncated membership results, unknown statuses,
failed authentication, or ambiguous fields fail closed. Column identities use
the explicit `name:` namespace (for example `name:Done`), not invented database
IDs. Completion requires the separately observed `Completed` status.

Codex dispatch binds the canonical workspace to an explicitly named new project.
Native project-list readback must prove absence before creation and a unique
exact name afterward; partial or ambiguous name matches fail closed. The first
creation contract is provenance, not a restriction against future work contracts.
This prevents an accidental different project in the dispatch charter; it is
not a proxy enforcing every argument a native model subsequently emits.

Claude correlated output remains supported, but name-bound dispatch and fresh
final report collection are not yet implemented for its native adapter. Those
Taskavel paths fail closed. No implicit Codex fallback or credential copying occurs.
This is not complete cross-harness acceptance or a measured meetup rehearsal.
