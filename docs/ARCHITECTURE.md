# Universal Harness — Architecture

**Phase 0 deliverable.** Target architecture, state model, security model, and recovery
models. Companion documents: [PROTOCOL.md](PROTOCOL.md) (protocol detail),
[ADR-001..008](adr/) (decision rationale), [RISK-REGISTER.md](RISK-REGISTER.md) (open risks).

---

## 1. System topology

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Universal Harness                            │
│  Portable Environment + Execution Nodes + Adapter + Protocol +       │
│  Portable State/Migration + Security + Remote Control + Recovery     │
└──────────────────────────────────────────────────────────────────────┘
        │                          │                         │
   ┌────┴─────┐              ┌─────┴─────┐             ┌─────┴─────┐
   │ Desktop  │              │ Android   │             │ iPhone    │
   │ nodes    │              │ node      │             │ / iPad    │
   │ Win/Lin/ │              │ (PRoot)   │             │ control   │
   │ macOS    │              │           │             │ client    │
   └────┬─────┘              └─────┬─────┘             └─────┬─────┘
        │                          │                         │
        └──────────┬───────────────┴──────────┬──────────────┘
                   │   Universal Protocol v1  │
                   │   (WSS/HTTPS, LAN)       │
                   ▼                          ▼
         ┌──────────────────┐      ┌──────────────────┐
         │ dsh --profile sdk│      │  dsh --profile   │
         │ (JSON-RPC stdio) │      │  sdk (JSON-RPC)  │
         └────────┬─────────┘      └────────┬─────────┘
                  │                         │
        ┌─────────┴────────┐      ┌─────────┴────────┐
        │ bundled Node.js  │      │ PRoot + Ubuntu   │
        │ runtimes/<plat>  │      │ + arm64 Node     │
        └──────────────────┘      └──────────────────┘
                   ▼
        DeepSeek Harness (`@deepseek-ai/dsh`)  ← unmodified engine
```

DeepSeek Harness is **the** execution layer (ADR-001). Universal Harness never reimplements
the agent, model orchestration, reasoning, or task execution. Where upstream lacks a capability,
we build an adapter and record the gap (PROTOCOL.md §10).

### Roles

- **Execution node** — Windows x64, Linux x64, macOS arm64 (bundled Node runtimes), Android
  arm64 (PRoot Ubuntu arm64). Owns processes, tasks, and authoritative state.
- **Control client** — iPhone/iPad (native SwiftUI) and, later, browser clients. Observes and
  controls. Never owns tasks (ADR-002, ADR-005).

## 2. Portable distribution layout

What a user puts on a USB stick. Relative paths only; **no symlinks anywhere** (exFAT safety);
no machine-specific usernames; no registry installs; no system runtime dependencies.

```
Universal-Harness/
├── UniversalHarness                     # POSIX entry (linux/macos)
├── UniversalHarness.bat                 # Windows entry
├── UniversalHarness.command             # macOS double-click entry
│
├── core/                                # Universal Harness code (portable, JS/TS bundle)
├── launchers/                           # per-OS bootstrap scripts
│
├── runtimes/
│   ├── windows-x64/                     # lazy-installed, per-platform Node.js
│   ├── linux-x64/
│   └── macos-arm64/
│
├── harness/                             # private npm prefix with pinned @deepseek-ai/dsh
│                                        # (store + node_modules; installed by setup/update)
│
├── toolchains/                          # optional (python, jdk, ...), per-node opt-in
│
├── data/                                # ← the portable state root (see §4)
│   ├── portable-home/                   # $DSH_HOME redirect: settings.yaml,
│   │                                    #   .credentials.yaml (encrypted), storages/
│   ├── projects/                        # portable projects
│   ├── workspace-registry/              # which projects exist, where, and their kind
│   ├── sessions/                        # session log mirror/projection (node-managed)
│   ├── migration/                       # migration metadata + pre-migration backups
│   ├── devices/                         # pairing metadata (public parts only; see §5)
│   └── backups/                         # workspace / profile backups (excludes caches)
│
├── models/                              # independent of runtimes/harness (survives updates)
├── manifest/
│   ├── manifest.json                    # current manifest (schema 2)
│   ├── known/                           # historical manifests (drift detection)
│   └── staged/                          # staged-but-not-activated updates
│
├── cache/                               # regenerable (node/pnpm caches, projections)
├── state/                               # node-local runtime state (locks, event cursors)
├── logs/                                # redacted logs (secrets never logged)
├── temp/
└── third_party-licenses/                # offline-readable copies of all notices
```

Design notes:

- `runtimes/` is populated **lazily per platform** — a Windows machine only needs
  `runtimes/windows-x64`. Each bundle is downloaded, SHA-256-verified, staged, and activated
  atomically; a partially downloaded bundle never replaces a working one (§8).
- `models/`, `data/`, and `core/` are intentionally separate so harness updates, runtime
  reinstalls, and resets do not touch user data.
- `state/` holds volatile node state; it may be deleted on another machine without harm
  (it is device-local by policy, §5, even though it rides along physically).

## 3. Desktop execution node (Windows/Linux/macOS)

Process model:

```
UniversalHarness.bat / UniversalHarness          ← thin entry shim
        │
        ▼
