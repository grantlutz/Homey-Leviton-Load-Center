# Homey Community launch post

**Posted:** the live support thread is
https://community.homey.app/t/leviton-load-center-unofficial-smart-breaker-monitoring-energy-control/157620
and its topic id (**157620**) is set as `homeyCommunityTopicId` in `.homeycompose/app.json`, so the
App Store listing links to it. The draft below is kept for reference — edit the live post, not
this file.

---

## Subject

```
[APP][Pro] Leviton Load Center (Unofficial) — smart breaker monitoring, energy & control
```

---

## Post body

Hi all 👋

I'm sharing a new app for **Leviton Smart Load Centers**: per-circuit energy monitoring and breaker
control for your electrical panel, natively in Homey.

> ⚠️ **This is an unofficial community app.** It is not affiliated with, endorsed by, or supported
> by Leviton. It uses the same private cloud service as the My Leviton mobile app, which means it
> **requires an internet connection** and could stop working if Leviton changes their service.
> Please keep that in mind before relying on it for anything critical.

### What it does

- **Every smart breaker becomes a Homey device** — live power (W), current (A), voltage (V), and
  lifetime energy (kWh), plus a detailed state (on / off / GFCI fault / arc fault / overload /
  short circuit / …).
- **Remote on/off for Gen 2 breakers**, remote trip for Gen 1 and Gen 2, and a *blink locate LED*
  action so you can find the right breaker in the panel.
- **Trip alerts with the reason** — a Flow trigger (filterable by cause: GFCI, AFCI, overload,
  short circuit…) plus an automatic timeline notification the moment anything trips.
- **Homey Energy done properly** — the panel registers as your home's cumulative main meter and
  every breaker/CT is an individual consumer, so the Energy tab shows total, per-circuit, and
  "other" usage automatically.
- **Threshold Flow triggers** — power/current rose above or dropped below a value you set (great
  for "freezer stopped drawing power" or "workshop circuit at 80 % of its rating" alerts).
- **Bulk actions** — all breakers on / off / trip-all, staggered to avoid inrush surges.
- **Whole-home extras** — per-leg voltage/power/current/frequency on the panel device, CT clamp
  devices, Insights on everything.

### What you need

- A **Homey Pro** (the app opens an outbound WebSocket, so Homey Cloud is not supported)
- A Leviton Smart Load Center with an **LWHEM** (2nd gen Whole-Home Energy Module) or **LDATA**
  (1st gen) hub, already set up and online in the My Leviton app
- Your **My Leviton account** (2FA is supported; credentials go only to Leviton's cloud and the
  session is stored only on your own Homey — no third parties, no telemetry)

### Install

- **App Store:** *(link once live — currently submitted / in certification)*
- **Test build:** https://homey.app/a/com.leviton.loadcenter/test/
- **Source code (MIT):** https://github.com/grantlutz/Homey-Leviton-Load-Center — full docs,
  a feature/use-case guide, and the project's contribution principles live there. Issues and PRs
  welcome; it's a public repo because I'd love collaborators.

### Good to know

- Gen 1 breakers can be **tripped** remotely but not switched back on remotely — that's a hardware
  limitation, not an app bug.
- Leviton's cloud closes connections hourly; the app reconnects automatically and also polls every
  2 minutes as a fallback, so brief gaps self-heal.
- A **read-only mode** in app settings disables all control if you only want monitoring.
- The app will never automatically re-close a *faulted* breaker — trips are a safety signal, and
  turning a faulted circuit back on is a decision for a human.

### Credits

This app is a clean-room Node.js port of the excellent MIT-licensed Home Assistant integration by
**gtxaspec** ([leviton-load-center](https://github.com/gtxaspec/leviton-load-center) /
[aioleviton](https://github.com/gtxaspec/aioleviton)) — all the hard reverse-engineering is his
work. If you run Home Assistant, use the original!

Feedback, bug reports (app version + hub type + firmware please), and Flow ideas are very welcome —
here or on GitHub. 🔌⚡
