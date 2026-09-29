# bin

Launcher entry points. Both shims resolve the portable root relative to their own location and
exec the **bundled** Node — never a system Node — on `uh.mjs`.

- `UniversalHarness.cmd` — Windows. Resolves `%~dp0` and runs the bundled `node.exe`.
- `UniversalHarness.sh` — POSIX (linux/macos). Maps `uname` output to the runtime target
  (`linux`/`darwin`, `arm64`/`x64`) and runs the matching bundled `node`.
- `uh.mjs` — the CLI itself (commands implemented in `core/cli`).

If the runtime is not yet installed, the shims still work as long as *some* node can bootstrap
`uh setup` (the error message points at setup); after setup, only the bundled node is used.

## Status

Phase 1 — **implemented**. `UniversalHarness.cmd` executed for real on Windows x64 (smoke chain);
`.sh` is coded but **NOT TESTED** on Linux/macOS (no host).
