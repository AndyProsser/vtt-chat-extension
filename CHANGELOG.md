# Changelog

All notable changes to VTT-Chat DDB Connector are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

---

## [0.3.14] — 2026-06-24

### Added

- Manual **SYNC button** (refresh SVG icon) injected on D&D Beyond character sheet pages alongside the INFO button. Clicking it forces a full character data sync to the VTT-Chat backend. SVG spins and the button is disabled while the sync is in progress.
- `@keyframes vtt-spin` style tag injected once per page to drive the spin animation.
- `ensureGuestSession()` in `background.js` — rehydrates `guestSession` from `lastSession` storage + device credential exchange when the MV3 service worker has been killed and restarted since the user last connected. Fixes manual sync (and any other handler guarded by `guestSession`) silently doing nothing after browser idle restarts the worker.
- Complete icon set: `icon-16.png`, `icon-32.png`, `icon-128.png`, `icon-256.png` generated from the source `icon.png`. All sizes declared in `icons` and `action.default_icon` across all manifests.
- `CHANGELOG.md` (this file).
- `docs/STORE-SUBMISSION.md` — store listing copy, permissions justification, privacy policy text, asset checklist, and per-store submission steps for Chrome Web Store, Firefox AMO, and Microsoft Edge Add-ons.

### Fixed

- Manual SYNC button was silently doing nothing: `handleCharacterDataUpdated` in `background.js` guarded on the in-memory `guestSession` which is `null` after an MV3 service worker restart. Now calls `ensureGuestSession()` first to restore the session before attempting the sync.
- Button clicks on injected SYNC and INFO buttons were being captured by D&D Beyond's Google Tag Manager. Both buttons now use `stopImmediatePropagation()` (replacing `stopPropagation()`) in both bubble and capture phases to prevent GTM from seeing the events.

### Removed

- `webRequest` permission removed from all three manifests — no longer needed now that sync is user-initiated rather than XHR-triggered.
- `pendingCharacterSyncs` Map, `dispatchCharacterRefetch()`, and `browser.webRequest.onCompleted` listener removed from `background.js`.

---

## [0.3.11] — 2026-06-23

### Added

- **DM detection**: fetches `https://www.dndbeyond.com/api/campaign/stt/user-campaigns` using Cobalt auth headers to detect campaigns owned by the logged-in user. Cached for 24 hours to avoid bot detection.
- **DM campaign panel** in the popup: shows owned campaigns with a purple DM badge, invite-code launch flow, and a ↻ re-sync button on connected campaigns.
- `normalizeOwnedCampaigns()` — unwraps the `{"data":{...}}` envelope per item returned by the user-campaigns API and extracts `id`, `name`, `memberCount`, `dmId`.
- DM campaign filter: only shows campaigns where `dmId` matches the logged-in user's ID. Campaigns with a `null` dmId are shown defensively (API omission).
- In-memory **DEV override toggle** in the popup to bypass the DM filter during development.
- `buildDmCampaignPayload(ddbCampaignId)` in `content.js` — fetches campaign details + all member character stats in parallel (best-effort), builds a rich payload for `/api/integrations/external/dm-sync`.
- `dm-fetch-campaign-data` message type with `return true` + `sendResponse` pattern for async Chrome MV3 compatibility.
- `runDmCampaignSync` and `syncDmCampaignData` in `background.js` — sends the DM sync payload to the backend.
- Auto DM sync on connect: when a DM joins via the popup, `runDmCampaignSync` fires immediately instead of `triggerInitialCharacterSync`.
- `saveDmConnection()` persists the VTT-Chat `campaignId` alongside the DDB campaign ID in `dmConnections` storage.

### Fixed

- DM campaign filter was showing all campaigns (bug: API wraps each item in `{"data":{...}}` so `c.dmId` was always `undefined` → treated as `null` → always passing the filter). Fixed by unwrapping the envelope before reading `dmId`.

### Changed

- `handleRefetchCharacter` now also handles the manual trigger path from the content script (not just the background webRequest path).

---

## [0.3.3] — 2026-06-10

### Added

