// Security tests (spec §17): credentials never appear in logs, credentials
// never appear in portable state, an invalid runtime hash prevents execution,
// and secrets are sealed by the OS (Windows DPAPI) — or fail explicitly.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../core/logging/mod.mjs';
import { redact, redactObject, describeEnvSafe } from '../core/errors/mod.mjs';
import { createSecureStorage } from '../core/secrets/mod.mjs';
import { createConfig } from '../core/config/mod.mjs';
import { isWindows } from '../core/platform/mod.mjs';
import { taskEnvAllowlist } from '../core/executor/mod.mjs';

// Deliberately non-real inputs to the redaction tests below.
const SECRET = 'sk-deadbeefcafebabe1234567890abcdef'; // uh-secret-fixture

test('redaction: api keys, bearer tokens, and private keys are masked', () => {
  assert.equal(redact(`key: ${SECRET}`), 'key: [REDACTED]');
  assert.equal(/deadbeef/.test(redact(`bearer Bearer ${SECRET}`)), false);
  assert.equal(/\[REDACTED\]/.test(redact('Bearer abcdef1234567890abcdef1234567890')), true);
  // fake PEM armor — redaction must mask it whole.
  assert.equal(redact('-----BEGIN RSA PRIVATE KEY-----\nCONTENT\n-----END RSA PRIVATE KEY-----'), '[REDACTED]'); // uh-secret-fixture
  assert.equal(redact('plain text without secrets'), 'plain text without secrets');
});

test('redaction is recursive for structured context', () => {
  const out = redactObject({ token: SECRET, nested: { key: SECRET }, count: 3 });
  assert.equal(out.token, '[REDACTED]');
  assert.equal(out.nested.key, '[REDACTED]');
  assert.equal(out.count, 3);
});

test('logger: a secret written through the logger never reaches the log file', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'uh-log-'));
  try {
    const log = createLogger({ logDir: dir, level: 'debug', console: false });
    log.info('sending credential', { apiKey: SECRET, model: 'deepseek-official' });
    log.error(SECRET);
    const text = fs.readFileSync(path.join(dir, 'uh.log'), 'utf8');
    assert.equal(/deadbeef/.test(text), false);
    assert.equal(/\[REDACTED\]/.test(text), true);
    // The healthy fields survive.
    assert.equal(/deepseek-official/.test(text), true);
  } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
});

test('env summary: sensitive variables are reported as lengths, never values', () => {
  const before = process.env.UH_TEST_FAKE_API_KEY;
  process.env.UH_TEST_FAKE_API_KEY = SECRET;
  try {
    const summary = describeEnvSafe();
    const entry = summary.detail['UH_TEST_FAKE_API_KEY'];
    assert.ok(entry);
    assert.equal(/deadbeef/.test(entry), false);
    assert.equal(/REDACTED/.test(entry), true);
  } finally {
    if (before === undefined) delete process.env.UH_TEST_FAKE_API_KEY;
    else process.env.UH_TEST_FAKE_API_KEY = before;
  }
});

// ---------------------------------------------------------------------------
// OS secure storage
// ---------------------------------------------------------------------------

test('secrets: Windows DPAPI round trip stores a sealed blob outside the portable tree', async () => {
  if (!isWindows) { test.skip('DPAPI backend is Windows-only; other platforms fail explicitly (tested below)'); return; }
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'uh-sec-'));
  try {
    const p = { data: path.join(root, 'data'), device: path.join(os.tmpdir(), `uh-sec-dev-${process.pid}`) };
    const storage = createSecureStorage({ root, p });
    await storage.set('provider-key', SECRET);
    const readBack = await storage.get('provider-key');
    assert.equal(readBack, SECRET);

    // The blob lives under the device directory, never in the portable tree.
    const info = storage.describe();
    assert.ok(info.storeDir.startsWith(p.device), `${info.storeDir} must live under the device directory`);
    const blob = path.join(info.storeDir, 'provider-key.blob');
    const raw = fs.readFileSync(blob, 'utf8');
    assert.equal(/deadbeef/.test(raw), false); // value is not present in cleartext

    await storage.remove('provider-key');
    assert.equal(await storage.get('provider-key'), null);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('config: secrets are never written into the portable config', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'uh-cfg-'));
  try {
    const config = createConfig({ root, p: { data: path.join(root, 'data'), device: path.join(os.tmpdir(), `uh-cfg-dev-${process.pid}`) } });
    config.save({ workspace: { defaultLabel: 'mine' } });

    // Secret storage, when available, stays off the portable tree.
    try {
      await config.setSecret('provider-key', SECRET);
      const files = walk(path.join(root, 'data'));
      assert.deepEqual(files.filter((f) => f.endsWith('.blob')), []);
      const text = JSON.stringify(files) + fs.readFileSync(config.configPath, 'utf8');
      assert.equal(/deadbeef/.test(text), false);
      assert.equal(await config.getSecret('provider-key'), SECRET);
    } catch (e) {
      // On platforms without OS secure storage this must fail *explicitly* —
      // silently storing plaintext is forbidden.
      assert.equal(e.code, 'SECURE_STORAGE_UNAVAILABLE');
    }
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

test('audit 1.1: the task environment allowlist drops unrelated secrets, keeps runtime + provider vars', () => {
  const allow = taskEnvAllowlist({
    PATH: '/usr/bin', SystemRoot: 'C:\Windows', COMSPEC: 'cmd.exe',
    HOME: '/home/op', TEMP: '/tmp',
    DSH_HOME: '/home/op/.dsh',
    HTTP_PROXY: 'http://proxy:8080', NO_PROXY: 'localhost',
    DEEPSEEK_API_KEY: 'sk-provider', UH_ADAPTER: 'deepseek', UH_TUNE_X: '1',
    // Unrelated operator secrets must never reach a task child:
    AWS_SECRET_ACCESS_KEY: 'aws-secret', MY_DB_PASSWORD: 'hunter2',
    GITHUB_TOKEN: 'ghp_x', STRIPE_KEY: 'sk_live_x',
  });
  assert.equal(allow.PATH, '/usr/bin');
  assert.equal(allow.SystemRoot, 'C:\Windows');
  assert.equal(allow.DSH_HOME, '/home/op/.dsh');
  assert.equal(allow.HTTP_PROXY, 'http://proxy:8080');
  assert.equal(allow.DEEPSEEK_API_KEY, 'sk-provider');
  assert.equal(allow.UH_ADAPTER, 'deepseek');
  assert.equal(allow.UH_TUNE_X, '1');
  assert.equal('AWS_SECRET_ACCESS_KEY' in allow, false);
  assert.equal('MY_DB_PASSWORD' in allow, false);
  assert.equal('GITHUB_TOKEN' in allow, false);
  assert.equal('STRIPE_KEY' in allow, false);
});
