# Native worker report protocol

The Solo bridge exposes `worker_report` for Codex and Claude conductors. It
recollects real worker results; it does not accept caller-supplied agents,
models, tokens, costs, or review verdicts. Every worker must use the same
immutable task contract. Supply all assignment and repair run IDs.

Call `worker_result` after each worker stops and **before** dispatching its
dependent reviewer. This saves only an evidence hash and observation time,
not a transcript. A code reviewer must start after all builder results were
collected. Independent tester, browser QA and code review may then run in
parallel. One reviewer may combine verification and acceptance using the proof array below; a separate auditor is optional.
Old receipts without dispatch timestamps cannot prove this sequence and yield
`PARTIAL`. A changed result needs a new turn/run ID and delta review in the same session.

## Reviewer final response

The persisted immutable task contract is the required plan. Lenka may author it
directly for a small specified change; a separate `dev-planner` worker is not
mandatory. Any planner actually dispatched must still appear in the report and
independent checker coverage. One independent reviewer is mandatory; Lenka may
implement directly. Separate builder, tester and auditor sessions are optional.
Designer/browser QA remain required when their flags apply and need sufficient
approved worker budget.

Give the reviewer the actual run IDs, task contract and evidence. Require its
entire final response to be JSON, without Markdown fences:

```json
{
  "verdict": "APPROVED",
  "reviewedRunIds": ["every-actual-builder-and-repair-run-id"],
  "security": {"status": "PASS", "evidence": ["Specific observed security check"]},
  "performance": {"status": "PASS", "evidence": ["Specific observed performance check"]}
}
```

Use `CHANGES_REQUIRED` when repair is needed. A category may be
`NOT_APPLICABLE` only with a change-specific explanation in its evidence.
After repair, collect the builder result, then repeat affected verification and
continue the same reviewer with the scoped delta. The approved review must cover every builder run ID;
a later write invalidates it. The acceptance checker must also cover any tester and QA results.

An auditor decides only the immutable `contract.required` IDs. It must never
invent a local-decision tracker criterion. A real contract requirement for final
tracker state remains unproven until a fresh runtime readback; do not waive it
or promote PARTIAL to DONE.

After audit approval, the runtime may close only already-listed tasks using its
native OAuth operation. Add `trackerAuthorization` to the immutable contract
before dispatch: an exact `projectName`, numeric `taskIds`,
`operations: ["read", "update-task", "move-task"]`, and
`externalWriteAuthorized: true`. The closeout request must repeat that exact
authorization and name each task's Done column. For a fresh workspace binding,
the runtime first verifies one exact project name through its native
authenticated project listing, then stores the name binding locally; it never
uses a model-supplied name or creates a project. Model-supplied reconciliation
packets are never authority. It has no task creation or arbitrary-tool capability.
Fresh authenticated final tracker readback remains mandatory. This operation
does not require another audit, but a failed operation or readback leaves the
overall report PARTIAL.

## Auditor final response

The separate read-only auditor receives all preceding worker evidence and the
approved review. Its complete final response must be JSON:

```json
{
  "verdict": "DONE",
  "reviewRunId": "actual-approved-review-run-id",
  "reviewedRunIds": ["all-actual-preceding-run-ids"],
  "proof": [
    {"criterionId": "R1", "result": "passed", "method": "Independent observed journey", "evidence": ["Exact observed result"]}
  ]
}
```

Every immutable contract requirement needs a passed proof entry. Missing
roles, unsuccessful workers, missing structured evidence or unproven ordering
produce `PARTIAL`, never a prose-based success inference.

## Finalization and limitations

`worker_report` takes `reportId`, `contract`, `workerRunIds`, `status`, `summary`,
`workflow`, `designRequired`, `visualProofRequired`, `taskavel`, `blockers`, and
optional `trackerReconciliation` and `trackerCloseout`. Use `trackerCloseout`
only after an accepted audit and only with the exact immutable
`trackerAuthorization` described above. Its MCP schema documents the exact fields.
Reusing a report ID creates a new report revision, so a `PARTIAL` report can
be followed by a repaired run. Existing unrelated reports are preserved.

`taskavel: "synced"` requires a fresh task-by-task reconciliation packet:
accepted proof, completion flag and Done column are separate checks. Native
finalization now discards caller-supplied snapshots and requires a runtime-owned
authenticated collector. Without that collector, `synced` produces `PARTIAL`.
The collector must provide real readbacks; packet validation alone does not
authenticate network reads or reviewer identity. `not-requested` is a declared
scope decision, not an automatically verified absence of a Taskavel request.

The Codex collector binds reads to the project's installed native route and
uses native OAuth, without a model turn. Supply the stored `name:<project name>`
project identity, numeric task IDs as strings, and `doneColumnId: "name:Done"`
for a column literally named Done.
The `name:` namespace is explicit because the current Taskavel text response
does not expose numeric column IDs. At most 32 required tasks are read per
report. Missing membership, unknown status, or an unavailable native collector
keeps the report PARTIAL. Claude does not silently fall back to Codex.

Before contract creation, `worker_ready` may take `requireTaskavel:true` and
an exact `taskavelProjectName` for an existing unbound project. It verifies one
exact native OAuth project listing without a model turn, external write, or
local binding write, then returns `verifiedProjectName` and `bindingPending`.
The immutable closeout authorization still creates the binding later.

These gates verify role-linked native worker statements, not the truth of
their claims. Keep direct test and visual artifacts for inspection. Unknown
actual model and cost remain unavailable; finite nonnegative Claude native
`total_cost_usd` is retained when actually present. A total cost is supplied only
when every worker reports one; missing is never zero. The selected model is separately
labeled requested. Token totals cover collected workers only, not conductor
usage or account billing. Missing accounting is not functional test failure.

## Proportional default and continuation

Use Lenka directly plus one independent reviewer, or one builder plus one
reviewer. The reviewer includes `proof` with exactly one passed entry per
REQUIRED criterion (`criterionId`, `result`, `method`, `evidence`). A separate
tester or auditor is optional; missing independent proof never becomes DONE.
Use `worker_dispatch` with `continueRunId` and a fresh turn `runId` to continue
a stopped Codex/Claude session. The contract, role, model, owner and permissions
must match. Every turn keeps its own immutable receipt and Solo process panel;
the underlying native session is reused. Taskavel continuation is unsupported.
Include every turn in reports; the two-worker ceiling counts unique session
roots, and continuation is still bounded and consumes provider usage.
