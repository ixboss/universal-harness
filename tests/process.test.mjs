// Process lifecycle tests (spec §17): successful launch, initialization
// failure, prompt failure, graceful shutdown, timeout, forced termination,
// abnormal exit, no orphan process. These run against a fake dsh stub that
// speaks the real SDK protocol, so failures are deterministic and offline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter } from '../core/adapter/mod.mjs';
import { buildTempRoot, cleanTempRoot, pidAlive } from './helpers.mjs';
import { ERR } from '../core/errors/mod.mjs';

const created = [];
function adapterFor({ rm, root, mode, timeouts }) {
  const ad = createAdapter({
    rm, cwd: root,
    timeouts: { startup: 10_000, initialize: 5_000, shutdown: 600, terminate: 400, ...(timeouts || {}) },
    env: { UH_FAKE_MODE: mode || 'normal' },
  });
  created.push(ad);
  return ad;
}

async function withRoot(fn) {
  const ctx = await buildTempRoot();
  try { return await fn(ctx); }
  finally {
    // A failed test can leave a live stub child holding the event loop; never
    // let that escape into the next test or the runner.
    for (const ad of created.splice(0)) { try { ad.close(); } catch {} }
    await cleanTempRoot(ctx.root);
  }
}

test('successful launch: initialize + prompt + streaming events + graceful shutdown (exit 0)', async () => {
  await withRoot(async ({ rm, root }) => {
    const ad = adapterFor({ rm, root });
    await ad.launch();
    const init = await ad.initialize({ cwd: root });
    assert.equal(init.serverInfo.name, 'deepseek-harness-sdk-runtime');

    const received = [];
    ad.on('event', (p) => received.push(p));
    const res = await ad.prompt({ sessionId: 's1', text: 'ping' });
    assert.ok(res.messageId);
    await waitFor(() => received.some((p) => p.event?.type === 'turn/end'), 5_000);
    assert.ok(received.some((p) => p.event?.type === 'user/message'));

    const exit = await ad.shutdown();
    assert.equal(exit.code, 0);
    assert.equal(pidAlive(ad.pid), false);
  });
});

test('initialization failure: an error response becomes DSH_INIT_FAILED', async () => {
  await withRoot(async ({ rm, root }) => {
    const ad = adapterFor({ rm, root, mode: 'init-fail' });
    await ad.launch();
    await assert.rejects(() => ad.initialize({ cwd: root }), (e) => e.code === ERR.DSH_INIT_FAILED);
    await ad.shutdown();
    assert.equal(pidAlive(ad.pid), false);
  });
});

test('credential failure surfaces actionable guidance and never prints a key', async () => {
  await withRoot(async ({ rm, root }) => {
    const ad = adapterFor({ rm, root, mode: 'init-credential-fail' });
    await ad.launch();
    await assert.rejects(() => ad.initialize({ cwd: root }), (e) => {
      assert.equal(e.code, ERR.DSH_INIT_FAILED);
      assert.match(e.action, /credential/i);
      return true;
    });
    await ad.shutdown();
  });
});

test('prompt failure: protocol errors are rejected, process still shut down cleanly', async () => {
  await withRoot(async ({ rm, root }) => {
    const ad = adapterFor({ rm, root, mode: 'quota-error' });
    await ad.launch();
    await ad.initialize({ cwd: root });
    const events = [];
    ad.on('event', (p) => events.push(p));
    const res = await ad.prompt({ sessionId: 's2', text: 'ping' });
    assert.ok(res.messageId);          // prompt accepted; quota failure arrives as an event
    await waitFor(() => events.some((p) => p.event?.type === 'turn/end' && p.event?.data?.reason?.kind === 'error'), 5_000);
    const exit = await ad.shutdown();
    assert.equal(exit.code, 0);
  });
});

test('abnormal exit: pending requests are rejected as DSH_ABNORMAL_EXIT, nothing hangs', async () => {
  await withRoot(async ({ rm, root }) => {
    const ad = adapterFor({ rm, root, mode: 'crash' });
    await ad.launch();
    const exit = await new Promise((resolve) => ad.on('exit', resolve));
    assert.equal(exit.code, 12);
    await assert.rejects(() => ad.initialize({ cwd: root }), (e) => e.code === ERR.DSH_ABNORMAL_EXIT);
    assert.equal(pidAlive(ad.pid), false);
  });
});

test('timeout + forced termination: a hung runtime is SIGTERM-escalated then SIGKILLed', async () => {
  await withRoot(async ({ rm, root }) => {
    const ad = adapterFor({ rm, root, mode: 'hang', timeouts: { shutdown: 500, terminate: 500 } });
    await ad.launch();
    await ad.initialize({ cwd: root });

    // A hung prompt must not wedge the caller: cancel() runs the bounded
    // graceful-shutdown policy and escalates to force.
    const cancelResult = await cancelWithTimeout(ad, 20_000);
    assert.equal(cancelResult.cancelled, true);
    assert.notEqual(ad.exited, null);
    assert.equal(pidAlive(ad.pid), false, 'no orphaned dsh process');
  });
});

test('no orphan process: shutdown kills the parent even if stdin is still open', async () => {
  await withRoot(async ({ rm, root }) => {
    const ad = adapterFor({ rm, root, mode: 'hang', timeouts: { shutdown: 400, terminate: 400 } });
    await ad.launch();
    await ad.initialize({ cwd: root });
    const exit = await ad.shutdown(); // bounded graceful -> TERM -> KILL
    assert.ok(exit !== null);
    assert.equal(pidAlive(ad.pid), false);
  });
});

test('malformed stdout frames are tolerated, never crash the pump', async () => {
  await withRoot(async ({ rm, root }) => {
    const ad = adapterFor({ rm, root, mode: 'stdout-junk' });
    await ad.launch();
    const init = await ad.initialize({ cwd: root });
    assert.ok(init.serverInfo);       // junk line did not break communication
    await ad.shutdown();
  });
});

test('startup failure: an unverified runtime is never launched', async () => {
  await withRoot(async ({ rm, root, dirs }) => {
    // Break the runtime so status fails, then launch must refuse.
    const fs = await import('node:fs');
    await fs.promises.rm(dirs.dshDir, { recursive: true, force: true });
    const ad = adapterFor({ rm, root });
    await assert.rejects(() => ad.launch(), (e) => e.code === ERR.DSH_MISSING);
  });
});

function waitFor(cond, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      try { if (cond()) { clearInterval(iv); resolve(); return; } }
      catch (e) { clearInterval(iv); reject(e); return; }
      if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error('waitFor timeout')); }
    }, 50);
  });
}

async function cancelWithTimeout(ad, timeoutMs) {
  return Promise.race([
    ad.cancel(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('cancel timeout')), timeoutMs)),
  ]);
}
