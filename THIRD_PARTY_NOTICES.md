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
| `techjarves/Mobile-Harness` | **MIT** — verified via GitHub API `license` field (`spdx_id: MIT`); `LICENSE` file re-read verbatim at import ("Copyright (c) 2026 Mobile Harness Contributors") | adapted, imported as a **clean source snapshot at pinned commit `f0ba6730`** into `android/` (**Phase 3 baseline — imported**; git history intentionally not imported — see [android/PROVENANCE.md](android/PROVENANCE.md)) |
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

## Android node (adapted from Mobile-Harness, MIT) — Phase 3 import baseline

Imported 2026-10-01 as a clean source snapshot at pinned upstream commit
`f0ba6730b1522ce3225cf84089305d6d1e7df905` (tree `0ae06e7b0238ab99039e832fd8cb4d64c67f7ad7`),
no git history (see [android/PROVENANCE.md](android/PROVENANCE.md) for the security rationale
and the credential-free verification). All license texts below were read verbatim from the
imported files.

| Component | Version/Commit | License | Required action | Status |
|---|---|---|---|---|
| Mobile-Harness (source tree) | `f0ba6730` | MIT — `android/LICENSE` (verbatim, "© 2026 Mobile Harness Contributors") | Preserve license/attribution; no other obligation (permissive) | **Recorded** |
| PRoot (termux fork, © STMicroelectronics) | `61681c6481197e3c0cec6726075053adb740f235` = v5.1.107.91 | **GPL-2.0-or-later** — `android/third_party/proot/COPYING` (verbatim; source headers state "version 2 … or (at your option) any later version") | Preserve source + license (vendored in-tree); when a compiled proot ships in an APK, GPLv2 §3 is satisfied by the corresponding source in this public repo; state any patches | **Recorded** |
| libandroid-shmem (© Pylypenko 2013, Fornwall 2017) | `7f0bd7e25dbdd146265aff7c6a890029e374622d` = v0.7 | **BSD-3-Clause** — `android/third_party/libandroid-shmem/LICENSE` (verbatim; clause set verified) | Reproduce notice + conditions + disclaimer in distributed materials | **Recorded** |
| talloc (© Tridgell, Metzmacher; Samba lineage) | 2.4.3 (vendored in-tree) | **LGPL-3.0-or-later** — `android/third_party/talloc/LICENSE` (verbatim); built as its own shared `libtalloc.so` (SOVERSION 2, per `app/src/main/cpp/CMakeLists.txt`) | Keep LGPL text + notices; ship libtalloc.so as a separate shared library; relinkable sources = the vendored source (LGPL §4(d)) | **Recorded** |
| Upstream attribution copies | — | — | `android/app/src/main/assets/licenses/` preserved verbatim (`proot-GPL-2.0.txt`, `talloc-LGPL-3.0-or-later.txt`, `libandroid-shmem-BSD-3-Clause.txt`, `claude-code-android-MIT.txt`) | **Preserved** |
| Ubuntu 20.04 arm64 rootfs (ubuntu-base-20.04.5) | pinned image SHA-256 (upstream build script pins `f9b999af…`; **our bundle records its own SHA-256 at build time**) | **No single "Ubuntu license"** — aggregate of per-package licenses (git GPL-2.0-only, curl license, wget GPL-3+, Info-ZIP, xz-utils PD/GPL-2+, zstd BSD/GPLv2, ca-certificates GPL-2+/MPL, base packages mostly GPL/LGPL/MIT/BSD/Apache) | **Bundle-time discipline (not yet due — no bundle built):** record image URL + exact SHA-256, generated `dpkg -l` manifest, per-package `copyright` files; sources obtainable via the Ubuntu archive for the recorded package versions. Packages are separate programs, not linked into the APK. | **Pending bundle build — method recorded, no closure claimed** |
| Node.js (Android bundle) | **v24.21.0** linux-arm64 (manifest pinned; upstream Mobile-Harness's script pins v24.19.0 — our bundle uses the UH manifest pin) | Node.js license (MIT grant; `LICENSE` enumerates bundled components: OpenSSL, V8, libuv, ICU, zlib, c-ares, undici, etc. — "mostly MIT, plus Apache 2.0, BSD-style, ISC, Unicode-3.0, public-domain") | Preserve the full Node `LICENSE` text (it is the bundled-components notice) | **Recorded** (same terms as the Phase 1 desktop set) |
| npm | 11.x (inside the Node distribution) | Artistic-2.0 | Notice retention | **Recorded** |
| `@deepseek-ai/dsh` | 0.2.0-rc.2 | **MIT** (verified from the published tarball's `package/LICENSE`: "Copyright (c) 2026 DeepSeek") | Notice retention; lockfile preserved for provenance | **Recorded** |
| dsh npm dependency tree | 82 first-level dependencies individually verified via registry metadata (`npm view <name>@<version> license`), including the native-capable `koffi@3.1.1`, `node-addon-require-builtin@0.1.6`, and their linux-arm64 prebuilt packages | **All MIT — zero GPL/AGPL/LGPL/unlicensed/unknown flags found** | Notices; bundled transitively inside dsh's install tree (never re-distributed separately) | **Recorded** |

**Additional third-party components present in the imported snapshot:** Gradle wrapper
(`gradle/wrapper/` — Gradle performable distribution downloaded at build time, Apache-2.0 when
used; the wrapper JAR is upstream's), AndroidX/Compose dependencies resolved by Gradle at build
time under the Android Software Development Kit License Agreement and their own open-source
licenses (recorded per actual build output when the app first builds), and `fastlane/` assets
(MIT-adjacent tooling config, not distributed in the APK). These are build-time, not bundled,
and are re-reviewed at the first APK build. No other bundled binaries exist in the snapshot
(largest tracked file ≈ 1 MB image under `fastlane/graphics/`).

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
> and ships inside the Node distribution. The Android execution node adapts Mobile Harness
> (techjarves, MIT), with PRoot (© STMicroelectronics, GPL-2.0-or-later, termux fork), talloc
> (LGPL-3.0-or-later), and libandroid-shmem (BSD-3-Clause) vendored at pinned commits. See
> [android/PROVENANCE.md](android/PROVENANCE.md), [android/LICENSE](android/LICENSE), and the
> individual notices in `third_party-licenses/` for full terms.

---

**Pending-closure note:** the Android **source-set** licenses are now recorded with verbatim
evidence (this closes the license-reading half of R-08). Remaining R-08 items are strictly
bundle-time: the Ubuntu rootfs image's exact SHA-256 + `dpkg` manifest + per-package copyright
recording, and a re-review of Gradle-resolved Android dependencies at the first APK build. Both
happen when the runtime bundle is first built; no license closure is claimed for them here.
