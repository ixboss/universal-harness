# Android Runtime — Phase 3A foundation

What Phase 3A actually implements, how to build it, and what is verified. The honesty rules of
[this repository](COMPATIBILITY.md) apply: a Gradle build is not a device verification, and
**R-01 remains unresolved** until the real-device gate below passes.

## What Phase 3A delivers

All new code lives in the `com.universalharness.node` package
(`android/app/src/main/java/com/universalharness/node/`), kept strictly separate from the
imported Mobile-Harness sources (`com.jarves.mh.*`, pinned snapshot — see
[android/PROVENANCE.md](../android/PROVENANCE.md)):

| Piece | File(s) | Role |
|---|---|---|
| Runtime pins | `UhPins.kt` | Pinned Ubuntu 20.04.5 arm64 base, Node v24.21.0 linux-arm64, dsh 0.2.0-rc.2, each with official checksums (cdimage `SHA256SUMS`, nodejs.org `SHASUMS256.txt`, npm sha512 — mirrors `manifests/runtime.manifest.json`) |
| Verified acquisition | `UhIo.kt` | Streaming SHA-256; download-to-`.part` + hash-verify + atomic rename (a partial download can never masquerade as complete; a good prior copy is reused) |
| Safe extraction | `SafeTarExtractor.kt` | tar.gz extraction with traversal/absolute/NUL rejection, contained-relative-symlink policy, hard-link rejection, executable-bit preservation |
| Install state | `InstallStateStore.kt` | Per-stage durable records (temp+rename). A stage counts as done only while its recorded pin still matches; corrupt state reads as "nothing done" |
| Installer | `UhRuntimeInstaller.kt` | Stages: `rootfs` → `node` → `bootstrap` (guest DNS + `apt-get install ca-certificates`) → `dsh` (guest `npm install -g --exact @deepseek-ai/dsh@0.2.0-rc.2`) → `verify` (`uname -m` == `aarch64`, `node -v` == `v24.21.0`, `dsh --version` contains `0.2.0-rc.2`, all executed inside PRoot) |
| PRoot command | `UhPRootCommand.kt` | Builds the carrier-executed `libproot.so` invocation (same audited argv/env shape as Mobile-Harness's `RuntimeInstaller.process()`; `--link2symlink` OFF for dsh — its atomic temp-file renames break under PRoot hard-link emulation) |
| Native spawn | `uh_spawn.c` + `UhNativeProcess.kt` | New JNI bridge (`libuhspawn.so`): fork/execve with **three separate stdio pipes**, child process group (`setpgid` in child and parent), group-first signal, `PR_SET_PDEATHSIG` so the guest cannot outlive the app, `PR_SET_DUMPABLE` so PRoot may ptrace. Separate stderr is why this exists — pocketspawn merges stdout+stderr, which would corrupt the NDJSON seam |
| dsh SDK client | `DshSdkClient.kt`, `DshSdkProtocol.kt` | NDJSON framer (bounded per-line buffer, non-JSON lines tolerated like the desktop adapter), JSON-RPC `initialize`/`session/prompt`/`shutdown`, per-request correlation and timeouts, bounded teardown `shutdown(15s) → SIGTERM(10s) → SIGKILL(5s)`, cancellation without the graceful step, error propagation as `DshSdkException` |
| Restart reconciliation | `RuntimeReconciler.kt` | A session recorded `running` is rewritten to `reconciled-after-restart` at app start (ADR-005 supervisor rule: a dead process is never reported running; Android also kills the guest via `PR_SET_PDEATHSIG`) |
| Keystore foundation | `KeystoreCipher.kt` | AndroidKeyStore AES-256-GCM key ("uh_node_master"), `encrypt/decrypt` with random IV — the device-bound foundation for the future node identity/pairing secrets; no key material in files |
| Gate D checks | `UhRuntimeChecks.kt`, `UhNode.kt` | Callable check functions returning actual evidence (command output), used by the instrumented device test |

## How to build (Windows host)

Requirements: JDK 17 (Gradle 8.14 cannot run on newer JVMs), Android SDK with
`platforms;android-36`, `build-tools`, CMake 3.22.1, and an NDK (upstream pins
26.1.10909125; NDK 28.2.13676358 works and is selectable via `-PmhNdkVersion`).

```bash
cd android
export JAVA_HOME="<path to JDK 17>"        # e.g. Android Studio's jbr is too new (Java 25)
./gradlew :app:assembleDebug -PmhNdkVersion=28.2.13676358      # debug APKs (online + offline flavors)
./gradlew :app:assembleOnlineRelease -PmhNdkVersion=28.2.13676358   # unsigned release APK
./gradlew :app:testOnlineDebugUnitTest -PmhNdkVersion=28.2.13676358 # JVM unit tests (102)
./gradlew :app:assembleOnlineDebugAndroidTest -PmhNdkVersion=28.2.13676358  # instrumented test APK
```

Outputs: `app/build/outputs/apk/{online,offline}/debug/app-*-debug.apk` — **arm64-v8a only**
(upstream CMake guard), packaging `libproot.so`/`libprootloader.so` (the carrier-executed PRoot
binaries), `libtalloc.so`, `libandroid-shmem.so`, `libpocketspawn.so`, and the new
`libuhspawn.so`.

The upstream offline-flavor asset tasks are guarded (`onlyIf`) because Mobile-Harness's own
release bundles are not part of this repository; Universal Harness builds its runtime on-device
instead (see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for the recorded adaptations).

## How the runtime is installed and verified

`UhRuntimeInstaller.installAll()` on a device: downloads both pinned archives (skipped when a
hash-verified copy already exists), extracts the rootfs into a staging directory and swaps it
into place only after full extraction, bootstraps guest DNS + CA certificates, installs the
exact dsh pin with the guest npm, then runs the in-guest verification (`uname -m`, `node -v`,
`dsh --version`). Every stage writes its pin into `uh-state/install-state.json` atomically;
interruption at any point leaves the stage undone and re-runnable. **The real-device execution
of these stages has not happened yet** — Gate D is blocked on device availability (below).

## How to run the ARM64 runtime checks (Gate D)

With a real arm64 device connected (USB debugging):

```bash
cd android
./gradlew :app:installOnlineDebug -PmhNdkVersion=28.2.13676358
./gradlew :app:connectedOnlineDebugAndroidTest -PmhNdkVersion=28.2.13676358
```

`UhGateDInstrumentedTest` then checks: restart reconciliation, the packaged PRoot carrier,
`uname -m` == aarch64, `node -v` == v24.21.0, `dsh --version` containing 0.2.0-rc.2 — each
recording actual output. The JSON-RPC initialize round trip runs through `UhRuntimeChecks`
(`sdk-initialize`), driven the same way. Capture `adb logcat` output as evidence.

## Current verification status (honest)

| Gate | Status | Evidence |
|---|---|---|
| A — repository integrity | **Pass** | JS suite 121/121, lint-schemas 0 problems, validate-repo 0 problems; no secrets; dsh untouched |
| B — Android build | **Pass (host)** | Gradle debug + unsigned release + androidTest APK build; 102/102 JVM unit tests (incl. the full imported Mobile-Harness suite); arm64-v8a-only native packaging verified by APK inspection |
| C — runtime installation | **Implemented, not executed** | Stage machine + verifier implemented and unit-tested; no device has run the downloads/extraction |
| D — actual ARM64 execution | **BLOCKED — no ARM64 Android device available** | `adb devices` shows none; no AVD exists and the emulator is x86_64 while the APK is arm64-only. This is the R-01 gate; a build passing is NOT execution evidence |
| E — provider prompt test | **Not attempted** | Requires Gate D first and a funded dsh credential (separately blocked by the provider account, as on desktop) |

**R-01 remains UNRESOLVED.** What Phase 3A changed: every known source-level blocker has an
implementation and an automated test on the host side (pinned acquisition, safe extraction,
separate-stdio process management, bounded teardown, restart reconciliation), so the remaining
risk is concentrated in genuinely device-only behavior (PRoot syscall behavior on the specific
kernel, glibc/Node execution under ptrace, signal delivery, storage performance).

## Remaining risks and limitations

- PRoot ptrace overhead and kernel-specific syscall gaps are unmeasured on-device.
- The guest bootstrap needs device network access for apt/npm (one-time); offline install
  would require a prebuilt runtime bundle (a later concern).
- Mobile-Harness's own UI/agents remain imported but unused; trimming them is deliberately
  deferred to avoid unnecessary upstream churn.
- Node/npm downloads are not yet mirrored into an offline bundle; the pins live in code and in
  `manifests/runtime.manifest.json`.