launchers/<platform> bootstrap                    ← locate root, arch detection, guard checks
        │
        ▼
UniversalHarness launcher (core/portable)         ← subcommand dispatcher
        │
        ├─ setup      → runtime install + harness install + first-run config
        ├─ doctor     → machine-readable diagnostics (§9)
        ├─ update     → channel-scoped staged update (§8)
        ├─ reset      → remove mutable data (preserves models/ + projects after confirm)
        ├─ pair       → display short-lived QR pairing payload (§6 security)
        ├─ serve      → execution-node server (protocol) — runs alongside or standalone
        ├─ web        → passthrough: `dsh web` (browser UI at 127.0.0.1:3080)
        └─ -- …       → passthrough: raw dsh arguments
```

- The runtime `node` is always referenced by **relative path** from the portable root.
- `DSH_HOME=<root>/data/portable-home` is injected so all harness state follows the drive.
- `DEEPSEEK_API_KEY`-style secrets are injected from the **encrypted credential vault**, never
  from plaintext files and never logged (§6).
- The node server binds **loopback + LAN by default** (never public internet); binding beyond
  LAN is an explicit advanced opt-in with warnings.

## 4. State model

### 4.1 "Same environment" defined honestly

We do **not** claim OS environments are byte-identical. The contract is:

> **Same Universal Harness experience and portable project/session state, with
> platform-specific execution capabilities.**

### 4.2 Portable state (travels with the drive)

- projects (source trees under `data/projects/`)
- workspace registry (`data/workspace-registry/`)
- session logs and conversation history (harness JSONL/Zstd artifacts, or node-managed mirrors)
- harness configuration (`data/portable-home` settings, provider profiles)
- skills/plugins configuration
- workspace metadata (bookmarks / checkpoints)
- safe-to-migrate caches and projections (schema-version-gated; migrated or discarded otherwise)
- migration metadata and backups
- manifest/runtime metadata

### 4.3 Device-local state (never blindly travels)

- node identity keypair (private part) and pairing keys
- Keychain/Keystore/master-key material that decrypts portable credentials
- OS-specific credentials (OS keychain integration) and OS integration state
- temporary files, device-specific runtime caches, local discovery state
- event cursors and locks (regenerated on first use per device)

On Android, device-local state lives in app-private storage guarded by Keystore; the **portable
workspace snapshot** is imported/exported via Storage Access Framework into the app sandbox —
never executed directly from USB (§7).

### 4.4 Portable credentials — the explicit upgrade

Credentials are **never plaintext**, portability notwithstanding (ADR-007):

- Desktop: the credential vault is an encrypted container in `data/portable-home`; the key is
  device-local (machine-bound keystore where available, passphrase-derived otherwise). Losing
  the key yields ciphertext, not secrets. Re- provisioning key → re-entering API keys.
- Android: Keystore-backed (`ApiKeyVault` design, AUDIT §4.3).
- iOS: Keychain.
- QR codes, logs, diagnostics, backups, and protocol messages **redact** secrets by design.

This deliberately closes the inherited flaw from repo A ("credentials travel in plaintext"). The
trade-off — a restored backup prompts for re-authentication — is accepted.

### 4.5 Core entities (ADR-aligned)

| Entity | Identity | Owned by | Notes |
|---|---|---|---|
| `Project` | `projectId` (uuid) | workspace registry | portable or external |
| `Workspace` | `workspaceId` | project | on-disk tree + bindings |
| `Session` | `sessionId` | node | harness session + conversation history |
| `Task` | `taskId` | **execution node** | a driving interaction on a session |
| `ExecutionNode` | `nodeId` (uuid, stable) | itself | platform/arch/versions/capabilities |
| `Device` (client) | `deviceId` (uuid) paired | node registry | name, pubkey, scopes, last seen |
| `EventStream` | monotonic `eventId` per node | node | basis of missed-event replay (§7) |

Relationships: `Project A → Session X → Task Y → owned by Node 1`. The iPhone observes and
controls Task Y; it is not the owner (ADR-005).

## 5. Security, discovery, and pairing (summary; PROTOCOL.md §5 detail)

1. **Discovery ≠ authorization.** mDNS/Bonjour advertises `@universal-harness._tcp` with
   *public* info only (node name, protocol version, capabilities).
2. **Pairing** is a short-lived (60s) QR containing a one-time bearer token + node endpoint —
   never a permanent secret. Completing pairing exchanges device keypairs over a
   challenge-response; the node records the client's public key, name, platform, and scopes.
3. **Authentication** is challenge-response with pinned device keypairs; transport is TLS with
   per-node certificates (pinned by clients on first use).
4. **Authorization scopes**: `read-only`, `project/session-control`, `task-control`,
   `file-modify`, `terminal`, `node-admin`, `update`. Terminal and node-admin require explicit
   grant; discovery grants nothing.
5. **Revocation**: rename / revoke / forget / re-pair devices; active connections list;
   per-device last-seen. Revocation takes effect immediately for new connections and at the
   next event for live ones.

## 6. Reconnect and missed-event recovery

- Every node maintains an append-only **event log** with strictly monotonic `eventId`s.
- Clients track `lastEventId`. On reconnect: authenticate → handshake (lastEventId, capabilities)
  → node replays `lastEventId+1 … head` → then live stream.
- If history is unavailable or beyond retention, the node returns an **authoritative snapshot**
  plus reconciliation metadata (task states, session states); the client reconciles.
- Duplicate events are deduplicated by `eventId`; ordering is per-node total.
- Task state on disconnect is unchanged — the node keeps running (ADR-005). UI copy follows the
  "disconnected ≠ stopped" pattern in the brief.

## 7. Android execution node (ADR-003)

```
Kotlin app (Compose)
   └─ foreground services (setup + execution, specialUse)
        └─ pocketspawn (C bridge)
             └─ proot → Ubuntu 20.04 arm64 rootfs
                  └─ node (arm64) → /usr/local/bin/dsh --profile sdk
