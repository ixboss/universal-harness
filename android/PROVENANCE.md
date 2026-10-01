# android/ Provenance

This directory contains upstream-derived source and new Universal Harness code. This file
records exactly where the upstream-derived source came from, why, and how to refresh it.

## Upstream source

| Field | Value |
|---|---|
| Upstream repository | https://github.com/techjarves/Mobile-Harness |
| Upstream license | MIT (see [LICENSE](LICENSE) — verbatim upstream file) |
| Pinned upstream commit | `f0ba6730b1522ce3225cf84089305d6d1e7df905` |
| Upstream tree hash | `0ae06e7b0238ab99039e832fd8cb4d64c67f7ad7` |
| Snapshot imported | 2026-10-01 |
| Import method | **Clean snapshot** — `git archive` of the pinned commit; **no `.git`, no history, no tags, no branches imported** |
| Files | 125 files, byte-identical to the upstream tree at the pinned commit (verified by file-list diff against `git ls-tree -r`) |

## Vendored native dependencies (pinned commits, previously upstream git submodules)

| Component | Pinned commit | Upstream | License | Source |
|---|---|---|---|---|
| PRoot (termux fork) | `61681c6481197e3c0cec6726075053adb740f235` (v5.1.107.91) | https://github.com/termux/proot.git | GPL-2.0-or-later | [third_party/proot/COPYING](third_party/proot/COPYING) |
| libandroid-shmem | `7f0bd7e25dbdd146265aff7c6a890029e374622d` (v0.7) | https://github.com/termux/libandroid-shmem.git | BSD-3-Clause | [third_party/libandroid-shmem/LICENSE](third_party/libandroid-shmem/LICENSE) |
| talloc | 2.4.3 (in-tree upstream vendored) | Samba lineage | LGPL-3.0-or-later | [third_party/talloc/LICENSE](third_party/talloc/LICENSE) |

Upstream Mobile-Harness carried proot and libandroid-shmem as git submodules; a clean snapshot
contains no submodule contents, so they are vendored here at the exact pinned commits, with their
license texts verbatim. Attribution copies shipped by upstream are preserved at
[app/src/main/assets/licenses/](app/src/main/assets/licenses/).

## Why Git history was intentionally NOT imported

Upstream Mobile-Harness's git history contains a hardcoded API credential — `sk-d0c486…`
(redacted; format `sk-` + 32 hex, live-provider key shape) — committed in `2cf2fe98` (2026-08-20)
and removed from the tree in `badbe9ee` (2026-08-21), but still reachable from upstream `main`
history and delivered to every fresh clone of the upstream repository. Importing full or
sanitized history would either republish that credential in this public repository or add
permanently divergent rewritten-SHA complexity for no security gain. Security takes precedence
over history preservation. The current upstream **tree** at the pinned commit was verified
credential-free at import time (pattern sweep for the redacted identifier and generic key
formats across the whole imported tree: zero hits), as were the full histories of the two
vendored native dependencies.

This replaces the previously approved "import with git history" approach (ADR-003 as originally
written); see [ADR-003](../docs/adr/ADR-003-android-execution-node.md) for the ratified decision.

## Relationship between upstream-derived and new Universal Harness code

- Everything under `android/` that exists in the upstream tree at the pinned commit is
  **upstream-derived** (MIT). The import commit is the boundary: any file added after it that is
  not part of a future re-snapshot is Universal Harness code.
- **New Universal Harness Android code must live only in new files/packages** (planned package:
  `com.universalharness.node`), never as edits entangled inside upstream files except where an
  adaptation is unavoidable — such edits must be minimal and are recorded in PROVENANCE updates.
- No Android *implementation* exists yet at this baseline: this is the import, licensing, and
  runtime-target preparation only (ROADMAP.md Phase 3).

## Adaptations to imported upstream files (Phase 3A, recorded per NOTICES rule 2)

The following minimal changes were made to upstream files; all are additive or bug-fixing and
none alters upstream behavior on the upstream's own paths:

1. `app/src/main/cpp/CMakeLists.txt` — added the `uhspawn` shared-library target
   (`uh_spawn.c`, new Universal Harness code, not an upstream change) and quoted the
   `-include ${SHM_ROOT}/shm.h` compile flag, which breaks when the checkout path contains a
   space (as this repository's does).
2. `app/build.gradle.kts` — the two offline-bundle `Sync` tasks are guarded with `onlyIf` so
   the build works without Mobile-Harness's GitHub-release bundle files (not part of this
   repository); test dependencies for `kotlin("test")` and androidx.test were added.
3. `app/src/main/java/com/jarves/mh/runtime/WorkspaceCheckpoints.kt` — snapshot keys now use
   invariant separators (`invariantSeparatorsPath`); backslash keys broke the checkpoint
   contract on Windows hosts (caught by upstream's own `MemoryBoundsTest`).

## Device-driven fixes found by the real ARM64 Gate D run (2026-10-01, moto g 5G plus)

These are all in new Universal Harness code (`com.universalharness.node`), not upstream changes;
each was only discoverable by executing on a real device:

1. **Android denies `linkat(2)` to apps.** `SafeTarExtractor` now resolves tar hard links
   against the archive root (they are root-relative, not entry-parent-relative as symlinks are),
   materializes them in rounds to handle chains, and degrades to a byte copy when the OS refuses
   the hard link. The same denial breaks `dpkg` (it hard-links `status` → `status-old`), so
   `--link2symlink` is enabled for the apt/dpkg bootstrap only — it stays off for dsh, whose
   atomic temp-file renames break under the emulation.
2. **JNI symbol mismatch** — `uh_spawn.c` exported `UhNativeProcess$UhNativeSpawn_*` (nested
   class) while the Kotlin declaration is a top-level `object UhNativeSpawn`. The C names were
   corrected to match.
3. **Guest PATH links** — the Node stage linked only `/usr/local/bin/node`; npm/npx/dsh are now
   linked too (npm derives its global prefix from node's location, so `--prefix /usr/local` is
   passed explicitly for dsh), and both stages self-heal an install completed by an older build
   instead of trusting the recorded done-pin alone.
4. **Bootstrap recovery** — an interrupted apt bootstrap leaves dpkg half-configured and apt
   refuses to proceed; `dpkg --configure -a` runs before apt (an idempotent no-op when clean).
5. **SDK `initialize` provider default** — the dsh SDK server only auto-mounts its DeepSeek
   adapter for `provider: "deepseek-official"`; the client now defaults to that, matching the
   desktop adapter (`core/adapter/mod.mjs`).

## Update procedure for future upstream refreshes

1. Choose and record the new upstream commit SHA; re-verify it is credential-free (full-history
   pickaxe sweep for known patterns plus tree scan) and re-read its licenses.
2. Re-import with `git archive <sha> | tar -x -C android/` (after removing the previous upstream
   files), re-vendor the two native dependencies at their newly pinned commits, and update the
   tables above.
3. Diff the re-import against the previous snapshot and review every upstream delta before
   committing; never overwrite Universal Harness-specific files (`PROVENANCE.md`, new
   `com.universalharness.*` sources) during a refresh.
4. Repeat the license/notice review in [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)
   and update it if any component version changed.
