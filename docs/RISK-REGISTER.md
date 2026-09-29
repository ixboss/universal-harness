# Risk Register

**Phase 0 deliverable.** Per the brief §34: likelihood / impact / mitigation / validation
method / fallback for every major risk. **Unresolved risks are listed, not hidden.** Statuses:
`Open`, `Mitigating`, `Unresolved` (cannot be closed without evidence we do not yet have).

| ID | Risk | Likelihood | Impact | Mitigation | Validation | Fallback | Status |
|---|---|---|---|---|---|---|---|
| R-01 | **dsh does not run inside Android's PRoot environment** (native deps, signals, fs quirks, arm64 node) | Medium | Critical | Multi-stage gating before commit; rootfs/kernel compat detection; pin exact arm64 Node + dsh versions; audit Mobile-Harness's `DshRuntimeBridge` (proven for a sibling CLI) | **Real ARM64 device smoke test**: Node → dsh → prompt → stream event → shutdown. Required Phase 1 gate | Ship Android node as *remote-capable client + optional* execution; or ship Claude Code driver (repo B's proven path) as interim | **Unresolved** |
| R-02 | Upstream `dsh` breaks API/schema between releases (pre-1.0, rapid iteration) | High | High | Pin + SHA-512 integrity; schema-version gate before any read; session-format drift detection; update channel opt-in per channel with rollback | CI matrix over pinned versions; migration fuzz fixtures | Stay on pinned working version; mark newer versions `available` but not default | Open |
| R-03 | Session migration corrupts user data across platforms | Medium | Critical | Pre-migration backups; idempotency markers; never rewrite conversation content; atomic writes; validate-after-write | Migration test matrix (TESTING.md §1, §7) | Restore backup; task marks session `needs-repair` with doctor action | Mitigating |
| R-04 | Filesystem differences (exFAT no-symlink, case sensitivity, permissions) break portability | Medium | High | No-symlink mode enforced; relative-path canonicalization; fs capability probing at doctor time; test matrix over NTFS/ext4/APFS/exFAT | exFAT-mode CI profile; Unicode/space path tests | Disable features requiring symlinks; report as capability gap | Open |
| R-05 | Concurrent workspace mutation across nodes (two nodes, one active workspace) | Medium | High | Workspace advisory locks keyed by workspace id; `WORKSPACE_LOCKED` with holder info; node-side queueing | Protocol conformance tests for lock semantics | Refuse second access with actionable error; never silent merge | Mitigating |
| R-06 | Protocol evolution fragments clients and nodes | Medium | Medium | Major-versioned envelope + capability negotiation on every handshake; fixture suite shared by all three stacks | Schema conformance suite (TESTING.md §6) | Node serves supported range; client degrades gracefully | Open |
| R-07 | Pairing/authentication weakness exposes command execution | Low | Critical | Challenge-response + pinned device keypairs + TLS; discovery grants nothing; terminal scope explicit; audit logging; redaction; LAN-only default | Threat review + fuzzing of auth paths; negative-path tests | Revoke on suspicion; disable pairing in untrusted LANs | Mitigating |
| R-08 | Third-party licensing conflict blocks distribution | Medium | High | Repo A excluded entirely (no license); vendored licenses read verbatim at import (proot/talloc/libandroid-shmem/rootfs/Node/pnpm); notices regenerated per release | License audit script comparing vendored trees to records | Replace component or mark affected edition undistributable | Open |
| R-09 | Runtime distribution legality/size (Node per-platform, offline bundles ~900MB) | Medium | Medium | Lazy per-platform install; online/offline editions; checksums; CDN-independent mirror list acceptable | Release pipeline produces reproducible artifacts | Ship online-only edition | Open |
| R-10 | iOS client cannot be built/tested (Windows-only host) | Certain | Medium | Protocol locked via schemas first so the client is real, not a mock; iOS rows stay "Not tested" until a Mac exists | Manual iOS build + on-device tests later | Ship protocol-identical web client as interim control surface | Unresolved (environmental) |
| R-11 | Android background execution limits kill long tasks | High | High | Special-use foreground service + wake lock + battery-exemption request + supervisor reconciliation; orphan-task recovery on restart | Real-device background soak test (TESTING.md §2) | Task state preserved; user notified to grant exemption | Mitigating |
| R-12 | PRoot limitations break tools (no systemd/KVM/mounts; ncurses terminal rendering) | High | Medium | Documented limitations (ARCHITECTURE §19); toolchain caveats surfaced per project kind | Real-device capability matrix | Feature-aware capability negotiation hides unsupported ops | Open |
| R-13 | USB disconnect mid-write corrupts portable state | Medium | High | Atomic writes; append-only checksummed logs; finalize markers; recovery on next boot; Prepare-for-Eject workflow | Interrupted-write fault injection tests | Backup restore; degraded read-only mode | Mitigating |
| R-14 | Upstream session format moves beyond finalized v4 / released v3 | High | Medium | Schema-version gate + fail-safe; migration chains; `SESSION_FORMAT_VERSION` tracked per release | CI against new upstream versions | Pin to last known-good; mark migration required | Open |
| R-15 | Pairing UX or LAN discovery fails on hostile networks (AP isolation, IPv6-only) | Medium | Medium | Manual endpoint entry retained as advanced option; QR carries endpoint directly; mDNS + manual hybrid | Real-network matrix | Manual pairing by endpoint | Open |
| R-16 | Scope creep: building a harness replacement by accident | Medium | High | ADR-001 enforced in review; every new capability checked against the adapter table (PROTOCOL.md §10) | Architecture review per phase | Revert feature; document as upstream gap | Open |

## Explicitly unresolved items (carried into Phase 1 gates)

1. **R-01 dsh-on-Android** — source-plausible, never executed. Gated behind a real ARM64
   smoke test; the project does not claim Android works until that test passes
   ([COMPATIBILITY.md](COMPATIBILITY.md)).
2. **R-10 iOS build/test** — no macOS host. Swift client authored in Phase 4 with rows
   honestly marked Not tested.
3. **R-08 vendored license texts** — proot/talloc/libandroid-shmem/rootfs must be read at
   Android import (Phase 3) before any distribution; THIRD_PARTY_NOTICES.md is a plan until then.
4. **Live SDK-profile exit-code/error surfaces** — SIGTERM=0/SIGINT=130 are source-verified;
   finer-grained JSON-RPC error shapes will be pinned from a Phase 1 smoke test and folded back
   into PROTOCOL.md §10.
