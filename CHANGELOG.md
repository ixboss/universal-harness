# Changelog

All notable changes to Universal Harness. Format based on
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [Unreleased]

### Added — audit remediation (branch `audit/remediation`, 2026-11-14)

- `task-control` scope documented and warned as implying arbitrary code
  execution as the node user (experiment + docs/THREAT-MODEL.md T-1); `uh pair`
  prints the warning.
- Tasks run inside their project directory (`data/projects/<project>`) with a
  strict environment allowlist instead of the node's full `process.env`.
- CLI adapters reject prompts beginning with `-` (argument injection, audit
  0.2); new `promptMode: "stdin"` config; `UH_CLAUDE_ARGS` / `UH_GEMINI_ARGS`
  are shell-words parsed.
- HTTP/SSE adapters refuse plain-HTTP non-loopback base URLs without explicit
  `allowInsecureRemote: true`; unterminated trailing SSE lines are flushed.
- Node drops connections that do not authenticate within `preAuthTimeoutMs`
  (default 30s) and backs off remote addresses after repeated auth failures.
- Per-session conversation history (bounded) in the omniroute /
  openai-compatible adapters.
- macOS Keychain and Linux libsecret secure-storage backends (UNVERIFIED on
  those platforms; DPAPI verified on Windows incl. apostrophe-path fix).
- Release pipeline: test-gated builds, base64 keystore secret with CI failing
  hard on missing signing, update-manifest sha256/sizeBytes filled and
  enforced on Android release builds, build provenance attestation, CycloneDX
  SBOM, SHA-pinned actions, OS x Node test matrix, dependabot, CodeQL.
- Docs: SECURITY.md, CONTRIBUTING.md, this changelog, docs/THREAT-MODEL.md,
  committed (redacted) evidence transcripts under docs/evidence/.

## [1.0.0] — 2026-11-13

First tagged release. Universal Protocol v1 node server, `uh` CLI, portable
USB/desktop bundles, Android dual-mode app (LAN controller + on-device node),
Multi-Harness adapter registry (DeepSeek/dsh, OmniRoute, any OpenAI-compatible
gateway, Claude Code, Gemini CLI), Ed25519 pairing with TLS pinning, durable
event replay, session/task history, idempotent task submission, workspace
bundles (ADR-011).
