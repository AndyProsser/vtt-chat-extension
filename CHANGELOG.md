# Changelog

All notable changes to VTT-Chat DDB Connector are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Added

- `buildArmorProperties(def)` in `content.js` — converts `armorTypeId` + `armorClass` into a human-readable `properties` string on armor inventory items. Light/Medium/Heavy armor renders as e.g. `"Medium Armor (AC14)"`; shields render as `"Shield (+2 AC)"` (using the raw `armorClass` value so magical shields like a +3 shield show the correct bonus). Mutually exclusive with the weapon `properties` field — armor items use this new path, all other items use `buildItemProperties` as before.
- `fetchCobaltTokenFromBackground()` and `buildDmCampaignPayloadDirect()` in `background.js` — background-native DDB API access using the `cookies` permission. Reads the DDB session cookies from the browser store, exchanges them for a Cobalt auth token, then fetches campaign details and member data directly. No open D&D Beyond tab required.
- `runDmCampaignSync` now falls back to `buildDmCampaignPayloadDirect` when no DDB tab is available. Try-order: live tab content script first (full character stats) → background cookie path (basic metadata). Error message updated to no longer suggest opening a DDB tab.
- `runDmCampaignSync` now uses `ensureGuestSession()` instead of accessing `guestSession` directly, fixing the same MV3 service-worker-restart silent failure that was fixed for player syncs in 0.4.0.
- `docs/EXTENSION-INTEGRATION.md` §5f: full DM Campaign Sync Protocol specification covering the `/api/integrations/external/dm-sync` endpoint, request/response shapes, character resolution strategy (match → stub → lazy promotion), avatar handling, and error responses. §5a endpoint table updated to include the new endpoint.

---

## [0.4.0] — 2026-06-24

### Added

- Manual **SYNC button** (refresh SVG icon) injected on D&D Beyond character sheet pages alongside the INFO button. Clicking it forces a full character data sync to the VTT-Chat backend. SVG spins and the button is disabled while the sync is in progress.
- `@keyframes vtt-spin` style tag injected once per page to drive the spin animation.
- `ensureGuestSession()` in `background.js` — rehydrates `guestSession` from `lastSession` storage + device credential exchange when the MV3 service worker has been killed and restarted since the user last connected. Falls back to `lastSession.token` directly when no device credential is stored, so manual sync works even when the backend does not issue device credentials.
- Complete icon set: `icon-16.png`, `icon-32.png`, `icon-128.png`, `icon-256.png` generated from the source `icon.png`. All sizes declared in `icons` and `action.default_icon` across all manifests.
- `decodeHtml()` helper — uses a `<textarea>` to let the browser decode all HTML entities (`&amp;`, `&lt;`, `&#8212;`, etc.) from API text fields. Applied to character names, race, class, campaign names, DM usernames, descriptions, and public notes throughout `content.js`.
- `dmUsername` and `dateCreated` captured in `normalizeOwnedCampaigns()` and included in the DM sync payload's `campaignData`.
- DM campaign card now shows `dmUsername` in the detail line when present (e.g. "4 members · DM: wizardpete") — useful in DEV override mode.
- `CHANGELOG.md` (this file).
- `docs/STORE-SUBMISSION.md` — store listing copy, permissions justification, privacy policy text, asset checklist, and per-store submission steps for Chrome Web Store, Firefox AMO, and Microsoft Edge Add-ons.
- `[VTT-SYNC]` console trace logging added through the full sync chain (`handleRefetchCharacter` → `handleCharacterDataUpdated` → `syncCharacterAndCampaign`) to aid debugging.

### Fixed

- Manual SYNC button was silently doing nothing after an MV3 service worker restart: `handleCharacterDataUpdated` guarded on in-memory `guestSession` (always `null` after idle restart). Fixed by calling `ensureGuestSession()` first, which restores the session from storage.
- `browser.runtime.sendMessage` in `handleRefetchCharacter` was not awaited — errors (including send failures) were silently swallowed. Now awaited so failures surface correctly.
- `ensureGuestSession` previously returned `null` when no device credential was stored, even though `lastSession.token` was available in storage. Now falls back to that token so the sync attempt is made.
- `normalizeOwnedCampaigns` was reading `item.memberCount` (undefined) instead of `item.playerCount` — DM campaign cards always showed "Dungeon Master" rather than the actual member count.
- Button clicks on injected SYNC and INFO buttons were being captured by D&D Beyond's Google Tag Manager. Both buttons now use `stopImmediatePropagation()` (replacing `stopPropagation()`) in both bubble and capture phases.

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
