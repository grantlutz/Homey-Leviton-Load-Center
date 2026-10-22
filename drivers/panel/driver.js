'use strict';

const Homey = require('homey');
const { registerPairAuth, registerRepairAuth } = require('../../lib/authSession');

module.exports = class PanelDriver extends Homey.Driver {
  async onInit() {
    const hub = this.homey.app.getHub();

    this.homey.flow.getConditionCard('panel_is_online')
      .registerRunListener(async (args) => args.device.getAvailable());
    this.homey.flow.getActionCard('identify_panel')
      .registerRunListener(async (args) => hub.identifyHub(args.device.getData().id));

    this.trgWentOffline = this.homey.flow.getDeviceTriggerCard('panel_went_offline');
    this.trgCameOnline = this.homey.flow.getDeviceTriggerCard('panel_came_online');
  }

  onPair(session) {
    const hub = this.homey.app.getHub();

    // Login view is skipped only if the stored session validates (see lib/authSession).
    registerPairAuth(session, hub);

    session.setHandler('list_devices', async () => {
      const tree = await hub.refreshDiscovery();
      const devices = [];
      for (const w of tree.whems) {
        devices.push({
          name: w.name || 'Leviton LWHEM',
          data: { id: String(w.id) },
          store: { hubType: 'whem', residenceId: String(w.residenceId) },
          settings: { model: w.model || 'LWHEM', serial: w.serial || '-' },
        });
      }
      for (const p of tree.panels) {
        devices.push({
          name: p.name || 'Leviton Load Center',
          data: { id: String(p.id) },
          store: { hubType: 'panel', residenceId: String(p.residenceId) },
          settings: { model: p.model || 'DAU', serial: String(p.id) },
        });
      }
      return devices;
    });
  }

  onRepair(session) {
    // One successful sign-in restores every Leviton device, not just this one.
    registerRepairAuth(session, this.homey.app.getHub());
  }
};
