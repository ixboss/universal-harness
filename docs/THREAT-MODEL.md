# Universal Harness — Threat Model

*Living document. Started by the 2026-11-14 audit remediation (Phase 0.1); sections grow as the audit proceeds.*

## Scope and trust model

A Universal Harness node runs on an operator's machine (desktop, or the Android app). Controller devices pair with the node over TLS and act within granted scopes. The harness adapters (dsh, claude-code, gemini-cli, omniroute, openai-compatible) are child processes of the node, running as the same OS user. Node identity and TLS private keys live in the device-local state directory (0600 files on POSIX, DPAPI CurrentUser on Windows).

Trust boundaries:

1. **Network → node**: TLS + ALPN framing, challenge-response auth with Ed25519 device keys, pairing tokens delivered out of band.
2. **Paired device → node operations**: scope gate on every operation (`core/scopes/mod.mjs`).
3. **Node → harness adapters**: the execution seam (`core/executor`, `core/adapter`). Tool approvals are unreachable over this seam (audit R-23).

## T-1: `task-control` implies arbitrary code execution as the node user (CONFIRMED, 2026-11-14)

**Status: CONFIRMED by experiment** — `tests/manual/task-control-experiment.mjs` (Windows x64, Node v26; the seam it exercises is platform-independent).

A paired device holding **only** the `task-control` scope was able to:

| # | Capability demonstrated | Evidence |
|---|---|---|
| 1 | `task.start` accepted (the scope gate is the only gate) | UH-TC-EXP 02 |
| 2 | Harness child process runs with `cwd` = the **entire portable root**, not a project directory | UH-TC-EXP 04 |
| 3 | The child inherits the node's full `process.env` — a planted sentinel secret was visible to the child | UH-TC-EXP 05 |
| 4 | The child reads the node's Ed25519 **private key** (`device-local/identity/node.private.pem`) | UH-TC-EXP 06 |
| 5 | The child writes files **outside** the task's project directory | UH-TC-EXP 07 |

The experiment drives the real production path end to end (real server, real scope gate, real `buildExecutorFactory` from `core/cli/serve.mjs`, real CLI-adapter child spawn) with a stub harness standing in for the agent CLI. Whatever the agent harness is willing to do — including executing model-directed tools — happens as the node user, and no approval flow intervenes.

**UNVERIFIED (needs a funded credential):** whether `dsh --profile sdk` in particular auto-allows model tool calls without any approval prompt. This does not change the verdict above: even a fully approval-gated harness runs with the credentials, environment, and filesystem reach demonstrated in items 2–5, and the harness itself can be asked to run arbitrary shell commands if it has any execution tool.

**Practical consequence:** grant `task-control` only to devices you trust with full code execution on the node host. It is not a "run a chat prompt" scope.

**Remediation tracked in the audit plan:** contain task execution (project-scoped `cwd`, env allowlist, explicit documentation that `task-control` ⇒ code execution, `uh pair` display) — audit item 1.1. Tool approvals (R-23) are a separate ADR-gated design spike (item 3.4).
