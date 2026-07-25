# Project Constitution

The principles this project is built on. They exist so that contributors, forks, and future
maintainers make the same trade-offs the codebase already embodies. PRs are reviewed against this
document; if a change requires breaking one of these articles, the constitution gets amended first
(deliberately), not silently violated.

This app controls **real circuit breakers in real electrical panels**. That is why safety comes
before every other article.

---

## Article I — Safety before convenience

Circuit breakers are life-safety equipment. The app must never be the reason a protective device
didn't do its job.

1. **Never re-close a faulted breaker automatically.** A GFCI/AFCI/overcurrent/short-circuit trip
   is a signal that something is physically wrong. The app exposes trip *alarms* and a manual
   *Turn on*, but no code path — and no accepted PR — may auto-reset a fault state.
2. **No retry loops on control commands.** A failed on/off/trip is reported as a failure, once.
   Blindly retrying switching commands against a safety device is forbidden.
3. **Read-only mode is absolute.** When enabled, every control path (capability, Flow action, bulk
   operation) must refuse — not just the UI.
4. **Bulk operations stay staggered.** All-on/all-off/trip-all must sequence breakers with a delay
   (user-configurable, never zero) to avoid inrush surges and cloud rate-limiting.
5. **Destructive actions are explicit.** Trip and bulk cards say what they do in plain language.
   Nothing that cuts power may ever be a side effect of something else.

## Article II — Be a good cloud citizen

We use Leviton's private cloud uninvited. The polite guest gets to stay.

1. **One session, one WebSocket, one poll loop** — regardless of how many devices are paired
   (a panel can hold ~66 breakers). Per-device connections are forbidden.
2. **Never tighten the cadence.** The 2-minute poll and the documented keepalive/backoff timings
   are ceilings, not suggestions. Features that need faster data must come from the push socket.
3. **Back off on failure.** Reconnects use escalating delays; auth failures must never hot-loop.
4. If Leviton ever objects, the responsible-citizen story (fewer API calls than their own app) must
   still be true.

## Article III — Honesty about being unofficial

1. This is an **unofficial** integration of a **private** API. Every user-facing surface (store
   listing, README, pairing) must say so, and must say it is cloud-dependent.
2. When Leviton changes something and the app breaks, devices go **unavailable with an honest
   message** — never silently frozen values.
3. No affiliation with or endorsement by Leviton Manufacturing Co. is implied. Trademarks and
   product imagery are used only as far as nominative fair use allows.

## Article IV — Privacy is structural, not a policy

1. Credentials go to **Leviton's cloud only**; the session token is stored **only on the user's
   Homey** (app settings). No third-party endpoint, ever.
2. **No telemetry, analytics, or phone-home** of any kind.
3. Logs must not contain passwords or tokens. Debug output that could leak a credential is a bug.

## Article V — Clean-room provenance and attribution

1. Protocol knowledge (URLs, payload shapes, state names, timing constants) derives from the
   MIT-licensed work of [gtxaspec](https://github.com/gtxaspec)
   ([`leviton-load-center`](https://github.com/gtxaspec/leviton-load-center),
   [`aioleviton`](https://github.com/gtxaspec/aioleviton)) and from observing our own panels —
   **never** from decompiled Leviton apps or leaked material. Contributions from such sources will
   be rejected.
2. Attribution to the upstream projects stays in the README, the store listing, and this file.
3. The project is and remains **MIT licensed**.

## Article VI — Homey-native, compose-first

1. `.homeycompose/` and `drivers/*/*.compose.json` are the **only** hand-edited manifests; the root
   `app.json` is generated (committed for convenience, never edited directly).
2. Use **standard Homey capabilities** wherever one fits; custom capabilities only when nothing
   standard exists (e.g. `breaker_state`). Energy, Insights, and Flow support are first-class
   requirements for any new capability, not afterthoughts.
3. Flow card placeholders (`[[x]]`) must reference **arguments**; tokens are for output tags.
   (Learned the hard way — v1.0.2.)
4. The three drivers' `pair/login.html` are identical copies — change one, sync all three.

## Article VII — Reliability over features

1. The reconnect machinery (55-min proactive cycle, silence watchdog, backoff ladder, delta trap)
   is load-bearing. New features must not bypass or weaken it.
2. `meter_power` is **monotonic**. Any change to energy handling must preserve that.
3. Prefer a smaller feature that survives a cloud hiccup over a bigger one that doesn't.

## Article VIII — Compatibility is sacred

1. **Never change a device's `data.id` scheme.** It's how Homey matches paired devices; changing it
   orphans every user's devices and Flows.
2. Existing Flows must keep working across updates. When a card gains arguments, old saved
   instances must behave sensibly without them (see the `breaker_tripped` reason filter).
3. Renaming/removing capabilities, settings keys, or store values is a breaking change and needs a
   migration path.

## Article IX — Tested core, validated shell

1. Protocol/state/energy mapping logic lives in **pure functions** (`lib/normalize.js`) with
   offline unit tests (`npm test`). Logic PRs include tests.
2. `homey app validate --level publish` must pass on every commit to `main`.
3. Anything touching pairing, repair, or control should be smoke-tested on real hardware before
   release; say so in the PR.

## Article X — Documentation keeps pace

1. Every release gets a `CHANGELOG.md` entry; versions are bumped in **both**
   `.homeycompose/app.json` and `package.json` (semver: fixes = patch, new cards/capabilities =
   minor, breaking = major — see Article VIII before ever needing major).
2. User-visible behavior changes update the README and/or `docs/FEATURES.md` in the same PR.

## Article XI — Collaboration

1. **Issues first** for anything beyond a small fix — agree on the approach before writing code.
2. PRs are reviewed against this constitution; "it works" is necessary, not sufficient.
3. Be specific in bug reports: app version, hub type (LWHEM/LDATA), firmware, and `homey app run`
   logs when possible.
4. Be kind. This is volunteer work on both sides of the review.

## Amendments

Propose amendments as PRs against this file with the reasoning in the description. The maintainer
([@grantlutz](https://github.com/grantlutz)) merges amendments; substantive safety articles
(I, II, IV) should be loosened only with extraordinary justification.
