# third_party

Vendored third-party components, each **with its own LICENSE file in-tree** (mirrored into
`third_party-licenses/` in the portable distribution).

## Contents (Phase 3 import)

| Path | Origin | License record |
|---|---|---|
| `proot/` | Mobile-Harness submodule — termux PRoot fork, `VERSION 5.1.107.91` per audited CMakeLists | read at import; record in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) |
| `libandroid-shmem/` | Mobile-Harness submodule | read at import; record |
| `talloc/` | Mobile-Harness vendored dir (API 2.4.3) | read at import; record |
| `ubuntu-rootfs/` (or bundle URL metadata) | Ubuntu 20.04 arm64 | distribution terms recorded at bundle time |

## Rules

1. **Pin and record** — submodules pinned to exact commits; license texts read **verbatim** and
   recorded before any distribution (the parent repo's MIT does not cover these — AUDIT.md §6).
2. **Never strip** license files, copyright headers, or attribution.
3. **Modifications must be documented** with a diff rationale in THIRD_PARTY_NOTICES.md.
4. Node.js and the dsh npm package are **not** vendored here (downloaded at setup with
   integrity verification) — their licenses ship in the distribution's notices file.

## Status

Phase 0 — empty placeholder; no vendored trees exist yet.
