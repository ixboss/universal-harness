# bin

Launcher entry points. Both shims resolve the portable root relative to their own location and
exec the **bundled** Node — never a system Node — on `uh.mjs`.

- `UniversalHarness.cmd` — Windows. Resolves `%~dp0` and runs the bundled `node.exe`.
- `UniversalHarness.sh` — POSIX (linux/macos). Maps `uname` output to the runtime target
  (`linux`/`darwin`, `arm64`/`x64`) and runs the matching bundled `node`.
- `uh.mjs` — the CLI itself (commands implemented in `core/cli`).

If the runtime is not yet installed, both shims exit 11 (`RUNTIME_MISSING`) and print the setup
instruction — they do not fall back to a system node. The *desktop launchers*
(`desktop/windows/UniversalHarness.bat` and friends) do fall back to a PATH node so they can
bootstrap `uh setup` on a fresh tree; after setup, only the bundled node is used.

## Status

Phase 1 — **implemented**. `UniversalHarness.cmd` executed for real on Windows x64 (smoke chain);
`.sh` is coded but **NOT TESTED** on Linux/macOS (no host).
