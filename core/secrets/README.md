# core/secrets

Device-local secure storage (brief §15: *fail explicitly rather than silently storing secrets
insecurely*).

- Windows: DPAPI via a PowerShell child process — the secret is piped over **stdin**, never
  argv; the sealed blob lives under `%LOCALAPPDATA%\UniversalHarness`, outside the portable tree.
- Every other platform: `SECURE_STORAGE_UNAVAILABLE`. macOS Keychain is the planned path.

## Status

Phase 1 — **implemented + automated-tested** on Windows (`tests/security.test.mjs` DPAPI round
trip). Non-Windows failure path covered by the same suite.
