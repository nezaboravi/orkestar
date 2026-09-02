# Laravel Intent Proof

This is the first end-to-end acceptance task for agent-orchestra. It is small
enough to repeat on multiple computers and substantial enough to exercise
planning, implementation, testing, and independent audit.

## Starting point

- A fresh, disposable Laravel application in its own Git repository.
- SQLite configured for local tests.
- agent-orchestra installed into the project with the OpenCode adapter.
- OpenCode running inside a Herdr-managed terminal.
- No Taskavel, deployment, email, payment, or other external service.

## Human intent

> Build an Ideas API. An idea has a required title, optional description, and
> status (`draft`, `planned`, or `done`). I need to create ideas, list them
> newest first, view one idea, and change its status. Invalid input must return
> Laravel validation errors. Prove the behavior with tests and do not publish
> or deploy anything.

## Required team flow

1. `dev-lead` receives the intent and coordinates the run.
2. `dev-planner` inspects the fresh application and returns an executable plan.
3. `dev-builder` implements the approved plan without external or destructive
   operations.
4. `dev-tester` adds or extends tests and runs the relevant suite.
5. `dev-auditor` independently reads the diff, reruns verification, and returns
   `DONE` or `NOT DONE` with evidence.

The builder may fix objective test failures for at most three verification
cycles. The builder may not approve its own work.

## Behavior acceptance criteria

- The database schema represents title, description, and the three statuses.
- The API can create, list, show, and update the status of an idea.
- List order is deterministic and newest first.
- Title and status validation are covered by failing-input tests.
- Missing ideas use Laravel's normal not-found behavior.
- The focused test suite passes.
- Laravel Pint reports no formatting changes required.
- The final Git diff contains no debug code, credentials, generated secrets, or
  unrelated changes.

## Orchestra acceptance criteria

- The trace identifies every role that actually ran.
- The trace records the resolved model for every role.
- Available session statistics record tokens and actual cost; unavailable
  fields are reported as unknown, never estimated.
- No permission dialog is required for safe in-project work.
- Every explicitly denied destructive or external action remains denied in auto
  mode.
- The auditor's evidence is independent of the builder's report.
- A project-local handoff records the result and exact next step.

## Cross-machine record

For each computer, record:

- operating system and architecture;
- Node.js, Herdr, OpenCode, PHP, Composer, and Laravel versions;
- selected models and provider readiness;
- install and doctor result;
- team result and verification commands;
- token and cost fields exposed by the harness;
- any machine-specific failure.

A machine-specific fix is incomplete until it is implemented in this public
repository and the proof is repeated from a clean starting point.
