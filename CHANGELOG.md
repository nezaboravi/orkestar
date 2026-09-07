# Release notes

## Unreleased — dispatch prerequisites

- Single and wave dispatches can declare required input files, dependency
  directories and capabilities. Invalid declared prerequisites stop the whole
  wave before worker-session reservation or launch.
- Ownership and prerequisite errors identify the failing declaration without
  exposing raw filesystem errors. Unsupported declared network, local-server
  and Git metadata write requirements stop before paid dispatch.
- Conductor guidance calls for verified checkout/dependency preparation before
  retrying a blocked assignment and keeps deterministic formatting with the
  original builder or an already-authorized conductor path.
- Review guidance requires the actual scope authority behind blocking
  expectations and distinguishes existing risks, new regressions and missing
  required evidence. Security/performance and acceptance gates are unchanged.
- These optional host-side checks cannot prove sandbox access or discover
  undeclared dependencies. No new percentage saving is claimed. Installation
  into active project sessions is deferred until those sessions can safely end.

## 0.1.5 — 2026-09-07

### Lower coordination overhead

- **79% lower estimated model usage in a controlled Solo test.** The same
  read-only check ran once with one verifier and an intentional 75-second
  delay before and after the update. Published token-rate weighting fell
  from 24.551 to 5.18312 credits (78.89%). This is a comparison estimate,
  not a measured reduction in billed credits or weekly allowance, and does
  not imply that every task is 79% faster or cheaper.
- Worker-wait calls fell from **five to two** in that paired test. The old
  run encountered one wait-call error; the updated run encountered none.
  Both checks passed with exit status zero.
- Codex coordination now prefers **Terra at medium reasoning** when access
  is verified. Astra remains a verified fallback; worker, reviewer and
  auditor model routes remain separate.
- Small, fully specified changes avoid unnecessary planning and test-writing
  workers. Required testing, security/performance review and independent
  acceptance gates remain in place.

### More reliable waiting

- Bounded worker waits now use a shared 60-second deadline with backoff,
  plus a 90-second MCP transport timeout.
- Cancellation reaches the matching wait, releases its request slot and
  cleans up on transport shutdown without terminating the actual worker.
- An exhausted or sub-millisecond remaining deadline returns a partial
  timeout instead of a request failure.
- Coordination guidance avoids redundant status checks and resumes an
  existing yielded wait rather than starting another one.

### Verification and adoption

- **541 automated tests passed**, plus 85 focused checks by an independent
  tester. Independent security/performance review and final audit approved
  the release. The final auditor also observed the completed Solo check.
- The comparison covers one controlled read-only task, not a benchmark of
  complex development quality. The generic fixture report remains PARTIAL
  because that fixture excludes extra audit workers; the release itself
  received a separate independent audit.
- Relaunch existing Orkestar sessions to load the new runtime and routing
  defaults. Explicit model selections can still override the default.

Token-rate source: [OpenAI pricing](https://learn.chatgpt.com/docs/pricing).
