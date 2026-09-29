# Third-Party Notices

**Phase 0 deliverable.** License obligations for every component Universal Harness bundles or
adapts. The brief's rule: *do not assume every vendored dependency shares the parent
repository's license.* Each entry below records the upstream source, the license evidence, and
its status. This file is **regenerated at every release** from the actually-vendored trees.

---

## Licensing posture

| Source | License | Reuse posture |
|---|---|---|
| Universal Harness (new code here) | MIT ([LICENSE](LICENSE)) | authored |
| `deepseek-ai/deepseek-harness` | **MIT** — verified via GitHub API `license` field (`spdx_id: MIT`) and repo `LICENSE` file | bundled, unmodified, pinned + integrity-verified |
| `techjarves/Mobile-Harness` | **MIT** — verified via GitHub API `license` field (`spdx_id: MIT`) | adapted, with git history, into `android/` |
| `techjarves/Deepseek-Harness-Portable` | **NONE** (`license: null`; no LICENSE file in tree) | **no code copied — design reference only** ([AUDIT.md §3.5](docs/AUDIT.md#35-licensing-verdict--clean-room-reimplementation)) |

## Direct dependencies (bundled)

| Component | Upstream | License | Evidence status |
|---|---|---|---|
| DeepSeek Harness (`@deepseek-ai/dsh`) | https://github.com/deepseek-ai/deepseek-harness (npm: `@deepseek-ai/dsh`) | MIT | **Verified at audit** (repo metadata + `LICENSE`) |
| Node.js (per-platform: win-x64, linux-x64, darwin-arm64) | https://nodejs.org/dist | Node.js license (BSD-style / MIT-adjacent; see `LICENSE` in each tarball) | To record per distribution at bundle time |
| pnpm (offline store) | https://github.com/pnpm/pnpm | MIT | To record at bundle time |
| Node module: `koffi` | https://github.com/koffi/koffi | MIT | Upstream manifest lists `koffi@3.3.1`; record at install time |
| Node module: `node-pty` | https://github.com/microsoft/node-pty | MIT | Upstream manifest lists `node-pty@1.2.0-beta.15`; record at install time |
| Node module: `@google/genai` | Google | Apache-2.0 | record at install time |
| Node module: `protobufjs` | https://github.com/protobufjs/protobuf.js | BSD-3-Clause | record at install time |
| Node module: `fflate` | https://github.com/101arrowz/fflate | MIT | record at install time |

## Android node (adapted from Mobile-Harness, MIT)

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
   code as entirely original").
3. **Vendored `LICENSE` files are kept in-tree** at `third_party/<component>/LICENSE` and
   mirrored to `third_party-licenses/` in the portable distribution for offline reading.
4. **Submodules are pinned to commits** whose license texts are recorded here before any
   distribution (closes RISK R-08).
5. **This notices file is regenerated at release time**, not hand-maintained indefinitely.

## Attribution text (to be included in releases)

> Universal Harness includes DeepSeek Harness (`@deepseek-ai/dsh`), © DeepSeek AI, MIT License.
> Android execution node adapted from Mobile Harness by techjarves, MIT License. Node.js is ©
> Node.js contributors. See the individual notices in `third_party-licenses/` for full terms.

---

**Pending-closure note:** items marked PENDING cannot be completed in Phase 0 because the
vendored trees do not exist in this repository yet (Android import is Phase 3, per the
"skeletons only" rule). They are tracked as R-08 in [docs/RISK-REGISTER.md](docs/RISK-REGISTER.md)
and must be closed **before any distribution** of an Android build.
