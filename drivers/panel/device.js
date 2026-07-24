'use strict';

const Homey = require('homey');

module.exports = class PanelDevice extends Homey.Device {
  async onInit() {
    this.hub = this.homey.app.getHub();
    this._id = this.getData().id;
    this._prevOnline = null;
    this._lastSettingsJson = null;
    this.hub.registerDevice('panel', this._id, this);
  }

  /** Called by the hub with normalized whole-panel / hub state. */
  async applyState(s) {
    if (s.online) await this.setAvailable().catch(() => {});
    else await this.setUnavailable('Load center offline').catch(() => {});

    // Connectivity transition triggers (skip the first observation).
    if (this._prevOnline !== null && s.online !== this._prevOnline) {
      const card = s.online ? this.driver.trgCameOnline : this.driver.trgWentOffline;
      if (card) card.trigger(this, {}, {}).catch(() => {});
    }
    this._prevOnline = s.online;

    await this._set('measure_power', s.power);
    await this._set('meter_power', s.energy);
    await this._set('measure_current', s.current);
    await this._set('measure_voltage', s.voltage);
    if (s.frequency != null) await this._set('measure_frequency', s.frequency);
    await this._set('measure_voltage.leg1', s.voltageLeg1);
    await this._set('measure_voltage.leg2', s.voltageLeg2);
    await this._set('measure_power.leg1', s.powerLeg1);
    await this._set('measure_power.leg2', s.powerLeg2);
    await this._set('measure_current.leg1', s.currentLeg1);
    await this._set('measure_current.leg2', s.currentLeg2);
    await this._set('measure_frequency.leg1', s.frequencyLeg1);
    await this._set('measure_frequency.leg2', s.frequencyLeg2);

    const d = s.diagnostics || {};
    this._syncSettings({
      model: d.model || '-',
      serial: d.serial != null ? String(d.serial) : '-',
      firmware: d.firmwareMain || '-',
      firmware_update: d.firmwareUpdate || '-',
      ip: d.localIP || '-',
      wifi_ssid: d.wifiSSID || '-',
      wifi_rssi: d.wifiRSSI != null ? String(d.wifiRSSI) : '-',
      residence: d.residenceId != null ? String(d.residenceId) : '-',
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
