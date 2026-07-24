'use strict';

const Homey = require('homey');
const LevitonClient = require('../../lib/LevitonClient');

module.exports = class CtDriver extends Homey.Driver {
  async onInit() {}

  onPair(session) {
    const hub = this.homey.app.getHub();

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
      return tree.cts.map((c) => ({
        name: c.name || `CT ${c.channel != null ? c.channel : c.id}`,
        data: { id: String(c.id) },
        store: { hubId: String(c.hubId), residenceId: String(c.residenceId) },
        settings: {
          usage_type: c.usageType || '-',
          channel: c.channel != null ? String(c.channel) : '-',
        },
      }));
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
