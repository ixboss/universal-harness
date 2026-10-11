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
         -e class com.universalharness.node.UhGateDInstrumentedTest \
         com.jarves.mh.test/androidx.test.runner.AndroidJUnitRunner

2. Start the node and mint a payload for the workstation:

       adb shell am instrument -w -e uhMintPayload true \
         -e class 'com.universalharness.node.UhGateEInstrumentedTest#e09_mintPayloadForHostVerification' \
         com.jarves.mh.test/androidx.test.runner.AndroidJUnitRunner

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

1. Build + install the current app and test APKs (Gate D once, as above):

       cd android
       ./gradlew :app:installOnlineDebug :app:installOnlineDebugAndroidTest

2. Start the node through the production foreground service and mint a payload,
   holding the process open for the script:

       adb shell am instrument -w \
         -e uhMintPayload true -e uhKeepNode true -e uhPayloadCount 1 \
         -e uhHoldSeconds 600 \
         -e class 'com.universalharness.node.UhGateEInstrumentedTest#e09_mintPayloadForHostVerification' \
         com.jarves.mh.test/androidx.test.runner.AndroidJUnitRunner

   A node holds **one unconsumed pairing token at a time** (the pending-token
   record is a single entry), so `-e uhPayloadCount 2` writes two payload files
   but only the LAST token is live — the two phases cannot both use payloads
   minted in one run. Run one phase per node run instead (below).

3. Pull the payload (the `run-as` pull is the out-of-band channel):

       adb shell run-as com.jarves.mh cat files/uh-state/pairing-payload-host.json > payload-1.json

   The payload's `endpoint` comes from the node's `lanAddress()`. On a device
   with both Wi-Fi and cellular that can be the **cellular** IP, which the
   workstation cannot reach; if so, rewrite `endpoint` to the device's Wi-Fi
   address (`adb shell ip -4 addr show wlan0`). The pinned certificate and node
   identity are unchanged, so the client still verifies the node.

4. Run phase A, then restart the node and run phase B (one payload per run):

       node tests/manual/gate-f-controller.mjs phase-a payload-1.json --state gatef-state.json --expect-kind android
       # restart the node (new instrumentation run) + mint + pull -> payload-2.json
       node tests/manual/gate-f-controller.mjs phase-b payload-2.json --state gatef-state.json

   The node restarts on the same port (7437) with the same identity, certificate
   and durable state, so phase B reuses phase A's state file. Drop
   `--expect-kind` when the node's kind should not be asserted. Against a
   desktop node instead of the device, run `uh serve --listen tls://127.0.0.1:7443`
   and `uh pair --endpoint https://127.0.0.1:7443` for each payload, and pass
   `--expect-kind desktop`.

Provider-backed completion remains R-21-blocked: the task is expected to stay
in flight and not settle. The gate records that honestly — what it proves is
the controller/node system: pairing, authorization, sessions (linked
continuation), idempotent submission, events, replay, pagination, and
multi-controller isolation, all over the real network.

Verification status: executed against a **Windows desktop node** (localhost TLS)
and against the **physical moto g 5G plus** (nairo, Android 11 / API 30,
arm64-v8a) over the real Wi-Fi LAN — **28/28 assertions across both phases,
0 FAIL, 2026-10-11**; the device node reported `nodeKind=android`. Retained
transcripts: `diagnostics/gate-f/gatef-state.json.evidence.txt` (desktop) and
`diagnostics/gate-f/gatef-device-evidence.txt` (device).
