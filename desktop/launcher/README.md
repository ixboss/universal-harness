# desktop/launcher

The desktop launcher — the user-facing entry point. Users should never need to understand the
runtime. CLI power is preserved alongside any future GUI launcher (ADR-008, ARCHITECTURE.md §3).

## Commands (conceptual)

| Command | Purpose |
|---|---|
| `UniversalHarness` | First-run setup (if needed) then the default experience (harness web UI) |
| `UniversalHarness setup` | Install/refresh runtime + harness + first-run config |
| `UniversalHarness doctor` | Diagnostics report + actionable repair commands |
| `UniversalHarness update` | Channel-scoped staged update; `--rollback <channel>` |
| `UniversalHarness reset` | Remove mutable data (preserves `models/` + projects after confirm) |
| `UniversalHarness pair` | Render short-lived QR pairing payload |
| `UniversalHarness serve` | Start the execution-node server (protocol) |
| `UniversalHarness -- <args>` | Passthrough: raw `dsh` arguments |

Flags: `--root <path>` (override portable root), `--target <platform>` (cross-platform
operations such as migration dry-runs), `--no-open` (suppress browser launch).

## Platform entries

- `desktop/windows/` — `UniversalHarness.bat` (shim → PowerShell bootstrap)
- `desktop/linux/` — `UniversalHarness` (shim → POSIX bootstrap)
- `desktop/macos/` — `UniversalHarness.command`

Each entry is intentionally tiny: detect root (script-relative), exec the launcher, forward
arguments and exit code.

## Status

Phase 0 — skeleton. Implementation is Phase 1.
