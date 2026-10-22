'use strict';

const Homey = require('homey');
const { shouldIncludeBreaker, classifyBreaker } = require('../../lib/normalize');
const { registerPairAuth, registerRepairAuth } = require('../../lib/authSession');

module.exports = class BreakerDriver extends Homey.Driver {
  async onInit() {
    const hub = this.homey.app.getHub();

    // Condition cards.
    this.homey.flow.getConditionCard('breaker_is_on')
      .registerRunListener(async (args) => args.device.getCapabilityValue('onoff') === true);
    this.homey.flow.getConditionCard('breaker_state_is')
      .registerRunListener(async (args) => args.device.getCapabilityValue('breaker_state') === args.state);

    // Action cards.
    this.homey.flow.getActionCard('turn_on')
      .registerRunListener(async (args) => hub.setBreaker(args.device.getData().id, true));
    this.homey.flow.getActionCard('turn_off')
      .registerRunListener(async (args) => hub.setBreaker(args.device.getData().id, false));
    this.homey.flow.getActionCard('trip')
      .registerRunListener(async (args) => hub.tripBreaker(args.device.getData().id));
    this.homey.flow.getActionCard('identify')
      .registerRunListener(async (args) => {
        const id = args.device.getData().id;
        await hub.blinkBreaker(id, true);
        this.homey.setTimeout(() => hub.blinkBreaker(id, false).catch(this.error), 5000);
        return true;
      });

    // Threshold triggers (run listeners compare against the crossing recorded in state).
    this.trgPowerAbove = this.homey.flow.getDeviceTriggerCard('power_rose_above')
      .registerRunListener(async (args, state) => state.prev < args.watts && state.power >= args.watts);
    this.trgPowerBelow = this.homey.flow.getDeviceTriggerCard('power_dropped_below')
      .registerRunListener(async (args, state) => state.prev > args.watts && state.power <= args.watts);
    this.trgCurrentAbove = this.homey.flow.getDeviceTriggerCard('current_rose_above')
      .registerRunListener(async (args, state) => state.prev < args.amps && state.current >= args.amps);
    this.trgCurrentBelow = this.homey.flow.getDeviceTriggerCard('current_dropped_below')
      .registerRunListener(async (args, state) => state.prev > args.amps && state.current <= args.amps);

    // Cached device trigger cards (avoid per-push lookups in device.applyState).
    // Flows saved before the reason dropdown existed have no args.reason → treat as 'any'.
    this.trgTripped = this.homey.flow.getDeviceTriggerCard('breaker_tripped')
      .registerRunListener(async (args, state) => !args.reason || args.reason === 'any' || args.reason === state.reasonId);
    this.trgWentOffline = this.homey.flow.getDeviceTriggerCard('breaker_went_offline');
    this.trgCameOnline = this.homey.flow.getDeviceTriggerCard('breaker_came_online');
  }

  onPair(session) {
    const hub = this.homey.app.getHub();

    // Login view is skipped only if the stored session validates (see lib/authSession).
    registerPairAuth(session, hub);

    session.setHandler('list_devices', async () => this._listDevices(hub));
  }

  onRepair(session) {
    // One successful sign-in restores every Leviton device, not just this one.
    registerRepairAuth(session, this.homey.app.getHub());
  }

  async _listDevices(hub) {
    const tree = await hub.refreshDiscovery();
    const { hideDummy } = hub.options;
    return tree.breakers
      .filter((b) => shouldIncludeBreaker(b, { hideDummy }))
      .map((b) => {
        const c = classifyBreaker(b);
        const name = b.name || `Breaker ${b.position || b.id}`;
        return {
          name,
          data: { id: String(b.id) },
          store: {
            hubId: String(b.hubId),
            hubType: b.hubType,
            residenceId: String(b.residenceId),
            isGen2: c.isGen2,
            isSmart: c.isSmart,
            poles: c.poles,
          },
          settings: {
            model: c.model || '-',
            serial: b.serialNumber || '-',
            position: b.position != null ? String(b.position) : '-',
            rating: b.currentRating != null ? String(b.currentRating) : '-',
          },
        };
      });
  }
};
