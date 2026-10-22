'use strict';

/* Offline tests for session renewal / auth-failure handling. All Leviton HTTP calls
 * go to an in-memory fetch mock; the WebSocket's network methods are stubbed.
 * Run via: npm test (harness.js runs these after the pure-function tests). */

const assert = require('assert');
const LevitonHub = require('../lib/LevitonHub');
const LevitonSocket = require('../lib/LevitonSocket');
const LevitonClient = require('../lib/LevitonClient');
const { registerPairAuth, registerRepairAuth } = require('../lib/authSession');

const { ERR } = LevitonClient;

// Never touch the network from the socket in tests.
LevitonSocket.prototype.connect = async function connect() { this._closing = false; this.connectCalls = (this.connectCalls || 0) + 1; };
const origClose = LevitonSocket.prototype.close;
LevitonSocket.prototype.close = async function close() { this.closeCalls = (this.closeCalls || 0) + 1; return origClose.call(this); };

function mockHomey(initial = {}) {
  const store = new Map(Object.entries(initial));
  const triggers = [];
  const notes = [];
  const timer = (fn, ms) => { const h = setTimeout(fn, ms); if (h.unref) h.unref(); return h; };
  const interval = (fn, ms) => { const h = setInterval(fn, ms); if (h.unref) h.unref(); return h; };
  return {
    triggers,
    notes,
    store,
    settings: {
      get: (k) => (store.has(k) ? store.get(k) : null),
      set: (k, v) => store.set(k, v),
      unset: (k) => store.delete(k),
    },
    setTimeout: timer,
    clearTimeout: (h) => clearTimeout(h),
    setInterval: interval,
    clearInterval: (h) => clearInterval(h),
    flow: { getTriggerCard: (id) => ({ trigger: async (tokens) => { triggers.push({ id, tokens }); } }) },
    notifications: { createNotification: async (n) => { notes.push(n); } },
  };
}

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body };
}

/** Route-based fetch mock. `routes(method, path, headers, body)` returns a response. */
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, auth: init.headers.authorization, body });
    return routes(init.method, path, init.headers, body);
  };
  fn.calls = calls;
  return fn;
}

function mockDevice() {
  const d = { available: true, msg: null };
  d.setAvailable = async () => { d.available = true; d.msg = null; };
  d.setUnavailable = async (m) => { d.available = false; d.msg = m; };
  d.applyState = async () => {};
  return d;
}

const STORED = {
  token: 'old-token', userId: 'u1', user: { id: 'u1' }, email: 'me@example.com', password: 'pw',
};
const loginOk = () => json(200, {
  id: 'new-token', userId: 'u1', ttl: 1209600, created: new Date().toISOString(),
});

function makeHub(settings, routes) {
  const homey = mockHomey(settings);
  const hub = new LevitonHub({ homey });
  const fetchMock = mockFetch(routes);
  hub.client._fetch = fetchMock;
  hub.restoreSession();
  return { hub, homey, fetchMock };
}

const tests = [];
const t = (name, fn) => tests.push({ name, fn });

t('401 -> silent re-login -> request retried once with new token', async () => {
  const { hub, homey, fetchMock } = makeHub(STORED, (m, p, h) => {
    if (p === '/Person/login') return loginOk();
    if (p.endsWith('/residentialPermissions')) return h.authorization === 'new-token' ? json(200, [{ id: 1 }]) : json(401, {});
    return json(404, {});
  });
  const res = await hub.client.getPermissions();
  assert.deepStrictEqual(res, [{ id: 1 }]);
  assert.strictEqual(fetchMock.calls.filter((c) => c.path === '/Person/login').length, 1);
  assert.strictEqual(fetchMock.calls.at(-1).auth, 'new-token');
  assert.strictEqual(homey.settings.get('token'), 'new-token');
  assert.strictEqual(hub.authState, 'ok');
  assert.ok(hub._renewTimer, 'proactive renewal scheduled');
  await hub.stop();
});

t('concurrent 401s share one re-login (single-flight)', async () => {
  const { hub, fetchMock } = makeHub(STORED, (m, p, h) => {
    if (p === '/Person/login') return loginOk();
    return h.authorization === 'new-token' ? json(200, []) : json(401, {});
  });
  await Promise.all([hub.client.getPermissions(), hub.client.getWhems('r1'), hub.client.getPanels('r1')]);
  assert.strictEqual(fetchMock.calls.filter((c) => c.path === '/Person/login').length, 1);
  await hub.stop();
});

t('401 is retried only once (no infinite loop)', async () => {
  const { hub, fetchMock } = makeHub(STORED, (m, p) => (p === '/Person/login' ? loginOk() : json(401, {})));
  await assert.rejects(hub.client.getPermissions(), (e) => e.code === ERR.TOKEN_EXPIRED);
  assert.strictEqual(fetchMock.calls.filter((c) => c.path.endsWith('/residentialPermissions')).length, 2);
  await hub.stop();
});

