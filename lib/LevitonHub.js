'use strict';

const LevitonClient = require('./LevitonClient');
const LevitonSocket = require('./LevitonSocket');
const N = require('./normalize');
const { MODEL, TIMINGS } = require('./constants');

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

    this.client = new LevitonClient({ log, error });
    this.socket = null;

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

  hasSession() {
    return !!this.homey.settings.get('token');
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

  /** Log in (used by pairing/repair) and persist the session app-wide. */
  async login(email, password, code) {
    await this.client.login(email, password, code);
    this.homey.settings.set('email', email);
    this.persistSession();
    // A repair after token expiry must revive the WebSocket — the expiry handler
    // closed it (which halts its reconnect loop).
    if (this._started && this.socket && !this.socket.connected) {
      this.socket.connect().catch((err) => this.error(`WS reconnect after login failed: ${err.message}`));
    }
    return true;
  }

  // ---- Lifecycle --------------------------------------------------------

  async start() {
    if (this._started) return;
    if (!this.restoreSession()) {
      this.log('No stored session — waiting for pairing.');
      return;
    }
    this._started = true;
    // Create the socket BEFORE the first discovery so _rebuildSubscriptions() can
    // register subscriptions (they are flushed to the server on the ready handshake).
    this._startSocket();
    try {
      await this.refreshDiscovery();
    } catch (err) {
      this.error(`Initial discovery failed: ${err.message}`);
      if (err.code === LevitonClient.ERR.TOKEN_EXPIRED) this._markAllUnavailable('Please repair: session expired');
    }
    this._startPolling();
  }

  async stop() {
    this._started = false;
    if (this._pollTimer) { this.homey.clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._bandwidthTimer) { this.homey.clearInterval(this._bandwidthTimer); this._bandwidthTimer = null; }
    if (this.socket) { await this.socket.close(); this.socket = null; }
  }

  // ---- Device registry --------------------------------------------------

  registerDevice(kind, id, device) {
    this._devices.set(String(id), { kind, device });
    const last = this._lastState.get(String(id));
    if (last) Promise.resolve(device.applyState(last)).catch(this.error);
    // Ensure the hub is running once at least one device exists.
    if (!this._started && this.hasSession()) this.start().catch(this.error);
  }

  unregisterDevice(id) {
    this._devices.delete(String(id));
  }

  _dispatch(id, state) {
    this._lastState.set(String(id), state);
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
      this.refreshDiscovery().catch((err) => {
        this.error(`poll failed: ${err.message}`);
        if (err.code === LevitonClient.ERR.TOKEN_EXPIRED) this._markAllUnavailable('Please repair: session expired');
      });
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
      // Re-validate the token before reconnecting. A hard auth failure must STOP the
      // reconnect loop and prompt the user to repair, rather than retry forever.
      try {
        await this.client.getPermissions();
      } catch (err) {
        if (err.code === LevitonClient.ERR.TOKEN_EXPIRED || err.code === LevitonClient.ERR.AUTH) {
          this.error('Session expired — halting WebSocket reconnect; please repair the device.');
          this._markAllUnavailable('Please repair: session expired');
          await this.socket.close();
        }
        throw err;
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
