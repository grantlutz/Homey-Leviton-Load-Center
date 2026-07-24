'use strict';

const Homey = require('homey');
const { shouldIncludeBreaker, classifyBreaker } = require('../../lib/normalize');
const LevitonClient = require('../../lib/LevitonClient');

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
    this.trgTripped = this.homey.flow.getDeviceTriggerCard('breaker_tripped');
    this.trgWentOffline = this.homey.flow.getDeviceTriggerCard('breaker_went_offline');
    this.trgCameOnline = this.homey.flow.getDeviceTriggerCard('breaker_came_online');
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

    session.setHandler('list_devices', async () => this._listDevices(hub));
  }

  onRepair(session, device) {
    const hub = this.homey.app.getHub();
    session.setHandler('login', async ({ username, password, code }) => {
      try {
        await hub.login(username, password, code);
        await device.setAvailable();
        return 'repaired';
      } catch (err) {
        if (err.code === LevitonClient.ERR.TWO_FACTOR) return 'twofactor';
        if (err.code === LevitonClient.ERR.INVALID_CODE) throw new Error('Invalid verification code — try again.');
        throw new Error(err.message || 'Login failed');
      }
    });
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
