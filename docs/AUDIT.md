# Architecture & Source Audit

**Phase 0 deliverable.** Everything in this document is backed by source-code inspection
performed 2026-09-29, not by README claims. Where a README and source disagreed, the source is
recorded as authoritative and the difference is documented in [§6 Discrepancies](#6-discrepancies).

Paths cited as `repo:<path>` are relative to each repository root. Fetches were performed
against default branches (`main` for both techjarves repos, `master` for `deepseek-ai/deepseek-harness`).

---

## 1. Repositories audited

| # | Repository | Role | License | Size | Inspected |
|---|---|---|---|---|---|
| A | `techjarves/Deepseek-Harness-Portable` | Desktop portability wrapper (reference) | **NONE** (`license: null`, no LICENSE file) | ~113 KB, 21 files | full tree + key sources |
| B | `techjarves/Mobile-Harness` | Android on-device coding IDE (adaptation base) | **MIT** | ~5.3 MB | full tree + key sources |
| C | `deepseek-ai/deepseek-harness` | Upstream execution engine (`dsh`) | **MIT** | ~245 MB monorepo | docs, CLI, persistence, config |

Repository A is **not** the harness and **not** licensed for reuse of its code; it is a thin
wrapper. Repository B is an MIT-licensed Android application. Repository C is the actual
execution engine that A and B both wrap.

---

## 2. Upstream DeepSeek Harness (the execution engine)

### 2.1 Identity and health

- npm package `@deepseek-ai/dsh` — "dsh CLI: profile launch, plugin management, and
  configuration inspection" (`apps/cli/package.json`, `master`), published by DeepSeek AI
  maintainers (`imccyu`, `tianyicui-deepseek`). Dist-tags at audit time:
  `latest` / `next` = **0.2.0-rc.2**, `alpha` = 0.1.7-alpha.2.
- GitHub `deepseek-ai/deepseek-harness`: MIT, TypeScript, pnpm workspace monorepo,
  ~239k stars, last push 2026-09-29. Self-described as "DeepSeek Harness: Everything is a
  Plugin", built on the **Cordis** plugin framework. Topics: `ai-agents`, `cordis`, `dsh`, `dsh-plugin`.
- Upstream is **pre-1.0 and iterating rapidly**; README states breaking changes are expected.
  It already ships its own `THIRD_PARTY_NOTICES.md`, `SAFETY.md`, and `BENCHMARK.md`.

### 2.2 CLI surface (source: `apps/cli/src/args.ts`, `bin.ts`)

```
dsh [command] [options] [args...]
  commands: plugin, dsh
  flags:    -V, --version
            --profile <name>
            --from-default-profile <name>
            --patch <path>
            --dump-config | --dump-config-schema | --dump-default-config
```

Profile names referenced in source/examples: `web`, `tui`, `rescue`, `headless`, `desktop`,
and — critically for us — `sdk`. Profiles are composable bundles; users may create custom
profiles from shipped templates via `--from-default-profile`.

### 2.3 The `sdk` profile — our integration seam

**Direct source evidence** (`apps/cli/src/sdk-source.cordis.patch.yml`, verbatim comment):

> "The SDK JSON-RPC application does not consume the Typert remote gateway; installed builds
> retain the complete dsh-base row."

So `dsh --profile sdk` is, upstream's own words, an SDK **JSON-RPC application**. This is
confirmed by a second, independent shipping integration: Mobile-Harness's `DshRuntimeBridge`
(repo B, `app/src/main/java/com/jarves/mh/runtime/DshRuntimeBridge.kt`) drives the harness as:

```kotlin
listOf("/usr/local/bin/dsh", "--profile", "sdk")
```

with newline-delimited JSON-RPC frames over stdio:

- `initialize` — working directory, provider, model
- `session/prompt` — composed task prompt
- `shutdown` — graceful teardown when the agent goes idle

Output is consumed by incrementally reading a merged capture file and parsing complete lines
into protocol events (reasoning deltas, tool calls, assistant text, status changes).

From `docs/agent-lifecycle.md` (upstream):

- The **SDK participant** is "the UI or SDK listener" — a consumer of live `agent/*` events.
- "Transient chunk frames are not replayable; SDK users that need replayable transcript data
  should consume `session/event`."
- The lifecycle is turn/step based: `turn/start`…`turn/end`, `step/start`…`step/end`,
  `agent/status` (`running` → `idle`), `assistant/message` (settled) vs `assistant/attempt`
  (failed/retried/cancelled), `tool/call` / `tool/result` with "barriers and bounded rolling pool".
- **Cancellation**: "cancellation during either async phase commits neither system nor users" —
  a cancelled attempt leaves **no durable settlement**; hard process loss before settlement
  leaves no durable attempt stream.

### 2.4 Process semantics (source: `apps/cli/src/profile-boot.ts`, `process-shutdown.ts`)

- `SIGTERM` → bounded interrupt, **exit code 0** ("it does not know whether the app considered
  its work complete").
- `SIGINT` → **exit code 130**.
- Launcher-owned readiness signal (`createAppReady`) committed only after boot succeeds and a
  loader is present; startup teardown aggregates failures without masking the original error.
- Home-level config layer ("machine-local preferences") outranks per-profile layers; profile
  boot rewrites the root `cordis.yml` to prevent loader tree write-back from duplicating
  bundle inserts.

### 2.5 Persistence and storage (source: `docs/subsystems/persistence.md`, `docs/persistence-catalog.md`, `docs/session-format-status.md`, plus repo A's migration code as a second witness)

- **Per-session append-only logical JSONL log**, stored as "checksummed concatenated Zstandard
  frames by default or raw lines".
- Session artifacts live in a **project/session directory**; "JSONL supplies the absolute
  transcript path inside its project/session directory".
- The **immutable `SessionHeader`** (fields: `version`, `cwd`, lineage `isSeeded`) travels
  *separately from the event log body*. This is exactly the header that repo A rewrites for
  portability (see §3.3).
- Event envelope: `{ type, seq, time, data, optional ignorable, conditional surfaceOp,
  sourceEventSeqs }`. Five **surface** event types: `system/message`, `developer/message`,
  `user/message`, `assistant/message`, `tool/result`. Everything else (e.g. `agent/*`, `step/*`,
  `turn/*`, `tool/*`, `llm/*`, `compaction/*`, `workspace/*`, `session/*`) is **log-only**.
- **Session format is versioned in code, only**: `SESSION_FORMAT_VERSION` in
  `packages/core/session/src/types.ts` is "the only hand-maintained current-writer number in
  code". At audit time: `latestFinalizedVersion: 4`, `latestReleasedVersion: 3` (record in
  `docs/persistence-changes/`). Historical formats are documented under
  `persistence-changes/historical-formats/` for every integer version.

### 2.6 Configuration (source: `docs/config-catalog.md`)

- **`DSH_HOME`** — harness home directory; default fallback `~/.dsh`.
- **`DEEPSEEK_API_KEY`** — default credential reference for the API-key LLM route.
- Credentials plugin: `.credentials.yaml` **under the harness home**.
- Permission presets: `workspace-write` (sandbox workspace-write + approval `ask`) and
  `danger-full-access` (sandbox danger-full-access + approval `never`); `custom`/`auto` reserved;
  user-selectable `defaultPreset`. This is the portable equivalent of Mobile-Harness's
  `DSH_PERMISSION_MODE` injection.
- Provider configuration: routes (DeepSeek account, DeepSeek API-key, pi-ai/OpenAI-compatible
  `providers` dict with `baseURL`, `models`, `compat` switches, `defaultContextWindow: 262144`,
  `defaultMaxTokens: 32768`, retry policy).

### 2.7 Desktop ecosystem

Upstream already ships Electron desktop plumbing (`apps/desktop`, `apps/desktop-host` —
"Private Node-mode host process for the Electron desktop application", MIT). It depends on
`koffi` (FFI), `node-pty`, and workspace packages (`dsh-home-paths`, `dsh-workspace`, `dsh-jobs`,
`dsh-schedule`, `dsh-host-webserver`, `dsh-client-connection`). Universal Harness deliberately
does **not** reuse the Electron app; our portable runtime drives the CLI
(see [ADR-001](adr/ADR-001-deepseek-harness-engine.md)).

---

## 3. Deepseek-Harness-Portable (repo A) — design reference only

### 3.1 Facts

- 21 files total (complete tree, `truncated: false`): root launchers `windows.bat`, `linux.sh`,
  `mac.sh`; `scripts/` (`portable.mjs`, `portable.ps1`, `portable.sh`, `reset.bat`, `reset.sh`,
  `session-portability.mjs`, `manifest.json`, `automation/update-deepseek.mjs`,
  `locks/{package.json,package-lock.json}`, `tests/test-portable.mjs`); `models/README.md`;
  `.github/` (README, workflows `auto-update.yml`, `release.yml`, `test.yml`).
- API metadata: `license: null`, JavaScript, ~113 KB, 6 stars, last push 2026-09-29.
- **There is no LICENSE file anywhere in the tree** — checked both the tree listing and a direct
  fetch of `LICENSE` (HTTP 404).
- Language: POSIX shell + Windows batch + PowerShell + ESM JavaScript.

### 3.2 What it actually does (verified from `manifest.json` and `portable.mjs`)

The manifest (`scripts/manifest.json`, schema 1, `portableVersion: 1.0.4`) pins:

- harness: `@deepseek-ai/dsh` **0.1.7-rc.2**, update channel `next`, pinned upstream commit
  `477b4f42…`, `sha512` integrity, plus `allowScripts` for `@deepseek-ai/dsh-subprocess-local`,
  `koffi@3.3.1`, `node-pty@1.2.0-beta.15`, `@google/genai@1.52.0`, `protobufjs@7.6.6`, and an
  `overrides` pin of `fflate@0.8.3`;
- **Node.js 24.21.0** per platform, downloaded from nodejs.org dist with `sha256`:
  `windows-x64` (zip), `linux-x64` (tar.xz), `macos-arm64` (tar.xz);
- `pnpm: 11.28.0` and a lock-pinned `dependencyLock` (`locks/package-lock.json` + sha256);
- release: GitHub releases manifest URL, `autoUpdateHours: 24`.

`scripts/locks/package.json` reproduces the same deps (`@deepseek-ai/dsh`, `pnpm`, allowScripts,
overrides) — i.e. it pnpm-installs the harness into a private portable prefix rather than
running `npx`.

`portable.mjs` subcommands (verified from source): `setup`, `doctor`, `portable-update`
(supports `--manifest URL`), `web` (default; launches the harness web interface), `--`
(passthrough of native harness arguments), `--profile web`, global `--root <path>` and
`--target <platform>`.

`windows.bat` is a two-line shim that calls
`powershell -NoLogo -NoProfile -ExecutionPolicy Bypass scripts\portable.ps1` with forwarded
arguments; `linux.sh` execs `scripts/portable.sh linux-x64 "$@"` (with `mac.sh` analogous).

### 3.3 Session portability (source: `scripts/session-portability.mjs`, read in detail)

- Path classification: `platformOfPath` tags anything matching `^[A-Za-z]:[\\/]/` or containing
  a backslash as `windows-x64`. `portableRelativePath` maps `/data/portable-home/…` and
  `/data/portable-workspaces/…` back to portable-relative paths.
- Rewrites: `storages/workspace.json` (workspace registry `path` per workspace, written
  atomically via staged `.new` + `renameSync`), `sessions/<projectKey>/…` (directories renamed
  to a new sanitized path key), `session.v{N}.jsonl[.zstd]` (header `cwd` rewritten; Zstd
  streams **recompressed while trailing frames are preserved**), and
  `storages/session_projcache/sessions/*.json` (`record.identity.cwd`).
- `portable-workspace-paths.json` (`{ schema: 1, workspaces: {} }`) remembers per-platform
  workspace path mappings; non-registered paths get recorded there keyed by target platform.
- Backups: created **only** for session log files (`${path}.portable-backup`, copy-once). Cache
  record errors are swallowed (`catch { continue }`).
- Not idempotent in every dimension: session directory renames **throw** if the destination
  already exists ("portable session destination already exists").
- Contract tests (`scripts/tests/test-portable.mjs`) verify: portability metadata validity
  (package name, SemVer, update channel, Node SHA-256 per platform), and a full
  Windows→macOS migration fixture (workspace moved, session log header rewritten, **trailing
  event frame byte-identical after recompression**, old key removed).

### 3.4 Documented behavior to avoid inheriting blindly

- README itself warns: "Credentials stored by DeepSeek Harness travel inside the portable
  folder **in plaintext**" — users must treat the drive as sensitive. Universal Harness
  deliberately does not inherit this property ([ADR-007](adr/ADR-007-security-and-pairing.md)).
- Unsupported in v1 (per README): Windows ARM64, Linux ARM64, Intel macOS, musl Linux.
- No remote-control, pairing, discovery, conflict detection, workspace import/export, backup
  tooling, or storage accounting. Doctor is minimal.

### 3.5 Licensing verdict — clean-room reimplementation

`license: null` with no LICENSE file means, under GitHub's default and standard copyright law,
**"All rights reserved"**. No permission is granted to copy, modify, or redistribute the code.
The user's Phase 0 brief states this explicitly: do not copy the implementation; public
behavior, architecture concepts, and independently observable design may inform a clean-room
reimplementation.

**Decision:** Universal Harness reimplements the *concepts* (versioned manifest with per-platform
SHA-256-pinned runtimes; lock-pinned private npm install; `setup|doctor|update|web|--` launcher;
session-header path migration) **from scratch**, with no line of repo A's source reused. The
upstream dsh *storage format* (§2.5) is an independently observable, MIT-licensed spec — reading
and writing those files is not copying repo A. Where repo A and upstream disagree about format
details, upstream source and its own docs win.

---

## 4. Mobile-Harness (repo B) — adaptation base

### 4.1 Facts

- API metadata: **MIT**, Kotlin, ~5.3 MB, ~453 stars, last push 2026-09-28 (active).
- Description: "Claude Code on Android: AI-powered mobile coding IDE for Android — … No root
  required." Android 9+, ARM64-only, Jetpack Compose UI.
- Android app id `com.jarves.mh`; internal brand "PocketDev".

### 4.2 Native stack (source: `app/src/main/cpp/CMakeLists.txt`)

- `project(mobile_harness_native C ASM)`; **FATAL_ERROR unless `ANDROID_ABI == arm64-v8a`**.
- Vendored in `third_party/`: **PRoot** (sources compiled from `third_party/proot/src`,
  `VERSION "5.1.107.91"`, with `HAVE_PROCESS_VM` and `HAVE_SECCOMP_FILTER`), **talloc**
  (2.4.3 API emulated via `TALLOC_BUILD_VERSION_*`, SOVERSION 2), **libandroid-shmem**
  (`_PATH_TMP=/data/data/com.jarves.mh/cache/`).
- Build artifacts: `proot`, `prootloader` (static, `-nostdlib`, `-Ttext=0x2000000000`), and
  `pocketspawn` shared library. Proot links `WITH_LIBANDROID_SHMEM` and bundles its loader
  (`PROOT_UNBUNDLE_LOADER="."`).
- **The APK carrier-executable trick** (documented in the CMakeLists comment): "AGP packages
  shared-library targets but not executable targets. Each carrier advertises the APK entry,
  then is replaced by the real executable after link" — a `.so`-named carrier is overwritten
  POST_BUILD with the real ELF binary so it lands in the APK. This is a solved, non-obvious
  Android packaging problem worth reusing verbatim.
- Notable PRoot extensions exercised: `fake_id0`, `link2symlink`, `sysvipc`, `ashmem_memfd`,
  `kompat`, `fix_symlink_size`.

### 4.3 Application architecture (source: package tree under `com/jarves/mh`)

- **Agent abstraction**: `AgentDriver` (interface: `kind`, `runtime`, `capabilities`,
  `isInstalled()`, `install()`), `AgentRegistry` ("Single selection point for agent runtimes",
  validates "Every built-in agent must be registered"), `AgentCapability` enum: `API_KEY`,
  `ACCOUNT_LOGIN`, `PROVIDER_PICKER`, `MODEL_PICKER`, `REASONING_EFFORT`, `RESUME`,
  `INTERACTIVE_APPROVALS`. Built-ins: Claude Code, DeepSeek Harness, Antigravity.
- **Runtime contract** (`RuntimeBridge` interface): `startSession(projectId, projectSlug,
  projectKind, prompt, conversationHistory, provider): String`, `respondToApproval(request,
  approved)`, `stopSession(sessionId)`, `stopActiveSession()`, `undoLastChanges`,
  `acceptLastChanges`, `loadPendingChanges`, `undoFileChange`, `acceptFileChange`; event flow
  via `SharedFlow`; plus `RuntimeLaunchConfigBuilder` producing env-var launch configuration.
- **DSH driver** (`DshRuntimeBridge.kt`): as described in §2.3 — also disables hard-link
  emulation in PRoot because "dsh's editor saves through an atomic temp-file rename" that PRoot
  would otherwise break; workspace mounted at `/workspace/$projectSlug`; writes
  `$DSH_HOME/settings.yaml` with provider route and model; injects API key and
  `DSH_PERMISSION_MODE` env; on stop: destroys the process, escalates to forced termination
  after **500 ms**, cancels the foreground work.
- **Lifecycle**: `RuntimeExecutionService` and `RuntimeSetupService` are foreground services
  with `foregroundServiceType="specialUse"` (`PROPERTY_SPECIAL_USE_FGS_SUBTYPE` = "User-started
  local development task" / "…installation of the local coding environment"), permissions
  `INTERNET`, `ACCESS_NETWORK_STATE`, `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_SPECIAL_USE`, `WAKE_LOCK`, `REQUEST_INSTALL_PACKAGES` (for on-device APK
  installs dispatched to the system installer with user approval).
- **Credentials** (`ApiKeyVault.kt`): AndroidKeystore AES/GCM/NoPadding with a single app-wide
  key alias `pocket-provider-key`; per-secret random IV stored in plaintext SharedPreferences
  alongside Base64 ciphertext; per-provider key *pool* model (`<providerId>.pool`, `…pool.<id>`,
  `<providerId>.active`) with legacy single-key migration. Pool metadata and IVs are plaintext;
  secrets and key material are not.
- **Workspace safety** (`WorkspaceCheckpoints.kt`): snapshot before execution, compute changed
  files after, per-file or whole-workspace undo/accept by restoring/deleting against the backup.
- **Other**: `RuntimeInstaller` (rootfs download + SHA-256 verification; Online Edition
  87.4 MB vs Offline Edition 887.7 MB), `GitHubClient`/`AppUpdater` (GitHub-release updates),
  `ProviderApiClient`, `BoundedFileReads`, `AndroidAppInstallReceiver`.
- **Build config**: root plugins AGP 8.13.2, Kotlin 2.2.21, Compose; README requires JDK 17,
  NDK 26.1.10909125, CMake 3.22.1; `./gradlew assembleDebug`; `-PplayBuild=true` for Play
  compliance. UI: `MainActivity`, `PocketDevApp`, `AgentScreen`, `SettingsScreen`,
  `TerminalScreen`, `MarkdownText`, `MainViewModel`, theme dir.

### 4.4 Runtime environment

Ubuntu 20.04 LTS ARM64 rootfs inside PRoot ("user-space architecture emulation with zero kernel
modifications"), verified by SHA-256 during guided bootstrap. Optional toolchains: Python,
Android/JVM (OpenJDK 17 + Gradle), C/C++, PHP.

### 4.5 Documented limitations (from repo README, believed and retained)

- **PRoot is not a virtualization boundary or hardened security jail** — only run trusted projects.
- Docker, KVM, systemd, nested emulators unsupported under PRoot.
- "The terminal uses a process bridge instead of a complete PTY emulator, meaning ncurses apps
  may render incorrectly."
- No root required; the user must grant battery-optimization exemption for heavy workloads.

### 4.6 Critical absence

**Repository B has no remote-control capability whatsoever.** `network/` contains only
`GitHubClient` and `ProviderApiClient` (outbound HTTP). There is no server, no discovery, no
pairing, no protocol, no iOS story. The Universal Protocol, pairing, identity model, and the
entire iOS client are **net-new work** (see [REUSE-MAP.md](REUSE-MAP.md)).

---

## 5. Cross-repository findings that shape the architecture

1. **The harness integration seam is `dsh --profile sdk` JSON-RPC over stdio**, and it is
   *proven* by an independent shipping implementation (repo B driving dsh on Android).
   Upstream documents the SDK participant's live-event semantics; durable replay comes from
   `session/event` logs.
2. **Cancelling a task has no durable settlement upstream.** Our execution node must own task
   state: cancel = SIGTERM (bounded, exit 0 per §2.4) → force kill → node records outcome.
   ([ADR-005](adr/ADR-005-node-authoritative-state.md).)
3. **Session-format versioning lives in upstream code only** (`SESSION_FORMAT_VERSION`), with
   finalized v4 / released v3 at audit time. Our migration layer must detect unsupported
   versions and fail safe rather than corrupt logs. The immutable `SessionHeader` (with `cwd`)
   is the portable-path anchor — matched by repo A's independent implementation.
4. **Zstd session logs are checksummed frame concatenations**; rewriting requires recompression
   while preserving trailing frames — repo A demonstrates this is feasible.
5. **No-symlink constraint** is real and twofold: USB filesystems (exFAT) and PRoot's
   `link2symlink` extension exist precisely to fake symlinks inside Android's private storage.
   Portable paths must avoid symlinks; the Android node's internal workspace may use PRoot's
   emulation but must never assume the USB shares it.
6. **Licensing is asymmetric**: repo A is unlicensed (reference-only), repos B and C are MIT
   (adaptable/bundleable with notices).
7. **Upstream is a fast-moving pre-1.0 project** — pinning, integrity verification, and
   schema-drift detection are first-class requirements, not nice-to-haves.

---

## 6. Discrepancies (current source authoritative over earlier observation)

| # | Subject | Earlier observation | Current source | Resolution |
|---|---|---|---|---|
| 1 | dsh npm description | registry metadata: "profile boot, plugin management, and the browser UI alias" | `apps/cli/package.json` (master): "profile launch, plugin management, and configuration inspection" | Registry metadata lags master; treat repo source as authoritative for current behavior |
| 2 | dsh version | DSH-Portable pins 0.1.7-rc.2 (`next` channel) | npm `next` = 0.2.0-rc.2; dist-tags latest=next=0.2.0-rc.2, alpha=0.1.7-alpha.2 | Version drift between wrapper and upstream; our update layer must handle both pinning and drift |
| 3 | Mobile-Harness identity | New-project speculation that it wraps "DeepSeek Harness on Android" | Source: primarily Claude Code on Android; **dsh is an on-demand second driver** (`DshRuntimeBridge`); description says "Claude Code on Android" | Android node is multi-agent; dsh is one (our default) driver |
| 4 | Repo A completeness | README implies an elaborate portable system | Tree is 21 files; migration logic exists but backup coverage is partial (session logs only), no remote/conflict/import-export features | Scope of reimplementation is launcher + runtime + migration + doctor; everything else is new |
| 5 | `third_party/proot`, `third_party/libandroid-shmem` | Assumed to be vendored source dirs | GitHub contents API lists both as **gitlinks (submodules)**; only `talloc` is an in-tree vendored dir | Android import must initialize submodules at a pinned commit |
| 6 | Automated license check | "check licenses" treated as one task | Repo A has **no license at all**; repo B's *vendored* deps (proot/talloc/libandroid-shmem/rootfs images) have their own licenses, not the parent repo's MIT | THIRD_PARTY_NOTICES.md records each vendored license **individually at import time** |

---

## 7. What could not be verified from source alone

Recorded honestly rather than papered over; all are tracked in
[RISK-REGISTER.md](RISK-REGISTER.md):

- **dsh running inside Android's PRoot environment** — never exercised on a real ARM64 device
  by this audit (Windows host). Plausible, since repo B ships Claude Code there and dsh is an
  on-demand driver in the same codebase, but **not validated**. Real-device smoke test is a
  Phase 1 gate.
- **Full text of large files** that exceeded fetch limits: `portable.sh`, `portable.mjs`,
  repo A README; Mobile-Harness `RuntimeBridge.kt` (interface fully summarized via API),
  `app/build.gradle.kts` (AGP/Kotlin/Compose versions known from root build file and README).
  These gaps do not affect any decision above; implementation-time re-verification is noted in
  REUSE-MAP.md.
- **Exact exit codes / error JSON-RPC surfaces of the SDK profile** beyond SIGTERM=0 /
  SIGINT=130 — to be pinned from a live smoke test in Phase 1 and recorded in PROTOCOL.md.
- **Vendored license texts** for proot / talloc / libandroid-shmem / Ubuntu rootfs — must be
  read verbatim at Phase 3 import and recorded in THIRD_PARTY_NOTICES.md.
