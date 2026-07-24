'use strict';

/* Offline unit tests for the pure state/energy normalization core.
 * Run: npm test  (or: node test/harness.js) — no Homey runtime required. */

const assert = require('assert');
const N = require('../lib/normalize');

let passed = 0;
function t(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

// ---- classifyBreaker --------------------------------------------------
t('classify gen2 smart breaker', () => {
  const c = N.classifyBreaker({ model: 'DGD115', canRemoteOn: true, poles: 1 });
  assert.strictEqual(c.isSmart, true);
  assert.strictEqual(c.isGen2, true);
  assert.strictEqual(c.isPlaceholder, false);
});
t('classify gen1 smart breaker (trip only)', () => {
  const c = N.classifyBreaker({ model: 'DGA120', canRemoteOn: false, poles: 1 });
  assert.strictEqual(c.isSmart, true);
  assert.strictEqual(c.isGen2, false);
});
t('classify placeholder', () => {
  const c = N.classifyBreaker({ model: 'NONE', poles: 1 });
  assert.strictEqual(c.isPlaceholder, true);
  assert.strictEqual(c.isSmart, false);
});
t('classify LSBMA composite', () => {
  const c = N.classifyBreaker({ model: 'LSBMA' });
  assert.strictEqual(c.isLsbma, true);
});

// ---- shouldIncludeBreaker --------------------------------------------
t('include smart breaker', () => {
  assert.strictEqual(N.shouldIncludeBreaker({ model: 'DGD115', canRemoteOn: true }), true);
});
t('exclude pure LSBMA', () => {
  assert.strictEqual(N.shouldIncludeBreaker({ model: 'LSBMA' }), false);
});
t('include placeholder with LSBMA CT', () => {
  assert.strictEqual(N.shouldIncludeBreaker({ model: 'NONE', lsbmaId: 'abc' }), true);
});
t('hideDummy drops placeholder-with-CT', () => {
  assert.strictEqual(N.shouldIncludeBreaker({ model: 'NONE', lsbmaId: 'abc' }, { hideDummy: true }), false);
});
t('exclude bare placeholder', () => {
  assert.strictEqual(N.shouldIncludeBreaker({ model: 'NONE' }), false);
});

// ---- power / current --------------------------------------------------
t('power single pole', () => {
  assert.strictEqual(N.breakerPower({ model: 'X', poles: 1, power: 240 }), 240);
});
t('power two pole sums legs', () => {
  assert.strictEqual(N.breakerPower({ model: 'X', poles: 2, power: 1200, power2: 1100 }), 2300);
});
t('measured current two pole sums legs', () => {
  const a = N.breakerCurrent({ model: 'X', poles: 2, rmsCurrent: 10, rmsCurrent2: 9 });
  assert.strictEqual(a, 19);
});
t('calculated current = power / voltage', () => {
  const a = N.breakerCurrent({ model: 'X', poles: 1, power: 1200, rmsVoltage: 120 }, { calculatedCurrent: true });
  assert.strictEqual(a, 10);
});
t('calculated current 2-pole 240V', () => {
  const a = N.breakerCurrent(
    { model: 'X', poles: 2, power: 2400, power2: 0, rmsVoltage: 120 },
    { calculatedCurrent: true },
  );
  assert.strictEqual(a, 10); // 2400 / 240
});
t('calculated current 2-pole 208V option', () => {
  const a = N.breakerCurrent(
    { model: 'X', poles: 2, power: 2080, rmsVoltage: 120 },
    { calculatedCurrent: true, voltage208: true },
  );
  assert.strictEqual(a, 10); // 2080 / 208
});

// ---- energy delta-vs-lifetime heuristic -------------------------------
t('first reading accepted as lifetime', () => {
  assert.strictEqual(N.normalizeLifetime(12.5, undefined), 12.5);
});
t('growth accepted', () => {
  assert.strictEqual(N.normalizeLifetime(13.0, 12.5), 13.0);
});
t('bandwidth-1 delta discarded (keeps prior lifetime)', () => {
  // raw 0.3 is a period delta, prior lifetime 100 -> keep 100
  assert.strictEqual(N.normalizeLifetime(0.3, 100), 100);
});
t('two-pole lifetime sums legs', () => {
  const r = N.breakerLifetimeEnergy({ model: 'X', poles: 2, energyConsumption: 50, energyConsumption2: 40 }, null);
  assert.strictEqual(r.total, 90);
});
t('dailyEnergy clamps to zero', () => {
  assert.strictEqual(N.dailyEnergy(5, 8), 0);
  assert.strictEqual(N.dailyEnergy(10, 8), 2);
});

// ---- breaker state mapping -------------------------------------------
t('gen2 on via remoteState', () => {
  const s = N.mapBreakerState({ model: 'X', canRemoteOn: true, remoteState: 'RemoteON', currentState: 'ManualON' });
  assert.strictEqual(s.on, true);
  assert.strictEqual(s.state, 'on');
  assert.strictEqual(s.tripped, false);
});
t('gen2 off via remoteState overrides currentState', () => {
  const s = N.mapBreakerState({ model: 'X', canRemoteOn: true, remoteState: 'RemoteOFF', currentState: 'ManualON' });
  assert.strictEqual(s.on, false);
});
t('gfci trip', () => {
  const s = N.mapBreakerState({ model: 'X', currentState: 'GFCIFault' });
  assert.strictEqual(s.state, 'gfci_fault');
  assert.strictEqual(s.gfci, true);
  assert.strictEqual(s.tripped, true);
  assert.strictEqual(s.reason, 'Ground fault (GFCI)');
});
t('afci serial arc trip maps to afci_fault', () => {
  const s = N.mapBreakerState({ model: 'X', currentState: 'AFCISerialArc15AFault' });
  assert.strictEqual(s.state, 'afci_fault');
  assert.strictEqual(s.afci, true);
});
t('overcurrent phase maps', () => {
  const s = N.mapBreakerState({ model: 'X', currentState: 'OverCurrentTripPhase2' });
  assert.strictEqual(s.state, 'overcurrent_trip');
  assert.strictEqual(s.tripped, true);
});
t('offline when not connected', () => {
  const s = N.mapBreakerState({ model: 'X', connected: false, currentState: 'NotCommunicating' });
  assert.strictEqual(s.online, false);
  assert.strictEqual(s.state, 'offline');
});
t('offline via currentState even without connected:false', () => {
  const s = N.mapBreakerState({ model: 'X', currentState: 'CommunicationFailure' });
  assert.strictEqual(s.state, 'offline');
  assert.strictEqual(s.online, false); // must not report available
});

// ---- legAverage -------------------------------------------------------
t('legAverage of two legs', () => {
  assert.strictEqual(N.legAverage(120, 122), 121);
});
t('legAverage with one missing leg', () => {
  assert.strictEqual(N.legAverage(120, null), 120);
});
t('legAverage null when both legs absent', () => {
  assert.strictEqual(N.legAverage(null, undefined), null);
});

// ---- breakerLeg -------------------------------------------------------
t('breakerLeg odd position = leg 1', () => {
  assert.strictEqual(N.breakerLeg(3, 1), '1');
});
t('breakerLeg even position = leg 2', () => {
  assert.strictEqual(N.breakerLeg(4, 1), '2');
});
t('breakerLeg 2-pole spans both', () => {
  assert.strictEqual(N.breakerLeg(5, 2), 'Both');
});
t('breakerLeg unknown position', () => {
  assert.strictEqual(N.breakerLeg(null, 1), null);
});

console.log(`\n${passed} tests passed.`);
