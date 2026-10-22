'use strict';

const LevitonClient = require('./LevitonClient');
const LevitonSocket = require('./LevitonSocket');
const N = require('./normalize');
const { MODEL, TIMINGS } = require('./constants');

const { ERR, AUTH_FAILURE_CODES } = LevitonClient;

const AUTH_FAILED_MESSAGE = 'Leviton sign-in expired - open any breaker and tap Repair';
const DAY = 24 * 60 * 60 * 1000;
// Renew this long before the Leviton token's created+ttl expiry.
const RENEW_BEFORE_EXPIRY = DAY;
// Homey's setTimeout is backed by a 32-bit ms delay (~24.8 days); stay well under it.
const MAX_TIMER = 20 * DAY;
// Network/rate-limit backoff for automatic re-login: 30s, 1m, 2m, 4m ... capped at 30 min.
const REAUTH_BACKOFF_BASE = 30 * 1000;
const REAUTH_BACKOFF_MAX = 30 * 60 * 1000;

/**
 * App-level orchestrator: owns ONE shared REST client, ONE WebSocket, and ONE poll
 * loop, and fans normalized state out to the registered Homey devices. Devices are
 * thin capability sinks that register/unregister themselves here by Leviton id.
 */
class LevitonHub {
  constructor({ homey, log = () => {}, error = () => {} }) {
    this.homey = homey;
    this.log = log;
    this.error = error;

    this.client = new LevitonClient({
      log,
      error,
      // A 401 on any authenticated REST call triggers one silent re-login + retry.
      onUnauthorized: () => this._reauth('unauthorized'),
    });
    this.socket = null;

    // 'unknown' until proven; 'ok' after a validated/renewed session; 'failed' when the
    // user must sign in again (bad password / 2FA / no stored credentials).
    this._authState = 'unknown';
    this._reauthInFlight = null;
    this._reauthFailures = 0;
    this._reauthNotBefore = 0;
    this._renewTimer = null;

    // Registered devices: id -> { kind: 'breaker'|'panel'|'ct', device }
    this._devices = new Map();
    // Raw object caches keyed by Leviton id (merge target for partial WS pushes).
    this._raw = { breakers: new Map(), whems: new Map(), panels: new Map(), cts: new Map() };
    // Monotonic lifetime-energy accumulators keyed by id.
    this._lifetime = new Map();
    // Last normalized state per id (pushed to a device on (re)register).
    this._lastState = new Map();

    this._started = false;
    this._pollTimer = null;
    this._bandwidthTimer = null;
    this._bandwidthFailures = 0;
    this._bandwidthSkip = 0;
  }

  get options() {
    const s = this.homey.settings;
    return {
      readOnly: !!s.get('read_only'),
      calculatedCurrent: !!s.get('calculated_current'),
      voltage208: !!s.get('voltage_208'),
      hideDummy: !!s.get('hide_dummy'),
      showEnergyImport: !!s.get('show_energy_import'),
      staggerDelay: Number(s.get('stagger_delay')) || 2,
    };
  }

  // ---- Session ----------------------------------------------------------

  get authState() { return this._authState; }

  hasSession() {
    return !!this.homey.settings.get('token');
  }

  /** True when the user opted in to "Stay signed in" (email + password kept on the Homey). */
  hasStoredCredentials() {
    return !!(this.homey.settings.get('email') && this.homey.settings.get('password'));
  }

  getStoredEmail() {
    return this.homey.settings.get('email') || '';
  }

  restoreSession() {
    const token = this.homey.settings.get('token');
    if (!token) return false;
    this.client.restoreSession({
      token,
      userId: this.homey.settings.get('userId'),
      user: this.homey.settings.get('user') || {},
    });
    return true;
  }

  persistSession() {
    this.homey.settings.set('token', this.client.token);
    this.homey.settings.set('userId', this.client.userId);
    this.homey.settings.set('user', this.client.user);
  }

  /**
   * Does the stored token still work? Used by pairing to decide whether the login view
   * can be skipped. A 401 first tries a silent re-login with stored credentials (if the
   * user opted in); any failure returns false so the login view is shown.
   */
  async validateSession() {
    if (!this.hasSession()) return false;
    if (!this.client.isAuthenticated) this.restoreSession();
    try {
      // Silent re-login only if the user opted in to "Stay signed in"; otherwise just probe.
      await this.client.getPermissions({ reauth: this.hasStoredCredentials() });
      return true;
    } catch (err) {
      if (err.code !== ERR.TOKEN_EXPIRED && err.code !== ERR.AUTH) {
        this.error(`Session validation failed: ${err.message}`);
      }
      return false;
    }
  }

