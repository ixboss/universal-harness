# Manual (hardware-in-the-loop) test scripts

Nothing in this directory runs under `npm test` — these scripts drive a physical device
over the real LAN and require the debug APK plus an installed on-device runtime.

## `gate-e-host.mjs` — Phase 3B host-side device verification

The controller half of the Phase 3B matrix, executed from this workstation against the
node server running on the Android device, over the real Wi-Fi LAN. It is the cross-device
complement of `android/.../UhGateEInstrumentedTest.kt`, which runs the same matrix on the
device itself.

Run (in order):

1. Install the debug APK and the runtime (Gate D, once):

       cd android
       ./gradlew :app:installOnlineDebug
       adb shell am instrument -w -e uhInstallRuntime true \
         com.jarves.mh.test/com.universalharness.node.UhGateDInstrumentedTest

2. Start the node and mint a payload for the workstation:

       adb shell am instrument -w -e uhMintPayload true \
         com.jarves.mh.test/com.universalharness.node.UhGateEInstrumentedTest

3. Pull the pairing payload (the `run-as` pull IS the out-of-band channel — in production
   the operator scans the payload off the device screen):

       adb shell run-as com.jarves.mh cat files/uh-state/pairing-payload-host.json > payload.json

4. Verify from the workstation:

       node tests/manual/gate-e-host.mjs --payload payload.json

What it proves, with printed evidence (`UH-GATE-E-HOST nn:` lines):

- the device's TLS listener is reachable over the LAN, and the certificate fingerprint
  pinned from the pairing payload matches what the device presents;
- the greeting names the payload's node and offers a challenge nonce;
- a genuine token pairs; terminal/node-admin are never auto-granted;
- the node proves possession of the identity key the payload bound (sha256 of its public
  key equals the payload fingerprint, and its challenge signature verifies);
- a signed-in device's `terminal.exec` is refused `SCOPE_DENIED` (deny-by-default);
- task operations succeed for the authenticated device (note: `session.list` answered CAPABILITY_UNSUPPORTED until Phase 3C implemented it);
- a started task keeps running after the controller disconnects, and its durable events
  replay (monotonic ids) after reconnect + `auth.connect`;
- the one-shot HTTP path on the same TLS port accepts a request-signed
  `Authorization: UH` request.

## `gate-f-controller.mjs` — Phase 3C controller gate

The real controller gate: the workstation runs two independent `core/client`
UniversalClient controllers (the same library `uh connect` uses, with their own
device keys and registry profiles) against the live node on the physical
device, over the real Wi-Fi LAN. It verifies pairing per controller,
capabilities, session create/read/list, idempotent task submission
(`clientRequestId` same-task replay + CONFLICT on material change), live task
events, deliberate disconnect, reconnect + auth, full durable replay, cursor-
paginated task history with no duplicates, linked-continuation
`session.resume` (priorSessionId on the wire, dsh conversation NOT reopened),
and controller-B isolation (own deviceId, no elevated scopes, same durable
truth, device-scoped idempotency).

Run (in order — the device node must stay alive while the script runs):

1. Build + install the current APK (Gate D once, as above).

2. Start the node through the production foreground service and mint TWO
   payloads (tokens are single-use; one per controller), holding the process
   open for the script:

       adb shell am instrument -w \
         -e uhMintPayload true -e uhKeepNode true -e uhPayloadCount 2 \
         -e uhHoldSeconds 240 \
         com.jarves.mh.test/com.universalharness.node.UhGateEInstrumentedTest

3. Pull both payloads (the `run-as` pull is the out-of-band channel):

       adb shell run-as com.jarves.mh cat files/uh-state/pairing-payload-host-1.json > payload-1.json
       adb shell run-as com.jarves.mh cat files/uh-state/pairing-payload-host-2.json > payload-2.json

4. Run the controller gate from the workstation (two phases sharing one state
   file; evidence lines accumulate in `<state>.evidence.txt`):

       node tests/manual/gate-f-controller.mjs phase-a payload-1.json --state gatef-state.json --expect-kind android
       node tests/manual/gate-f-controller.mjs phase-b payload-2.json --state gatef-state.json

   Drop `--expect-kind` when the node's kind should not be asserted. Against a
   desktop node instead of the device, run `uh serve --listen tls://127.0.0.1:7443`
   and `uh pair --endpoint https://127.0.0.1:7443` for each payload, and pass
   `--expect-kind desktop`.

Provider-backed completion remains R-21-blocked: the task is expected to stay
in flight and not settle. The gate records that honestly — what it proves is
the controller/node system: pairing, authorization, sessions (linked
continuation), idempotent submission, events, replay, pagination, and
multi-controller isolation, all over the real network.

Verification status: executed against a **desktop node** (localhost TLS,
28/28 assertions across both phases, 2026-10-02). The **Android device** run
was not executed in this pass — the physical device was unreachable on the LAN
when the gate was re-run — so the device-side Gate F row in
[docs/COMPATIBILITY.md](../../docs/COMPATIBILITY.md) is recorded as not
executed, not as passing.
