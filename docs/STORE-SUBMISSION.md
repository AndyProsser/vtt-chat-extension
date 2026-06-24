# Extension Store Submission Guide

This document contains all the copy, metadata, and checklist items needed to submit **VTT-Chat DDB Connector** to the Chrome Web Store, Firefox Add-ons (AMO), and Microsoft Edge Add-ons store.

---

## Extension Identity

| Field | Value |
|---|---|
| **Name** | VTT-Chat DDB Connector |
| **Version** | 0.3.11 |
| **License** | AGPL-3.0 |
| **Homepage** | https://github.com/AndyProsser/vtt-chat-extension |
| **Support / Bug reports** | https://github.com/AndyProsser/vtt-chat-extension/issues |

---

## Store Listings Copy

### Short Description (132 chars max)
> Launch VTT-Chat sessions from D&D Beyond. Syncs your character stats, inventory, and campaign data to your tabletop chat server.

### Long Description

> **VTT-Chat DDB Connector** bridges D&D Beyond with your VTT-Chat server so you can jump straight into a chat session without manual data entry.
>
> **For Players**
> - Detects your D&D Beyond characters automatically
> - Launch a VTT-Chat session from any character sheet with a single click
> - Syncs your character's stats, HP, conditions, inventory, spells, features, and currency to the session
> - Use the SYNC button on your character sheet to push the latest version of your character to the session at any time
> - Supports multiple VTT-Chat servers and invite codes
>
> **For Dungeon Masters**
> - Detects campaigns you own on D&D Beyond
> - Launch a DM-mode session that includes full party data — every player character's stats, inventory, and spells
> - Re-sync the entire party with one click from the extension popup
> - Campaign metadata (name, DM, member list) is sent alongside character data
>
> **Privacy**
> - Reads only character and campaign data that the logged-in user already has access to, using their own D&D Beyond session
> - No data is collected, stored, or shared beyond what is needed to run a single user's VTT-Chat session
> - All communication goes directly between your browser and your own VTT-Chat server — no third-party analytics or telemetry
>
> **Requirements**
> - A running VTT-Chat server (self-hosted or provided by your group)
> - A D&D Beyond account
>
> This is an unofficial extension and is not affiliated with Wizards of the Coast or D&D Beyond.

---

## Category & Tags

| Store | Category | Tags / Keywords |
|---|---|---|
| Chrome Web Store | Entertainment | tabletop, dnd, d&d beyond, rpg, dungeon dragons, chat, vtt, character sheet |
| Firefox AMO | Entertainment | tabletop, dnd beyond, rpg, character sync, vtt |
| Edge Add-ons | Lifestyle | tabletop, dnd, d&d beyond, rpg, character sheet |

---

## Permissions Justification

Each store (especially Firefox AMO) requires a written explanation for every permission. Use the text below verbatim or adapt it.

### `storage`
> Used to persist the user's server URL, invite code, session token, cached character list, and campaign connections between browser sessions. No data leaves the browser except to the user's own VTT-Chat server.

### `cookies`
> Required to access the D&D Beyond authentication cookie (Cobalt token) so the extension can make authenticated API calls to D&D Beyond's character and campaign services on behalf of the logged-in user. The cookie is read-only; the extension never sets or modifies cookies.

### `tabs`
> Used to locate the currently open D&D Beyond tab so the background service worker can send a message to the content script asking it to re-fetch character data. No tab contents or browsing history are read.

### Host Permissions

| Host | Reason |
|---|---|
| `https://www.dndbeyond.com/*` | Content script target — character sheet and campaign pages |
| `https://character-service.dndbeyond.com/*` | Fetches character list and full character detail using Cobalt auth token |
| `https://api.dndbeyond.com/*` | Fetches campaign details (member list, DM ID, campaign name) |
| `https://*/*` and `http://*/*` | Allows the background script to POST to the user's self-hosted VTT-Chat server, which can be on any URL/IP |

> **Note for reviewers:** The broad `https://*/*` and `http://*/*` host permissions are necessary because VTT-Chat servers are self-hosted — the user enters their own server URL in the popup. The extension only ever contacts the URL the user explicitly provides; there is no hardcoded third-party endpoint.

---

## Privacy Policy

The extension does not collect, transmit, or store any personal data beyond what is required to operate a single user's VTT-Chat session:

- Character names, stats, and inventory are read from D&D Beyond and sent to the user's own VTT-Chat server only.
- No analytics, crash reporting, or telemetry libraries are included.
- No data is sent to the extension developer or any third party.
- Cached data (character list, campaign list) is stored in `browser.storage.local` on the user's own device and is cleared when the user removes the extension.

A full privacy policy can be hosted at your project URL if the store requires a link. Suggested minimal text:

