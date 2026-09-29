# core/platform

Platform/architecture detection and the supported runtime target table.

- `PLATFORM` (`win` | `macos` | `linux`), `ARCH` (`x64` | `arm64`), derived `RUNTIME_TARGET`
  (`win-x64` | `linux-x64` | `macos-arm64`).
- `SUPPORTED_TARGETS` — the manifest must carry a pinned entry for every target so a drive
  prepared on one OS is verifiable on another.
- `deviceStateDir()` — the device-local state root (`%LOCALAPPDATA%\UniversalHarness` on
  Windows); secrets live here, never in the portable tree.
- `npmCliRelPath` — the npm CLI location inside a stock Node distribution (**platform-specific**:
  the Windows zip ships npm under `node_modules/npm/`, POSIX under `lib/node_modules/npm/`).

## Status

Phase 1 — **implemented**, exercised on win-x64 (real chain + automated tests). Linux/macOS
paths are coded but **NOT TESTED** (no host).
