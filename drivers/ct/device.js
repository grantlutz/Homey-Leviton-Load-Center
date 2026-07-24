'use strict';

const Homey = require('homey');

module.exports = class CtDevice extends Homey.Device {
  async onInit() {
    this.hub = this.homey.app.getHub();
    this._id = this.getData().id;
    this._lastSettingsJson = null;
    this.hub.registerDevice('ct', this._id, this);
  }

  async applyState(s) {
    if (s.online) await this.setAvailable().catch(() => {});
    else await this.setUnavailable('CT offline').catch(() => {});

    await this._set('measure_power', s.power);
    await this._set('measure_current', s.current);
    await this._set('meter_power', s.energy);

    // Imported energy — only when the option is on AND this CT reports it.
    const wantImport = !!this.homey.settings.get('show_energy_import') && s.energyImport != null;
    const hasImport = this.hasCapability('meter_power.imported');
    if (wantImport && !hasImport) {
      await this.addCapability('meter_power.imported').catch(this.error);
      await this.setCapabilityOptions('meter_power.imported', { title: { en: 'Energy imported' } }).catch(() => {});
    } else if (!wantImport && hasImport) {
      await this.removeCapability('meter_power.imported').catch(this.error);
    }
    if (this.hasCapability('meter_power.imported')) await this._set('meter_power.imported', s.energyImport);

    const d = s.diagnostics || {};
    this._syncSettings({
      usage_type: d.usageType || '-',
      channel: d.channel != null ? String(d.channel) : '-',
      serial: d.serial != null ? String(d.serial) : '-',
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
