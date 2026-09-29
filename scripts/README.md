# scripts

Build, packaging, and release helper scripts.

## Planned (Phase 1+)

- `build-desktop.mjs` — assemble the portable distribution per platform (entry shims + bundled
  core + manifest; runtimes installed lazily at setup time, so the base package stays small).
- `verify-licenses.mjs` — compare vendored trees and dependencies against
  [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) records; fail on unrecorded components
  (R-08).
- `publish-release.mjs` — produce release artifacts with checksums and regenerate notices.
- `diagnose-ci.mjs` — CI-facing quick doctor (subset checks).

## Convention

Scripts must run on the **bundled portable Node** (no global pnpm/npm requirement for
consumers) and never write outside an explicitly provided root.
