# Orkestar · Lenka

Run Lenka in your project and let her coordinate a small team of coding agents.
You use your own AI account; Orkestar provides the launcher, role permissions,
worker coordination, and evidence collection.

**Early release · 0.1.1.** Useful, but not a hands-off delivery guarantee.
The meetup demo did not finish successfully. This release improves worker
readability and checks local prerequisites; a reliable 15-minute demo has
**not** been demonstrated.

## Install

You need Git and an authenticated supported AI CLI. Orkestar uses Node.js 20+
(the bootstrap can install an isolated runtime). Setup may make model requests
using your account and back up conflicting configuration files.

macOS / Linux:

```sh
git clone https://github.com/nezaboravi/orkestar.git
cd orkestar
./bootstrap.sh
```

Windows PowerShell: run `.\bootstrap.ps1` from the cloned folder.
Windows and Linux support have platform-specific verification limits; see
[portability](docs/PORTABILITY.md).

Then, from the project you want to work on:

```sh
lenka up
```

The setup asks which AI service and workspace to use. Run `lenka setup` to
change those choices. If `lenka` is not on your PATH, use
`~/.local/bin/lenka` on macOS/Linux.

## Use with Solo

Install Solo separately and sign in to Codex or Claude Code, then run:

```sh
lenka up solo codex
# Or: lenka up solo claude
```

The launcher may ask you to register an **Orkestar Worker** custom tool in
Solo once. It prints the exact command; see [worker setup](docs/VISIBLE-WORKERS.md).
Solo and the selected CLI must be allowed to read your project folder.

Give Lenka a clear outcome, acceptance criteria, and a time limit. For a small
feature, the intended flow is one builder, parallel focused verification and
independent review, then an auditor. Taskavel is optional; without it, local
coordination is explicitly marked unsynced.

### What changed in 0.1.1

- Worker panels show readable assignment, progress, and result summaries.
- Managed browser screenshots stay inside the project for evidence sharing.
- A new `worker_ready` check can verify local setup and a real screenshot
  capture before work starts. Lenka is instructed to use it; dispatch does not
  enforce it automatically.

### Current limits

- Provider capacity can fail after setup. Readiness does not reserve quota.
- Native Solo workers cannot resume an interrupted session. A replacement is
  a new worker, with additional time and usage.
- Browser readiness proves capture works, not that an application is correct.
  Tests, visual evidence, independent review, and audit are still required.
- Some read-only roles cannot run every test command. Missing proof must remain
  **PARTIAL**, even when the code looks finished.
- No fixed completion time or universal cross-platform compatibility is promised.

## Other ways to run

`lenka up codex --direct` runs in your terminal. Herdr and other CLI adapters
are also included; consult [portability](docs/PORTABILITY.md) for their limits.
**Cursor support means the Cursor Agent CLI, not the Cursor desktop Agent panel.**

## Update

Pull this repository and rerun the bootstrap. Editing the clone alone does
not update the installed `lenka` package. Existing running sessions must be
restarted to load new code and instructions.

[Worker details](docs/VISIBLE-WORKERS.md) ·
[Architecture](docs/ARCHITECTURE.md) ·
[Recovered meetup source](docs/INSTALLED-SNAPSHOT.md)

MIT license.
