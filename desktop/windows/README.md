# desktop/windows

Windows x64 execution-node entry points and platform specifics.

## Scope (planned)

- `UniversalHarness.bat` — entry shim (batch → PowerShell bootstrap, `ExecutionPolicy Bypass`,
  no profile — mirrors the proven entry pattern without copying expression, AUDIT §3.2).
- Bootstrap: script-relative root resolution, arch detection (x64), runtime activation.
- Windows-specific behavior: drive letters in path migration, NTFS/exFAT handling, console
  encoding (UTF-8), long-path awareness, exit-code propagation.
- No registry entries, no system PATH changes, no system runtime dependency.

## Status

Phase 0 — skeleton. Implementation is Phase 1. Target: Windows x64 (ARM64 unsupported).
