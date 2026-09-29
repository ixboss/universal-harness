# Third-Party Notices

**Phase 1 update (2026-09-29).** License obligations for every component Universal Harness
bundles or adapts. The brief's rule: *do not assume every vendored dependency shares the parent
repository's license.* Each entry below records the upstream source, the license evidence, and
its status. This file is **regenerated at every release** from the actually-vendored trees.

---

## Licensing posture

| Source | License | Reuse posture |
|---|---|---|
| Universal Harness (new code here) | MIT ([LICENSE](LICENSE)) | authored |
| `deepseek-ai/deepseek-harness` | **MIT** — verified via GitHub API `license` field (`spdx_id: MIT`) and repo `LICENSE` file | **bundled, unmodified** (npm `@deepseek-ai/dsh@0.2.0-rc.2`), integrity-recorded, driven only through the SDK adapter |
| `techjarves/Mobile-Harness` | **MIT** — verified via GitHub API `license` field (`spdx_id: MIT`) | adapted, with git history, into `android/` (**Phase 3 — not yet imported**) |
| `techjarves/Deepseek-Harness-Portable` | **NONE** (`license: null`; no LICENSE file in tree) | **no code copied — design reference only** ([AUDIT.md §3.5](docs/AUDIT.md#35-licensing-verdict--clean-room-reimplementation)) |

## Direct dependencies (bundled in Phase 1)

| Component | Upstream | License | Evidence status |
|---|---|---|---|
| Node.js **v24.21.0** (one distribution per target: win-x64, linux-x64, darwin-arm64) | https://nodejs.org/dist/v24.21.0/ | Node.js license (BSD-style; MIT-adjacent components) — `LICENSE` file inside each archive | **Recorded** — SHA-256 per archive from nodejs.org `SHASUMS256.txt`, pinned in `manifests/runtime.manifest.json`, verified before unpack. win-x64 installed and hash-verified; linux-x64 + macos-arm64 pinned, not downloaded on this host. The full license text ships inside each distribution and is preserved on disk under `runtime/node/<target>/`. |
| DeepSeek Harness (**`@deepseek-ai/dsh@0.2.0-rc.2`**) | https://github.com/deepseek-ai/deepseek-harness (npm: `@deepseek-ai/dsh`) | **MIT** | **Recorded** — installed unmodified via the bundled npm (`--omit=dev --no-audit --no-fund --exact`); SHA-512 integrity (`sha512-EAJ3g…IdA==`) read from the generated lockfile and pinned in `manifests/runtime.manifest.json`. No patch, no fork (ADR-001). |
| npm (part of the Node distribution) | https://github.com/npm/cli | Artistic-2.0 (npm proper) + dependencies under their own licenses | **Recorded** — ships inside every Node.js distribution; used only to install the pinned dsh (`--omit=dev`, no scripts run from dsh's tree since no git/CI lifecycle is triggered offline) |
| dsh's own runtime dependencies (`koffi@3.x`, `node-pty`, `@google/genai` Apache-2.0, `protobufjs` BSD-3-Clause, `fflate` MIT, zod, etc.) | respective upstreams | per-project licenses, declared in dsh's own `package.json`/lockfile | **Bundled transitively inside dsh's install tree — Universal Harness never builds, patches, or re-distributes them separately.** Their license declarations are recorded in dsh's lockfile, which is preserved in the install tree. Native modules (`koffi`, `node-pty`) load under the bundled Node ABI (verified, smoke stage 04). |

> Phase 0 listed pnpm as a bundled installer. **Phase 1 does not use pnpm**: the bundled stock
> npm CLI performs the exact-pin install, which removes the pnpm license from the
> direct-dependency set.

## Android node (adapted from Mobile-Harness, MIT) — Phase 3, not yet imported

| Component | Upstream | License | Evidence status |
|---|---|---|---|
| Mobile-Harness (parent) | https://github.com/techjarves/Mobile-Harness | MIT | **Verified at audit** |
| PRoot | `third_party/proot` — **git submodule**, termux fork, `VERSION "5.1.107.91"` (per audited `CMakeLists.txt`) | **must be read from the submodule at pinned commit** (historically GPL-2.0 in proot lineage) | **PENDING** — read at Phase 3 import |
| talloc | `third_party/talloc` — vendored dir, API level 2.4.3 per `CMakeLists.txt` | **must be read from vendored dir** (Samba lineage, historically LGPL-3.0+) | **PENDING** — read at Phase 3 import |
| libandroid-shmem | `third_party/libandroid-shmem` — **git submodule** | **must be read from the submodule at pinned commit** | **PENDING** — read at Phase 3 import |
| Ubuntu 20.04 LTS arm64 rootfs | Ubuntu / Canonical | Ubuntu license terms (components individually Apache/MIT/GPL/etc.) | **PENDING** — distribution/redistribution terms recorded at bundle time |
| Optional toolchains (Python, OpenJDK 17, Gradle, PHP) | respective upstreams | per-project licenses | record per toolchain when enabled |

## Embedding rules adopted

1. **Never copy Deepseek-Harness-Portable source** (no license). Public behavior and observable
   design may inform clean-room reimplementation; no expression is copied.
2. **Modified upstream components are documented** — any change to a vendored/adapted file is
   recorded in this file with the diff rationale (per the brief: "do not falsely present upstream
   code as entirely original"). **Phase 1 makes no modifications to dsh or Node.**
3. **Vendored `LICENSE` files are kept in-tree** — the Node distribution and the npm-installed dsh
   tree keep their own `LICENSE` files on disk; they are mirrored to `third_party-licenses/` in
   the portable distribution for offline reading at packaging time.
4. **Submodules are pinned to commits** whose license texts are recorded here before any
   distribution (closes RISK R-08 for the Android set).
5. **This notices file is regenerated at release time**, not hand-maintained indefinitely.

## Attribution text (to be included in releases)

> Universal Harness includes DeepSeek Harness (`@deepseek-ai/dsh`), © DeepSeek AI, MIT License.
> Node.js is © Node.js contributors and is bundled under the Node.js license; npm is Artistic-2.0
> and ships inside the Node distribution. Android execution node adapted from Mobile Harness by
> techjarves, MIT License (Phase 3). See the individual notices in `third_party-licenses/` for
> full terms.

---

**Pending-closure note:** items marked PENDING are the Android-set licenses (proot, talloc,
libandroid-shmem, Ubuntu rootfs), which cannot be recorded until the Phase 3 vendored import. The
Phase 1 distribution set (Node.js, npm, pinned dsh including its transitive dependencies) is
recorded above with hashes pinned in
[manifests/runtime.manifest.json](manifests/runtime.manifest.json). R-08 remains open for the
Android set and must be closed **before any distribution** of an Android build.
