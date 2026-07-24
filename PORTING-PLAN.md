# Leviton Load Center → Homey Pro — Porting Plan & Design

> Porting the [`gtxaspec/leviton-load-center`](https://github.com/gtxaspec/leviton-load-center)
> Home Assistant integration (and its underlying [`aioleviton`](https://github.com/gtxaspec/aioleviton)
> client library, both MIT-licensed) to a native **Homey Pro** app (Apps SDK v3).

## Context

The Leviton 2nd-gen Smart Load Center (smart circuit breakers + an in-panel hub —
**LWHEM** Whole-Home Energy Module or the older **LDATA/DAU** panel) has **no local API**.
All telemetry and control route through the **My Leviton cloud** (`my.leviton.com` REST +
`socket.cloud.leviton.com` WebSocket push). The only mature integration is for Home Assistant;
there is **no native Homey app**. Rather than bridge through Home Assistant, this project builds a
first-class Homey Pro app that talks to the Leviton cloud directly and exposes every breaker as a
Homey device with full Energy-dashboard, Insights, and Flow integration.

**Deployment reality:** unofficial cloud API → can break if Leviton changes it; cloud-dependent →
no data during outages; requires **Homey Pro** (CLI sideload) — Homey Cloud only runs store apps.
Credentials are entered in the app's own pairing screen, never in chat.

## Feature parity matrix (HA → Homey)

| HA feature | Homey equivalent | Notes |
|---|---|---|
| Per-breaker power (W) | `measure_power` | Sum of both poles for 2-pole breakers |
| Per-breaker current (A) | `measure_current` | `rmsCurrent`, or calc = power/voltage (option) |
| Per-breaker daily energy (kWh) | `meter_power` | Cumulative; feeds Homey Energy |
| Lifetime energy (diagnostic) | `meter_power.lifetime` (sub-cap) + setting | |
| Breaker on/off (Gen 2) | `onoff` (setable) | `remoteOn` / `remoteTrip` |
| Breaker trip (Gen 1, one-way) | Flow action + `button.trip` capability | `remoteTrip` only, can't re-close |
| Breaker status enum | custom `breaker_state` (enum) | on/off/gfci/afci/overload/etc. |
| GFCI / AFCI / overload fault | `alarm_generic` + custom `alarm_gfci`,`alarm_afci` | drives Flows + Insights |
| Amp rating (diagnostic) | custom `breaker_rating` (number, A) + setting | |
| Identify/locate LED | Flow action `identify` (`blinkLED`) | all smart breakers |
| Whole-panel / LWHEM meter | `panel` driver device | `measure_power/current/voltage/frequency`, `meter_power` (cumulative main) |
| Per-leg voltage/frequency/power/current | sub-capabilities `.leg1`/`.leg2` | |
| CT sensors (LWHEM only) | `ct` driver device | power/current/energy |
| all_on / all_off / trip_all | Flow actions (app-scoped) | staggered, with delay setting |
| Connectivity binary sensor | `setAvailable`/`setUnavailable` + `alarm_generic` | |
| Firmware/MAC/IP/serial/RSSI diagnostics | read-only `label` device settings | |
| Config options (208V, read-only, calc current, hide dummy, energy import, stagger) | app settings + device settings | |
| 2FA login, reauth, token reuse | custom pair + `onRepair`, token in app settings | 406=2FA needed, 408=bad code |

## Architecture

```
app.js                       Owns ONE shared LevitonClient + ONE WebSocket + ONE poll loop.
                             Fans state out to devices by id. Registers app-scoped Flow cards.
lib/
  LevitonClient.js           REST: login/2FA, discovery walk, control (PATCH/PUT), energy history.
  LevitonSocket.js           WebSocket push + 55-min reconnect + 30s watchdog + 60s bandwidth keepalive.
  LevitonHub.js              Orchestrates discovery, subscription set, delta→lifetime energy accounting,
                             daily-baseline snapshot at midnight, dispatch to devices.
  constants.js               URLs, endpoints, state maps, keepalive timings.
drivers/
  breaker/                   One Homey device per smart/LSBMA breaker.
  panel/                     One device per hub (handles BOTH IotWhem and ResidentialBreakerPanel).
  ct/                        One device per CT (LWHEM only).
```

**Why one shared client + one poll loop (not per-device):** a panel can have ~66 breakers; N
devices each hitting the cloud would blow rate limits. The app holds the client; devices are thin
capability sinks. This mirrors HA's single DataUpdateCoordinator.

**Real-time strategy (ported verbatim):**
- **Primary:** WebSocket push (subscribe per hub/panel + per-breaker on LWHEM FW ≥ 2.0.0).
- **Fallback:** REST poll (HA uses 10 min; we use ~a few min, and always REST-poll LDATA panels
  because WS omits their energy).
- **60-min hard timeout mitigation:** proactive reconnect @ 55 min; silence watchdog @ 30s →
  reconnect if no data for 90s; bandwidth `1→0→1` toggle @ 60s (exponential backoff on failure).
- Reconnect backoff `[10,30,60,120,300]s`; re-validate token via permissions on reconnect;
  401 → mark devices unavailable + prompt repair.
- **Bandwidth/energy trap:** with `bandwidth=1`, REST energy is a *period delta*, not lifetime.
  Reset bandwidth to 0, sleep ~1s, then read energy; accumulate deltas into lifetime/daily.

## Device & capability model

### `breaker` driver
`class`: `socket` (Gen 2, has onoff) / `sensor` (monitoring-only).
Capabilities: `onoff`* , `measure_power`, `meter_power`, `measure_current`, `measure_voltage`,
`alarm_generic`, custom `breaker_state`, `breaker_rating`, `alarm_gfci`, `alarm_afci`.
(*onoff only added for Gen 2; Gen 1 trip is a Flow action.)
`energy`: **not** cumulative (branch consumer). `store`: `{hubId, hubType, breakerId, gen, isSmart, hasLsbma}`.
Settings (read-only labels): model, serial, firmware (ble/meter/protect), amp rating, poles, position, leg, BLE MAC/RSSI.

### `panel` driver (LWHEM hub or LDATA panel)
`class`: `sensor`. Capabilities: `measure_power`, `meter_power`, `measure_current`,
`measure_voltage`, custom `measure_frequency`, plus per-leg sub-caps
(`measure_voltage.leg1/2`, `measure_power.leg1/2`, `measure_current.leg1/2`, `measure_frequency.leg1/2`).
`energy`: `{ cumulative: true }` — this is the whole-home main meter.
Settings: model, serial, firmware set, IP, Wi-Fi SSID/mode/RSSI, residence id, firmware-update status.

### `ct` driver (LWHEM only)
`class`: `sensor`. Capabilities: `measure_power`, `meter_power`, `measure_current`,
per-leg current/power sub-caps. Settings: usage type, serial.

### Custom capabilities (`.homeycompose/capabilities/`)
- `breaker_state` — enum: on, off, connecting, offline, software_trip, gfci_fault, afci_miswire,
  afci_fault, overcurrent_trip, overload_trip, short_circuit_trip, upstream_fault.
  Fires `breaker_state_changed` Flow trigger automatically.
- `breaker_rating` — number, unit A, read-only sensor.
- `measure_frequency` — number, unit Hz, read-only sensor.
- `alarm_gfci`, `alarm_afci` — boolean, with `insightsTitleTrue/False`.

## Flow cards

**Triggers** (driver-scoped, `breaker`): `breaker_tripped` (tokens: `reason`, `power`),
`power_rose_above` / `power_dropped_below` (arg: watts), plus free system triggers for `onoff`,
`measure_power`, and auto `breaker_state_changed`.
**Conditions**: `breaker_is_on`, `breaker_state_is` (arg: state).
**Actions** (breaker): `turn_on`, `turn_off`, `trip` (Gen 1), `identify`.
**Actions** (app-scoped, panel): `all_on`, `all_off`, `trip_all` — staggered by `stagger_delay`.

## Pairing & auth

1. `login_credentials` pair view (email + password).
2. On login: `POST /Person/login?include=user`. On HTTP **406** → show custom `two_factor` view
   (code input) → re-login with `code`. **408** → invalid-code error. Store `{token, userId, email}`
   in `this.homey.settings` (app-wide, shared by all 3 drivers so the user logs in once).
3. `list_devices`: run discovery walk, return devices for the driver being paired (breaker/panel/ct),
   tagging each with `store` metadata. Subsequent driver pairings reuse the stored token (skip login).
4. `onRepair`: re-auth an existing device after password change / token expiry (`login_credentials`
   + `two_factor` views) and refresh the stored token.

## App settings (global options, mirrors HA options flow)
`voltage_208` (bool), `read_only` (bool — hides all control), `calculated_current` (bool),
`hide_dummy` (bool), `show_energy_import` (bool), `stagger_delay` (1–10s, default 2).

## Homey-native enhancements (beyond HA parity)
- **Energy dashboard**: panel marked `cumulative` → Homey auto-computes "other/unmonitored" usage;
  each breaker is a first-class consumer line item.
- **Insights**: every numeric/boolean capability auto-logged & graphable (power, current, trips).
- **Timeline notifications**: `homey.notifications.createNotification` on trip events
  ("Kitchen breaker tripped — GFCI").
- **Flow tokens**: trip reason / power / voltage exposed to Flows.
- **Threshold Flow triggers** (`power_rose_above`) — not present in HA, native here.
- **Availability + warnings**: `setUnavailable`/`setWarning` on offline / cloud outage.
- **Repair flow** for painless re-auth without removing devices.

## Build order (de-risk hard part first)
1. **Client core** (`lib/`): login/2FA → discovery → control → WebSocket + keepalive. Unit-testable
   with a small Node harness (no Homey required).
2. **App manifest + capabilities + flow + locales** (compose).
3. **Drivers/devices** (breaker, panel, ct) + pairing + settings + Flow registration.
4. **Docs** (`README.md`), then **validation** (`homey app validate`, self-review loops).

## Verification
- `homey app validate --level publish` must pass clean.
- `node test/harness.js` (offline) exercises the state-mapping pure functions
  (breaker_state decode, power summing, delta→lifetime energy, calc-current).
- End-to-end on the user's Homey Pro with their My Leviton account: `homey app run`, pair, confirm
  live power/current/energy, toggle a Gen-2 breaker, verify Energy dashboard + Insights + a Flow.

## License / attribution
MIT. `README` credits `gtxaspec/leviton-load-center` and `gtxaspec/aioleviton`; protocol facts
(URLs, JSON shapes) reimplemented clean-room in Node.js.
