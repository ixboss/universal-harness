# ADR-011: Workspace bundles — a directory format with verify-then-commit import

**Status:** Accepted — 2026-10-16
**Date:** 2026-10-16
**Implements:** ROADMAP Phase 5 (cross-platform synchronization), stages S2–S3

## Context

Phase 5's requirement is **portable transfer** of a workspace between machines: a user moves
their Universal Harness tree (or its metadata) to another host and expects projects, sessions,
configuration and workspace identity to arrive intact, with no cloud and no account
(ADR-006).

Two design questions had to be answered: *what shape is a bundle*, and *how is an untrusted
bundle imported safely*.

A prior audit of the repository found that no export/import existed at all, that the
`sync.workspace`/`backup.create` capability names were enum-only with no request schema, and
that the one shared invariant the docs claimed (a "no-symlink mode") did not exist in code.

## Decision

### 1. A bundle is a **directory**, not an archive

```
<name>.uhbundle/
├── manifest.json
└── data/
    ├── workspace/.workspace.json
    ├── workspace/registry.json
    ├── config/config.json
    ├── sessions/index.json
    ├── migration/<uuid>.json
    └── projects/<id>/.uh-project.json     (markers only, by default)
        projects/<id>/**                   (only with --include-projects)
```

A directory removes the single highest-risk component of the alternative design — a custom
extractor that must be hardened against zip-slip, symlink escape, decompression bombs and
malformed central directories. The bundle is read by ordinary file APIs under the same
canonicalisation rules the rest of the codebase already enforces.

### 2. The manifest is versioned and self-describing

`manifest.json` carries `bundleVersion` (integer major), `kind`
(`universal-harness.workspace-bundle`), `createdAt`, `producer` (platform/arch/version),
`source` (workspace id; **`recordedRoot` is always `null`**), `options`, `excludes`, `entries`
(each with `path`, `sha256`, `bytes`) and `entriesChecksum` — the SHA-256 of the canonical
entries list, reusing the exact pattern already proven in `core/backup/mod.mjs`.

A **newer major version is refused** (`BUNDLE_VERSION_UNSUPPORTED`), never guessed at. Additive
fields are tolerated so an older reader can still consume a newer minor change.

### 3. Import is **verify-then-commit** and **never overwrites**

1. The manifest is read and validated (kind, version, entry limits, checksum).
2. **Every** entry path is validated against an **allowlist** — only the paths a bundle is
   allowed to carry may appear. Device-local state, secrets, logs, regenerable runtime, the
   node-owned event log and nested backups are refused even if the manifest claims them.
3. Every entry's SHA-256 is verified, and the bundle tree must contain **exactly** the listed
   files — an unlisted file is a refusal, so a bundle cannot smuggle content.
4. Only then are files written, each with a same-directory `temp + fsync + rename`.
5. A target file that already exists with **different** content aborts the **entire** import
   with `IMPORT_CONFLICT` and a per-file report. There is **no `--force`**: recovery is an
   explicit user action (rename or remove the target, then re-run). A target that is already
   byte-identical (with `recordedRoot` normalised out) is skipped, so re-importing is
   idempotent.

### 4. An absolute path never travels

The exported `registry.json` has `recordedRoot` neutralised to `null`; on import the receiving
machine re-derives it to its own root. The absolute source path therefore cannot leak into a
bundle, and a bundle cannot pin a workspace to a path that does not exist on the target.

### 5. Export and import hold the advisory workspace lock

Both operations take the advisory lock (`core/portable/lock.mjs`, `data/state/locks/`), so two
Universal Harness commands never mutate one workspace at once. This gives the long-dead
`WORKSPACE_LOCKED` condition its first real implementation.

## Consequences

- **No new protocol operation.** `sync.workspace` over the wire is *not* added: the requirement
  is portable transfer, which a local bundle satisfies. Adding a wire operation would require a
  request schema, advertisement, conflict negotiation and node-side locking — a synchronization
  protocol the requirements do not demonstrate a need for. The enum values stay (removing them
  would be a breaking v1 schema change).
- **The no-symlink invariant is now real for bundles**: export refuses to emit a symlink and
  import refuses to accept one. This is the first time the documented invariant is enforced in
  code, mirroring the Android `SafeTarExtractor` precedent.
- **R-04 (exFAT/case-sensitivity matrix) moves from Open to Mitigating**, not Closed: the
  invariant and the collision checks are implemented and tested on NTFS, but a real exFAT device
  is still required to close it honestly.
- **S4 (the Android leg) remains outstanding** — it requires a physical device and is not
  claimed here.
- **No session content is ever rewritten** (R-20/R-14 unchanged); a bundle carries UH metadata
  only.

## Alternatives considered

1. **A zip/tar archive.** Rejected: it requires a hardened extractor (zip-slip, symlink escape,
   bombs) — the highest-risk code in the feature — for no benefit a directory does not provide.
2. **A live device-to-device sync protocol.** Rejected for Phase 5: the requirement is transfer,
   not concurrent replication; a sync protocol needs conflict resolution semantics that are out
   of scope and unverifiable on this host.
3. **SAF / document-picker transfer on Android.** Deferred: the Android node reaches the bundle
   through the guest Node, mirroring the existing `uh pair` invocation. SAF is a later stage.
4. **`--force` on import.** Rejected deliberately. A silent overwrite is exactly the failure
   mode the conflict policy exists to prevent; recovery is an explicit user action.

## Risks

- **Hostile-bundle parsing is the highest-risk code in the feature** — mitigated by the
  allowlist, strict canonicalisation, symlink rejection, duplicate/Unicode/case collision
  rejection, reserved-name rejection and explicit resource limits, all covered by tests.
- **Doc-vs-code drift** — this ADR and the Phase 5 ROADMAP entry replace the earlier claims;
  `core/portable/README.md` and `ARCHITECTURE.md` are aligned to what is implemented.