t('429 maps to RATE_LIMIT and does not kill the socket or mark auth failed', async () => {
  const { hub, homey } = makeHub(STORED, () => json(429, {}));
  hub._started = true;
  const dev = mockDevice();
  hub._devices.set('b1', { kind: 'breaker', device: dev });
  hub._startSocket();
  await assert.rejects(hub.socket._onBeforeReconnect(), (e) => e.code === ERR.RATE_LIMIT);
  assert.ok(!hub.socket.closed, 'socket must keep reconnecting');
  assert.ok(!hub.socket.closeCalls);
  assert.notStrictEqual(hub.authState, 'failed');
  assert.strictEqual(dev.available, true);
  assert.strictEqual(homey.triggers.length, 0);
  await hub.stop();
});

t('403/404 map to a generic API error, not auth (no re-login)', async () => {
  const { hub, fetchMock } = makeHub(STORED, (m, p) => (p.includes('Breakers') ? json(404, {}) : json(403, {})));
  await assert.rejects(hub.client.getBreaker('x'), (e) => e.code === ERR.API);
  await assert.rejects(hub.client.getPermissions(), (e) => e.code === ERR.API);
  assert.strictEqual(fetchMock.calls.filter((c) => c.path === '/Person/login').length, 0);
  await hub.stop();
});

t('406 (2FA) during re-login -> auth_failed once: trigger, notification, unavailable, socket stopped', async () => {
  const { hub, homey } = makeHub(STORED, (m, p) => (p === '/Person/login' ? json(406, {}) : json(401, {})));
  hub._started = true;
  const dev = mockDevice();
  hub._devices.set('b1', { kind: 'breaker', device: dev });
  hub._startSocket();
  await assert.rejects(hub.socket._onBeforeReconnect(), (e) => e.code === ERR.TOKEN_EXPIRED);
  assert.strictEqual(hub.authState, 'failed');
  assert.strictEqual(homey.settings.get('auth_state'), 'failed');
  assert.ok(hub.socket.closed, 'socket stopped');
  assert.strictEqual(dev.available, false);
  assert.strictEqual(dev.msg, 'Leviton sign-in expired - open any breaker and tap Repair');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(homey.triggers.length, 1);
  assert.strictEqual(homey.triggers[0].id, 'auth_failed');
  assert.match(homey.triggers[0].tokens.error, /two-factor/);
  assert.strictEqual(homey.notes.length, 1);
  // Further failures in the same episode: no new trigger/notification, no new login attempts.
  await assert.rejects(hub.client.getPermissions());
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(homey.triggers.length, 1);
  assert.strictEqual(homey.notes.length, 1);
  // Pushed state does not flip devices back to available while signed out.
  hub._dispatch('b1', { online: true });
  assert.strictEqual(dev.available, false);
  await hub.stop();
});

t('Repair (hub.login) ends the episode and restores every device + socket', async () => {
  let loginStatus = 406;
  const { hub } = makeHub(STORED, (m, p, h) => {
    if (p === '/Person/login') return loginStatus === 200 ? loginOk() : json(loginStatus, {});
    return h.authorization === 'new-token' ? json(200, []) : json(401, {});
  });
  hub._started = true;
  const d1 = mockDevice();
  const d2 = mockDevice();
  hub._devices.set('b1', { kind: 'breaker', device: d1 });
  hub._devices.set('p1', { kind: 'panel', device: d2 });
  hub._startSocket();
  await assert.rejects(hub.client.getPermissions());
  assert.strictEqual(hub.authState, 'failed');
  loginStatus = 200;
  await hub.login('me@example.com', 'pw', null, { remember: true });
  assert.strictEqual(hub.authState, 'ok');
  assert.ok(d1.available && d2.available);
  assert.ok(!hub.socket.closed, 'socket revived');
  await hub.stop();
});

t('no stored password + 401 -> auth_failed without a login attempt', async () => {
  const { hub, homey, fetchMock } = makeHub({ ...STORED, password: null }, () => json(401, {}));
  await assert.rejects(hub.client.getPermissions(), (e) => e.code === ERR.TOKEN_EXPIRED);
  assert.strictEqual(hub.authState, 'failed');
  assert.strictEqual(fetchMock.calls.filter((c) => c.path === '/Person/login').length, 0);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(homey.triggers.length, 1);
  await hub.stop();
});