  /**
   * Interactive log in (pairing / repair). Persists the session app-wide and recovers
   * every device, so one Repair fixes them all.
   * @param {boolean} [opts.remember=true] keep e-mail + password so the app can sign
   *   back in automatically; false clears any stored password.
   */
  async login(email, password, code, { remember = true } = {}) {
    await this.client.login(email, password, code);
    this.homey.settings.set('email', email);
    if (remember) this.homey.settings.set('password', password);
    else this.homey.settings.unset('password');
    this.persistSession();
    this._reauthFailures = 0;
    this._reauthNotBefore = 0;
    await this._onAuthRecovered('login');
    return true;
  }

  /**
   * Silent re-login with stored credentials. Single-flight: concurrent callers share
   * one attempt. Resolves true when a fresh token is in place.
   */
  _reauth(reason) {
    if (this._reauthInFlight) return this._reauthInFlight;
    this._reauthInFlight = this._doReauth(reason).finally(() => { this._reauthInFlight = null; });
    return this._reauthInFlight;
  }

  async _doReauth(reason) {
    // Never hammer Leviton with credentials that already failed — wait for a Repair.
    if (this._authState === 'failed') return false;
    if (!this.hasStoredCredentials()) {
      this._authFailed('Session expired and "Stay signed in" is off');
      return false;
    }
    if (Date.now() < this._reauthNotBefore) {
      this.log(`Re-login (${reason}) skipped: backing off after a network error`);
      return false;
    }
    this.log(`Leviton session renewal (${reason})...`);
    try {
      await this.client.login(this.homey.settings.get('email'), this.homey.settings.get('password'));
    } catch (err) {
      if (AUTH_FAILURE_CODES.has(err.code)) {
        const why = err.code === ERR.TWO_FACTOR
          ? 'Leviton requires a two-factor code'
          : `Leviton rejected the stored credentials (${err.message})`;
        this._authFailed(why);
        return false;
      }
      // Network / server / rate limit: transient — back off, keep devices as they are.
      this._reauthFailures = Math.min(this._reauthFailures + 1, 12);
      const delay = Math.min(REAUTH_BACKOFF_BASE * (2 ** (this._reauthFailures - 1)), REAUTH_BACKOFF_MAX);
      this._reauthNotBefore = Date.now() + delay;
      this.error(`Re-login (${reason}) failed (${err.code}): ${err.message}; retry allowed in ${Math.round(delay / 1000)}s`);
      if (reason === 'proactive') this._setRenewTimer(Math.max(delay, 60 * 60 * 1000));
      return false;
    }
    this._reauthFailures = 0;
    this._reauthNotBefore = 0;
    this.persistSession();
    this.log(`Leviton session renewed (${reason})`);
    await this._onAuthRecovered(reason);
    return true;
  }

  /**
   * A valid session is (back) in place: clear the failure episode, revive the socket,
   * refresh data and make every registered device available again.
   */
  async _onAuthRecovered(reason) {
    const wasFailed = this._authState === 'failed';
    this._setAuthState('ok');
    this._scheduleProactiveRenewal();
    if (!this._started) {
      // Pairing before any device exists: devices start the hub when they register.
      if (this._devices.size) this.start().catch(this.error);
      return;
    }
    // _authFailed() closed the socket (halting its reconnect loop) — revive it. A socket
    // that is merely mid-reconnect picks up the new token on its own.
    if (!this.socket) this._startSocket();
    else if (this.socket.closed) {
      this.socket.connect().catch((err) => this.error(`WS reconnect after sign-in failed: ${err.message}`));
    }
    // A silent renewal (proactive / 401 retry) needs nothing more; after a failure
    // episode or an interactive sign-in, bring every device back.
    if (!wasFailed && reason !== 'login') return;
    this.log('Leviton sign-in restored for all devices');
    for (const { device } of this._devices.values()) {
      Promise.resolve(device.setAvailable()).catch(() => {});
    }
    // Re-apply cached state (offline breakers go back to their own "offline" message),
    // then refresh from REST. Not awaited: we may be inside a 401 retry of a discovery.
    this._dispatchAll();
    this.refreshDiscovery().catch((err) => this.error(`refresh after sign-in failed: ${err.message}`));
  }

