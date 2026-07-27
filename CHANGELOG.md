# Changelog

All notable changes to this project are recorded here, newest first.

> **Maintenance policy:** this file is maintained by Claude (the AI assistant working on this repo)
> as part of every change set — human contributors are welcome to add entries in PRs, and Claude
> will reconcile them. Rules:
> - Every user-visible change lands here **in the same commit** that makes it.
> - Entries are grouped under the release version (`Added` / `Changed` / `Fixed`), with an
>   **Unreleased** section collecting work between releases; it becomes the next version's entry
>   when the version is bumped in `.homeycompose/app.json` + `package.json`.
> - Dates are absolute (YYYY-MM-DD). Semver per the [Constitution](./CONSTITUTION.md), Article X:
>   fixes = patch, new cards/capabilities = minor, breaking = major.
> - Entries say what a **user** will notice, not which files changed.

## Unreleased

### Added
- Real App Store artwork replacing the generated placeholders: app hero image plus breaker,
  load-center, and CT driver illustrations at all required sizes. Original flat-design artwork,
  no Leviton trademarks; editable SVG sources kept in `scripts/artwork/`.
- Homey Community launch post draft (`docs/COMMUNITY-LAUNCH-POST.md`) with the `[APP][Pro] …
  (Unofficial)` subject line, ready for the forum support thread.
- Full feature/functionality/use-case reference (`docs/FEATURES.md`) and project
  [Constitution](./CONSTITUTION.md), both linked from the README.

### Changed
- README: prominent attribution to gtxaspec's original Home Assistant integration.
- The app now links to its [Homey Community support thread](https://community.homey.app/t/leviton-load-center-unofficial-smart-breaker-monitoring-energy-control/157620)
  (`homeyCommunityTopicId` 157620) — shown as the Community link on the App Store listing.

## 1.0.2 — 2026-07-25

### Fixed
- **Flow:** the *"This breaker tripped (reason)"* trigger showed a dead, uneditable "reason" chip —
  the placeholder referenced a token instead of an argument. The reason is now a real dropdown
  (**Any reason**, Remote trip, Ground fault (GFCI), Arc fault (AFCI), AFCI miswire, Overcurrent,
  Overload, Short circuit, Upstream fault) and the trigger filters on it. The *Trip reason* and
  *Power* tags are still available to later cards. Flows saved with the old card keep working and
  behave as "Any reason" — open them and re-pick the card to use the filter.

## 1.0.1 — 2026-07-24

### Fixed
- **Pairing:** removed Homey's default *Continue* button from the sign-in view. It skipped the login
  and left pairing stuck on "waiting for authentication". The custom **Sign in** button is now the
  only action.
- **Pairing:** the Sign in button now starts disabled (grey) and turns blue once e-mail and password
  (and the 2FA code, when shown) are filled in, and shows *Signing in…* while authenticating.
- **Repair:** the repair flow now closes correctly after a successful re-login (it previously tried
  to navigate to a pairing view that doesn't exist in repair sessions).
- **Breaker pairing:** the login step is now skipped when you're already signed in via another
  driver, matching the Load Center and CT drivers.

### Changed
- Manifest `source`/`support` now point to
  [github.com/grantlutz/Homey-Leviton-Load-Center](https://github.com/grantlutz/Homey-Leviton-Load-Center).

## 1.0.0 — 2026-07-23

Initial release.

- Breaker, Load Center (LWHEM/LDATA), and Current Transformer drivers.
- Live power/current/voltage/energy via WebSocket push with 2-minute REST poll fallback.
- Remote on/off (Gen 2), trip, locate-LED blink, bulk all-on/all-off/trip-all with stagger delay.
- Trip/GFCI/AFCI alarms, breaker state enum, Homey Energy integration, Insights, timeline
  notifications, threshold Flow triggers, repair flow, 2FA login support.
