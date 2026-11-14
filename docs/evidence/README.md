# Evidence

Redacted transcripts of real-platform verification runs, committed so the
claims in [COMPATIBILITY.md](../COMPATIBILITY.md) and
[TESTING.md](../TESTING.md) are checkable from the repository itself. The
working copies live under `/diagnostics/`, which is gitignored at rest.

LAN addresses are redacted (`<lan-ip-redacted>`); device and node ids are
pseudonymous and retained as-is. Pairing tokens and key material never appear
in these transcripts.

| File | Run |
|---|---|
| `gatef-state.json.evidence.txt` | Phase 3C controller gate, Windows desktop node (2026-10-11) |
| `gatef-device-evidence.txt` | Phase 3C controller gate, physical Android node over Wi-Fi (2026-10-11) |
| `uh-connect-e2e.evidence.txt` | Live `uh connect` controller CLI end-to-end (2026-10-11) |