  /**
   * The user has to sign in again. Once per failure episode: mark everything
   * unavailable, stop the socket, fire the Flow trigger and a timeline notification.
   */
  _authFailed(msg) {
    if (this._authState === 'failed') return;
    this._setAuthState('failed');
    this.error(`Leviton sign-in failed: ${msg}`);
    this._clearRenewTimer();
    this._markAllUnavailable(AUTH_FAILED_MESSAGE);
    if (this.socket) this.socket.close().catch(() => {});
    try {
      const card = this.homey.flow.getTriggerCard('auth_failed');
      Promise.resolve(card.trigger({ error: String(msg) })).catch((e) => this.error(`auth_failed trigger: ${e.message}`));
    } catch (e) { this.error(`auth_failed trigger: ${e.message}`); }
    try {
      Promise.resolve(this.homey.notifications.createNotification({
        excerpt: `Leviton Load Center: sign-in expired (${msg}). Open any breaker and tap Repair to sign in again.`,
      })).catch((e) => this.error(`notification failed: ${e.message}`));
    } catch (e) { this.error(`notification failed: ${e.message}`); }
  }

  _setAuthState(state) {
    this._authState = state;
    try { this.homey.settings.set('auth_state', state); } catch (e) { /* diagnostics only */ }
  }

  // ---- Proactive token renewal -----------------------------------------

  /** Schedule a silent re-login ~24h before the token's created+ttl expiry. */
  _scheduleProactiveRenewal() {
    this._clearRenewTimer();
    const user = this.client.user || {};
    const ttlSec = Number(user.ttl);
    const created = Date.parse(user.created);
    if (!Number.isFinite(ttlSec) || ttlSec <= 0 || !Number.isFinite(created)) return;
    const expiresAt = created + ttlSec * 1000;
    this.log(`Leviton token expires ${new Date(expiresAt).toISOString()}`);
    if (!this.hasStoredCredentials()) {
      this.log('"Stay signed in" is off: no automatic renewal; Repair will be needed after expiry');
      return;
    }
    this._setRenewTimer(Math.max(expiresAt - RENEW_BEFORE_EXPIRY - Date.now(), 5000));
  }

  _setRenewTimer(delay) {
    this._clearRenewTimer();
    const capped = delay > MAX_TIMER;
    this._renewTimer = this.homey.setTimeout(() => {
      this._renewTimer = null;
      if (capped) { this._scheduleProactiveRenewal(); return; } // re-arm until within range
      this._reauth('proactive').catch((err) => this.error(`proactive renewal: ${err.message}`));
    }, capped ? MAX_TIMER : delay);
  }

  _clearRenewTimer() {
    if (this._renewTimer) { this.homey.clearTimeout(this._renewTimer); this._renewTimer = null; }
  }

  // ---- Lifecycle --------------------------------------------------------

  async start() {
    if (this._started) return;
    if (!this.restoreSession()) {
      this.log('No stored session — waiting for pairing.');
      return;
    }
    this._started = true;

    // Validate the restored token up-front; renew it with stored credentials if expired.
    try {
      await this.client.getPermissions({ reauth: false });
      this._setAuthState('ok');
      this._scheduleProactiveRenewal();
    } catch (err) {
      if (err.code === ERR.TOKEN_EXPIRED) {
        // On success _reauth -> _onAuthRecovered starts the socket and discovery itself.
        await this._reauth('startup');
      } else {
        this.error(`Startup token check failed (${err.code}): ${err.message}`);
      }
    }
    if (!this._started) return; // stopped meanwhile

    if (this._authState !== 'failed') {
      // Create the socket BEFORE the first discovery so _rebuildSubscriptions() can
      // register subscriptions (they are flushed to the server on the ready handshake).
      this._startSocket();
      try {
        await this.refreshDiscovery();
      } catch (err) {
        this.error(`Initial discovery failed: ${err.message}`);
      }
    }
    this._startPolling();
  }

  async stop() {
    this._started = false;
    this._clearRenewTimer();
    if (this._pollTimer) { this.homey.clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._bandwidthTimer) { this.homey.clearInterval(this._bandwidthTimer); this._bandwidthTimer = null; }
    if (this.socket) { await this.socket.close(); this.socket = null; }
  }

  // ---- Device registry --------------------------------------------------

