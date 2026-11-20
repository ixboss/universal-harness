# Contributing

## Ground rules

1. **Zero npm runtime dependencies.** The Node runtime (`core/`, `bin/`) is
   pure ESM on Node >= 20. Build/test tooling may be devDependencies only.
2. **Upstream dsh is never modified** (ADR-001). It is pinned exactly in
   `manifests/runtime.manifest.json`; changes land upstream, not here.
3. **Wire protocol v1 and the auth handshake are coordinated surfaces.**
   Changes require an ADR in `docs/adr/` and a matching Kotlin client change
   (`android/app/src/main/java/com/universalharness/node/`). Never silently.
4. **Honesty in verification.** A claim may move to "verified" only via a
   recorded real-platform test outcome (docs/COMPATIBILITY.md). If something
   cannot be verified, write UNVERIFIED — never claim it works.

## Development

```sh
npm test                 # node --test tests/*.test.mjs — must stay green
node scripts/diagnose-ci.mjs   # schema lint + repo validation
```

- Tests run on Node 20/22/24 across Linux/Windows/macOS in CI — keep them
  deterministic and cross-platform (no POSIX-only shell assumptions).
- New behaviour ships with tests; bug fixes with a test that reproduces the
  bug first.
- One logical change per commit; imperative subject line.

## Android

The app lives under `android/` (Gradle, Kotlin, AGP 8.x). Debug builds are
zero-setup; release builds in CI require the upload signing secrets
(see `.github/workflows/release.yml`).

## Security issues

Never open a public issue — see [SECURITY.md](SECURITY.md).
