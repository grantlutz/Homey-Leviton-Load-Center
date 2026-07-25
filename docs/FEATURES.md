# Leviton Load Center for Homey — Features, Functionality & Use Cases

The complete reference for what the app does and how to use it. For install/pairing basics see the
[README](../README.md); for the project's guiding principles see the
[Constitution](../CONSTITUTION.md).

- [Supported hardware](#supported-hardware)
- [The three device types](#the-three-device-types)
- [Capabilities in detail](#capabilities-in-detail)
- [Flow cards in detail](#flow-cards-in-detail)
- [Homey Energy integration](#homey-energy-integration)
- [Insights, timeline & diagnostics](#insights-timeline--diagnostics)
- [App settings](#app-settings)
- [Sign-in, sessions & repair](#sign-in-sessions--repair)
- [How data flows (behavior you'll observe)](#how-data-flows-behavior-youll-observe)
- [Use cases & example Flows](#use-cases--example-flows)

---

## Supported hardware

| Hardware | Generation | What you get |
|---|---|---|
| **LWHEM** Whole-Home Energy Module | 2nd gen | Whole-home meter, per-leg data, CT clamps, breaker push updates, hub locate LED |
| **LDATA** Data Acquisition Unit | 1st gen | Whole-home meter and breaker data via polling-oriented cloud path |
| **Gen 2 smart breakers** (e.g. LB-series, `canRemoteOn`) | 2nd gen | Full monitoring **+ remote on/off** + trip + locate LED |
| **Gen 1 smart breakers** | 1st gen | Full monitoring + remote **trip only** (cannot re-close remotely — hardware limitation) |
| **LSBMA CT-monitored branch circuits** | — | Power/current/energy monitoring on standard (non-smart) breakers |
| **Whole-home CT clamps** on the LWHEM | — | Separate Current Transformer devices |

Everything goes through the **My Leviton cloud** — the panel hub must be online in the My Leviton
app first. There is no local API; if your internet or Leviton's cloud is down, the app is down
(devices are marked unavailable and recover automatically).

## The three device types

### 1. Breaker
One Homey device per smart or CT-monitored breaker. The heart of the app: live electrical data,
trip/fault alarms, and (Gen 2) remote switching.

### 2. Load Center
One Homey device per LWHEM hub or LDATA panel — the **whole-home main meter**. Reports totals
across the panel plus per-leg (L1/L2) voltage, power, current, and frequency. Registered as
Homey Energy's cumulative meter. Also the anchor for **bulk actions** (all on / all off / trip all).

### 3. Current Transformer
One Homey device per CT clamp connected to the LWHEM. Power, current, and energy for whatever the
clamp measures (mains legs, solar backfeed, subpanel, generator input…).

## Capabilities in detail

### Breaker

| Capability | Meaning | Notes |
|---|---|---|
| `onoff` | Remote switch | **Gen 2 only.** Off = `remoteTrip`, on = `remoteOn`. Hidden on Gen 1/CT-only breakers. Locked in read-only mode. |
| `measure_power` | Live power (W) | Pushed over WebSocket, ~seconds granularity |
| `measure_current` | Live current (A) | Reported RMS, or calculated P÷V (setting) |
| `measure_voltage` | Live voltage (V) | Per-breaker |
| `meter_power` | Lifetime energy (kWh) | Monotonic — feeds Homey Energy |
| `breaker_state` | Detailed state enum | on · off · connecting · offline · remote trip · GFCI fault · AFCI fault · AFCI miswire · overcurrent · overload · short circuit · upstream fault |
| `alarm_generic` ("Tripped") | Any trip/fault active | Drives Flows, Insights, timeline |
| `alarm_gfci` | Ground-fault trip active | |
| `alarm_afci` | Arc-fault trip active | |
| `breaker_rating` | Amperage rating | Read-only, from panel config |

Per-breaker **device settings** show model, serial, rating, poles, panel position, split-phase leg,
three firmware versions (BLE / meter / protection), and BLE signal strength.

### Load Center (panel)

| Capability | Meaning |
|---|---|
| `measure_power` / `measure_current` / `measure_voltage` / `measure_frequency` | Whole-panel totals |
| `meter_power` | Whole-home lifetime energy (kWh) — the Homey Energy cumulative meter |
| `measure_voltage.leg1` / `.leg2` | Per-leg voltage (spot brownouts & lost-leg conditions) |
| `measure_power.leg1` / `.leg2` | Per-leg power (check panel balance) |
| `measure_current.leg1` / `.leg2` | Per-leg current |
| `measure_frequency.leg1` / `.leg2` | Per-leg frequency |

Panel device settings expose Wi-Fi and firmware diagnostics.

### Current Transformer

`measure_power`, `measure_current`, `meter_power` — a lean consumer/producer meter.

## Flow cards in detail

### Breaker — triggers

| Card | Arguments | Tags (tokens) |
|---|---|---|
| **This breaker tripped (…)** | Reason dropdown: *Any reason*, Remote trip, Ground fault (GFCI), Arc fault (AFCI), AFCI miswire, Overcurrent, Overload, Short circuit, Upstream fault | Trip reason (text), Power (W) at trip |
| **Power rose above … W** | Watts | — |
| **Power dropped below … W** | Watts | — |
| **Current rose above … A** | Amps (0.5 A steps) | — |
| **Current dropped below … A** | Amps | — |
| **Breaker went offline** / **came back online** | — | — |

Threshold triggers fire **on the crossing only** (previous value on one side, new value on the
other), so a load hovering near the threshold doesn't spam your Flow.

All standard capability triggers also exist: turned on/off, power/current/voltage/energy changed,
state changed, any alarm turned on/off.

### Breaker — conditions
- **Breaker is on / is not on**
- **Breaker state is / is not …** (full state enum dropdown)

### Breaker — actions
- **Turn on** / **Turn off** — Gen 2 only; errors on Gen 1 or in read-only mode
- **Trip** — software-trips the breaker (Gen 1 + Gen 2)
- **Blink locate LED** — blinks the breaker's LED for ~5 s so you can find it in the panel

### Load Center — triggers / conditions / actions
- Triggers: **Load center went offline**, **Load center came back online**
- Condition: **Load center is / is not online**
- Actions: **Turn all breakers on**, **Turn all breakers off**, **Trip all breakers** — each breaker
  is actioned in sequence with the configurable **stagger delay** (avoids inrush surge and cloud
  rate-limits); **Blink hub locate LED** (LWHEM only, ~10 s)

### Tags everywhere
Every numeric capability is available as a tag in Flows via the standard "capability changed"
triggers, so you can push values into notifications, logic cards, webhooks, MQTT, dashboards, etc.

## Homey Energy integration

- The **Load Center** registers as a **cumulative (whole-home) meter** — Homey Energy shows your
  total consumption from it.
- Every **Breaker** and **CT** is an individual consumer; Homey computes the "Other" remainder
  automatically (total minus monitored circuits).
- **Don't double-count:** if a CT clamps a feed that is *also* a paired smart breaker, pair only the
  one you want counted.
- Energy values survive app restarts and reinstalls (they come from the panel's lifetime counters,
  filtered so they only move forward — see [delta trap](#how-data-flows-behavior-youll-observe)).

## Insights, timeline & diagnostics

- **Insights:** every numeric and boolean capability is logged — graph per-circuit power over
  months, compare legs, overlay trips against load.
- **Timeline:** a push notification is created the moment any breaker trips, naming the breaker and
  the reason (e.g. "⚡ Kitchen GFCI tripped — Ground fault (GFCI)").
- **Device settings** double as a diagnostics page (firmware, signal, position, leg).

## App settings

**More → Apps → Leviton Load Center → Configure app**

| Setting | Default | Effect |
|---|---|---|
| **Read-only mode** | off | Hard-disables *all* control (on/off, trip, bulk). The on/off tile is locked on every Gen 2 breaker immediately. Monitoring continues. |
| **Calculate current from power ÷ voltage** | off | Use P÷V instead of the panel's reported RMS current (some firmware reports noisy/zero RMS). |
| **208 V system** | off | For 208 V commercial split-phase: corrects 2-pole calculated current. |
| **Hide non-smart / placeholder breakers** | on | Hides placeholder slots (unmetered plain breakers) from pairing. |
| **Expose imported-energy meters** | off | Adds a separate imported-energy meter where applicable. |
| **Bulk operation stagger delay** | 2 s | Seconds between breakers during all-on / all-off / trip-all (1–10). |

Settings that affect discovery re-run it live — no app restart needed (except read-only mode's
control lock, which also applies instantly to the on/off tiles).

## Sign-in, sessions & repair

- **One account, one session.** You sign in once (any driver's pairing); every other pairing skips
  the login screen. The session token lives only on your Homey.
- **2FA supported.** If your account has two-factor auth, a code field appears after the first
  sign-in attempt.
- **Repair flow.** Password changed or token revoked? Devices go unavailable → long-press any of
  them → **Settings → Maintenance → Repair** → sign in. All devices recover at once.

## How data flows (behavior you'll observe)

1. **WebSocket push first.** Live values update within seconds. On LWHEM firmware ≥ 2.0.0 each
   breaker gets its own subscription.
2. **REST poll every 2 minutes** as a safety net (and the source of truth for LDATA energy).
3. **Hourly reconnect is normal.** Leviton's server closes sockets at ~60 min; the app reconnects
   proactively at 55 min with a silence watchdog and exponential backoff — you shouldn't notice.
4. **Optimistic switching.** Leviton doesn't echo remote commands over the socket, so a toggle shows
   instantly and is reconciled on the next poll (≤ 2 min).
5. **Energy delta trap.** In high-bandwidth mode the cloud sometimes reports *period deltas* instead
   of lifetime totals; the app discards suspected deltas so `meter_power` never runs backwards.

## Use cases & example Flows

### Safety & protection

**Instant trip alerts, with the cause**
> WHEN *Kitchen counter* → This breaker tripped (**Any reason**)
> THEN Send a notification: "Kitchen tripped: *Trip reason* at *Power* W"

**Arc-fault pattern watch** (AFCI trips can precede real wiring faults)
> WHEN *Bedroom* → This breaker tripped (**Arc fault (AFCI)**)
> THEN Send notification + log to a Google Sheet via webhook — call an electrician if it recurs.

**Freezer / sump-pump circuit watchdog**
> WHEN *Garage freezer* → Power dropped below **5 W**
> AND Time is between … (give the compressor a duty cycle window)
> THEN Alert: "Freezer circuit has stopped drawing power."
Also: WHEN *Breaker went offline* THEN alert.

**Overload early warning** (act before the breaker does)
> WHEN *Workshop* → Current rose above **16 A** (80 % of a 20 A rating)
> THEN Announce on a speaker: "Workshop circuit near its limit."

**Cut power to a misbehaving appliance**
> WHEN smoke detector in laundry = alarm
> THEN *Dryer* → **Trip**

### Energy management

**Whole-home + per-circuit energy dashboard** — pair the Load Center and your key breakers; Homey
Energy shows total, per-circuit, and "Other" automatically. No Flows required.

**EV charging in cheap hours** (Gen 2 breaker on the EVSE circuit)
> WHEN Time is 23:00 THEN *EV charger* → **Turn on**
> WHEN Time is 07:00 THEN *EV charger* → **Turn off**
> (Guard with: AND Breaker current dropped below 1 A — don't cut a mid-charge session.)

**Peak-shaving / demand response**
> WHEN *Load Center* power rose above **12000 W**
> THEN Turn off *Water heater*, *Pool pump* (Gen 2), notify.
> WHEN power dropped below 8000 W THEN turn them back on.

**Find phantom loads** — Insights per-breaker power at 3 a.m. tells you which circuits never sleep.

**Panel balance check** — compare `power.leg1` vs `power.leg2` in Insights; chronically lopsided
legs are worth rebalancing with your electrician.

### Away, vacation & rentals

**Vacation mode**
> WHEN Flow "Leaving for vacation" starts
> THEN *Load Center* → **Turn all breakers off** — except keep fridge/security by simply not pairing
> them as Gen 2 control or turning those specific breakers back on next.
> (Or: individual **Turn off** cards for exactly the circuits you want dead.)

**Rental / workshop lockout**
> Turn off the hot-tub or shop-equipment breaker outside allowed hours; turn on when booked.

### Monitoring & maintenance

**"Which breaker is that?"** — the **Blink locate LED** action from your phone while standing at
the panel. **Blink hub locate LED** finds the LWHEM itself.

**Grid-quality log** — Insights on panel voltage/frequency (per leg) catches brownouts and
lost-neutral events; add a trigger on `measure_voltage.leg1` below 110 V to be told immediately.

**Cloud-outage awareness**
> WHEN Load center went offline THEN notify "Panel lost cloud connection."
> WHEN Load center came back online THEN notify all-clear.

**Appliance-done notifications**
> WHEN *Dryer* power dropped below **10 W** AND *Dryer* power was above 300 W in the last 10 min
> (use a logic variable set by "rose above 300") THEN "Laundry is done."

### Solar / generation (via CTs)

Clamp a CT on the solar backfeed → a Current Transformer device gives you production power and
energy, graphable in Insights and usable in export-aware Flows.

---

*Something you built that isn't here? Open a PR against this file — real-world Flow recipes are
very welcome.*
