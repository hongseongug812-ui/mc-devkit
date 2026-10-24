'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const MinecraftAccount = require('../core/minecraft-account');

const CLIENT_ID = '12345678-1234-1234-1234-123456789abc';
const UUID = '0123456789abcdef0123456789abcdef';
const REFRESH = 'private-microsoft-refresh-token';
const TOKEN = 'private-minecraft-access-token';

function encryptedStorage(backend = 'gnome_libsecret') {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString(text) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(bytes) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
}
function httpError(data, status = 400) {
  return Object.assign(new Error('private server text and private-token'), { response: { data, status }, config: { secret: TOKEN } });
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Account state did not settle');
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-account-'));
  const calls = [], events = [], timers = [];
  let currentTime = 100000;
  const storage = options.secureStorage === undefined ? encryptedStorage() : options.secureStorage;
  const respond = async config => {
    const form = new URLSearchParams(typeof config.data === 'string' ? config.data : '');
    if (config.url.endsWith('/devicecode')) return { device_code: 'private-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 };
    if (config.url.endsWith('/token')) return { access_token: 'private-microsoft-access-token', refresh_token: form.get('grant_type') === 'refresh_token' ? 'rotated-private-refresh-token' : REFRESH };
    if (config.url.includes('user.auth.xboxlive.com')) return { Token: 'private-xbox-token' };
    if (config.url.includes('xsts.auth.xboxlive.com')) return { Token: 'private-xsts-token', DisplayClaims: { xui: [{ uhs: '123456', xid: '123456789' }] } };
    if (config.url.endsWith('/login_with_xbox')) return { access_token: TOKEN, expires_in: 3600 };
    if (config.url.endsWith('/mcstore')) return { items: [{ name: 'game_minecraft' }] };
    if (config.url.endsWith('/profile')) return { id: UUID, name: 'TestPlayer' };
    assert.fail(`Unexpected URL: ${config.url}`);
  };
  const request = async config => {
    calls.push(config);
    const data = options.respond ? await options.respond(config, respond) : await respond(config);
    return { status: 200, data };
  };
  const service = new MinecraftAccount(root, {
    clientId: options.clientId === undefined ? CLIENT_ID : options.clientId,
    secureStorage: storage, request, onChange: status => events.push(status), now: () => currentTime,
    setTimeoutFn: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeoutFn: timer => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
  });
  t.after(async () => { service.close(); await service._diskQueue; await fs.remove(root); });
  const tick = async () => {
    assert.ok(timers.length, 'poll must schedule its next request');
    const timer = timers.shift();
    currentTime += timer.ms;
    timer.fn();
    await new Promise(resolve => setImmediate(resolve));
  };
  const login = async () => { await service.beginLogin(); await tick(); await until(() => !service.status().busy); return service.status(); };
  return { root, service, calls, events, timers, storage, request, tick, login };
}

test('device login returns only public code promptly, then verifies Java ownership and encrypts refresh token', async t => {
  const f = await fixture(t);
  const status = await f.service.beginLogin();
  assert.deepEqual(status.pending, { userCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/devicelogin', expiresAt: 1000000 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers[0].ms, 5000);
  const form = new URLSearchParams(f.calls[0].data);
  assert.equal(form.get('scope'), 'XboxLive.signin offline_access');
  assert.equal(form.get('client_id'), CLIENT_ID);
  await f.tick();
  await until(() => !f.service.status().busy);
  assert.deepEqual(f.service.status().account, { id: UUID, name: 'TestPlayer', persistent: true });
  assert.equal(f.service.status().pending, null);
  const contents = await fs.readFile(f.service.file, 'utf8');
  assert.equal(contents.includes(REFRESH), false);
  assert.equal(contents.includes(TOKEN), false);
  const saved = JSON.parse(contents);
  assert.equal(f.storage.decryptString(Buffer.from(saved.encryptedRefreshToken, 'base64')), REFRESH);
  assert.equal(Object.hasOwn(saved, 'refreshToken'), false);
  assert.equal(JSON.stringify(f.events).includes('private-'), false);
  for (const request of f.calls) {
    assert.equal(request.timeout, 15000);
    assert.equal(request.maxRedirects, 0);
    assert.equal(request.maxContentLength, 1024 * 1024);
    assert.ok(request.signal instanceof AbortSignal);
  }
});

test('pending and slow_down responses respect server polling intervals', async t => {
  let attempts = 0;
  const f = await fixture(t, { respond: async (config, fallback) => {
    if (config.url.endsWith('/token')) {
      attempts++;
      if (attempts === 1) throw httpError({ error: 'authorization_pending' });
      if (attempts === 2) throw httpError({ error: 'slow_down' });
    }
    return fallback(config);
  } });
  await f.service.beginLogin();
  await f.tick();
  assert.equal(f.timers[0].ms, 5000);
  await f.tick();
  assert.equal(f.timers[0].ms, 10000);
  await f.tick();
  await until(() => !f.service.status().busy);
  assert.equal(f.service.status().account.name, 'TestPlayer');
});

test('cancelling an in-flight token request cannot complete or persist a login', async t => {
  const gate = deferred();
  const f = await fixture(t, { respond: async (config, fallback) => config.url.endsWith('/token') ? gate.promise : fallback(config) });
  await f.service.beginLogin();
  await f.tick();
  assert.equal(f.calls.length, 2);
  f.service.cancelLogin();
  assert.equal(f.calls[1].signal.aborted, true);
  gate.resolve({ access_token: 'late-access', refresh_token: 'late-refresh' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.status().account, null);
  assert.equal(f.service.status().pending, null);
  assert.equal(f.calls.length, 2);
  assert.equal(await fs.pathExists(f.service.file), false);
});

test('logout while Java profile request is in flight prevents late account resurrection', async t => {
  const gate = deferred();
  const f = await fixture(t, { respond: async (config, fallback) => config.url.endsWith('/profile') ? gate.promise : fallback(config) });
  await f.service.beginLogin();
  await f.tick();
  await until(() => f.calls.some(call => call.url.endsWith('/profile')));
  await f.service.logout();
  gate.resolve({ id: UUID, name: 'TestPlayer' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.status().account, null);
  assert.deepEqual(await fs.readJson(f.service.file), { version: 1, clientId: CLIENT_ID });
});

test('unavailable or basic_text storage allows only an in-memory session and saves no token', async t => {
  for (const secureStorage of [null, encryptedStorage('basic_text')]) {
    const f = await fixture(t, { secureStorage });
    assert.equal((await f.login()).account.persistent, false);
    assert.deepEqual(await fs.readJson(f.service.file), { version: 1, clientId: CLIENT_ID });
    assert.equal((await f.service.getSession()).accessToken, TOKEN);
  }
});

test('restored encrypted login refreshes Microsoft tokens, rechecks ownership, and rotates saved credentials before launch', async t => {
  const f = await fixture(t);
  await f.login();
  const restored = new MinecraftAccount(f.root, { secureStorage: f.storage, clientId: '', request: f.request });
  t.after(() => restored.close());
  assert.equal((await restored.init()).account.name, 'TestPlayer');
  assert.equal(restored.status().clientId, CLIENT_ID);
  const before = f.calls.length;
  const session = await restored.getSession();
  assert.equal(session.userType, 'msa');
  assert.equal(session.uuid, UUID);
  assert.equal(session.accessToken, TOKEN);
  const form = new URLSearchParams(f.calls[before].data);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), REFRESH);
  assert.ok(f.calls.slice(before).some(call => call.url.endsWith('/mcstore')));
  assert.ok(f.calls.slice(before).some(call => call.url.endsWith('/profile')));
  const saved = await fs.readJson(f.service.file);
  assert.equal(f.storage.decryptString(Buffer.from(saved.encryptedRefreshToken, 'base64')), 'rotated-private-refresh-token');
  assert.equal(JSON.stringify(restored.status()).includes(TOKEN), false);
});

test('entitlements and a valid Java profile are both required for a linked account', async t => {
  for (const failure of ['missing-entitlement', 'unrelated-entitlement', 'missing-profile', 'malformed-profile']) {
    const f = await fixture(t, { respond: async (config, fallback) => {
      if (config.url.endsWith('/mcstore') && failure.endsWith('entitlement')) return { items: failure.startsWith('unrelated') ? [{ name: 'bedrock' }] : [] };
      if (config.url.endsWith('/profile') && failure === 'missing-profile') throw httpError({}, 404);
      if (config.url.endsWith('/profile') && failure === 'malformed-profile') return { id: 'invalid', name: '<script>' };
      return fallback(config);
    } });
    const status = await f.login();
    assert.equal(status.account, null, failure);
    assert.ok(status.error);
    assert.equal(await fs.pathExists(f.service.file), false);
  }
});

test('expired and declined logins stop polling without exposing server error details', async t => {
  for (const code of ['expired_token', 'authorization_declined', 'access_denied']) {
    const f = await fixture(t, { respond: async (config, fallback) => {
      if (config.url.endsWith('/token')) throw httpError({ error: code, error_description: TOKEN });
      return fallback(config);
    } });
    const status = await f.login();
    assert.equal(status.account, null);
    assert.equal(status.pending, null);
    assert.ok(status.error);
    assert.equal(f.timers.length, 0);
    assert.equal(JSON.stringify(status).includes(TOKEN), false);
  }
});

test('client ID configuration is validated and changing it clears previous account credentials', async t => {
  const f = await fixture(t, { clientId: '' });
  await assert.rejects(f.service.beginLogin(), /클라이언트 ID/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.service.configure('borrowed-client-id'), /클라이언트 ID/);
  await f.service.configure(CLIENT_ID);
  await f.login();
  const nextId = '87654321-4321-4321-4321-cba987654321';
  await f.service.configure(nextId);
  assert.equal(f.service.status().account, null);
  assert.deepEqual(await fs.readJson(f.service.file), { version: 1, clientId: nextId });
});

test('credentials encrypted for another OS keychain are rejected without exposing ciphertext or plaintext', async t => {
  const f = await fixture(t);
  await f.login();
  const restored = new MinecraftAccount(f.root, { secureStorage: encryptedStorage(), clientId: CLIENT_ID, request: f.request });
  t.after(() => restored.close());
  const status = await restored.init();
  assert.equal(status.account, null);
  assert.ok(status.error);
  assert.equal(JSON.stringify(status).includes('private-'), false);
  await assert.rejects(restored.getSession(), /먼저 연결/);
});

test('refresh failure blocks launch and never leaks the upstream error or secrets', async t => {
  let refuse = false;
  const f = await fixture(t, { respond: async (config, fallback) => {
    if (refuse && config.url.endsWith('/token')) throw httpError({ error: 'invalid_grant', error_description: REFRESH });
    return fallback(config);
  } });
  await f.login();
  refuse = true;
  await assert.rejects(f.service.getSession(), error => {
    assert.equal(error.code, 'refresh');
    assert.equal(JSON.stringify(error).includes('private-'), false);
    assert.equal(error.message.includes(REFRESH), false);
    return true;
  });
  assert.equal(f.service.status().busy, false);
  assert.equal(JSON.stringify(f.service.status()).includes('private-'), false);
});

test('a refresh may update the player name but cannot switch Minecraft identity', async t => {
  let refreshed = false;
  const f = await fixture(t, { respond: async (config, fallback) => {
    if (refreshed && config.url.endsWith('/profile')) return { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'OtherPlayer' };
    return fallback(config);
  } });
  await f.login();
  refreshed = true;
  await assert.rejects(f.service.getSession(), /다시 연결/);
  assert.equal(f.service.status().account.id, UUID);
  assert.equal((await fs.readJson(f.service.file)).account.id, UUID);
});

test('untrusted verification links and device response text never reach public status', async t => {
  const f = await fixture(t, { respond: async (config, fallback) => {
    const response = await fallback(config);
    if (config.url.endsWith('/devicecode')) return { ...response, verification_uri: 'https://microsoft.com.evil.example/devicelogin', message: TOKEN };
    return response;
  } });
  await assert.rejects(f.service.beginLogin(), /Microsoft 로그인/);
  assert.equal(f.service.status().pending, null);
  assert.equal(JSON.stringify(f.events).includes(TOKEN), false);
});

test('closing a pending login aborts its request and cancels timers', async t => {
  const f = await fixture(t);
  await f.service.beginLogin();
  assert.equal(f.timers.length, 1);
  f.service.close();
  assert.equal(f.timers.length, 0);
  assert.equal(f.calls[0].signal.aborted, true);
  await assert.rejects(f.service.beginLogin(), /종료/);
  assert.equal(await fs.pathExists(f.service.file), false);
});

test('cancellation during the final disk rename cannot publish or retain the pending account', async t => {
  const f = await fixture(t);
  const originalRename = fs.rename;
  fs.rename = async (source, destination) => {
    await originalRename(source, destination);
    if (destination === f.service.file) f.service.cancelLogin();
  };
  try {
    await f.service.beginLogin();
    await f.tick();
    await until(() => !f.service.status().busy);
    await f.service._diskQueue;
    assert.equal(f.service.status().account, null);
    assert.equal(await fs.pathExists(f.service.file), false);
  } finally { fs.rename = originalRename; }
});

test('an encryption failure removes previously saved credentials instead of keeping stale refresh tokens', async t => {
  const f = await fixture(t);
  await f.login();
  f.storage.encryptString = () => { throw Error(TOKEN); };
  const session = await f.service.getSession();
  assert.equal(session.accessToken, TOKEN);
  assert.equal(f.service.status().account.persistent, false);
  assert.deepEqual(await fs.readJson(f.service.file), { version: 1, clientId: CLIENT_ID });
  assert.equal(JSON.stringify(f.events).includes(TOKEN), false);
});

test('cancelling a replacement login during persistence preserves the previously connected account on disk', async t => {
  const f = await fixture(t);
  await f.login();
  const previous = await fs.readFile(f.service.file, 'utf8');
  const originalRename = fs.rename;
  let intercepted = false;
  fs.rename = async (source, destination) => {
    await originalRename(source, destination);
    if (destination === f.service.file && !intercepted) {
      intercepted = true;
      f.service.cancelLogin();
    }
  };
  try {
    await f.service.beginLogin();
    await f.tick();
    await until(() => !f.service.status().busy);
    await f.service._diskQueue;
    assert.equal(await fs.readFile(f.service.file, 'utf8'), previous);
    assert.equal(f.service.status().account.persistent, true);
  } finally { fs.rename = originalRename; }
});
