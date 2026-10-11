# tests

Cross-platform test suite root. The strategy and matrix are
[docs/TESTING.md](../docs/TESTING.md); per-platform verification status is in
[docs/COMPATIBILITY.md](../docs/COMPATIBILITY.md).

## Layout (current — through Phase 3C)

```
tests/
├── runtime.test.mjs        runtime manifest/status: present, version, arch, integrity,
│                           hash mismatch, corrupted manifest, tree-hash determinism
├── workspace.test.mjs      workspace identity marker, registry, move detection, conflicts
├── sessions.test.mjs       dsh session discovery (JSONL + Zstd), replay, UH index lineage
├── process.test.mjs        adapter lifecycle: launch/init/prompt/shutdown/timeout/abnormal
│                           exit/orphan/malformed stdout/unverified-refused
├── security.test.mjs       redaction, logger, env summary, DPAPI round trip, config plaintext
├── migration.test.mjs      move detection, apply + backup, conflict, rollback safety
├── transport.test.mjs      Phase 2 transport contract (memory/stdio)
├── protocol-core.test.mjs  Phase 2 protocol envelopes/events/operations vs the JSON Schemas
├── server.test.mjs         Phase 2 node server end-to-end over a transport
├── auth.test.mjs           identity, pairing, challenge-response, scopes, revocation
├── net-transport.test.mjs  Phase 3B TLS listener, ALPN framing, one-shot HTTP, pairing
├── client.test.mjs         Phase 3C UniversalClient: pinning, pairing, auth, capabilities
├── session-ops.test.mjs    Phase 3C session create/list/read/resume (linked continuation)
├── task-history.test.mjs   Phase 3C cursor-paginated task history, stale-cursor reporting
├── idempotency.test.mjs    Phase 3C clientRequestId replay + semantic CONFLICT
├── connection-limits.test.mjs  Phase 3C maxConnections + idle timeout
├── diagnostics-op.test.mjs Phase 3C real diagnostics.run operation
├── protocol/
│   ├── lint-schemas.mjs    $ref resolution + EventKind→DurabilityClass mapping
│   │                       (7 files, 104 refs, 0 problems)
│   └── validate-repo.mjs   repository validation: no secrets, no junk, structure invariants
├── helpers.mjs             temp-root builder with a fake pinned runtime + fake dsh package
├── fixtures/               fake dsh stub, wire/net/smoke-node helpers for the suites
└── manual/                 hardware-in-the-loop scripts (NOT run by `npm test`) —
                            gate-e-host.mjs (Phase 3B device), gate-f-controller.mjs (Phase 3C)
```

Run everything with the bundled (or system) Node:

```
node --test tests/*.test.mjs
node tests/protocol/lint-schemas.mjs
node tests/protocol/validate-repo.mjs
```

Current result (2026-10-11, this host): **187 tests, 187 pass, 0 fail** (`node --test`,
exit 0, ~35s); schema lint **7 files, 104 refs, 0 problems**; repository validation **0
problems**. No third-party test dependencies — `node:test` only, so the suite runs on the
bundled Node without any install step.

## Why the fake dsh stub exists

Process-lifecycle behavior (crash, hang, credential refusal, malformed stdout) must be
deterministic and offline. `fixtures/fake-dsh.mjs` speaks exactly the observed real wire
protocol (`initialize` / `session/prompt` / `shutdown` + `session.event` / `session.status`
notifications) and fails on cue via `UH_FAKE_MODE`. The real pinned dsh is exercised by the
`uh smoke` full chain (TESTING.md §1a) instead — the stub never substitutes for real-platform
verification.

## Manual (hardware-in-the-loop) scripts

`tests/manual/` is not part of `npm test`. `gate-e-host.mjs` is the Phase 3B workstation half of
the device matrix; `gate-f-controller.mjs` is the Phase 3C controller gate (real UniversalClient
controllers against a live node). See [tests/manual/README.md](manual/README.md). The Phase 3C
gate was executed against a Windows desktop node (28/28); it was **not** run against the physical
Android device in this pass.

## Later phases

- `android/` — instrumented tests (Gate D/E); the Phase 3C device gate (Gate F) is pending a
  connected device
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