  registerDevice(kind, id, device) {
    this._devices.set(String(id), { kind, device });
    const last = this._lastState.get(String(id));
    if (this._authState === 'failed') Promise.resolve(device.setUnavailable(AUTH_FAILED_MESSAGE)).catch(() => {});
    else if (last) Promise.resolve(device.applyState(last)).catch(this.error);
    // Ensure the hub is running once at least one device exists.
    if (!this._started && this.hasSession()) this.start().catch(this.error);
  }

  unregisterDevice(id) {
    this._devices.delete(String(id));
  }

  _dispatch(id, state) {
    this._lastState.set(String(id), state);
    // While signed out, devices stay unavailable with the Repair message.
    if (this._authState === 'failed') return;
    const entry = this._devices.get(String(id));
    if (entry) Promise.resolve(entry.device.applyState(state)).catch(this.error);
  }

  _markAllUnavailable(msg) {
    for (const { device } of this._devices.values()) {
      Promise.resolve(device.setUnavailable(msg)).catch(() => {});
    }
  }

  // ---- Discovery / polling ---------------------------------------------

  /** Full REST discovery walk; caches raw, rebuilds subscriptions, dispatches state. */
  async refreshDiscovery() {
    // Overlap guard: a slow cycle (large account) must not interleave with the next poll.
    if (this._discoveryInFlight) return this._discoveryInFlight;
    this._discoveryInFlight = (async () => {
      const tree = await this.client.discoverTree();
      this._tree = tree;

      // Merge (don't replace) so WS-only fields survive REST polls.
      for (const w of tree.whems) this._mergeRaw('whems', w.id, w);
      for (const p of tree.panels) this._mergeRaw('panels', p.id, p);
      for (const b of tree.breakers) this._mergeRaw('breakers', b.id, b);
      for (const c of tree.cts) this._mergeRaw('cts', c.id, c);
      this._pruneStale(tree);

      this._rebuildSubscriptions();
      this._dispatchAll();
      return tree;
    })();
    try {
      return await this._discoveryInFlight;
    } finally {
      this._discoveryInFlight = null;
    }
  }

  /** Drop cached devices that disappeared from the account (else ghost totals persist). */
  _pruneStale(tree) {
    const keep = {
      whems: new Set(tree.whems.map((w) => String(w.id))),
      panels: new Set(tree.panels.map((p) => String(p.id))),
      breakers: new Set(tree.breakers.map((b) => String(b.id))),
      cts: new Set(tree.cts.map((c) => String(c.id))),
    };
    for (const bucket of Object.keys(keep)) {
      for (const id of this._raw[bucket].keys()) {
        if (!keep[bucket].has(id)) {
          this._raw[bucket].delete(id);
          this._lifetime.delete(`b:${id}`);
          this._lifetime.delete(`bi:${id}`);
          this._lifetime.delete(`c:${id}`);
          this._lastState.delete(id);
        }
      }
    }
  }