- **INFO button** injected on D&D Beyond character sheet pages (owned characters only, not on builder pages). Placed inside `.ddbc-character-tidbits__heading` after `.ddbc-character-tidbits__menu-callout` using DnD Beyond's own `ct-theme-button` classes with a blue 50% opacity background.
- `injectCharacterPageInfoButton()` replaces the earlier `injectCharacterInfoButtons()`.
- `isBuilderPage()` helper — returns `true` when the URL includes `/builder/`.

### Changed

- INFO button removed from the character listing cards in the popup; it now lives exclusively on the character sheet page itself.
- MutationObserver IIFE simplified: fires `injectCharacterPageInfoButton()` after a 300 ms debounce on DOM changes.

---

## [0.3.1] — 2026-05-28

### Added

- Enriched inventory items with additional fields:
  - `isContainer` — `true` when the item definition has `isContainer === true` or includes a `"Container"` tag.
  - `containerEntityId` — ID of the parent container when an item is stored inside one.
  - `magic` — sourced from `item.definition.magic` (boolean, not inferred from rarity).
  - `description` — plain-text item description from the definition.
  - `tags` — array of tag strings from the definition.
  - `avatarUrl` — item artwork URL.
- Weapon-specific inventory fields:
  - `damage` — dice string (e.g. `"1d6"` or `"2d4+2"`) via `buildItemDamage()`.
  - `damageType` — e.g. `"Piercing"`.
  - `properties` — comma-separated string of property names via `buildItemProperties()`. Thrown/Range properties are annotated with range values in parentheses (e.g. `"Thrown (20/60)"`, `"Range (80/320)"`). Only applied when `def.range > 10` to distinguish melee reach (5 ft / 10 ft) from actual ranged/thrown weapons.
- `buildItemProperties(def)` and `buildItemDamage(def)` helper functions in `content.js`.

---

## [0.3.0] — 2026-05-10

### Added

- Live character sync via `webRequest` — monitors `character-service.dndbeyond.com` for POST/PUT responses and triggers a re-fetch with a 2-second debounce.
- `pendingCharacterSyncs` Map and `dispatchCharacterRefetch()` in `background.js`.
- `browser.webRequest.onCompleted` listener scoped to `https://character-service.dndbeyond.com/*`.
- `handleCharacterDataUpdated()` in `background.js` — syncs refreshed character data to the VTT-Chat backend.
- `refetch-character` message type: background → content script triggers a fresh DDB API pull and re-sync.

### Added (manifest)

- `webRequest` permission added to all three manifests.

---

## [0.2.0] — 2026-04-20

### Added

- Multiclass support in character payload: `classes` array with per-class `name`, `level`, `subclass`, and `hitDice`.
- Expanded feature extraction: orphan actions (features with no associated class/race) are now filtered out.
- Inventory and currency included in the character sync payload.
- `extractInventory(data)` returns items with `id`, `name`, `type`, `subtype`, `rarity`, `quantity`, `equipped`, `isAttuned`, `chargesUsed`, `weight`, `cost`.
- `extractCurrency(data)` returns `{ cp, sp, ep, gp, pp }`.

---

## [0.1.0] — 2026-04-01

### Added

- Initial release.
- Browser polyfill (`if (typeof browser === "undefined") { var browser = chrome; }`).
- User detection via `#mega-menu-target`, `window.Cobalt`, and Next.js flight script fallbacks.
- Character list fetch via `character-service.dndbeyond.com` using Cobalt auth token.
- Popup UI: user identity bar, character list cards with avatar, class, level, campaign name.
- "Launch VTT-Chat" flow with invite code, server URL, and optional email.
- "Reopen Last Session" button using `browser.storage.local`.
- Campaign connections list (collapsible) with per-campaign delete.
- Content script on `*.dndbeyond.com/characters/*` and `*.dndbeyond.com/campaigns/*`.
- Background service worker: token renewal, `syncCharacterAndCampaign`, `checkSessionStatus`.
- Build system (`build.js`) producing separate `build/firefox/`, `build/chrome/`, `build/edge/` outputs.
- `npm run package` producing distributable ZIPs for all three browsers.
- ESLint configuration.
- Firefox `browser_specific_settings` with `gecko.id` and `strict_min_version`.
