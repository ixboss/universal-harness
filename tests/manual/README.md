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
- `session.list` succeeds for the authenticated device;
- a started task keeps running after the controller disconnects, and its durable events
  replay (monotonic ids) after reconnect + `auth.connect`;
- the one-shot HTTP path on the same TLS port accepts a request-signed
  `Authorization: UH` request.
