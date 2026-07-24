'use strict';

const Homey = require('homey');

module.exports = class BreakerDevice extends Homey.Device {
  async onInit() {
    this.hub = this.homey.app.getHub();
    this._id = this.getData().id;
    // All null until the first applyState — trigger evaluation is skipped on the
    // first observation so app restarts don't re-fire trips/thresholds.
    this._prevPower = null;
    this._prevCurrent = null;
    this._prevTripped = null;
    this._prevOnline = null;
    this._lastSettingsJson = null;

    await this.reconcileControl();
    this.hub.registerDevice('breaker', this._id, this);
  }

  /** Add/remove the on/off control capability to match the breaker profile + read-only mode. */
  async reconcileControl() {
    const isGen2 = this.getStoreValue('isGen2');
    const readOnly = !!this.homey.settings.get('read_only');
    const wantControl = isGen2 && !readOnly;

    if (wantControl && !this.hasCapability('onoff')) await this.addCapability('onoff').catch(this.error);
    if (!wantControl && this.hasCapability('onoff')) await this.removeCapability('onoff').catch(this.error);

    if (this.hasCapability('onoff')) {
      await this.setClass('socket').catch(() => {});
      // registerCapabilityListener replaces (not stacks), so always (re-)register —
      // a listener may not survive removeCapability/addCapability cycles.
      this.registerCapabilityListener('onoff', async (value) => {
        await this.hub.setBreaker(this._id, value);
      });
    }
  }

  /** Expose meter_power.imported only when the option is on AND the breaker reports it. */
  async _reconcileImport(s) {
    const want = !!this.homey.settings.get('show_energy_import') && s.energyImport != null;
    const has = this.hasCapability('meter_power.imported');
    if (want && !has) {
      await this.addCapability('meter_power.imported').catch(this.error);
      await this.setCapabilityOptions('meter_power.imported', { title: { en: 'Energy imported' } }).catch(() => {});
    } else if (!want && has) {
      await this.removeCapability('meter_power.imported').catch(this.error);
    }
  }

  /** Called by the hub with normalized breaker state. */
  async applyState(s) {
    if (s.online) await this.setAvailable().catch(() => {});
    else await this.setUnavailable('Breaker offline').catch(() => {});

    // Connectivity transition triggers (skip the first observation).
    if (this._prevOnline !== null && s.online !== this._prevOnline) {
      const card = s.online ? this.driver.trgCameOnline : this.driver.trgWentOffline;
      if (card) card.trigger(this, {}, {}).catch(() => {});
    }
    this._prevOnline = s.online;

    await this._set('measure_power', s.power);
    await this._set('measure_current', s.current);
    if (s.voltage != null) await this._set('measure_voltage', s.voltage);
    await this._set('meter_power', s.energy);
    await this._set('breaker_state', s.breakerState);
    if (s.rating != null) await this._set('breaker_rating', s.rating);
    await this._set('alarm_generic', s.tripped);
    await this._set('alarm_gfci', s.gfci);
    await this._set('alarm_afci', s.afci);
    if (this.hasCapability('onoff')) await this._set('onoff', s.on);

    await this._reconcileImport(s);
    if (this.hasCapability('meter_power.imported')) await this._set('meter_power.imported', s.energyImport);

    // Trip transition → Flow trigger + timeline notification (skip first observation).
    if (this._prevTripped !== null && s.tripped && !this._prevTripped) {
      if (this.driver.trgTripped) {
        this.driver.trgTripped
          .trigger(this, { reason: s.reason || 'Tripped', power: s.power }, {})
          .catch(this.error);
      }
      this.homey.notifications.createNotification({
        excerpt: `⚡ ${this.getName()} tripped — ${s.reason || 'fault'}`,
      }).catch(() => {});
    }
    this._prevTripped = s.tripped;

    // Power / current threshold triggers (skip first observation).
    if (this._prevPower !== null && s.power !== this._prevPower) {
      const st = { power: s.power, prev: this._prevPower };
      if (this.driver.trgPowerAbove) this.driver.trgPowerAbove.trigger(this, {}, st).catch(() => {});
      if (this.driver.trgPowerBelow) this.driver.trgPowerBelow.trigger(this, {}, st).catch(() => {});
    }
    this._prevPower = s.power;
    if (this._prevCurrent !== null && s.current !== this._prevCurrent) {
      const st = { current: s.current, prev: this._prevCurrent };
      if (this.driver.trgCurrentAbove) this.driver.trgCurrentAbove.trigger(this, {}, st).catch(() => {});
      if (this.driver.trgCurrentBelow) this.driver.trgCurrentBelow.trigger(this, {}, st).catch(() => {});
    }
    this._prevCurrent = s.current;

    // Diagnostic settings — only written when something actually changed.
    const d = s.diagnostics || {};
    this._syncSettings({
      model: d.model || '-',
      serial: d.serialNumber || '-',
      firmware_ble: d.firmwareBLE || '-',
      firmware_meter: d.firmwareMeter || '-',
      firmware_protect: d.firmwareProtect || '-',
      rating: s.rating != null ? String(s.rating) : '-',
      poles: d.poles != null ? String(d.poles) : '-',
      position: d.position != null ? String(d.position) : '-',
      leg: d.leg || '-',
      ble_rssi: d.bleRSSI != null ? String(d.bleRSSI) : '-',
    });
  }

  /** setSettings only when something actually changed (state arrives on every WS push). */
  _syncSettings(settings) {
    const json = JSON.stringify(settings);
    if (json === this._lastSettingsJson) return;
    this._lastSettingsJson = json;
    this.setSettings(settings).catch(() => {});
  }

  async _set(cap, value) {
    if (value === undefined || value === null) return;
    if (!this.hasCapability(cap)) return;
    if (this.getCapabilityValue(cap) === value) return;
    await this.setCapabilityValue(cap, value).catch(this.error);
  }

  onDeleted() {
    if (this.hub) this.hub.unregisterDevice(this._id);
  }
};
