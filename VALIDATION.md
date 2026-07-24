# Validation & Review Log

Records the plan → build → validate work, the two review loops, feature-parity verification, and
what still needs live testing on real hardware.

## Automated gates (all green)

| Gate | Result |
|---|---|
| `homey app validate --level publish` | ✅ Pass (1 benign warning — see below) |
| `node test/harness.js` (30 pure-function unit tests) | ✅ 30/30 pass |
| `node --check` on every `.js` | ✅ Pass |
| Homey Compose build (`.homeycompose` → `app.json`) | ✅ 3 drivers, 5 custom capabilities, 13 flow cards |

**Benign warning:** `drivers.panel … missing 'cumulativeExportedCapability'`. The Leviton load center
is a consumption-only main meter (no solar/export telemetry), so there is intentionally no exported
cumulative capability. Semantically correct; non-blocking.

## Loop 1 — Planning (design)

Reverse-engineered the source integration + protocol and the Homey SDK, producing
[`PORTING-PLAN.md`](./PORTING-PLAN.md) with a full HA→Homey feature-parity matrix, device/capability
model, real-time strategy (WebSocket + keepalive), and build order (client core first).

## Loop 2 — Code validation (adversarial review)

An independent review checked every `lib/*.js` and driver file against the *verified* wire protocol.
Confirmed correct: auth header (`authorization: <rawtoken>`), 406/408/401 mapping, WS auth-first-frame
envelope, `data.ResidentialBreaker`/`data.IotCt` routing, all control payloads, and every JSON field
name. Findings and dispositions:

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | Major | WS subscriptions weren't registered until the first REST poll (~2 min), because the socket was created *after* the initial discovery → `_rebuildSubscriptions()` early-returned. | **Fixed:** create the socket before the first `refreshDiscovery()` so subscriptions register and flush on the ready handshake. |
| 2 | Major | Bandwidth keepalive only started if the *initial* `connect()` resolved; if it failed and the socket self-reconnected later, the 1→0→1 CT keepalive never ran. | **Fixed:** start the (idempotent) keepalive from `onStateChange(true)` — every successful ready. |
| 3 | Minor | A non-communicating breaker (`currentState` = NotCommunicating, no `connected:false`) reported `online:true`. | **Fixed:** `online = connected && state !== 'offline'` + unit test. |
| 4 | Minor | Token expiry during reconnect looped forever instead of prompting repair. | **Fixed:** `onBeforeReconnect` now detects TOKEN_EXPIRED/AUTH, marks devices unavailable, and closes the socket to stop the loop. |
| 5 | Minor | `legAverage` returned `0` (not `null`) when both legs were absent → panel pushed voltage/frequency `0`. | **Fixed:** returns `null` when both inputs are nullish + unit test. |
| 6 | Minor | With `calculated_current` on, hub total current uses derived amps while per-leg totals use raw `rmsCurrent`, so they can disagree. | **Documented** — cosmetic reporting nuance on the aggregate meter only; per-breaker values are correct. |
| 7 | Minor | Toggling `read_only` didn't add/remove the breaker on/off tile until restart (control itself was correctly blocked live). | **Fixed:** `reconcileControl()` on the breaker device is re-run from the app settings listener. |

Post-fix: re-validated (publish level, clean) and re-ran tests (30/30).

## Feature-parity verification (HA → Homey)

| HA feature | Status |
|---|---|
| Per-breaker power / current / voltage | ✅ `measure_power` / `measure_current` / `measure_voltage` |
| Per-breaker energy (→ Energy dashboard) | ✅ `meter_power` (lifetime, monotonic; Insights derives daily) |
| Gen-2 remote on/off | ✅ `onoff` (`remoteOn`/`remoteTrip`) |
| Gen-1 remote trip (one-way) | ✅ *Trip* Flow action (`remoteTrip`) |
| Breaker status enum | ✅ `breaker_state` (12 states incl. all trip causes) |
| GFCI / AFCI / trip alarms | ✅ `alarm_generic` + `alarm_gfci` + `alarm_afci` |
| Amp rating, model, serial, firmware, position, poles, RSSI diagnostics | ✅ read-only device settings + `breaker_rating` |
| Locate LED | ✅ *Blink locate LED* action (`blinkLED`) |
| LWHEM & LDATA whole-panel meter (power/current/energy/voltage/freq, per-leg) | ✅ `panel` driver (cumulative main), per-leg voltage sub-caps |
| CT sensors | ✅ `ct` driver (`activePower`/`rmsCurrent`/`energyConsumption`) |
| all_on / all_off / trip_all (staggered) | ✅ app-scoped Flow actions using `stagger_delay` |
| Connectivity | ✅ `setAvailable`/`setUnavailable` per device |
| Options: 208V, read-only, calc-current, hide-dummy, energy-import, stagger | ✅ app settings |
| 2FA login, reauth/repair, token reuse | ✅ custom sign-in view (406/408), `onRepair`, session in app settings |
| WebSocket push + 55m reconnect + 30s/90s watchdog + 60s bandwidth keepalive + backoff | ✅ `LevitonSocket` + hub keepalive |
| Delta-vs-lifetime energy heuristic | ✅ `normalize.normalizeLifetime` (+ unit tests) |
| LWHEM FW ≥ 2.0.0 per-breaker subscriptions | ✅ `_rebuildSubscriptions` version gate |

