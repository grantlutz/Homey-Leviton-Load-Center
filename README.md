# Leviton Load Center — Homey Pro App

A native **Homey Pro** app that monitors and controls **Leviton 2nd-generation Smart Load Center**
circuit breakers (LWHEM Whole-Home Energy Module and the older LDATA/DAU panel) through the
**My Leviton cloud**.

> 🙏 **This app is a port.** All protocol knowledge comes from the excellent MIT-licensed
> Home Assistant integration by **[gtxaspec](https://github.com/gtxaspec)** —
> [`gtxaspec/leviton-load-center`](https://github.com/gtxaspec/leviton-load-center) and its
> [`aioleviton`](https://github.com/gtxaspec/aioleviton) protocol library — reimplemented
> clean-room in Node.js for the Homey SDK. If you use Home Assistant, use the original.

> ⚠️ **Unofficial.** Leviton publishes no public API. This app talks to the same private cloud the
> My Leviton app uses. Leviton can change it and break the app at any time. It is **cloud-dependent**
> (no local fallback) and requires a **Homey Pro** (sideloaded via the Homey CLI — Homey Cloud only
> runs published Store apps).

- **Repository:** https://github.com/grantlutz/Homey-Leviton-Load-Center
- **Issues / support:** https://github.com/grantlutz/Homey-Leviton-Load-Center/issues
- **App id:** `com.leviton.loadcenter` · **SDK:** 3 · **Platform:** Homey Pro (local)

---

## Contents

- [What you need](#what-you-need)
- [Features](#features)
- [Installation](#installation)
- [Pairing your devices](#pairing-your-devices)
- [Configuration (app settings)](#configuration-app-settings)
- [Flow cards](#flow-cards)
- [Homey Energy](#homey-energy)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)
- [Development](#development)
- [Limitations & notes](#limitations--notes)
- [Credits & license](#credits--license)

---

## What you need

| Requirement | Notes |
|---|---|
| **Homey Pro** | Early 2019 or Early 2023 model. Homey Cloud cannot run sideloaded apps. |
| **Leviton Smart Load Center** | With an **LWHEM** (Whole-Home Energy Module, 2nd gen) or **LDATA** (Data Acquisition Unit, 1st gen) hub, online in the My Leviton app. |
| **My Leviton account** | The same e-mail + password you use in the My Leviton mobile app. 2FA is supported. |
| **A computer with Node.js ≥ 18** | Only for installation — the app runs entirely on the Homey afterwards. |

## Features

### Devices
| Driver | Represents | Key data |
|---|---|---|
| **Breaker** | Each smart / CT-monitored breaker | Power (W), Current (A), Voltage (V), Energy (kWh), on/off (Gen 2), state, rating, GFCI/AFCI/trip alarms |
| **Load Center** | An LWHEM hub or LDATA panel (whole-home main meter) | Total power/current/energy, per-leg voltage, frequency, Wi-Fi/firmware diagnostics |
| **Current Transformer** | An LWHEM CT clamp | Power, Current, Energy |

### Per-breaker capabilities
- `onoff` — remote on/off for **Gen 2** breakers (`remoteOn` / `remoteTrip`). Gen 1 breakers are
  trip-only (see the *Trip* Flow action).
- `measure_power`, `measure_current`, `measure_voltage`, `meter_power` (cumulative → **Homey Energy**).
- `breaker_state` — enum: on / off / connecting / offline / remote trip / GFCI / AFCI / overcurrent /
  overload / short-circuit / upstream fault.
- `alarm_generic` (tripped), `alarm_gfci`, `alarm_afci` — drive Flows & Insights timelines.
- `breaker_rating` — amperage rating (read-only).

### Homey-native enhancements (beyond the HA feature set)
- **Homey Energy dashboard** — the Load Center device is marked cumulative (whole-home main); each
  breaker is a first-class consumer, so Homey computes monitored vs. unmonitored usage automatically.
- **Insights** — every numeric/boolean capability is logged and graphable.
- **Timeline notifications** — a push notification fires when a breaker trips.
- **Threshold Flow triggers** — power/current rose-above / dropped-below (not in the HA integration).
- **Repair flow** — re-authenticate after a password change / token expiry without removing devices.

---

## Installation

The app is sideloaded with the official Homey CLI. You do this once from any computer on the same
network account; the app then lives on your Homey Pro permanently (it survives reboots).

```bash
# 1. One-time tooling (needs Node.js ≥ 18)
npm install --global homey
homey login                # opens a browser to authenticate your Athom account

# 2. Get the app
git clone https://github.com/grantlutz/Homey-Leviton-Load-Center.git
cd Homey-Leviton-Load-Center
npm install

# 3. Install it on your Homey Pro
homey app install          # pick your Homey when prompted
```

Alternatives to step 3:

- `homey app run` — development mode: streams live logs to your terminal, and **uninstalls when you
  press Ctrl-C**. Useful for a first test or when reporting a bug.
- `homey app validate --level publish` — pre-flight check without installing anything.

**Updating:** `git pull`, then `homey app install` again. Sideloaded apps do not auto-update; your
paired devices, settings, and Flows are preserved across reinstalls.

## Pairing your devices

1. In the Homey mobile app go to **Devices → “+” → Leviton Load Center**.
2. Pick a driver — start with **Breaker**.
3. Sign in with your **My Leviton e-mail and password**. The **Sign in** button lights up blue once
   both fields are filled — tap it (not the OS keyboard's return key, though that works too).
   If your account has two-factor authentication, a code field appears — enter the code from your
   e-mail/SMS and sign in again.
4. Select the breakers you want and confirm. Smart breakers and CT-monitored branch circuits are
   listed; placeholder slots can be hidden via app settings.
5. Repeat **Add device** for the **Load Center** (whole-panel meter, recommended for Homey Energy)
   and **Current Transformer** drivers — the login step is skipped automatically because you're
   already signed in.

> 🔐 Your credentials are sent only to Leviton's cloud (`my.leviton.com`) and the session token is
> stored on your own Homey. Nothing is sent anywhere else. Never paste your credentials anywhere else.

**Password changed / token expired?** Devices go unavailable with an authentication message. Long-press
the device → **Settings → Maintenance → Repair**, and sign in again. All devices recover at once — the
app uses one shared session.

## Configuration (app settings)

**More → Apps → Leviton Load Center → Configure app:**

| Setting | Effect |
|---|---|
| **Read-only mode** | Disables all breaker control (on/off/trip/bulk). Takes effect on app restart. |
| **Calculate current from power ÷ voltage** | Derive amps instead of using the reported `rmsCurrent`. |
| **208 V system** | Use a 208 V divisor for 2-pole calculated current (commercial split-phase). |
| **Hide non-smart / placeholder breakers** | Exclude placeholder slots that only carry an LSBMA CT. |
| **Expose imported-energy meters** | Reserved for import-energy metering. |
| **Bulk operation stagger delay** | Seconds between breakers in *all on/off/trip* (1–10, default 2). |

## Flow cards

| Type | Card | Notes |
|---|---|---|
| Trigger | **A breaker tripped** | Tokens: reason, power at trip |
| Trigger | **Power rose above / dropped below … W** | Per-breaker threshold |
| Trigger | **Current rose above / dropped below … A** | Per-breaker threshold |
| Trigger | **Breaker went offline / came online** | Connectivity watch |
| Trigger | **Panel went offline / came online** | Hub connectivity |
| Condition | **Breaker is on**, **Breaker state is …** | State enum matches the tile |
| Action | **Turn on / Turn off / Trip** | On/off is Gen 2 only; Trip works on Gen 1 + Gen 2 |
| Action | **Blink locate LED** | Identifies the physical breaker (5 s blink) |
| Action | **All breakers on / off / Trip all** | On the Load Center device, staggered by the delay setting |
| Action | **Identify panel** | Blinks the hub LED |

All standard capability triggers (`onoff` changed, power changed, alarms) are available too.

## Homey Energy

- Add the **Load Center** device and Homey Energy treats it as the **whole-home cumulative meter**.
- Each **Breaker** (and **CT**) is an individual consumer; Homey shows monitored vs. "other" usage.
- ⚠️ **Avoid double counting:** if a CT clamps a circuit that is already a paired smart breaker,
  both report the same energy. Pair whichever one you want counted, not both.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| **"Waiting for authentication" during pairing** | Fixed in v1.0.1 — earlier builds showed a Homey *Continue* button that skipped the login. Update the app (`git pull && homey app install`). |
| **Login fails with correct credentials** | If 2FA is enabled a code field appears after the first attempt — that first "failure" is the cloud sending you a code. Enter it and sign in again. |
| **Devices unavailable, "authentication" error** | Password changed or token revoked. Device → Settings → Maintenance → **Repair**, sign in again. |
| **Values freeze for ~1–2 minutes at a time** | Leviton's cloud kills WebSockets hourly; the app reconnects automatically (55-min proactive cycle + watchdog) and the 2-min REST poll bridges gaps. Sustained gaps → check the app's log (`homey app run` build) or your internet. |
| **On/off tile doesn't update immediately after switching** | Leviton doesn't echo remote commands over the push socket; the app updates optimistically and reconciles on the next poll. |
| **Energy (kWh) jumps or resets** | The app filters the cloud's "delta vs. lifetime" ambiguity, but a hub firmware reset can genuinely reset lifetime counters. Homey Insights keeps its own history. |
| **A breaker is missing from pairing** | It may be a placeholder slot — untick **Hide non-smart / placeholder breakers** in app settings and pair again. |
| **Gen 1 breaker won't turn back on remotely** | Hardware limitation: Gen 1 supports remote *trip* only; re-close it physically at the panel. |

Still stuck? [Open an issue](https://github.com/grantlutz/Homey-Leviton-Load-Center/issues) with the
app version, hub type (LWHEM/LDATA), firmware version, and — if you can — logs from `homey app run`.

## Architecture

```
app.js                      One shared client + WebSocket + poll loop; registers bulk Flow actions.
lib/
  constants.js              URLs, endpoints, state maps, keepalive timings.
  LevitonClient.js          REST: login/2FA, discovery walk, control (PATCH/PUT).
  LevitonSocket.js          WebSocket push + 55-min reconnect + 30s watchdog + backoff.
  LevitonHub.js             Discovery, subscriptions, energy accounting, bandwidth keepalive,
                            state fan-out to devices, control.
  normalize.js              Pure state/energy mapping functions (unit-tested).
drivers/
  breaker/  panel/  ct/     driver.js (pairing/flow) + device.js (capability sink).
```

**One shared connection.** A panel can hold ~66 breakers; the app keeps a **single** REST client,
**single** WebSocket, and **single** poll loop, then fans normalized state out to each device by
Leviton id. Devices are thin capability sinks that register with the hub on init.

**Real-time strategy (ported from the HA integration):**
1. **WebSocket push** is primary — subscribes to each hub/panel and, on LWHEM firmware ≥ 2.0.0, to
   each breaker individually (newer firmware stopped nesting breaker data in hub notifications).
2. **REST poll** every 2 minutes is the fallback (and the source of truth for LDATA panel energy).
3. **60-minute hard-timeout mitigation:** Leviton's server kills the socket at ~60 min. The app
   reconnects proactively at 55 min, runs a 30 s silence watchdog (reconnect if no data for 90 s),
   and toggles WHEM bandwidth `1→0→1` every 60 s to keep CT pushes flowing. Reconnect backoff is
   `[10, 30, 60, 120, 300] s`, and the token is re-validated before each reconnect.
4. **Energy delta trap:** with `bandwidth=1` the cloud returns period *deltas* instead of lifetime
   totals; `normalize.js` discards suspected deltas so `meter_power` stays monotonic.

## Development

```bash
npm test              # offline unit tests for normalize.js (no Homey required)
npm run validate      # homey app validate --level publish
homey app run         # live dev run with streaming logs (Ctrl-C uninstalls)
```

- Edit only `.homeycompose/*` and `drivers/*/*.compose.json`; the CLI regenerates the root
  `/app.json` on every build — never edit it by hand.
- Pairing UI lives in `drivers/*/pair/login.html` (one copy per driver — keep them in sync).
- Placeholder images can be regenerated with `npm run build:images`.
- See [`PORTING-PLAN.md`](./PORTING-PLAN.md) for the original design & HA feature-parity matrix,
  [`VALIDATION.md`](./VALIDATION.md) for the manual test checklist, and
  [`PUBLISHING.md`](./PUBLISHING.md) for the Homey App Store publishing runbook.

Contributions welcome — open an issue first for anything beyond a small fix.

## Limitations & notes

- **Unofficial & cloud-only** — breaks if Leviton changes the API or the cloud/Internet is down.
- **Gen 1 breakers** can be tripped remotely but **not re-closed** remotely (hardware limitation).
- **CT double-counting:** if a CT measures a circuit already represented by a breaker device, both
  appear as consumers in Homey Energy. Remove whichever you don't want counted.
- **Remote commands** aren't echoed back over the WebSocket, so on/off state is updated optimistically
  and reconciled on the next poll.

## Credits & license

MIT. Ported from the Home Assistant integration by [**gtxaspec**](https://github.com/gtxaspec):
protocol facts (URLs, JSON shapes, timing constants) were reimplemented clean-room in Node.js from
the MIT-licensed [`gtxaspec/leviton-load-center`](https://github.com/gtxaspec/leviton-load-center)
and [`gtxaspec/aioleviton`](https://github.com/gtxaspec/aioleviton) — thank you for doing the hard
reverse-engineering work. Not affiliated with or endorsed by Leviton Manufacturing Co.
