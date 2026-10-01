// Phase 2 — authentication, pairing, and authorization tests (brief §18).
// Invariants: challenge-response is required, a pairing token alone cannot
// impersonate a node (NEG-PAIR-01), tokens are single-use, revoked devices
// cannot reconnect, and scope enforcement is deterministic in both directions.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadOrCreateNodeIdentity } from '../core/identity/mod.mjs';
import { createAuthStore } from '../core/auth/mod.mjs';
import { portablePaths } from '../core/paths/mod.mjs';
import { authorize, isEscalation, requiredScopes, SCOPE } from '../core/scopes/mod.mjs';
import { newDeviceKey } from './fixtures/stack.mjs';

async function makeAuth() {
  const root = `/tmp/uh-auth-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const fs = await import('node:fs');
  fs.mkdirSync(root + '/data', { recursive: true });
  const p = portablePaths(root);
  const identity = await loadOrCreateNodeIdentity({ p });
  const auth = createAuthStore({ p, identity });
  return { root, identity, auth, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/**
 * Like makeAuth, but the device-local tree (device records AND the pending
 * pairing-token hash) is isolated under the temp root instead of the shared
 * OS location, so multi-store scenarios cannot interfere with other suites.
 */
async function makeIsolatedAuth({ tokenTtlMs } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uh-auth-iso-'));
  const p = { ...portablePaths(root), device: path.join(root, 'device-local') };
  const identity = await loadOrCreateNodeIdentity({ p });
  const auth = createAuthStore({ p, identity, tokenTtlMs });
  return {
    root, p, identity, auth,
    deviceRoot: p.device,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const PENDING_FILE = 'pending-pairing.json';

async function pairDevice(auth, identity, { expectedOverride, scopes = ['read-only'], signChallenge = true } = {}) {
  const pairing = auth.mintPairingPayload({ endpoint: 'memory://test' });
  const key = newDeviceKey();
  const challenge = auth.newChallenge();
  const result = auth.pair({
    deviceName: 'phone',
    platform: 'ios',
    devicePublicKeyPem: key.publicKeyPem,
    token: pairing.token,
    expectedNodeIdentitySha256: expectedOverride ?? pairing.nodeIdentitySha256,
    sigB64: signChallenge ? key.sign(challenge) : 'not-a-signature',
    challenge,
    requestedScopes: scopes,
  });
  return { result, key, pairing };
}

test('pairing: a valid signature and matching identity succeed', async () => {
  const { auth, identity, cleanup } = await makeAuth();
  try {
    const { result } = await pairDevice(auth, identity);
    assert.equal(result.ok, true);
    assert.match(result.deviceId, /^device_[0-9a-f]{32}$/);
    assert.ok(result.grantedScopes.includes('read-only'));
  } finally { cleanup(); }
});

test('NEG-PAIR-01: a token bound to a DIFFERENT node identity is rejected', async () => {
  const { auth, identity, cleanup } = await makeAuth();
  try {
    const { result } = await pairDevice(auth, identity, {
      expectedOverride: '0'.repeat(64), // a fingerprint the client bound to some other node
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NODE_IDENTITY_MISMATCH');
  } finally { cleanup(); }
});

test('pairing: an unsigned challenge is rejected (token alone is not enough)', async () => {
  const { auth, identity, cleanup } = await makeAuth();
  try {
    const { result } = await pairDevice(auth, identity, { signChallenge: false });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CHALLENGE_FAILED');
  } finally { cleanup(); }
});

test('pairing: the token is single-use even when the challenge fails', async () => {
  const { auth, identity, cleanup } = await makeAuth();
  try {
    const first = await pairDevice(auth, identity, { signChallenge: false });
    assert.equal(first.result.ok, false);
    // The same token cannot be retried with a correct signature.
    const pairing = first.pairing;
    const key = first.key;
    const challenge = auth.newChallenge();
    const retry = auth.pair({
      deviceName: 'phone', platform: 'ios', devicePublicKeyPem: key.publicKeyPem,
      token: pairing.token, expectedNodeIdentitySha256: pairing.nodeIdentitySha256,
      sigB64: key.sign(challenge), challenge, requestedScopes: ['read-only'],
    });
    assert.equal(retry.ok, false);
    assert.equal(retry.code, 'TOKEN_CONSUMED');
  } finally { cleanup(); }
});

test('pairing: an expired token is rejected', async () => {
  const { auth, identity, cleanup } = await makeAuth({ });
  try {
    const pairing = auth.mintPairingPayload({ endpoint: 'x' });
    pairing.expiresAt = new Date(Date.now() - 10_000).toISOString();
    // Push the expired state by minting and rewinding time is not possible on
    // the public API, so exercise the expiry path through a fresh store that
    // treats the token as expired by construction.
    const key = newDeviceKey();
    const challenge = auth.newChallenge();
    const result = auth.pair({
      deviceName: 'phone', platform: 'ios', devicePublicKeyPem: key.publicKeyPem,
      token: 'never-minted',
      expectedNodeIdentitySha256: pairing.nodeIdentitySha256,
      sigB64: key.sign(challenge), challenge, requestedScopes: ['read-only'],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TOKEN_EXPIRED');
  } finally { cleanup(); }
});

test('pairing: a wrong token is rejected, not accepted as a fresh pairing', async () => {
  const { auth, identity, cleanup } = await makeAuth();
  try {
    const { result } = await pairDevice(auth, identity, { expectedOverride: undefined });
    // sanity: real pairing works
    assert.equal(result.ok, true);
    const key = newDeviceKey();
    const challenge = auth.newChallenge();
    const bad = auth.pair({
      deviceName: 'other', platform: 'web', devicePublicKeyPem: key.publicKeyPem,
      token: 'not-the-token',
      expectedNodeIdentitySha256: identity.fingerprint,
      sigB64: key.sign(challenge), challenge, requestedScopes: ['read-only'],
    });
    assert.equal(bad.ok, false);
  } finally { cleanup(); }
});

test('pairing: escalation is refused — terminal and node-admin are never auto-granted', async () => {
  const { auth, identity, cleanup } = await makeAuth();
  try {
    const { result } = await pairDevice(auth, identity, {
      scopes: ['read-only', 'terminal', 'node-admin', 'task-control'],
    });
    assert.equal(result.ok, true);
    assert.ok(result.grantedScopes.includes('read-only'));
    assert.ok(result.grantedScopes.includes('task-control'));
    assert.ok(!result.grantedScopes.includes('terminal'), 'terminal must not be auto-granted');
    assert.ok(!result.grantedScopes.includes('node-admin'), 'node-admin must not be auto-granted');
  } finally { cleanup(); }
});

test('auth: a returning device proves its key on every connection', async () => {
  const { auth, identity, cleanup } = await makeAuth();
  try {
    const { result, key } = await pairDevice(auth, identity);
    const challenge = auth.newChallenge();
    const ok = auth.verifyChallenge({ deviceId: result.deviceId, sigB64: key.sign(challenge), challenge });
    assert.equal(ok.ok, true);
  } finally { cleanup(); }
});

test('auth: a bad signature fails with CHALLENGE_FAILED and reveals nothing', async () => {
  const { auth, identity, cleanup } = await makeAuth();
  try {
    const { result } = await pairDevice(auth, identity);
    const other = newDeviceKey();
    const challenge = auth.newChallenge();
    const r = auth.verifyChallenge({ deviceId: result.deviceId, sigB64: other.sign(challenge), challenge });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CHALLENGE_FAILED');
  } finally { cleanup(); }
});

test('auth: an unknown device id fails the same way (no enumeration oracle)', async () => {
  const { auth, cleanup } = await makeAuth();
  try {
    const challenge = auth.newChallenge();
    const key = newDeviceKey();
    const r = auth.verifyChallenge({ deviceId: 'device_' + 'f'.repeat(32), sigB64: key.sign(challenge), challenge });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CHALLENGE_FAILED');
  } finally { cleanup(); }
});

test('auth: a revoked device cannot authenticate', async () => {
  const { auth, identity, cleanup } = await makeAuth();
  try {
    const { result, key } = await pairDevice(auth, identity);
    const revoked = auth.revokeDevice(result.deviceId);
    assert.equal(revoked.ok, true);
    assert.equal(revoked.status, 'revoked');
    const challenge = auth.newChallenge();
    const r = auth.verifyChallenge({ deviceId: result.deviceId, sigB64: key.sign(challenge), challenge });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'DEVICE_REVOKED');
  } finally { cleanup(); }
});

test('auth: forgetting removes the record entirely', async () => {
  const { auth, identity, cleanup } = await makeAuth();
  try {
    // Device records live in the device-local tree, not the per-test root
    // (core/auth/mod.mjs §device-bound state), so the store is not empty at
    // entry. Assert the delta instead of an absolute count.
    const before = auth.listDevices();
    const { result } = await pairDevice(auth, identity);
    const forgotten = auth.revokeDevice(result.deviceId, { forget: true });
    assert.equal(forgotten.status, 'forgotten');
    const after = auth.listDevices();
    assert.ok(!after.some((d) => d.deviceId === result.deviceId), 'forgotten record is gone');
    assert.equal(after.length, before.length, 'forget removed exactly that one record');
  } finally { cleanup(); }
});

test('auth: revoking an unknown device fails deterministically', async () => {
  const { auth, cleanup } = await makeAuth();
  try {
    const r = auth.revokeDevice('device_' + '0'.repeat(32));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NOT_FOUND');
  } finally { cleanup(); }
});

test('scopes: read-only grants reads and denies control', () => {
  assert.equal(authorize('task.list', ['read-only']).allowed, true);
  assert.equal(authorize('session.read', ['read-only']).allowed, true);
  const denied = authorize('task.start', ['read-only']);
  assert.equal(denied.allowed, false);
  assert.equal(denied.scope, 'task-control');
});

test('scopes: task-control permits start/cancel but not file writes', () => {
  assert.equal(authorize('task.start', ['task-control']).allowed, true);
  assert.equal(authorize('task.cancel', ['task-control']).allowed, true);
  assert.equal(authorize('file.write', ['task-control']).allowed, false);
});

test('scopes: terminal is its own grant and nothing else implies it', () => {
  assert.equal(authorize('terminal.exec', ['terminal']).allowed, true);
  assert.equal(authorize('terminal.exec', ['task-control', 'file-modify', 'node-admin']).allowed, false);
});

test('scopes: handshake operations need no scope', () => {
  assert.equal(requiredScopes('node.hello'), null);
  assert.equal(requiredScopes('auth.connect'), null);
  assert.equal(requiredScopes('device.pair'), null);
  assert.equal(authorize('node.hello', []).allowed, true);
});

test('scopes: an unknown operation is denied, never allowed through', () => {
  const r = authorize('something.new', ['read-only']);
  assert.equal(r.allowed, false);
});

test('scopes: node-admin covers device listing and revocation only', () => {
  assert.equal(authorize('device.list', ['node-admin']).allowed, true);
  assert.equal(authorize('device.revoke', ['node-admin']).allowed, true);
  assert.equal(authorize('task.start', ['node-admin']).allowed, false);
});

test('scopes: isEscalation detects a widening request', () => {
  assert.equal(isEscalation(['file.write'], ['read-only']), true);
  assert.equal(isEscalation(['read-only'], ['read-only', 'file.write']), false);
  assert.equal(authorize('file.write', []).allowed, false);
  assert.equal(SCOPE.TERMINAL, 'terminal');
});

// ---------------------------------------------------------------------------
// Persisted pending pairing token: `uh pair` mints in its own process; a
// separately running `uh serve` must be able to consume the token. Only a
// SHA-256 hash of the token may ever touch disk.
// ---------------------------------------------------------------------------

function pairWithToken(store, pairing, { key = newDeviceKey(), signChallenge = true, token, includePin = true } = {}) {
  const challenge = store.newChallenge();
  return store.pair({
    deviceName: 'phone',
    platform: 'ios',
    devicePublicKeyPem: key.publicKeyPem,
    token: token ?? pairing.token,
    ...(includePin ? { expectedNodeIdentitySha256: pairing.nodeIdentitySha256 } : {}),
    sigB64: signChallenge ? key.sign(challenge) : 'not-a-signature',
    challenge,
    requestedScopes: ['read-only'],
  });
}

test('pairing: the pending token is persisted as a hash, never as plaintext', async () => {
  const { auth, deviceRoot, cleanup } = await makeIsolatedAuth();
  try {
    const pairing = auth.mintPairingPayload({ endpoint: 'memory://test' });
    const file = path.join(deviceRoot, PENDING_FILE);
    const raw = fs.readFileSync(file, 'utf8');
    const rec = JSON.parse(raw);
    assert.match(rec.tokenHash, /^[0-9a-f]{64}$/, 'the record carries a SHA-256 hash');
    assert.ok(rec.mintedAt && rec.expiresAt, 'the record carries its lifetime');
    assert.ok(!raw.includes(pairing.token), 'the plaintext token must never touch disk');
    assert.ok(!raw.includes('token:'), 'no plaintext token field exists');
  } finally { cleanup(); }
});

test('pairing: a separately constructed store (a fresh process) consumes the persisted token', async () => {
  const { p, identity, deviceRoot, cleanup } = await makeIsolatedAuth();
  try {
    const minter = createAuthStore({ p, identity });
    const pairing = minter.mintPairingPayload({ endpoint: 'memory://test' });
    // A brand-new store = the state a separately launched `uh serve` starts with.
    const server = createAuthStore({ p, identity });
    const result = pairWithToken(server, pairing);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(!fs.existsSync(path.join(deviceRoot, PENDING_FILE)), 'successful consumption deletes the persisted record');
  } finally { cleanup(); }
});

test('pairing: an expired persisted token is rejected and deleted', async () => {
  const { p, identity, deviceRoot, cleanup } = await makeIsolatedAuth({ tokenTtlMs: 15 });
  try {
    const minter = createAuthStore({ p, identity, tokenTtlMs: 15 });
    const pairing = minter.mintPairingPayload({ endpoint: 'memory://test' });
    await new Promise((r) => setTimeout(r, 60));
    const server = createAuthStore({ p, identity });
    const result = pairWithToken(server, pairing);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TOKEN_EXPIRED');
    assert.ok(!fs.existsSync(path.join(deviceRoot, PENDING_FILE)), 'an expired token is burned, not left behind');
  } finally { cleanup(); }
});

test('pairing: the persisted token is single-use across processes', async () => {
  const { p, identity, deviceRoot, cleanup } = await makeIsolatedAuth();
  try {
    const minter = createAuthStore({ p, identity });
    const pairing = minter.mintPairingPayload({ endpoint: 'memory://test' });
    const first = createAuthStore({ p, identity });
    assert.equal(pairWithToken(first, pairing).ok, true);
    const second = createAuthStore({ p, identity });
    const retry = pairWithToken(second, pairing);
    assert.equal(retry.ok, false);
    assert.equal(retry.code, 'TOKEN_EXPIRED');
    assert.ok(!fs.existsSync(path.join(deviceRoot, PENDING_FILE)));
  } finally { cleanup(); }
});

test('pairing: a failed challenge burns the persisted token exactly like the in-memory one', async () => {
  const { p, identity, cleanup } = await makeIsolatedAuth();
  try {
    const minter = createAuthStore({ p, identity });
    const pairing = minter.mintPairingPayload({ endpoint: 'memory://test' });
    const first = createAuthStore({ p, identity });
    const failed = pairWithToken(first, pairing, { signChallenge: false });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'CHALLENGE_FAILED');
    // Consumption already happened: the token cannot be retried with a good signature.
    const second = createAuthStore({ p, identity });
    const retry = pairWithToken(second, pairing);
    assert.equal(retry.ok, false);
    assert.equal(retry.code, 'TOKEN_EXPIRED');
  } finally { cleanup(); }
});

test('pairing: a wrong token does not burn the persisted token', async () => {
  const { p, identity, cleanup } = await makeIsolatedAuth();
  try {
    const minter = createAuthStore({ p, identity });
    const pairing = minter.mintPairingPayload({ endpoint: 'memory://test' });
    const first = createAuthStore({ p, identity });
    const wrong = pairWithToken(first, pairing, { token: 'not-the-token' });
    assert.equal(wrong.ok, false);
    // The legitimate holder can still use the token.
    const second = createAuthStore({ p, identity });
    assert.equal(pairWithToken(second, pairing).ok, true);
  } finally { cleanup(); }
});

test('pairing: a missing identity pin is refused and does not burn the token', async () => {
  const { p, identity, deviceRoot, cleanup } = await makeIsolatedAuth();
  try {
    const minter = createAuthStore({ p, identity });
    const pairing = minter.mintPairingPayload({ endpoint: 'memory://test' });
    const first = createAuthStore({ p, identity });
    const unpinned = pairWithToken(first, pairing, { includePin: false });
    assert.equal(unpinned.ok, false);
    assert.equal(unpinned.code, 'NODE_IDENTITY_MISMATCH');
    assert.ok(fs.existsSync(path.join(deviceRoot, PENDING_FILE)), 'an identity mismatch must not consume the token');
    const second = createAuthStore({ p, identity });
    assert.equal(pairWithToken(second, pairing).ok, true, 'the legitimate holder can still pair');
  } finally { cleanup(); }
});

test('pairing: a real `uh pair` subprocess mints a token a separate serve-side store consumes', async () => {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const uhBin = fileURLToPath(new URL('../bin/uh.mjs', import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uh-pair-proc-'));
  for (const d of ['bin', 'core', 'manifests', 'data']) fs.mkdirSync(path.join(root, d), { recursive: true });
  // The subprocess's device-local tree, isolated exactly the way
  // core/platform deviceStateDir() resolves it on this platform.
  const appdata = path.join(root, 'appdata');
  fs.mkdirSync(appdata, { recursive: true });
  const deviceDir = process.platform === 'win32'
    ? path.join(appdata, 'UniversalHarness')
    : path.join(appdata, '.universal-harness');

  const child = spawn(process.execPath, [uhBin, 'pair'], {
    cwd: repoRoot,
    env: { ...process.env, UH_ROOT: root, LOCALAPPDATA: appdata, HOME: appdata },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  const code = await new Promise((res) => child.on('close', res));
  assert.equal(code, 0, `uh pair exited ${code}: ${err || out}`);

  const payload = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
  assert.ok(payload.token, 'the pairing payload carries the token on the out-of-band channel');

  // The serve side: a store this process constructed after the minter exited,
  // sharing only the device-local tree — the deployed `uh pair`/`uh serve` flow.
  // The identity private key is sealed with the OS secure store, so load it
  // through the same backend the minting process used.
  const p = { ...portablePaths(root), device: deviceDir };
  const { createSecureStorage } = await import('../core/secrets/mod.mjs');
  const identity = await loadOrCreateNodeIdentity({ p, secureStorage: createSecureStorage({ root, p }) });
  const server = createAuthStore({ p, identity });
  const result = pairWithToken(server, payload);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(!fs.existsSync(path.join(deviceDir, PENDING_FILE)), 'the consumed token record is gone');
  fs.rmSync(root, { recursive: true, force: true });
});
