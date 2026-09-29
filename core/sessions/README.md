# core/sessions

Session discovery, replay, and the UH session index (brief §7). **Reads only** — dsh owns dsh
session internals.

- Decodes dsh's persistence under `$DSH_HOME/sessions/<mangled-workspace>/<id>/`: plain `.jsonl`
  and concatenated Zstd frames (`session.v4.jsonl.zstd`), including the immutable
  `SessionHeader` (`version`, `id`, `createdAt`, `cwd`, `isSeeded`).
- `summarizeSession()` — open turns vs. completed turns.
- `createSessionIndex()` — the only UH-authored session artifact: `data/sessions/index.json`
  with lineage (`priorSessionId`), implementing reopen as durable-read + linked continuation
  (R-20).

## Status

Phase 1 — **implemented + automated-tested** (5 tests; replay of a real dsh log is also proven in
smoke stages 14–15).
