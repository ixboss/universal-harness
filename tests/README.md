# tests

Cross-platform test suite root. The strategy and matrix are
[docs/TESTING.md](../docs/TESTING.md); per-platform verification status is in
[docs/COMPATIBILITY.md](../docs/COMPATIBILITY.md).

## Layout (as delivered in Phase 1)

```
tests/
├── runtime.test.mjs      runtime manifest/status: present, version, arch, integrity,
│                         hash mismatch, corrupted manifest, tree-hash determinism
├── workspace.test.mjs    workspace identity marker, registry, move detection, conflicts
├── sessions.test.mjs     dsh session discovery (JSONL + Zstd), replay, UH index lineage
├── process.test.mjs      adapter lifecycle: launch/init/prompt/shutdown/timeout/abnormal
│                         exit/orphan/malformed stdout/unverified-refused
├── security.test.mjs     redaction, logger, env summary, DPAPI round trip, config plaintext
├── migration.test.mjs    move detection, apply + backup, conflict, rollback safety
├── protocol/
│   ├── lint-schemas.mjs  $ref resolution + EventKind→DurabilityClass mapping (7 files,
│   │                     62 refs, 0 problems)
│   └── validate-repo.mjs repository validation: no secrets, no junk, structure invariants
├── helpers.mjs           temp-root builder with a fake pinned runtime + fake dsh package
└── fixtures/
    └── fake-dsh.mjs      stub speaking the real SDK wire protocol, with deterministic
                          failure modes selected by UH_FAKE_MODE
```

Run everything with the bundled (or system) Node:

```
node --test tests/*.test.mjs
node tests/protocol/lint-schemas.mjs
node tests/protocol/validate-repo.mjs
```

Phase 1 result: **41/41 pass**, no third-party test dependencies — `node:test` only, so the
suite runs on the bundled Node without any install step.

## Why the fake dsh stub exists

Process-lifecycle behavior (crash, hang, credential refusal, malformed stdout) must be
deterministic and offline. `fixtures/fake-dsh.mjs` speaks exactly the observed real wire
protocol (`initialize` / `session/prompt` / `shutdown` + `session.event` / `session.status`
notifications) and fails on cue via `UH_FAKE_MODE`. The real pinned dsh is exercised by the
`uh smoke` full chain (TESTING.md §1a) instead — the stub never substitutes for real-platform
verification.

## Later phases

- `android/` — instrumented tests; gated by the R-01 real-device smoke test (Phase 3)
- `ios/` — client tests, macOS-host only (Phase 4; not testable on this host, R-10)
- `e2e/` — realistic workflows A–F from the brief (Phase 6)

## Standing rules

- A feature is not done because it compiles — suites cover the matrix or the feature stays
  marked TBD in [docs/COMPATIBILITY.md](../docs/COMPATIBILITY.md).
- Anything untestable on this host is categorized "not yet testable" in TESTING.md, not
  silently skipped.
- A failing test that leaves a child process alive is a bug in the test, not just a failure:
  the adapter exposes `close()` for last-resort teardown so a broken run can never hang the
  runner.
