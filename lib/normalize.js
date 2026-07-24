'use strict';

const {
  PLACEHOLDER_MODELS, LSBMA_MODEL,
  mapCurrentState, TRIP_STATES, GFCI_STATES, AFCI_STATES, TRIP_REASON,
} = require('./constants');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round3 = (v) => Math.round(v * 1000) / 1000;

/** Classify a raw breaker object into its capability profile. */
function classifyBreaker(raw) {
  const model = raw.model || '';
  const isPlaceholder = PLACEHOLDER_MODELS.includes(model);
  const isLsbma = model === LSBMA_MODEL;
  const isSmart = !isPlaceholder && !isLsbma && model !== '';
  const hasLsbma = isPlaceholder && !!raw.lsbmaId;
  const canRemoteOn = !!raw.canRemoteOn;
  return {
    model,
    isPlaceholder,
    isLsbma,
    isSmart,
    hasLsbma,
    canRemoteOn,
    isGen2: canRemoteOn,
    poles: num(raw.poles) || 1,
  };
}

/**
 * Whether a breaker should surface as a Homey device.
 * Excludes pure LSBMA composites entirely; monitoring-only placeholders are
 * included only if they carry an LSBMA CT. `hideDummy` drops those too.
 */
function shouldIncludeBreaker(raw, { hideDummy = false } = {}) {
  const c = classifyBreaker(raw);
  if (c.isLsbma) return false;
  if (c.isSmart) return true;
  if (c.hasLsbma) return !hideDummy;
  return false;
}

/** Total instantaneous power (W) across both poles. */
function breakerPower(raw) {
  const c = classifyBreaker(raw);
  return c.poles === 2 ? num(raw.power) + num(raw.power2) : num(raw.power);
}

/** Nominal voltage for a breaker (used for calculated current). */
function breakerVoltage(raw, { voltage208 = false } = {}) {
  const c = classifyBreaker(raw);
  const v = num(raw.rmsVoltage) || 120;
  if (c.poles === 2) return voltage208 ? 208 : v * 2;
  return v;
}

/** Current (A): measured rmsCurrent (summed for 2-pole), or derived from power/voltage. */
function breakerCurrent(raw, { calculatedCurrent = false, voltage208 = false } = {}) {
  const c = classifyBreaker(raw);
  if (calculatedCurrent) {
    const v = breakerVoltage(raw, { voltage208 });
    return v > 0 ? round3(breakerPower(raw) / v) : 0;
  }
  return c.poles === 2 ? num(raw.rmsCurrent) + num(raw.rmsCurrent2) : num(raw.rmsCurrent);
}

/**
 * Delta-vs-lifetime heuristic (ported from energy.py `_normalize_energy`).
 * With bandwidth=1 the API returns period deltas rather than lifetime totals;
 * a value that collapsed to a small delta is discarded so we keep the prior lifetime.
 * Returns the new lifetime value to store.
 */
function normalizeLifetime(raw, prevLifetime) {
  const current = num(prevLifetime);
  const value = num(raw);
  if (current === 0 || value > current * 0.5) return round3(value);
  return round3(current); // discard suspected delta
}

/** Sum a lifetime energy field across poles, applying the delta heuristic per leg. */
function breakerLifetimeEnergy(raw, prev, { field = 'energyConsumption' } = {}) {
  const c = classifyBreaker(raw);
  const legField = `${field}2`;
  const prevObj = prev || {};
  const leg1 = normalizeLifetime(raw[field], prevObj[field]);
  if (c.poles === 2) {
    const leg2 = normalizeLifetime(raw[legField], prevObj[legField]);
    return { total: round3(leg1 + leg2), [field]: leg1, [legField]: leg2 };
  }
  return { total: leg1, [field]: leg1 };
}

/** Daily energy = lifetime - midnight baseline, clamped to >= 0. */
function dailyEnergy(lifetime, baseline) {
  return round3(Math.max(0, num(lifetime) - num(baseline)));
}

/**
 * Map a raw breaker into display state.
 * Returns { state, on, tripped, gfci, afci, reason, online }.
 */
function mapBreakerState(raw) {
  const c = classifyBreaker(raw);
  let state = mapCurrentState(raw.currentState);
  const remoteState = raw.remoteState; // RemoteON | RemoteOFF
  const connected = raw.connected !== false;

  // Gen-2 on/off truth comes from remoteState; fall back to currentState.
  let on;
  if (c.isGen2 && (remoteState === 'RemoteON' || remoteState === 'RemoteOFF')) {
    on = remoteState === 'RemoteON';
  } else if (state === 'on') {
    on = true;
  } else if (state === 'off') {
    on = false;
  } else {
    on = state != null ? !TRIP_STATES.has(state) && state !== 'offline' : connected;
  }

  if (state == null) {
    if (!connected) state = 'offline';
    else state = on ? 'on' : 'off';
  }

  const tripped = TRIP_STATES.has(state);
  return {
    state,
    on,
    tripped,
    gfci: GFCI_STATES.has(state),
    afci: AFCI_STATES.has(state),
    reason: tripped ? (TRIP_REASON[state] || 'Tripped') : null,
    // Breakers signal loss of comms via currentState (mapped to 'offline'); they
    // don't carry a `connected` field, so honour the state too.
    online: connected && state !== 'offline',
  };
}

/**
 * Split-phase leg for a breaker: odd panel positions sit on leg 1, even on leg 2;
 * 2-pole breakers span both. Mirrors the HA integration's computed `leg` diagnostic.
 */
function breakerLeg(position, poles) {
  if (num(poles) === 2) return 'Both';
  const pos = num(position);
  if (pos <= 0) return null;
  return pos % 2 === 1 ? '1' : '2';
}

/** Average of two per-leg readings, ignoring missing legs; null when both absent. */
function legAverage(a, b) {
  const va = num(a);
  const vb = num(b);
  if (a != null && b != null) return round3((va + vb) / 2);
  if (a != null) return round3(va);
  if (b != null) return round3(vb);
  return null;
}

module.exports = {
  num,
  round3,
  breakerLeg,
  classifyBreaker,
  shouldIncludeBreaker,
  breakerPower,
  breakerVoltage,
  breakerCurrent,
  normalizeLifetime,
  breakerLifetimeEnergy,
  dailyEnergy,
  mapBreakerState,
  legAverage,
};
