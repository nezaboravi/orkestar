# Installed Solo package recovery — 2026-09-06

The canonical installation source is https://github.com/nezaboravi/orkestar.
Install with the platform bootstrap instructions in the README, then run
`lenka up` from the target project (`lenka up solo` explicitly selects Solo).

This recovery preserves the files from the installed `agent-orchestra` package
that provided the local `lenka` command. Its package label is `0.1.0`; that label
was reused and does not identify a unique Git revision. The installed package
contains no Git commit metadata. The original source checkout that produced
this exact installation could not be established from that metadata.

Before recovery, GitHub main was `7e108bec06a5042bd6f3b4002975f00f9defd630`.
The installed package had 26 changed tracked files and 61 additional files.
The bootstrap intentionally installs a standalone npm package instead of linking
the source checkout. The cached `agent-orchestra-0.1.0.tgz` was also older than
the installed tree: 22 archive members differed, so it is not a reproducible
source for this exact installed snapshot.

`installed-snapshot-sha256.json` records every recovered package file. Runtime
files are copied unchanged. One test fixture,
`tests/native-taskavel-readback.test.mjs`, uses synthetic tracker metadata in
place of the installed fixture values. The manifest records its original and
sanitized publication hashes separately. Repository-only `.gitignore` is retained; this note
and the checksum manifest are additional provenance documentation. No user
credentials, runtime session directories, application data or global settings
are included in the recovery.

Verification: the recovered package passed 469 tests with no failures or skips
using `node --test tests/*.test.mjs` on the recovery machine. This proves those
checks, not a successful installation on every supported operating system.
The meetup Most voted run remained partial because independent visual evidence
was unavailable; recovering its orchestration source does not change that result.
