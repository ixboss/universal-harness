# core/diagnostics

Machine-readable doctor/diagnostics (ARCHITECTURE.md §9).

## Diagnostic record

Each check carries: `id`, `severity` (`ok` / `warn` / `fail`), `component`, `condition`,
`evidence`, `recommendedAction`, `autoRepairSafe` — serialized per
[shared/protocol/v1/operations.schema.json](../../shared/protocol/v1/operations.schema.json)
(`DiagnosticRecord`).

## Check components

OS · architecture · filesystem + compatibility (exFAT/no-symlink) · available storage ·
portable root · runtime presence + integrity · harness installation · runtime integrity ·
permissions · workspace registry · sessions (schema-version validity) · credentials ·
configuration · network · API configuration · remote-control server · pairing state ·
Android runtime state (on Android) · update state.

## Scope

- Run harness: full check suite; subset selection per component.
- Repair actions: only those marked `autoRepairSafe`; everything else is an explicit command
  with rationale (e.g. "Run Repair Runtime" copy per ARCHITECTURE §18).
- Redaction: secrets never appear in `condition` or `evidence` (ADR-007).
- Output adapters: CLI table, JSON, protocol `diagnostics.run` operation.

## Status

Phase 1 — **implemented** (`mod.mjs`): 6 doctor check groups, live launch/initialize/shutdown probe, Expected/Actual/Action FAIL format, plaintext-secret scan, JSON report writer. **Automated-tested** (`tests/process.test.mjs` startup-failure, smoke chain).
