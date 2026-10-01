// Phase 3B test fixture: a node server exposed over a real TLS listener on
// loopback, plus the controller-side pairing flow over a real socket.
//
// This is the "deterministic local test controller" the brief asks for when no
// second physical device is available: the bytes leave the process, traverse a
// TLS handshake, and come back, so the network path is exercised for real —
// only the loopback address stands in for the LAN. The security checks are not
// weakened for it (brief §16).

import { generateKeyPairSync, sign } from 'node:crypto';

import { createNodeServer } from '../../core/server/mod.mjs';
import { loadOrCreateNodeTlsCertificate } from '../../core/transport/cert.mjs';
import {
  createNetworkNodeListener, createLoopbackNodeListener, connectNodeTransport,
  connectLoopbackTransport, NodeTransportError,
} from '../../core/transport/net.mjs';
import { requestEnvelope } from '../../core/protocol/mod.mjs';
import { buildStack, disposeStack, newDeviceKey } from './stack.mjs';
import { wireClient } from './wire.mjs';

const DEFAULT_SCOPES = ['read-only', 'project-session-control', 'task-control', 'file-modify'];

/**
 * A temp stack with a TLS listener and a loopback listener both wired to one
 * node server.
 *
 * @param {{nodeDescriptor?: object|null, executorOptions?: object}} opts
 */
export async function buildNetStack({ nodeDescriptor = null, executorOptions = {}, tokenTtlMs = null } = {}) {
  const stack = await buildStack({ executorOptions, ...(tokenTtlMs ? { tokenTtlMs } : {}) });
  const server = createNodeServer({
    root: stack.root, p: stack.p,
    identity: stack.identity, auth: stack.auth, events: stack.events,
    workspace: stack.workspace, executorFactory: stack.executorFactory,
    uhVersion: '0.3.0', nodeDescriptor,
  });
  const recovery = server.recover();
  const cert = await loadOrCreateNodeTlsCertificate({ p: stack.p });
  const tlsListener = await createNetworkNodeListener({
    server, certPem: cert.certPem, keyPem: cert.privateKeyPem, host: '127.0.0.1', port: 0,
  });
  const loopbackListener = await createLoopbackNodeListener({
    server, host: '127.0.0.1', port: 0,
  });

  return {
    stack, server, cert, recovery,
    tlsListener, loopbackListener,
    /** Endpoint information for the TLS listener. */
    tlsEndpoint() {
      const a = tlsListener.address();
      return { host: a.address, port: a.port, fingerprintSha256: cert.fingerprintSha256 };
    },
    loopbackEndpoint() {
      const a = loopbackListener.address();
      return { host: a.address, port: a.port };
    },
    /** Mint a pairing payload bound to this node's real certificates. */
    mintPairing({ endpoint = null } = {}) {
      const a = tlsListener.address();
      return stack.auth.mintPairingPayload({
        endpoint: endpoint || `https://${a.address}:${a.port}`,
        nodeCertSha256: cert.fingerprintSha256,
        nodeName: 'test-node',
      });
    },
    async dispose() {
      tlsListener.close('test finished');
      loopbackListener.close('test finished');
      disposeStack(stack);
    },
  };
}

/**
 * Connect a controller over TLS and complete pairing, exactly as a real client
 * does from a scanned QR: pin the certificate fingerprint, pin the node
 * identity fingerprint, then pair. Returns a wired, authorized client.
 *
 * @param {object} net the buildNetStack result
 * @param {{pairing: object, scopes?: string[], transport?: object}} opts
 */
export async function pairOverTls(net, { pairing, scopes = DEFAULT_SCOPES }) {
  const { host, port } = net.tlsEndpoint();
  const transport = await connectNodeTransport({
    host, port,
    // The pin comes from the pairing payload — never from the network.
    pinnedCertSha256: pairing.nodeCertSha256,
  });
  const wire = wireClient(transport);
  const hello = await wire.next((e) => e.payload?.kind === 'node.hello');
  if (hello.payload.nodeId !== pairing.nodeId) {
    transport.close('node identity mismatch');
    throw new NodeTransportError('NODE_PROTOCOL', 'node.hello nodeId does not match the pairing payload');
  }
  const device = newDeviceKey();
  const reply = await wire.request('device.pair', {
    deviceName: 'test-controller',
    platform: 'desktop',
    devicePublicKeyPem: device.publicKeyPem,
    pairingToken: pairing.token,
    expectedNodeIdentitySha256: pairing.nodeIdentitySha256,
    requestedScopes: scopes,
    sigB64: device.sign(hello.payload.challengeB64),
  }, 'req_pair');
  if (!reply.ok) {
    transport.close('pairing failed');
    throw new NodeTransportError('NODE_PROTOCOL', `pairing failed: ${JSON.stringify(reply.payload)}`);
  }
  return {
    transport, wire,
    deviceId: reply.payload.deviceId,
    grantedScopes: reply.payload.grantedScopes,
    device,
    /** Reconnect the same device over a fresh TLS connection and authenticate. */
    async reconnect({ pinnedCertSha256 = pairing.nodeCertSha256 } = {}) {
      const t2 = await connectNodeTransport({ host, port, pinnedCertSha256 });
      const w2 = wireClient(t2);
      const hello2 = await w2.next((e) => e.payload?.kind === 'node.hello');
      const authReply = await w2.request('auth.connect', {
        deviceId: reply.payload.deviceId,
        sigB64: device.sign(hello2.payload.challengeB64),
      }, 'req_auth');
      if (!authReply.ok) {
        t2.close('auth failed');
        throw new NodeTransportError('NODE_PROTOCOL', `reconnect auth failed: ${JSON.stringify(authReply.payload)}`);
      }
      return { transport: t2, wire: w2, grantedScopes: authReply.payload.grantedScopes };
    },
  };
}

/** A raw (unpaired) TLS client transport, for negative tests. */
export async function connectRaw(net, { pinnedCertSha256 = null } = {}) {
  const { host, port } = net.tlsEndpoint();
  return connectNodeTransport({ host, port, pinnedCertSha256: pinnedCertSha256 || net.cert.fingerprintSha256 });
}

/** A request envelope ready for the HTTP path. */
export function httpRequestEnvelope(kind, payload, requestId) {
  return requestEnvelope(kind, payload, requestId);
}

export { DEFAULT_SCOPES, newDeviceKey };
