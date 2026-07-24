# Publishing this app to the Homey App Store

How to take `com.leviton.loadcenter` from this folder to a public listing other Homey users can
install. Publishing is free; you need an [Athom account](https://homey.app) and the Homey CLI.

## 0. One-time prerequisites

```bash
npm install --global homey     # Homey CLI
homey login                    # authenticate the CLI with your Athom account
```

Create a developer account at **https://tools.developer.homey.app** (sign in with the same Athom
account — that's all "becoming a developer" takes).

## 1. Before you submit — quality checklist

- [ ] **Test on real hardware.** Run `homey app run`, pair against your My Leviton account, and
      verify: login (+2FA), live power/current updates, a Gen-2 on/off toggle, Energy dashboard,
      and at least one Flow. The store review will exercise the app.
- [ ] **Replace the placeholder images.** `assets/images/*.png` and `drivers/*/assets/images/*.png`
      are generated solid-color placeholders. The store requires real artwork:
      - App: 250×175 / 500×350 / 1000×700 — brand imagery, no device screenshots.
      - Drivers: 75×75 / 500×500 / 1000×1000 — a photo/render of the breaker, panel, CT.
      - Keep `assets/icon.svg` (or refine it) — it's the monochrome device icon.
      - ⚠️ Don't use Leviton's logo or product photos without permission — the store checks
        trademark use. A generic breaker illustration is safest.
- [ ] **README.txt for the store.** The App Store listing text comes from `README.txt` (not
      `README.md`). Create it with a short user-facing description:
      what it does, that it's unofficial, that it needs a My Leviton account + LWHEM/LDATA hub.
- [ ] **Verify the manifest basics** in `.homeycompose/app.json`: bump `version` if needed, and make
      sure `source` and `support` URLs point at your real GitHub repo (create one and push this
      folder). The `homeyCommunityTopicId` field is optional but recommended once you open a forum
      thread (step 5).
- [ ] `homey app validate --level publish` passes (it does today).

## 2. Publish a build

```bash
homey app publish
```

The CLI will:
1. Ask to bump the version (patch/minor/major) — it updates `.homeycompose/app.json`.
2. Ask for a changelog message (shown to users on update).
3. Validate at `publish` level and upload the build to the App Store as a **draft**.

## 3. Submit for certification

1. Open **https://tools.developer.homey.app → Apps SDK → My apps**.
2. Your uploaded build appears as *Draft*. Click it, review the listing (description, images,
   category, tags), then **submit for certification**.
3. Athom reviews the app (typically days to ~2 weeks). Common rejection reasons to pre-empt:
   - Trademark/branding issues (see images note above; also consider naming it
     "Load Center for Leviton" style if Athom flags the bare brand name — apps for third-party
     clouds commonly use that pattern).
   - Missing/low-quality images, missing support URL.
   - Crashes during their smoke test — hence step 1.
4. Once approved you choose **Test** or **Live**:
   - **Test**: installable only via a direct test URL (`https://homey.app/a/com.leviton.loadcenter/test/`) —
     great for a beta with other Leviton owners before going public.
   - **Live**: public in the App Store for everyone.

## 4. Updates

Repeat `homey app publish` → new draft → submit. Users get updates automatically once approved.
Semantic versioning: bug fixes = patch, new flow cards/capabilities = minor. **Never change a
device's `data.id` scheme between versions** — that's how Homey matches existing paired devices;
changing it orphans everyone's devices.

## 5. Community expectations (recommended, not required)

- Open a topic in the **Homey Community forum** (community.homey.app, "Apps" category) titled
  `[APP][Pro] Leviton Load Center` — this is where users ask questions. Put its topic id in
  `homeyCommunityTopicId` in `.homeycompose/app.json` so the app links to it.
- Keep the GitHub repo public with issues enabled (the manifest's `source`/`support` URLs).
- State clearly in the listing that this is **unofficial**, cloud-based, and can break if Leviton
  changes their API — it sets expectations and it's required honesty for cloud apps.

## 6. Things specific to this app to keep in mind

- **Credentials handling**: the app stores the Leviton session token in app settings on the user's
  own Homey; nothing leaves the device except calls to `my.leviton.com` / `socket.cloud.leviton.com`.
  Say this in the listing — reviewers and users both care.
- **`platforms: ["local"]`** is already set (Homey Pro only) — correct, since the app opens an
  outbound WebSocket and Homey Cloud doesn't allow arbitrary sockets.
- **Rate friendliness**: the app already uses one shared connection + WS push (~3× fewer API calls
  than the official Leviton app), which is the responsible-citizen story if Leviton ever asks.
- **MIT attribution** to `gtxaspec/leviton-load-center` and `aioleviton` is in the README — keep it
  in the store listing credits too.

## Quick reference

| Command | Purpose |
|---|---|
| `homey app validate --level publish` | Pre-flight check |
| `homey app run` | Live dev run (logs, Ctrl-C uninstalls) |
| `homey app install` | Persistent dev install on your Homey Pro |
| `homey app publish` | Version-bump + upload draft to the App Store |
| `homey app manage` | Open the app in Developer Tools (submit, promote Test→Live) |
