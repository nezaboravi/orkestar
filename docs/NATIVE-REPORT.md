# Native worker report protocol

The Solo bridge exposes `worker_report` for Codex and Claude conductors. It
recollects real worker results; it does not accept caller-supplied agents,
models, tokens, costs, or review verdicts. Every worker must use the same
immutable task contract. Supply all assignment and repair run IDs.

Call `worker_result` after each worker stops and **before** dispatching its
dependent reviewer. This saves only an evidence hash and observation time,
not a transcript. A code reviewer must start after all builder results were
collected. Independent tester, browser QA and code review may then run in
parallel. The auditor joins all their collected results before accepting work.
Old receipts without dispatch timestamps cannot prove this sequence and yield
`PARTIAL`. A changed result needs a new assignment/run ID and a new review.

## Reviewer final response

The persisted immutable task contract is the required plan. Lenka may author it
directly for a small specified change; a separate `dev-planner` worker is not
mandatory. Any planner actually dispatched must still appear in the report and
auditor coverage. Builder, tester, independent reviewer and auditor remain
mandatory, with designer/browser QA required when their flags apply.

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
dispatch a new reviewer. The approved review must cover every builder run ID;
a later write invalidates it. The auditor must also cover tester and QA results.

When a contract explicitly requires the observed final tracker state, an initial
audit may remain PARTIAL while accepting named individual task outcomes. Close
only those accepted outcomes, obtain fresh readback, and request a bounded final
audit covering the outstanding tracker criterion and required review evidence.
Never claim the tracker criterion passed before observing it. This is not a new
implementation iteration and does not relax the final all-criteria proof gate.

After audit approval, a Taskavel worker may close only the already-listed tasks
using read/update/move/comment operations. These receipt-bound closure workers
remain in the report and must finish, but do not require another audit. Fresh
authenticated final tracker readback remains mandatory. Creation operations,
unknown scope and unlisted tasks do not receive this chronology exception.

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
optional `trackerReconciliation`. Its MCP schema documents the exact fields.
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

These gates verify role-linked native worker statements, not the truth of
their claims. Keep direct test and visual artifacts for inspection. Unknown
actual model and cost remain unavailable; finite nonnegative Claude native
`total_cost_usd` is retained when actually present. A total cost is supplied only
when every worker reports one; missing is never zero. The selected model is separately
labeled requested. Token totals cover collected workers only, not conductor
usage or account billing. Missing accounting is not functional test failure.