> VTT-Chat DDB Connector does not collect personal data. It reads D&D Beyond character and campaign information using the signed-in user's own session credentials and sends that information to the VTT-Chat server URL that the user configures. No data is sent to the extension developer or any third party. Data cached locally is stored in the browser's extension storage and is removed when the extension is uninstalled.

---

## Required Assets

### Icons

| Size | File | Status |
|---|---|---|
| 48 × 48 px | `icons/icon-48.png` | Present |
| 96 × 96 px | `icons/icon-96.png` | Present |
| 128 × 128 px | `icons/icon-128.png` | Present |

### Screenshots

Each store requires at least one screenshot. Recommended set:

| # | Description | Recommended Size |
|---|---|---|
| 1 | Popup showing a character list with a launched session | 1280 × 800 px |
| 2 | D&D Beyond character sheet with the SYNC and INFO buttons visible | 1280 × 800 px |
| 3 | Popup DM view showing a campaign card with the ↻ sync button | 1280 × 800 px |

Screenshots must not contain real personal data — use a test account or blur user-identifiable information.

---

## Build Checklist Before Submission

```bash
npm run lint          # Must pass with 0 errors
npm run build         # Generates build/firefox/, build/chrome/, build/edge/
npm run package       # Creates distributable ZIPs in build/
```

Verify the ZIPs before uploading:
- `build/vtt-chat-ddb-connector-firefox.zip`
- `build/vtt-chat-ddb-connector-chrome.zip`
- `build/vtt-chat-ddb-connector-edge.zip`

---

## Per-Store Submission Steps

### Chrome Web Store

1. Go to [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. Click **Add a new item** → upload `vtt-chat-ddb-connector-chrome.zip`
3. Fill in the store listing using the copy above
4. Set **Category**: Entertainment
5. Set **Language**: English
6. Upload screenshots (at least 1, up to 5)
7. Upload a 128 × 128 icon (also needed in the package)
8. Under **Privacy**, paste the privacy policy text and select:
   - **Single purpose**: Sync D&D Beyond character data to VTT-Chat
   - Justify all permissions using the text in the "Permissions Justification" section
9. Submit for review — typical review time is 1–3 business days

**Notes:**
- Chrome requires `"service_worker"` in the background declaration (already correct in `manifest.chrome.json`)
- No `browser_specific_settings` in the Chrome manifest (already correct)
- The `https://*/*` host permission will trigger a manual review; include the permission justification in the submission notes

---

### Firefox Add-ons (AMO)

1. Go to [Firefox Add-on Developer Hub](https://addons.mozilla.org/developers/)
2. Click **Submit a New Add-on** → upload `vtt-chat-ddb-connector-firefox.zip`
3. Select **On this site** (listed publicly) or **Not listed** (self-distribution)
4. Fill in the listing using the copy above
5. Set **Category**: Entertainment
6. Upload screenshots
7. In the **Notes to Reviewer** field, include:
   - A description of what the extension does
   - The permissions justification text from this document
   - Note that `https://*/*` is needed because users self-host their VTT-Chat server
8. AMO requires source code submission if the ZIP contains minified or bundled JS — since this extension ships plain source files, it is not required; confirm this in the submission form

**Notes:**
- Firefox manifest must have `browser_specific_settings.gecko.id` — currently set to `@vtt-chat-extension` ✓
- `strict_min_version` is set to `140.0` ✓
- AMO review can take anywhere from a few hours to several weeks for initial submissions
- `data_collection_permissions` are declared in the Firefox manifest ✓ — set to `required: ["none"]`

---

### Microsoft Edge Add-ons

1. Go to [Microsoft Partner Center](https://partner.microsoft.com/dashboard/microsoftedge)
2. Create a new submission → upload `vtt-chat-ddb-connector-edge.zip`
3. Fill in the listing using the copy above
4. Set **Category**: Lifestyle (or Entertainment if available)
5. Upload screenshots (minimum 1, maximum 10)
6. Upload a 128 × 128 icon
7. Provide the privacy policy URL or paste the privacy policy text
8. Complete the **Certification notes** with the permissions justification
9. Submit — typical review time is 3–5 business days

**Notes:**
- Edge uses the same Chromium MV3 format as Chrome; the Chrome ZIP can generally be used for Edge, but `manifest.edge.json` exists in the build for Edge-specific overrides if needed
- The Edge store does not accept `"background.scripts"` (Firefox style) — use `"service_worker"` ✓

---

## Known Review Risk Areas

| Risk | Detail | Mitigation |
|---|---|---|
| Broad host permissions | `https://*/*` and `http://*/*` | Explain self-hosted server use case in reviewer notes |
| DnD Beyond unofficial API use | Extension uses undocumented Cobalt token endpoint | Note in reviewer notes that it uses the user's own session credentials, not bots |
| `cookies` permission | Required to read the Cobalt auth cookie | Explain read-only use in permissions justification |
| No privacy policy URL | AMO and Edge prefer a URL | Consider hosting one at the GitHub Pages URL for the repo |
