# Portability

The public acceptance target is one repository and the same user experience on
macOS, Linux, and Windows. Paths under `/Users`, `/home/<name>`, Laravel Herd,
Homebrew, and a developer's existing shell configuration are not dependencies.

## Platform entrypoints

| Platform | Entrypoint | Supported architectures | Herdr | Harness |
|---|---|---|---|---|
| macOS | `./bootstrap.sh` | Apple silicon, Intel | optional | Codex / Claude / Kimi / OpenCode auto-selection |
| Linux | `./bootstrap.sh` | aarch64, x86_64 | optional | Codex / Claude / Kimi / OpenCode auto-selection |
| Windows | `.\bootstrap.ps1` | x86_64; ARM64 through x86_64 emulation | optional ConPTY workspace | OpenCode (current bootstrap) |

Both entrypoints install runtime files below the selected user's home, prepend
those paths only for the bootstrap process, install the same agent definitions,
and open Lenka directly in the selected CLI. The Unix bootstrap selects Codex,
Claude Code, Kimi Code, or OpenCode only after a live response. `--herdr` adds
a project-specific persistent session without changing the harness. Unix does not edit
`.zshrc`, `.bashrc`, or profile files. Windows bootstrap also keeps its runtime
inside the orchestra directory instead of depending on Chocolatey or Scoop.

## Verification levels

1. **Static** — shell syntax, JavaScript tests, workflow/schema checks.
2. **Clean runtime** — no Node.js or selected harness is inherited from the
   normal user path; the bootstrap downloads and verifies its own required tools.
3. **Authenticated readiness** — the selected account returns a verified model
   response for every resolved role and every generated file matches the source.
4. **Behavior proof** — the selected harness executes the same Laravel intent
   through PLAN, BUILD, VERIFY, and PROVE, with usage and handoff evidence.

Passing a lower level never implies a higher one. Provider login is a real
human credential boundary; it is not bypassed, copied, or replaced with an
unannounced free model.

## Automated matrix

`.github/workflows/portable-bootstrap.yml` runs the project-only bootstrap on
GitHub-hosted macOS, Ubuntu, and Windows machines. It uses structural mode
because CI does not receive private provider credentials. The public matrix is
available in [GitHub Actions](https://github.com/nezaboravi/orkestar/actions/workflows/portable-bootstrap.yml).
Authenticated physical-machine proofs remain a separate, higher-level
requirement.

## Current local evidence

On 2026-09-01 the macOS Apple-silicon path passed both:

- a clean-runtime project-only bootstrap with checksum-verified Node.js 24.20.0
  and OpenCode 1.18.25, with Herdr 0.8.2 also tested as an optional workspace; and
- an authenticated project-only bootstrap with 48 inventoried models, all five
  role routes resolved, and 22/22 managed project files matching.

On 2026-09-02 the GitHub-hosted structural bootstrap passed on macOS, Ubuntu
Linux, and native Windows. The first two Windows attempts exposed and fixed two
real portability defects: line-ending-sensitive tests and a Git symlink that
materializes as a plain file on Windows. The final matrix exercised the actual
PowerShell bootstrap successfully, not only static tests.

On 2026-09-02 the native Kimi Code adapter passed an authenticated macOS proof
with Kimi Code CLI 0.39.1 and the configured `kimi-code/k3` model. Its live
probe returned the exact marker, the project-only install generated the Kimi
agent files and routing manifest, and doctor matched 23/23 managed files. This
is an adapter proof, not yet the full Laravel behavior proof.

This proves clean structural installation on the hosted runners. It does not
claim authenticated model routing or real project behavior on Vladimir's
physical Linux and Windows computers; those proofs still need their local
credentials and projects.
