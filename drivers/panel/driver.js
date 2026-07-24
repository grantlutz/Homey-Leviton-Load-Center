'use strict';

const Homey = require('homey');
const LevitonClient = require('../../lib/LevitonClient');

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

    // Skip the login view if we already have a session (signed in via another driver).
    session.setHandler('showView', async (viewId) => {
      if (viewId === 'login' && hub.hasSession()) await session.nextView();
    });

    session.setHandler('login', async ({ username, password, code }) => {
      try {
        await hub.login(username, password, code);
        return true;
      } catch (err) {
        if (err.code === LevitonClient.ERR.TWO_FACTOR) return 'twofactor';
        if (err.code === LevitonClient.ERR.INVALID_CODE) throw new Error('Invalid verification code — try again.');
        throw new Error(err.message || 'Login failed');
      }
    });

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
    const hub = this.homey.app.getHub();
    session.setHandler('login', async ({ username, password, code }) => {
      try {
        await hub.login(username, password, code);
        return 'repaired';
      } catch (err) {
        if (err.code === LevitonClient.ERR.TWO_FACTOR) return 'twofactor';
        throw new Error(err.message || 'Login failed');
      }
    });
  }
};
