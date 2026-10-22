'use strict';

const Homey = require('homey');
const { registerPairAuth, registerRepairAuth } = require('../../lib/authSession');

module.exports = class CtDriver extends Homey.Driver {
  async onInit() {}

  onPair(session) {
    const hub = this.homey.app.getHub();

    // Login view is skipped only if the stored session validates (see lib/authSession).
    registerPairAuth(session, hub);

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
    // One successful sign-in restores every Leviton device, not just this one.
    registerRepairAuth(session, this.homey.app.getHub());
  }
};
