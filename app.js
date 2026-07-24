'use strict';

const Homey = require('homey');
const LevitonHub = require('./lib/LevitonHub');

module.exports = class LevitonApp extends Homey.App {
  async onInit() {
    this.hub = new LevitonHub({
      homey: this.homey,
      log: (...a) => this.log(...a),
      error: (...a) => this.error(...a),
    });

    // Re-start the pipeline whenever behavior-affecting settings change.
    this.homey.settings.on('set', (key) => {
      if (['read_only', 'calculated_current', 'voltage_208', 'hide_dummy', 'show_energy_import'].includes(key)) {
        this.hub.refreshDiscovery().catch((e) => this.error(e));
      }
      // Read-only toggles the on/off tile on every Gen-2 breaker, live.
      if (key === 'read_only') {
        const driver = this.homey.drivers.getDriver('breaker');
        for (const device of driver.getDevices()) {
          if (device.reconcileControl) device.reconcileControl().catch((e) => this.error(e));
        }
      }
    });

    this._registerFlowActions();

    // Devices also kick this off on register; safe to call when a session exists.
    if (this.hub.hasSession()) {
      this.hub.start().catch((err) => this.error(`hub start failed: ${err.message}`));
    }
    this.log('Leviton Load Center app initialized');
  }

  getHub() {
    return this.hub;
  }

  _registerFlowActions() {
    const bulk = (op) => async (args) => {
      const hubId = args.panel && args.panel.getData ? args.panel.getData().id : null;
      if (!hubId) throw new Error('No load center selected');
      const hubType = args.panel.getStoreValue ? args.panel.getStoreValue('hubType') : null;
      await this.hub.bulkOperation(hubId, op, hubType);
      return true;
    };
    this.homey.flow.getActionCard('all_on').registerRunListener(bulk('on'));
    this.homey.flow.getActionCard('all_off').registerRunListener(bulk('off'));
    this.homey.flow.getActionCard('trip_all').registerRunListener(bulk('trip'));
  }

  async onUninit() {
    if (this.hub) await this.hub.stop();
  }
};
