# core/backup

Backup/restore foundation (brief §1: "backup/restore foundation"). Checksummed manifests (per-file
SHA-256 + overall checksum), `verifyBackup` compares hashes, `restoreBackup` **refuses to clobber
newer live state** unless forced. Used by migration before any rewrite.

## Status

Phase 1 — **implemented + automated-tested** (`tests/migration.test.mjs`).
