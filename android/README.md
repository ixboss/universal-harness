# android (execution node)

**Phase 0 — placeholder.** No Android code exists in this repository yet. The approved import
happens in **Phase 3** (ROADMAP.md), with git history preserved.

## Planned structure (from the audited Mobile-Harness, MIT — AUDIT.md §4)

```
android/
├── app/                            # Kotlin / Jetpack Compose application (com.jarves.* → repackaged)
│   ├── src/main/
│   │   ├── java/<pkg>/
│   │   │   ├── MainActivity.kt
│   │   │   ├── runtime/            # AgentDriver/AgentRegistry, RuntimeBridge (+Dsh/Claude/
│   │   │   │                       #   Antigravity bridges), RuntimeInstaller, setup +
│   │   │   │                       #   execution foreground services, NativeSpawnProcess,
│   │   │   │                       #   WorkspaceCheckpoints, AndroidAppInstaller
│   │   │   ├── network/            # + Universal Protocol node server (Kotlin) — new
│   │   │   ├── security/           # ApiKeyVault (Keystore AES-GCM) — adapted
│   │   │   ├── update/             # GitHub/release + rootfs channel updates
│   │   │   └── ui/                 # Compose UI
│   │   ├── cpp/                    # pocketspawn / launcher / carrier + CMakeLists (carrier trick)
│   │   └── AndroidManifest.xml
├── third_party/                    # proot + libandroid-shmem (git submodules, pinned),
│                                   # talloc (vendored) — each with its LICENSE
└── LICENSE · README
```

## Phase 3 import checklist (mandatory before any distribution — R-08)

1. Import Mobile-Harness into `android/` **with git history**; keep its MIT `LICENSE`.
2. Pin `third_party/proot` and `third_party/libandroid-shmem` submodules to exact commits.
3. **Read the vendored `LICENSE` files verbatim** and record them in
   [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) (the parent repo's MIT does **not** cover
   them — AUDIT.md §6 discrepancy 6).
4. Record the Ubuntu rootfs license/distribution terms.
5. Adapt: execution-node server, device identity/pairing, protocol, persistent background
   tasks, SAF-based workspace import/export (ADR-003).
6. Run the **R-01 gating smoke test** on a real ARM64 device (Node → dsh → prompt → event →
   shutdown). Android execution support is **not** claimed before this passes.

## Status

Phase 0 — skeleton only; no code present.
