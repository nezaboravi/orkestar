# Meetup Board — a 15-minute rehearsal

**Historical full-application brief, not the current live-demo recommendation.**
The user now wants a small change to the existing application. Use
[Community stats](meetup-community-stats.md) for the next timed rehearsal;
do not rebuild this application during the meetup slot.

## Purpose and boundary

Demonstrate intent, visible delegation, Taskavel progress, observed behavior,
independent security/performance review and an honest final verdict. This is a
time-boxed rehearsal, not a promise that model latency will fit a live slot.
Only call it a 15-minute demo after a complete timed run passes.

Before the timer: install the Laravel starter with authentication, install
Orkestar, authenticate the selected client and Taskavel, trust inspected hooks,
confirm Solo and browser tools work, and install project dependencies. Show
these prerequisites explicitly; do not count a hidden implementation as setup.

## Paste into Lenka

Build Meetup Board in this Laravel starter: one attractive public page where
visitors discover proposed Laravel meetup talks, and signed-in users can add a
proposal and vote once for each proposal. Reuse existing authentication.

The page is also the landing page: a short editorial hero, a clear call to
action, and ranked proposal cards with title, short description and vote count.
Provide a small accessible proposal form. Use an intentional modern visual
direction with excellent typography and spacing, desktop and mobile. No image
downloads or generated imagery are needed.

Keep the scope fixed: title up to 120 characters, description up to 300,
proposal creation, ranked listing and one vote per authenticated user per
proposal. Persist votes with a database uniqueness constraint. Guests may read
but may not create proposals or vote. No edit/delete flows, search, categories,
notifications, email, extra marketing pages, new auth system or deployment.

Seed eight realistic Laravel talk proposals and two local demo accounts.
Make the seeder safe to rerun without duplicates or overwriting user edits.
Keep demo accounts local-only. Report their credentials only in the local
handoff/final response, not Taskavel comments or public source.

Proceed immediately. Use these short, focused assignments:

1. Designer: one concise visual/interaction specification, not several options.
2. Planner: a compact implementation contract and acceptance checklist using the
   design. Lenka coordinates; do not create another coordination layer.
3. Backend and frontend builders in parallel after they agree route and data
   contracts; assign disjoint files. The backend builder also owns seed data.
4. Tester and browser QA: focused automated behavior tests and one desktop and
   mobile journey against the integrated app.
5. Independent reviewer: security and performance, including guest writes,
   duplicate votes, validation, escaped content and avoidable repeated queries.
6. Repair verified findings, obtain re-review, then ask the independent auditor
   for the evidence-based final verdict. Never skip a gate to meet the timer.

Use real separately visible Solo workers with meaningful assignment names when
the verified adapter supports them. If it does not, report that blocker rather
than substituting native hidden children or fake process panels.

Create a Taskavel project with at most six outcome tasks. Move them through the
actual columns at phase transitions, verify each update, and mirror their full
links into Solo. Keep brief outcome notes, not per-tool progress spam. Native
telemetry belongs in the activity report, not as repeated agent-name todos.

Use the runtime's verified model choices and narrow permission envelopes.
Pass only the relevant contract and result to each worker, not the entire
conversation. Parallelize independent work, preserve other agents' changes,
and avoid repeated repository inventories. One meaningful status update per
phase is enough. Do not repeat successful probes or unrelated test suites.

Prove: guest read works; guest writes are denied; authenticated creation works;
invalid input is rejected; repeated voting never increments twice; rankings are
correct; seed rerun is safe; desktop/mobile forms really work. Capture browser
evidence and check console/network failures. Formatting is not behavior proof.

Record the start time. At 10 minutes, prioritize the fixed acceptance checklist
and stop adding polish. At 15 minutes, report DONE only if all required checks
passed; otherwise report PARTIAL with the exact unfinished work and await the
user's decision on extending the demonstration. Do not kill workers or discard
their work to satisfy the timer.

Work locally except for the requested Taskavel coordination. No resets,
destructive operations, commits, pushes, deployment or publication. End with
the app URL, Taskavel links, actual worker/model/usage evidence, verification,
review and auditor outcomes, elapsed time and a saved handoff. Unknown cost is
unavailable, never zero. Do not call this a successful 15-minute demo if it took
longer or any required evidence is missing.

## Rehearsal acceptance

- Record the exact start/end timestamps and chosen models.
- Confirm each worker has a real independently selectable Solo process panel.
- Confirm Taskavel transitions, not just attempted tool calls.
- Confirm real browser input, not screenshots of an untested static page.
- If two rehearsals cannot finish within the slot, present a prepared app and
  implement one smaller change live. Disclose what was prepared; do not hide
  elapsed time or remove the independent review gate.