  _startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = this.homey.setInterval(() => {
      // Paused while signed out; resumes automatically after _onAuthRecovered().
      if (this._authState === 'failed') return;
      // 401s are handled inside the client (re-login + retry, or _authFailed()).
      this.refreshDiscovery().catch((err) => this.error(`poll failed (${err.code}): ${err.message}`));
    }, TIMINGS.REST_POLL);
  }

  _dispatchAll() {
    // Order matters: breakers and CTs must seed their lifetime accumulators BEFORE
    // hub totals are computed, or a cumulative panel meter would bounce 0 → N kWh
    // (phantom consumption in Homey Energy). _recomputeHubTotals dispatches hubs.
    for (const b of this._raw.breakers.values()) this._updateBreaker(String(b.id));
    for (const c of this._raw.cts.values()) this._updateCt(String(c.id));
    this._recomputeHubTotals();
  }

  // ---- WebSocket --------------------------------------------------------

  _startSocket() {
    if (this.socket) return;
    this.socket = new LevitonSocket({
      client: this.client,
      log: this.log,
      error: this.error,
      onNotification: (modelName, modelId, data) => this._onNotification(modelName, modelId, data),
      onStateChange: (connected) => {
        this.log(`WebSocket ${connected ? 'connected' : 'disconnected'}`);
        // Start the bandwidth keepalive on the first successful ready — NOT on the
        // initial connect promise, which may reject before the socket's own reconnect
        // eventually succeeds. _startBandwidthKeepalive() is idempotent.
        if (connected) this._startBandwidthKeepalive();
      },
    });
    this.socket.onBeforeReconnect = async () => {
      // Re-validate the token before reconnecting. An expired token is renewed silently
      // with stored credentials; only a hard auth failure (wrong password / 2FA / no
      // stored credentials) stops the socket — _authFailed() closes it and prompts Repair.
      // Network errors and 429 just throw, so the socket retries with its own backoff.
      if (this._authState === 'failed') throw new Error('Signed out — waiting for Repair');
      try {
        await this.client.getPermissions({ reauth: false });
        if (this._authState !== 'ok') { this._setAuthState('ok'); this._scheduleProactiveRenewal(); }
      } catch (err) {
        if (err.code !== ERR.TOKEN_EXPIRED) throw err;
        const ok = await this._reauth('websocket');
        if (!ok) throw err;
      }
    };
    this.socket.connect()
      .catch((err) => this.error(`WebSocket connect failed (REST fallback active): ${err.message}`));
  }

  _rebuildSubscriptions() {
    if (!this.socket) return;
    for (const w of this._raw.whems.values()) {
      this.socket.subscribe(MODEL.WHEM, w.id);
      // WHEM FW >= 2.0.0 stopped delivering nested breakers — subscribe each individually.
      if (this._whemMajorVersion(w) >= 2) {
        for (const b of this._raw.breakers.values()) {
          if (b.hubType === 'whem' && String(b.hubId) === String(w.id)) {
            this.socket.subscribe(MODEL.BREAKER, b.id);
          }
        }
      }
    }
    for (const p of this._raw.panels.values()) this.socket.subscribe(MODEL.PANEL, p.id);
  }

  _whemMajorVersion(whem) {
    const v = whem && whem.version ? String(whem.version) : '0';
    return parseInt(v.split('.')[0], 10) || 0;
  }

  _onNotification(modelName, modelId, data) {
    if (modelName === MODEL.WHEM) {
      const nested = data.ResidentialBreaker;
      const cts = data.IotCt;
      const own = { ...data };
      delete own.ResidentialBreaker;
      delete own.IotCt;
      this._mergeRaw('whems', modelId, { ...own, id: modelId });
      if (Array.isArray(nested)) for (const b of nested) this._ingestBreaker(b);
      if (Array.isArray(cts)) for (const c of cts) this._ingestCt(c);
      this._recomputeHubTotals(); // dispatches all whems/panels, incl. this one
    } else if (modelName === MODEL.PANEL) {
      const nested = data.ResidentialBreaker;
      const own = { ...data };
      delete own.ResidentialBreaker;
      this._mergeRaw('panels', modelId, { ...own, id: modelId });
      if (Array.isArray(nested)) for (const b of nested) this._ingestBreaker(b);
      this._recomputeHubTotals();
    } else if (modelName === MODEL.BREAKER) {
      this._ingestBreaker({ ...data, id: modelId });
      this._recomputeHubTotals();
    } else if (modelName === MODEL.CT) {
      this._ingestCt({ ...data, id: modelId });
      this._recomputeHubTotals();
    }
  }

  _mergeRaw(bucket, id, partial) {
    const key = String(id);
    const prev = this._raw[bucket].get(key) || {};
    this._raw[bucket].set(key, { ...prev, ...partial });
  }

  _ingestBreaker(partial) {
    const id = String(partial.id);
    // Preserve hub linkage / model discovered via REST.
    this._mergeRaw('breakers', id, partial);
    this._updateBreaker(id);
  }

  _ingestCt(partial) {
    const id = String(partial.id);
    this._mergeRaw('cts', id, partial);
    this._updateCt(id);
  }

  // ---- Normalization + dispatch ----------------------------------------

  _updateBreaker(id) {
    const raw = this._raw.breakers.get(String(id));
    if (!raw) return;
    const opts = this.options;
    const life = N.breakerLifetimeEnergy(raw, this._lifetime.get(`b:${id}`), { field: 'energyConsumption' });
    this._lifetime.set(`b:${id}`, life);
    // Imported energy (grid import on backfed/solar circuits) — tracked separately.
    const lifeImport = N.breakerLifetimeEnergy(raw, this._lifetime.get(`bi:${id}`), { field: 'energyImport' });
    this._lifetime.set(`bi:${id}`, lifeImport);
    const st = N.mapBreakerState(raw);
    const c = N.classifyBreaker(raw);

    const state = {
      kind: 'breaker',
      id: String(id),
      classify: c,
      power: N.breakerPower(raw),
      current: N.breakerCurrent(raw, opts),
      voltage: N.num(raw.rmsVoltage) || null,
      energy: life.total,
      energyImport: (raw.energyImport != null || raw.energyImport2 != null) ? lifeImport.total : null,
      rating: N.num(raw.currentRating) || null,
      breakerState: st.state,
      on: st.on,
      tripped: st.tripped,
      gfci: st.gfci,
      afci: st.afci,
      reason: st.reason,
      online: st.online,
      diagnostics: {
        model: raw.model,
        serialNumber: raw.serialNumber,
        firmwareBLE: raw.firmwareVersionBLE,
        firmwareMeter: raw.firmwareVersionMeter,
        firmwareProtect: raw.firmwareVersionGFCI || raw.firmwareVersionAFCI || raw.firmwareVersionSiLabs,
        poles: c.poles,
        position: raw.position,
        leg: N.breakerLeg(raw.position, c.poles),
        bleRSSI: raw.bleRSSI,
      },
    };
    this._dispatch(`${id}`, state);
  }

  _updateWhem(id) {
    const raw = this._raw.whems.get(String(id));
    if (!raw) return;
    const totals = this._hubTotals('whem', String(id));
    const state = {
      kind: 'panel',
      hubType: 'whem',
      id: String(id),
      power: totals.power,
      current: totals.current,
      energy: totals.energy,
      voltage: N.legAverage(raw.rmsVoltageA, raw.rmsVoltageB),
      voltageLeg1: N.num(raw.rmsVoltageA) || null,
      voltageLeg2: N.num(raw.rmsVoltageB) || null,
      frequency: N.legAverage(raw.frequencyA, raw.frequencyB),
      frequencyLeg1: N.num(raw.frequencyA) || null,
      frequencyLeg2: N.num(raw.frequencyB) || null,
      powerLeg1: totals.powerLeg1,
      powerLeg2: totals.powerLeg2,
      currentLeg1: totals.currentLeg1,
      currentLeg2: totals.currentLeg2,
      online: raw.connected !== false,
      diagnostics: {
        model: raw.model || 'LWHEM',
        serial: raw.serial,
        firmwareMain: raw.version,
        firmwareBLE: raw.versionBLE,
        firmwareUpdate: raw.downloaded ? 'Update downloaded' : 'Up to date',
        localIP: raw.localIP,
        mac: raw.mac,
        wifiRSSI: raw.rssi,
        residenceId: raw.residenceId,
      },
    };
    this._dispatch(`${id}`, state);
  }

  _updatePanel(id) {
    const raw = this._raw.panels.get(String(id));
    if (!raw) return;
    const totals = this._hubTotals('panel', String(id));
    const online = raw.offline == null
      ? true
      : !!(raw.online && Date.parse(raw.online) > Date.parse(raw.offline));
    const state = {
      kind: 'panel',
      hubType: 'panel',
      id: String(id),
      power: totals.power,
      current: totals.current,
      energy: totals.energy,
      voltage: N.legAverage(raw.rmsVoltage, raw.rmsVoltage2),
      voltageLeg1: N.num(raw.rmsVoltage) || null,
      voltageLeg2: N.num(raw.rmsVoltage2) || null,
      // Panels carry no frequency fields — derive per-leg from child breakers' lineFrequency.
      frequency: N.legAverage(totals.frequencyLeg1, totals.frequencyLeg2),
      frequencyLeg1: totals.frequencyLeg1,
      frequencyLeg2: totals.frequencyLeg2,
      powerLeg1: totals.powerLeg1,
      powerLeg2: totals.powerLeg2,
      currentLeg1: totals.currentLeg1,
      currentLeg2: totals.currentLeg2,
      online,
      diagnostics: {
        model: raw.model || 'DAU',
        serial: raw.id,
        firmwareMain: raw.packageVer,
        firmwareBCM: raw.versionBCM,
        firmwareNCM: raw.versionNCM,
        firmwareUpdate: raw.updateAvailability && raw.updateAvailability !== 'UP_TO_DATE'
          ? `Available${raw.updateVersion ? `: ${raw.updateVersion}` : ''}`
          : 'Up to date',
        wifiSSID: raw.wifiSSID,
        wifiMode: raw.wifiMode,
        wifiRSSI: raw.wifiRSSI,
        residenceId: raw.residenceId,
      },
    };
    this._dispatch(`${id}`, state);
  }

  _updateCt(id) {
    const raw = this._raw.cts.get(String(id));
    if (!raw) return;
    const power = N.num(raw.activePower) + N.num(raw.activePower2);
    const current = N.num(raw.rmsCurrent) + N.num(raw.rmsCurrent2);
    const prev = this._lifetime.get(`c:${id}`) || {};
    const acc = {
      e: N.normalizeLifetime(raw.energyConsumption, prev.e),
      e2: N.normalizeLifetime(raw.energyConsumption2, prev.e2),
      i: N.normalizeLifetime(raw.energyImport, prev.i),
      i2: N.normalizeLifetime(raw.energyImport2, prev.i2),
    };
    this._lifetime.set(`c:${id}`, acc);
    const state = {
      kind: 'ct',
      id: String(id),
      power,
      current,
      powerLeg1: N.num(raw.activePower) || null,
      powerLeg2: N.num(raw.activePower2) || null,
      currentLeg1: N.num(raw.rmsCurrent) || null,
      currentLeg2: N.num(raw.rmsCurrent2) || null,
      energy: N.round3(acc.e + acc.e2),
      energyImport: (raw.energyImport != null || raw.energyImport2 != null) ? N.round3(acc.i + acc.i2) : null,
      online: raw.connected !== false,
      diagnostics: { serial: raw.serial || raw.id, usageType: raw.usageType, channel: raw.channel },
    };
    this._dispatch(`${id}`, state);
  }

  /**
   * Aggregate whole-panel totals for a hub (main meter).
   * LWHEM: summed from its CTs (the whole-home clamps) — mirrors the HA integration;
   * summing breakers would undercount non-smart circuits.
   * LDATA panel: summed from its child breakers (panels have no CTs).
   */
  _hubTotals(hubType, hubId) {
    const t = {
      power: 0, current: 0, energy: 0,
      powerLeg1: 0, powerLeg2: 0, currentLeg1: 0, currentLeg2: 0,
    };
    if (hubType === 'whem') {
      for (const ct of this._raw.cts.values()) {
        if (String(ct.hubId) !== String(hubId)) continue;
        t.powerLeg1 += N.num(ct.activePower);
        t.powerLeg2 += N.num(ct.activePower2);
        t.currentLeg1 += N.num(ct.rmsCurrent);
        t.currentLeg2 += N.num(ct.rmsCurrent2);
        const acc = this._lifetime.get(`c:${ct.id}`);
        if (acc) t.energy += N.num(acc.e) + N.num(acc.e2);
      }
      t.power = t.powerLeg1 + t.powerLeg2;
      t.current = t.currentLeg1 + t.currentLeg2;
    } else {
      const opts = this.options; // hoisted — the getter reads Homey settings each call
      const freq = { sum1: 0, n1: 0, sum2: 0, n2: 0 };
      for (const b of this._raw.breakers.values()) {
        if (b.hubType !== hubType || String(b.hubId) !== String(hubId)) continue;
        const c = N.classifyBreaker(b);
        t.power += N.breakerPower(b);
        t.current += N.breakerCurrent(b, opts);
        const life = this._lifetime.get(`b:${b.id}`);
        if (life) t.energy += life.total;
        // Leg attribution by split-phase position (odd=leg1, even=leg2); 2-pole spans
        // both; unknown position (0/undefined) is excluded from leg totals.
        const pos = N.num(b.position);
        const leg = c.poles === 2 ? 'both' : (pos <= 0 ? null : (pos % 2 === 1 ? 1 : 2));
        if (leg === 1 || leg === 'both') { t.powerLeg1 += N.num(b.power); t.currentLeg1 += N.num(b.rmsCurrent); }
        if (leg === 2 || leg === 'both') {
          // A 2-pole leg-2 reading of 0 is legitimate — only fall back when absent.
          t.powerLeg2 += b.power2 != null ? N.num(b.power2) : N.num(b.power);
          t.currentLeg2 += b.rmsCurrent2 != null ? N.num(b.rmsCurrent2) : N.num(b.rmsCurrent);
        }
        // Panel frequency is derived from breakers' lineFrequency (averaged per leg).
        const f1 = b.lineFrequency;
        const f2 = b.lineFrequency2 != null ? b.lineFrequency2 : b.lineFrequency;
        if ((leg === 1 || leg === 'both') && f1 != null && N.num(f1) > 0) { freq.sum1 += N.num(f1); freq.n1 += 1; }
        if ((leg === 2 || leg === 'both') && f2 != null && N.num(f2) > 0) { freq.sum2 += N.num(f2); freq.n2 += 1; }
      }
      t.frequencyLeg1 = freq.n1 ? freq.sum1 / freq.n1 : null;
      t.frequencyLeg2 = freq.n2 ? freq.sum2 / freq.n2 : null;
    }
    for (const k of Object.keys(t)) t[k] = t[k] == null ? null : N.round3(t[k]);
    return t;
  }

  _recomputeHubTotals() {
    for (const w of this._raw.whems.values()) this._updateWhem(String(w.id));
    for (const p of this._raw.panels.values()) this._updatePanel(String(p.id));
  }

  // ---- Bandwidth keepalive ---------------------------------------------

  _startBandwidthKeepalive() {
    if (this._bandwidthTimer) return;
    this._bandwidthTimer = this.homey.setInterval(() => {
      if (!this.socket || !this.socket.connected) return;
      if (this._authState === 'failed') return; // paused while signed out
      if (this._bandwidthSkip > 0) { this._bandwidthSkip -= 1; return; }
      this._runBandwidthKeepalive().catch(() => {});
    }, TIMINGS.BANDWIDTH_KEEPALIVE);
  }

  async _runBandwidthKeepalive() {
    try {
      for (const w of this._raw.whems.values()) {
        // WHEM 1 -> 0 -> 1 toggle forces fresh CT pushes.
        await this.client.setWhemBandwidth(w.id, 1);
        await this.client.setWhemBandwidth(w.id, 0);
        await this.client.setWhemBandwidth(w.id, 1);
      }
      for (const p of this._raw.panels.values()) {
        await this.client.setPanelBandwidth(p.id, true);
      }
      this._bandwidthFailures = 0;
      this._bandwidthSkip = 0;
    } catch (err) {
      this._bandwidthFailures = Math.min(this._bandwidthFailures + 1, 5);
      this._bandwidthSkip = (2 ** (this._bandwidthFailures - 1)) - 1; // 0,1,3,7,15
      this.error(`bandwidth keepalive failed (${this._bandwidthFailures}): ${err.message}`);
    }
  }

  // ---- Control (called by devices / flow actions) ----------------------

  _assertWritable() {
    if (this.options.readOnly) throw new Error('Read-only mode is enabled in app settings');
  }

  async setBreaker(breakerId, on) {
    this._assertWritable();
    if (on) await this.client.breakerOn(breakerId);
    else await this.client.breakerOff(breakerId);
    // Optimistic: the API does not echo remoteState over WS.
    const raw = this._raw.breakers.get(String(breakerId));
    if (raw) { raw.remoteState = on ? 'RemoteON' : 'RemoteOFF'; this._updateBreaker(String(breakerId)); }
  }

  async tripBreaker(breakerId) {
    this._assertWritable();
    await this.client.breakerTrip(breakerId);
    const raw = this._raw.breakers.get(String(breakerId));
    if (raw) { raw.remoteState = 'RemoteOFF'; raw.currentState = 'SoftwareTrip'; this._updateBreaker(String(breakerId)); }
  }

  async blinkBreaker(breakerId, on = true) {
    this._assertWritable();
    await this.client.breakerBlink(breakerId, on);
  }

  /** Blink the hub's locate LED (LWHEM only — LDATA panels have no identify). */
  async identifyHub(hubId) {
    this._assertWritable();
    if (!this._raw.whems.has(String(hubId))) throw new Error('Identify is only supported on LWHEM hubs');
    await this.client.setWhemIdentify(hubId);
  }

  /** Staggered bulk operation across a hub's breakers. op in 'on'|'off'|'trip'. */
  async bulkOperation(hubId, op, hubType) {
    this._assertWritable();
    const delayMs = this.options.staggerDelay * 1000;
    // Match hubType too — whem and panel ids are distinct id spaces.
    const targets = [...this._raw.breakers.values()].filter(
      (b) => String(b.hubId) === String(hubId) && (!hubType || b.hubType === hubType),
    );
    for (const b of targets) {
      const c = N.classifyBreaker(b);
      try {
        if (op === 'on' && c.isGen2) await this.client.breakerOn(b.id);
        else if (op === 'off') await this.client.breakerOff(b.id);
        else if (op === 'trip' && c.isSmart) await this.client.breakerTrip(b.id);
        else continue;
      } catch (err) {
        this.error(`bulk ${op} failed for breaker ${b.id}: ${err.message}`);
      }
      await new Promise((r) => this.homey.setTimeout(r, delayMs));
    }
  }
}

module.exports = LevitonHub;