t('network error during re-login backs off instead of failing auth', async () => {
  const { hub, fetchMock } = makeHub(STORED, (m, p) => {
    if (p === '/Person/login') throw new Error('ECONNRESET');
    return json(401, {});
  });
  await assert.rejects(hub.client.getPermissions(), (e) => e.code === ERR.TOKEN_EXPIRED);
  assert.notStrictEqual(hub.authState, 'failed');
  assert.ok(hub._reauthNotBefore > Date.now());
  await assert.rejects(hub.client.getPermissions());
  assert.strictEqual(fetchMock.calls.filter((c) => c.path === '/Person/login').length, 1, 'backoff respected');
  await hub.stop();
});

t('login remember=true stores password; remember=false clears it', async () => {
  const { hub, homey } = makeHub({}, (m, p) => (p === '/Person/login' ? loginOk() : json(200, [])));
  await hub.login('me@example.com', 'secret', null, { remember: true });
  assert.strictEqual(homey.settings.get('password'), 'secret');
  assert.ok(hub.hasStoredCredentials());
  await hub.login('me@example.com', 'secret', null, { remember: false });
  assert.strictEqual(homey.settings.get('password'), null);
  assert.ok(!hub.hasStoredCredentials());
  assert.strictEqual(homey.settings.get('token'), 'new-token');
  await hub.stop();
});

t('validateSession: false on expired token (no creds), true when valid', async () => {
  let valid = false;
  const { hub } = makeHub({ ...STORED, password: null }, () => (valid ? json(200, []) : json(401, {})));
  assert.strictEqual(await hub.validateSession(), false);
  assert.notStrictEqual(hub.authState, 'failed', 'probing from pairing must not raise auth_failed');
  valid = true;
  assert.strictEqual(await hub.validateSession(), true);
  await hub.stop();
});

t('proactive renewal: timer capped and scheduled ~24h before expiry', async () => {
  const { hub } = makeHub(STORED, () => json(200, []));
  const delays = [];
  hub.homey.setTimeout = (fn, ms) => { delays.push(ms); return 1; };
  hub.homey.clearTimeout = () => {};
  hub.client._user = { ttl: 60 * 24 * 3600, created: new Date().toISOString() }; // 60 days
  hub._scheduleProactiveRenewal();
  assert.strictEqual(delays.at(-1), 20 * 24 * 3600 * 1000);
  hub.client._user = { ttl: 3 * 24 * 3600, created: new Date().toISOString() }; // 3 days
  hub._scheduleProactiveRenewal();
  const d = delays.at(-1);
  assert.ok(d > 47 * 3600 * 1000 && d <= 48 * 3600 * 1000, `delay ${d}`);
});

function fakeSession() {
  const h = {};
  return { handlers: h, setHandler: (k, fn) => { h[k] = fn; }, nextView: async () => { h.nexted = true; } };
}

t('repair handler: repaired / twofactor / invalid code / bad password', async () => {
  const outcomes = [null, { code: ERR.TWO_FACTOR }, { code: ERR.INVALID_CODE }, { code: ERR.AUTH, message: 'x' }];
  const seen = [];
  const hub = {
    homey: { settings: { get: () => null } },
    getStoredEmail: () => 'me@example.com',
    login: async (u, p, c, o) => {
      seen.push(o);
      const e = outcomes.shift();
      if (e) throw Object.assign(new Error(e.message || 'err'), { code: e.code });
    },
  };
  const s = fakeSession();
  registerRepairAuth(s, hub);
  assert.strictEqual(await s.handlers.login({ username: 'a', password: 'b' }), 'repaired');
  assert.strictEqual(seen[0].remember, true, 'remember defaults to true');
  assert.strictEqual(await s.handlers.login({ username: 'a', password: 'b' }), 'twofactor');
  await assert.rejects(s.handlers.login({ username: 'a', password: 'b', code: '1' }), /Invalid verification code/);
  await assert.rejects(s.handlers.login({ username: 'a', password: 'b', remember: false }), /Incorrect e-mail or password/);
  assert.strictEqual(seen[3].remember, false);
  assert.deepStrictEqual(await s.handlers.get_login_defaults(), { email: 'me@example.com' });
});

t('pair: login view skipped only when the session validates', async () => {
  let valid = false;
  const hub = { validateSession: async () => valid, getStoredEmail: () => '', homey: { settings: { get: () => null } }, login: async () => {} };
  const s = fakeSession();
  registerPairAuth(s, hub);
  await s.handlers.showView('login');
  assert.ok(!s.handlers.nexted);
  valid = true;
  await s.handlers.showView('login');
  assert.ok(s.handlers.nexted);
  assert.strictEqual(await s.handlers.login({ username: 'a', password: 'b' }), true);
});

module.exports = async function run() {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) {
      failed += 1;
      console.error(`FAIL  ${name}\n      ${err.stack}`);
    }
  }
  return { passed, failed };
};
