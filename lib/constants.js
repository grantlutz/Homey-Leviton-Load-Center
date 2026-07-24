'use strict';

/**
 * Wire-level constants for the My Leviton cloud, reimplemented in Node.js from the
 * MIT-licensed gtxaspec/aioleviton + gtxaspec/leviton-load-center projects.
 */

module.exports.API_BASE_URL = 'https://my.leviton.com/api';
module.exports.WEBSOCKET_URL = 'wss://socket.cloud.leviton.com/';

// Spoof the Android app's User-Agent, exactly as the reference client does.
module.exports.USER_AGENT = [
  'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UP1A.231105.001; wv)',
  'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0',
  'Chrome/120.0.6099.193 Mobile Safari/537.36',
].join(' ');

// HTTP status semantics used by the Leviton API.
module.exports.HTTP = {
  UNAUTHORIZED: 401,   // token expired / bad credentials
  TWO_FACTOR_REQUIRED: 406,
  INVALID_CODE: 408,
};

// Keepalive / timeout timings (ms) — ported verbatim from the HA WS manager.
module.exports.TIMINGS = {
  WS_HEARTBEAT: 30 * 1000,          // ws ping interval (HEARTBEAT_TIMEOUT / 2)
  WS_PROACTIVE_RECONNECT: 55 * 60 * 1000, // reconnect before the server's 60-min hard kill
  WS_WATCHDOG_TICK: 30 * 1000,      // silence-watchdog tick
  WS_SILENCE_LIMIT: 90 * 1000,      // force reconnect if no data for this long
  BANDWIDTH_KEEPALIVE: 60 * 1000,   // WHEM 1->0->1 bandwidth toggle
  READY_TIMEOUT: 10 * 1000,         // wait for {status:"ready"} handshake
  BANDWIDTH_SETTLE: 1000,           // firmware processes bandwidth async; wait before reading energy
  REST_POLL: 2 * 60 * 1000,         // REST fallback poll
};

// Exponential reconnect backoff (ms), ported from the HA manager.
module.exports.RECONNECT_BACKOFF = [10, 30, 60, 120, 300].map((s) => s * 1000);

module.exports.MODEL = {
  WHEM: 'IotWhem',
  PANEL: 'ResidentialBreakerPanel',
  BREAKER: 'ResidentialBreaker',
  CT: 'IotCt',
};

// Placeholder / non-smart breaker model names.
module.exports.PLACEHOLDER_MODELS = ['NONE', 'NONE-1', 'NONE-2'];
module.exports.LSBMA_MODEL = 'LSBMA';

/**
 * Map a raw Leviton `currentState` string to our `breaker_state` enum id.
 */
const CURRENT_STATE_MAP = {
  ManualON: 'on',
  ManualOFF: 'off',
  COMMUNICATING: 'connecting',
  NotCommunicating: 'offline',
  CommunicationFailure: 'offline',
  UNDEFINED: 'offline',
  SoftwareTrip: 'software_trip',
  GFCIFault: 'gfci_fault',
  AFCIMiswire: 'afci_miswire',
  AFCIParallelFault: 'afci_fault',
  OverloadTrip: 'overload_trip',
  ShortCircuitTrip: 'short_circuit_trip',
  UpstreamFault: 'upstream_fault',
};

module.exports.mapCurrentState = function mapCurrentState(currentState) {
  if (currentState == null) return null;
  if (CURRENT_STATE_MAP[currentState]) return CURRENT_STATE_MAP[currentState];
  // Pattern families that don't map 1:1.
  if (/^AFCISerialArc\d+AFault$/.test(currentState)) return 'afci_fault';
  if (/^OverCurrentTripPhase[12]$/.test(currentState)) return 'overcurrent_trip';
  return null;
};

// Which breaker_state ids represent an active trip/fault.
module.exports.TRIP_STATES = new Set([
  'software_trip', 'gfci_fault', 'afci_miswire', 'afci_fault',
  'overcurrent_trip', 'overload_trip', 'short_circuit_trip', 'upstream_fault',
]);
module.exports.GFCI_STATES = new Set(['gfci_fault']);
module.exports.AFCI_STATES = new Set(['afci_fault', 'afci_miswire']);

// Human-readable trip reason for Flow tokens / timeline notifications.
module.exports.TRIP_REASON = {
  software_trip: 'Remote trip',
  gfci_fault: 'Ground fault (GFCI)',
  afci_miswire: 'AFCI miswire',
  afci_fault: 'Arc fault (AFCI)',
  overcurrent_trip: 'Overcurrent',
  overload_trip: 'Overload',
  short_circuit_trip: 'Short circuit',
  upstream_fault: 'Upstream fault',
};