```

- The PRoot guest workspace is mounted under `/workspace/<slug>`; PRoot hard-link emulation is
  disabled for dsh (atomic temp-file rename saves break under it — AUDIT §4.3).
- **Workspace portability differs by necessity**: Android cannot execute from arbitrary USB
  filesystems. Portable workspace arrives via SAF import into app-private storage; export and
  sync are explicit operations with checksum verification and conflict detection.
- Android feasibility (dsh inside PRoot) is **UNRESOLVED** for this project — see
  RISK-REGISTER.md R-01; real-device validation is a Phase 1 gate.
- Background limits: special-use foreground service + wake lock + battery-optimization
  exemption request; phantom-process killing is a documented risk (R-12).

## 8. Update, rollback, and repair

Four independent channels with a shared lifecycle:

```
download → verify (SHA-256+) → stage → validate → activate → health-check → rollback on failure
```

- **Universal Harness core** (`core/`, launchers), **Harness** (pinned `@deepseek-ai/dsh`),
  **platform runtime** (Node bundles), **toolchains** (optional). The Android rootfs forms a
  fifth, node-local channel on the same lifecycle.
- Activation is **atomic promotion** (rename); the previous version remains recoverable in
  `manifest/known/` + a retained prior directory until pruning.
- Interrupted installs are detected by staged-state markers and repaired on next run; a partial
  download never endangers a working runtime.
- Rollback: `update --rollback <channel>` restores the last known-good version, with the same
  verify/activate dance, and never touches user data.
- Doctor integrates update state as diagnostic checks (§9).

## 9. Doctor / diagnostics

Machine-readable first, human-rendered second. Each diagnostic carries: `id`, `severity`
(ok/warn/fail), `component`, `condition`, `evidence`, `recommendedAction`, `autoRepairSafe`.

Components checked: OS, arch, filesystem + compatibility (exFAT/symlink capability), storage,
portable root, runtime presence + integrity, harness install, permissions, workspace registry,
sessions (schema-version validity), credentials, configuration, network, remote server status,
pairing state, Android runtime state (on Android nodes), update state.

Consumed by: CLI (table output), desktop UI, Android UI, iOS client (protocol `diagnostics`
operation). Repairs the system can perform safely are offered; everything else is an explicit
command with rationale.

## 10. Concurrency and locking

- Workspace locks: an active task holds an advisory lock (lock file under `state/locks/`) keyed
  by workspace. A second node attempting the **same active workspace** is refused with a
  `WORKSPACE_LOCKED` error carrying the holder's node id — never silent concurrent mutation.
- Per-node task limits: max concurrent tasks (configurable; conservative default), a FIFO queue,
  priorities (background/normal/urgent), cancellation semantics per §12.
- Runtime lock: installs/updates are exclusive per runtime slot (staged directory + atomic rename).
- Android: memory/CPU-conscious limits; forensic “heavy build” staging belongs in the setup
  service, not the execution service.

## 11. Crash and recovery semantics

Task state machine (node-owned): `queued → starting → running → recovering → completed |
failed | cancelled`. There is no permanent "running": a supervisor reconciles process liveness
against task records — on restart, orphaned `running` tasks are marked `failed` with a recovery
record (or resumed where the harness supports resumption).

Handled scenarios: UH core crash, dsh crash (exit code + stderr captured, task → failed with
details), PRoot crash (Android), device reboot, laptop sleep, process kill (SIGTERM/SIGINT per
AUDIT §2.4), USB disconnect (tasks in progress flush or fail safely; never corrupt),
network disconnect (tasks unaffected).

## 12. USB failure handling

- **Atomic writes** for all metadata (staged `.new` + rename); logs are append-only with
  checksummed frames so truncation is detectable.
- Active-operation indicator + **Prepare for Eject / Safe Shutdown** workflow: flush sessions,
  release locks, finalize event log, surface in-flight task count.
- Accidental disconnect: on next boot, recovery detects interrupted writes (partial `.new`,
  missing finalize markers) and restores from pre-migration/backups.
- Read-only filesystem, insufficient storage, filesystem errors: surfaced as actionable
  diagnostics with redaction, never silent corruption.
- USB is **not the sole source of truth while a node is running**: the node caches working
  state locally, writes-through when able, and promotes safely on recover (§13).

## 13. Consistency model (USB as unreliable external resource)

- Authoritative: the **node's task/session state** while a task is live; the **USB portable
  state** at rest.
- Sync windows: on lock release (task end), on safe-shutdown, on workspace import/export.
  Conflicts detected by content hash + mtime + migration metadata → **never silently
  overwritten**; users choose (keep USB / keep device / keep both as backup), with a compare view.
- File operations over the protocol use version/hash optimistic concurrency: writes carry the
  base version/hash the client read; mismatch → `CONFLICT` with current remote state.
- Temporary USB loss never corrupts active tasks: in-flight writes buffer locally
  (`state/`), replay on reconnect.

## 14. Migration subsystem (first-class)

Schema-versioned, chain-based, idempotent, with pre-migration backup and validation:

1. detect old-platform paths (Windows drive letters/backslashes vs POSIX)
2. canonicalize portable paths to portable-root-relative
3. rewrite only host-specific metadata: workspace registry, session-log `SessionHeader.cwd`
   (recompressing Zstd while preserving trailing frames — proven feasible, AUDIT §3.3),
   projection-cache identity records
4. **never** rewrite conversation content
5. validate, update registries, write migration metadata
6. interrupt-safe: idempotent steps + detection markers + rollback to pre-migration backup

Unsupported session schema versions (upstream `SESSION_FORMAT_VERSION`, currently finalized v3
released / v4 finalized — AUDIT §2.5) → fail safe with a useful error and untouched data.
Migration chains cover Windows ↔ Linux ↔ macOS ↔ Android path families.

## 15. Offline-first

LAN operation requires **no** cloud server, hosted database, account, relay, or subscription.
Nodes continue local execution when the internet vanishes (subject only to the external model
provider itself). mDNS + QR + direct WSS/HTTPS. A future optional cloud relay may exist later as
an additive capability, never a dependency.

## 16. Notifications

Local, node-originated, subscription-based over the protocol: task completed/failed, agent
waiting for input, approval required, device disconnected, update available. iOS notifications
are delivered while the app is connected; no push service is required for the core product.

## 17. Storage accounting

Per-bucket reporting (runtimes, projects, sessions, caches, toolchains, models, backups) with
cleanup actions that **never** delete user projects without confirmation: clear caches, remove
unused toolchains, prune old runtimes, prune old backups.

## 18. Failure language (UX)

Every major failure states: what happened, likely cause, what the system tried, what the user
can do, and a diagnostics action. No bare "error 127". The Android background-kill case, for
instance, explains foreground-service mechanics, not stack traces.

## 19. Non-goals / explicit limitations

- Not a harness replacement; no agent logic here (ADR-001).
- Not a cloud product (ADR-006).
- No PTY-complete terminal (inherited PRoot bridge limitation; ncurses apps may misrender) —
  documented, not hidden.
- PRoot is not a security boundary (AUDIT §4.5); sandbox policy stays upstream's.
- Windows ARM64 / Linux ARM64 desktop / Intel macOS / musl Linux: unsupported (inherited scope).
- iOS local execution: impossible, out of scope (ADR-002).
