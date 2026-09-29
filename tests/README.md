# tests

Cross-platform test suite root. Per-phase suites land here; the strategy and matrix are
[docs/TESTING.md](../docs/TESTING.md).

## Planned layout

```
tests/
├── desktop/        # portable core: launcher, runtime, migration, doctor, update (Phase 1)
├── protocol/       # schema conformance + fixture suite for all three stacks (Phase 2)
├── android/        # instrumented tests; gated by R-01 real-device smoke test (Phase 3)
├── ios/            # client tests, macOS-host only (Phase 4; Not tested on this host, R-10)
├── e2e/            # realistic workflows A–F from the brief (Phase 6)
└── fixtures/       # migration fixtures: migrated session bundles across platforms
```

## Available now (Phase 0)

- `protocol/lint-schemas.mjs` — validates that every `$ref` across the JSON Schema contract
  resolves (`node tests/protocol/lint-schemas.mjs` → 7 files, 36 refs, 0 problems). Not
  product code: it lints the Phase 0 contract itself, consistent with gate item 29.

## Standing rules

- A feature is not done because it compiles — suites cover the matrix or the feature stays
  marked TBD in [COMPATIBILITY.md](../docs/COMPATIBILITY.md).
- Anything untestable on this host is categorized "not yet testable" in TESTING.md, not
  silently skipped.