## Homey-native enhancements added (beyond HA)
- Whole-home **Energy dashboard** modeling (cumulative main + per-breaker consumers).
- **Insights** on every capability; **timeline notification** on trip.
- **Threshold Flow triggers** (power rose-above / dropped-below) — not in the HA integration.
- **Repair** flow for painless re-auth; live **read-only** capability reconciliation.

## Loop 3 — Full parity re-review + enhancement round

Re-audited every port file against the complete HA feature inventory. Parity gaps found & closed:

| Gap | Fix |
|---|---|
| LWHEM hub totals summed breakers (undercounts non-smart circuits) | `_hubTotals` now sums the hub's **CTs** (whole-home clamps), matching HA; LDATA panels still sum child breakers |
| `show_energy_import` setting had no implementation | Lifetime import tracked per breaker/CT; dynamic `meter_power.imported` capability added when enabled & reported |
| Hub identify LED unused | New *Blink hub locate LED* Flow action (`identifyHub`, LWHEM only) |
| Breaker split-phase `leg` diagnostic missing | `breakerLeg()` + read-only setting (+4 unit tests → 34 total) |
| Panel per-leg power/current/frequency not exposed | `measure_power/current/frequency.leg1/.leg2` sub-capabilities on the panel device |
| Firmware-update status missing | WHEM `downloaded` / panel `updateAvailability`+`updateVersion` → read-only setting |
| No connectivity Flow cards | Breaker + panel *went offline / came back online* triggers, *load center is online* condition |
| No current-threshold triggers | *Current rose above / dropped below* (A) triggers |

**Optimizations:** `setSettings` now JSON-diffed (was written on every WS push), device trigger
cards cached on the driver (was a registry lookup per push), redundant hub re-dispatch removed
from the WS notification path, options getter hoisted out of the per-breaker totals loop.

## Loop 4 — Second adversarial review (13 findings, all resolved)

SDK usage verified against `homey-apps-sdk-v3-types` (getAvailable/setClass/setCapabilityOptions
exist; `registerRunListener` chains; driver init precedes device init; dotted sub-capabilities
addable at runtime; flow compose sound). Fixes applied:

| # | Severity | Finding → Fix |
|---|---|---|
| 1 | Major | App restart re-fired trip notifications & threshold triggers (prev values seeded 0/false) → all prev-trackers start `null`; trigger evaluation skips the first observation |
| 2 | Major | After token-expiry closed the socket, repair never revived it → `login()` reconnects the socket when halted |
| 3 | Major | First dispatch computed hub totals before CT/breaker accumulators seeded → cumulative panel meter bounced 0→N kWh (phantom Homey Energy usage) → `_dispatchAll` seeds breakers+CTs first; hubs dispatched only via `_recomputeHubTotals` |
| 4 | Minor | Import energy nulled when only leg 2 reports → check `energyImport ?? energyImport2` |
| 5 | Minor | Panel `online` could be `null`, swallowing the came-online trigger → coerced boolean |
| 6 | Minor | No WS ping → healthy-but-quiet socket reconnected every ~90s → ping every 30s; pong/ping advance the watchdog clock |
| 7 | Minor | 2-pole leg-2 value of 0 W misattributed leg 1's power (`\|\|` fallback) → `!= null` ternary |
| 8 | Minor | Unknown breaker position attributed to leg 2 → excluded from leg totals |
| 9 | Minor | Deleted breakers/CTs ghosted in totals forever → `_pruneStale()` on every discovery |
| 10 | Minor | CT/hub raw replaced (not merged) on poll, losing WS-only fields → spread-merge everywhere |
| 11 | Minor | onoff listener not re-registered after capability re-add → always re-register (replaces, never stacks) |
| 12 | Minor | Bulk ops matched `hubId` only (whem/panel id spaces can collide) → also match `hubType` |
| 13 | Minor | No overlap guard on slow discovery cycles → in-flight promise reuse |

Post-fix: 34/34 tests, `homey app validate --level publish` clean.

## Requires live testing (cannot be verified offline)

These depend on a real My Leviton account + Homey Pro and should be checked with `homey app run`:
1. Login + 2FA against the live endpoint; token persistence across restart.
2. Discovery walk shape for your specific hardware (LWHEM vs LDATA; Gen-1 vs Gen-2 breakers).
3. WebSocket auth handshake acceptance and live push field values.
4. Bandwidth keepalive effect and the 60-minute reconnect over a long session.
5. A real Gen-2 on/off toggle and a trip event firing the Flow + notification.
6. Energy dashboard accounting once real `meter_power` values accumulate.

## Reproduce
```bash
npm install
npm test                 # 30 unit tests
npm run validate         # homey app validate --level publish
homey app run            # live, on your Homey Pro (requires homey login)
```
