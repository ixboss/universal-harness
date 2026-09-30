# core/runtime

The deterministic, auditable manifest system (brief §§3–4) answering *which exact Node and dsh
am I executing?*

- `manifest.mjs` — loads and validates `manifests/runtime.manifest.json`: schema version, every
  supported target, hex-64 SHA-256 over an `https` URL, and the `@deepseek-ai/*` package pin
  with its integrity. Malformed manifests are refused, never guessed.
- `mod.mjs` — `status()` (node/dsh present, version, integrity; whole-tree hash vs. the install
  record so tampering after install is detectable), `requireRuntime()` (throws the first failed
  check with an actionable error — the gate the adapter consults before spawn).
- `setup.mjs` — streaming download → verify-**before**-unpack → extract (bsdtar via System32 on
  Windows; GNU tar cannot read Node's zips) → exact-pin dsh install through the bundled npm.

## Status

Phase 1 — **implemented + automated-tested** (9 tests). The win-x64 setup chain is also proven on
a real Windows host (smoke stages 01–05).
