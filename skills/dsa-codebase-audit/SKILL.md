---
name: dsa-codebase-audit
description: Run an application-wide, read-only audit for materially useful simplifications in data structures, state representation, control flow, algorithms, lifecycle, and ownership. Use when the user asks for a DSA codebase audit, state-model or organizing-model audit, structural simplification review, complete subsystem audit, or explicitly invokes the dsa-codebase-audit skill. Do not use for security audits, ordinary bug hunts, style reviews, performance-only profiling, or implementation work.
---

# DSA Codebase Audit

Audit the complete target repository without changing it. Favor concrete simplifications that eliminate invalid state, duplicated decision logic, unnecessary repeated work, or unclear ownership. Do not manufacture findings.

## Preserve the repository

- Treat the target repository as read-only.
- Do not edit files, run tests, build, format, generate code, install dependencies, commit, push, or invoke commands that can write caches or runtime state.
- Use only read-only inspection commands.
- Keep working notes in the task context. If a persistent report is requested, write it only outside the target repository to a user-approved or app-designated output location.
- Record the current commit, branch, and exact `git status --short` output before reviewing. A dirty worktree is allowed; never clean or alter it.
- Repeat the repository-state checks at the end. Disclose any difference and do not attribute an externally produced change to the audit.
- Inspect existing tests, but do not execute them. Describe additional validation that a later implementation would require.

If the repository cannot be identified safely from the current context, ask the user for its path before starting.

## 1. Establish the coverage contract

Inspect the repository topology, manifests, entry points, and package boundaries. Inventory every identifiable subsystem before opening detailed review lanes.

Give each subsystem:

- a stable ID and descriptive name;
- an exact, non-overlapping ownership boundary;
- key implementation files;
- relevant public interfaces, major call sites, and tests;
- a status: `queued`, `in review`, `recommend`, or `skip`.

Include frontend, backend, shared infrastructure, platform bridges, generated-contract ownership, persistence boundaries, background processing, and test/tooling infrastructure where materially relevant. Do not use broad catch-all rows as proof of coverage.

Maintain one canonical audit record in the task context containing:

- the subsystem inventory;
- confirmed opportunities;
- explicit skip decisions;
- cross-cutting patterns;
- duplicates and superseded findings;
- final priorities and dependencies;
- a concise audit log.

Treat the inventory as the coverage contract. Continue until every row reaches `recommend` or `skip`.

## 2. Run bounded subsystem reviews

When subagents are available, act as coordinator and delegate distinct, non-overlapping subsystem boundaries in bounded waves. Never exceed the number of lanes that can be actively coordinated. Use a consolidated wait, let productive reviewers finish, and harvest their results before reusing a lane.

Give each reviewer this brief:

1. Stay inside the assigned ownership boundary. Inspect its implementation, public interfaces, major call sites, and existing tests.
2. Return at most two materially useful opportunities. Return `skip` when none clearly meets the threshold.
3. Mention cross-subsystem concerns without expanding the assigned scope.
4. Do not modify the repository or execute tests and write-producing commands.

Look for:

- scattered booleans or nullable fields that permit invalid combinations and should become a state machine, enum, or discriminated union;
- repeated assumptions about object shape that require one shared typed model or contract;
- duplicated decision structures that a small map, registry, reducer, or command model would materially simplify;
- unclear state or behavior ownership that a small module boundary would clarify;
- repeated scans, transformations, or lookups where a more appropriate collection or index would simplify behavior or complexity;
- lifecycle, concurrency, or asynchronous states whose representation permits stale or contradictory state;
- control flow whose complexity comes from the representation rather than the underlying domain.

Require a material benefit. A recommendation must credibly achieve at least one of these:

- make an important invalid state unrepresentable;
- remove meaningful duplicated branching or competing sources of truth;
- reduce repeated algorithmic work on a relevant path;
- establish one clear owner for a lifecycle or business invariant;
- materially simplify a public interface or its callers.

Do not recommend changes solely for:

- stylistic consistency or renaming;
- speculative extensibility;
- minor line-count reduction;
- generic deduplication with no behavioral benefit;
- hiding existing branching behind a new type;
- introducing a pattern, layer, service, DTO, or abstraction because it is fashionable;
- security, generic performance, dead-code, or UI/UX concerns outside this audit's structural scope.

Prefer clear local code when it is already the simplest honest representation.

For every proposed opportunity, require:

1. Verdict: `recommend` or `skip`.
2. Evidence with exact file and line references.
3. Current complexity, duplicated decisions, or representable invalid states.
4. Proposed representation and why it is simpler.
5. Smallest credible implementation scope, including affected files and interfaces.
6. Regression risks and migration concerns.
7. Existing validation and additional validation required.
8. Confidence: `high`, `medium`, or `low`.

## 3. Validate and synthesize

Independently verify every candidate against the current repository before accepting it. Read the cited source, relevant interfaces, callers, and tests.

Reject, narrow, merge, or demote recommendations that:

- are vague or lack line-level evidence;
- duplicate another finding;
- misunderstand intentional semantics;
- cross the stated ownership boundary without proof;
- merely relocate complexity;
- increase abstraction without eliminating a concrete problem;
- describe a bug, security issue, or performance concern that belongs to another audit.

Record reviewer skips as completed coverage. Deduplicate overlapping findings and assign every accepted recommendation to one authoritative subsystem.

## 4. Audit the audit

Before finishing, perform fresh coordinator passes for:

- repository coverage and missing subsystem boundaries;
- duplicate findings and ownership overlap;
- materiality and over-abstraction;
- completeness of every required finding field;
- dependency-aware priority ranking.

If the coverage pass finds a real omission, add an explicit subsystem row and review it. Do not hide the omission by broadening a completed boundary.

Rank accepted recommendations by concrete impact, confidence, implementation effort, blast radius, prerequisites, and the value of the smallest first slice.

## 5. Deliver the report

Write the final report in English. Lead with the most important accepted findings, then provide:

1. Repository snapshot: path, commit, branch, initial worktree state, and audit boundaries.
2. Ranked accepted recommendations with the complete eight-field schema.
3. Coverage matrix showing every subsystem and its `recommend` or `skip` outcome.
4. Cross-cutting observations, duplicates removed, dependencies, and suggested implementation order.
5. Validation limitations: tests inspected but not run, plus the validation each later change requires.
6. Final repository-state comparison and an explicit statement of whether the repository remained unchanged.

If no opportunity survives independent validation, say so plainly. A complete audit with all subsystems marked `skip` is a valid successful result.

The audit is complete only when every identifiable subsystem has been reviewed, every row has a recommendation or explicit skip, every accepted finding has complete evidence and risk fields, duplicates and weak abstractions have been removed, priorities and dependencies are consistent, and repository state has been checked again.
