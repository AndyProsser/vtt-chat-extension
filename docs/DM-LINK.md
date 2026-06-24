# DM Identity & Campaign Linking

_How the extension links a DM's full vtt-chat account to their DDB campaign, with automatic merging of any prior guest identity._

**Source of truth for backend contracts:** `vtt-chat/docs/extension/DM-LINK.md`

**Related extension docs:**

- [EXTENSION-INTEGRATION.md](EXTENSION-INTEGRATION.md) — endpoint table, §5f DM Campaign Sync, §10 launch flows
- [STORE-SUBMISSION.md](STORE-SUBMISSION.md) — permissions justification

---

## 1. Why the DM Flow Is Different

The player guest flow deliberately lowers the barrier to entry: DDB has already verified the player's identity, so vtt-chat trusts that assertion and issues a guest token without a password.

**The DM cannot use the same path.** The DM:

- Controls session state (start, pause, end)
- Controls campaign configuration (sync policy, environments, spectator access)
- Is the anchor identity for the campaign's data

A guest token holding those privileges is a security and data-integrity risk. More practically: **the DM already has a full vtt-chat account** — they had to create the campaign there before any invite code could exist.

The DM link flow therefore enforces a full account login. Guest tokens are rejected from `POST /api/auth/extension/dm-link` and `POST /api/integrations/external/dm-sync`.

---

## 2. The Linking Mechanism

The bridge between vtt-chat and DDB is the **player invite code**:

```text
vtt-chat campaign  ←─────────────────────────────────────────────────→  DDB campaign
  (Campaign.id)       CampaignExternalLink(campaignId, externalId)        (DDB campaign ID)
                      ↑
                      created when DM enters invite code in extension popup
```

The sequence that creates this bridge:

1. DM creates a campaign in vtt-chat (requires full account).
2. DM generates a player invite link from Campaign Settings → Invites → Player Invite.
3. DM opens their DDB campaign page with the extension installed.
4. Extension detects DM ownership (§3).
5. DM enters the vtt-chat invite code in the extension popup.
6. Extension validates the code (`GET /api/campaigns/invite/:code/validate`).
7. DM confirms and clicks **Link & Launch** → §4 DM Link Flow begins.

The invite code is used **once** to establish the link. Returning DM launches use the stored `deviceCredential` only — no re-entry needed.

---

## 3. DM Detection in the Extension

DM ownership is determined by comparing the logged-in DDB user ID against the campaign owner ID from the DDB API/DOM:

| Data point                 | Source                     | Used for                              |
| -------------------------- | -------------------------- | ------------------------------------- |
| Logged-in DDB user ID      | DDB session / profile DOM  | `externalUserId` sent to all auth     |
| DDB campaign owner user ID | Campaign list API response | Compared to detect DM ownership       |
| DDB campaign ID            | Campaign list API response | `externalCampaignId` in sync requests |

**DM identification rule:**

```text
if (loggedInDdbUserId === campaign.dmId) → user is DM of this campaign
```

> **Important:** This check must be strict even in DEV mode. The DEV toggle may show campaigns the user is a MEMBER of (not DM of) for debugging purposes, but those campaigns must be locked — no Link / Launch / Sync actions are permitted on them.

---

## 4. DM First-Time Link Flow (extension side)

_Runs once per DM per campaign._

```text
1.  DM is shown the first-time DM UI in the popup — invite code input field.
2.  DM enters their vtt-chat player invite code.
3.  On blur/submit: GET /api/campaigns/invite/:code/validate
        → valid: show campaign name as confirmation chip below field
        → invalid: show inline error "This code isn't valid"
4.  DM clicks "Link & Launch as DM":
        a. Disable button, show spinner.
        b. Extension opens a NEW TAB:
               /ext-launch?campaignId=<uuid>&hint=<ddb-email>&mode=dm-link
           Note: no token in URL — guest bypass is blocked server-side on this mode.
        c. Extension registers a tabs.onUpdated listener for the newly opened tab (§8).
5.  /ext-launch tab (vtt-chat web app) handles the full-account login and calls
        POST /api/auth/extension/dm-link (§5 / §6 below)
    then signals the extension via the VTT_CHAT_DM_LINK_COMPLETE mechanism (§8).
6.  Extension receives the signal:
        a. Stores { campaignId, deviceCredential } in browser.storage.local
           keyed as "dmlink:<externalCampaignId>:dndbeyond".
        b. Saves the DM connection (campaignId, externalCampaignId, serverUrl)
           in dmConnections storage — same structure used for returning launches.
        c. Fires POST /api/integrations/external/dm-sync (no throttle on first link).
        d. Fires POST /api/campaigns/:campaignId/session/ensure.
7.  Popup closes after 800 ms.
```

---

## 5. DM Returning Launch Flow (extension side)

_Normal path for all subsequent DM launches. No invite code needed._

```text
1.  Extension detects DM ownership on DDB campaign page (§3).
2.  Finds stored deviceCredential keyed "dmlink:<externalCampaignId>:dndbeyond".
3.  POST /api/auth/extension/credential/exchange { credential, deviceId }
        → success: fresh full-account JWT + rotated credential (store immediately)
        → CREDENTIAL_INVALID / CREDENTIAL_EXPIRED_GUEST:
            wipe stored credential → fall back to first-time flow (§4)
4.  DM sync (throttled — at most once per 10 minutes per campaign):
        POST /api/integrations/external/dm-sync
    Skip if last sync was < 10 min ago (check chrome.storage.session).
    Sync Campaign button in popup always bypasses this throttle.
5.  POST /api/campaigns/:campaignId/session/ensure → confirm session.
6.  Open /ext-launch?campaignId=<uuid>&token=<jwt>&sessionId=<id>
        → auto-login, redirect to campaign workspace.
```

---

## 6. POST /api/auth/extension/dm-link

Handled by the vtt-chat web app (ext-launch page), not called directly by the extension. Documented here for reference.

### Auth requirement

Requires a full-account JWT (`authType = FULL`). Guest tokens return `403 FORBIDDEN`.

The caller must be `currentDmId` of the specified `campaignId`.

### Request

```json
{
  "campaignId": "uuid",
  "externalSystem": "dndbeyond",
  "externalUserId": "string (DDB user ID of the DM)",
  "externalCampaignId": "string (DDB campaign ID)",
  "email": "string (DDB account email — informational only)",
  "displayName": "string | null"
}
```

### Response (200)

```json
{
  "message": "DM account linked successfully",
  "deviceCredential": { "credential": "opaque-string", "deviceId": "uuid" },
  "merged": false,
  "mergedAccount": null
}
```

When a prior guest account was merged (`merged: true`), `mergedAccount` contains:
`{ userId, email, charactersTransferred, membershipsTransferred }`.

### Error responses

| Status | Code                         | Cause                                                       |
| ------ | ---------------------------- | ----------------------------------------------------------- |
| 400    | `INVALID_INPUT`              | Missing required fields                                     |
| 401    | `UNAUTHORIZED`               | Missing or invalid token                                    |
| 403    | `FORBIDDEN`                  | Caller is a guest, or is not `currentDmId` of the campaign  |
| 403    | `INTEGRATION_NOT_AUTHORIZED` | External system blocked or not authorized                   |
| 409    | `IDENTITY_CONFLICT`          | `externalUserId` already linked to a different full account |

`409 IDENTITY_CONFLICT` should display: _"This DDB account is already linked to a different vtt-chat login. Please contact support."_

---

## 7. Extension Popup States (DM)

### 7a. First-Time DM (no device credential)

Campaign card shows the shield icon + campaign name. When expanded:

```text
┌─────────────────────────────────────────────────────┐
│  [shield]  Intro to Stormwreck Isle                 │
│            4 members · DM: ShadowGamer42            │
│                                                     │
│  Enter your VTT-Chat invite URL                     │
│  ┌────────────────────────────────────────────────┐ │
│  │  https://server/join/abc123                    │ │
│  └────────────────────────────────────────────────┘ │
│  ✓ "The Lost Mines" — invite valid                  │
│                                                     │
│  [ Link & Launch as DM ]                            │
└─────────────────────────────────────────────────────┘
```

The existing invite URL input and launch button already satisfy this, with the rename from
"Connect & Launch as DM" to **"Link & Launch as DM"** to reflect the authoritative intent.

### 7b. Returning DM (device credential present)

Campaign card shows shield icon + name + VTT-Chat campaign name. Right-side buttons:

- **↻ Sync** — fires dm-sync bypassing throttle
- **✎ Edit** — re-opens invite URL form (re-link to different campaign)

Launch button in expanded form becomes **"Launch as DM"** (no re-link unless user changed URL).

---

## 8. VTT_CHAT_DM_LINK_COMPLETE — Extension Receive Contract

After a successful `POST /api/auth/extension/dm-link`, the ext-launch page signals the extension.

### Signal mechanism

The vtt-chat web app navigates the ext-launch tab to a completion URL containing the result as a URL hash fragment:

```text
<serverUrl>/ext-launch#VTT_CHAT_DM_LINK_COMPLETE=<base64-encoded-json>
```

The base64 payload is:

```json
{
  "campaignId": "uuid",
  "externalCampaignId": "string",
  "deviceCredential": { "credential": "opaque-string", "deviceId": "uuid" },
  "merged": false
}
```

### Extension receive logic (background.js)

1. When opening the dm-link tab, record the tab ID.
2. Register `browser.tabs.onUpdated` listener scoped to that tab ID.
3. When `changeInfo.url` contains `#VTT_CHAT_DM_LINK_COMPLETE=`:
   a. Extract and base64-decode the payload.
   b. Validate that the tab's URL matches the configured server origin.
   c. Store device credential and proceed with §4 steps 6a–d.
   d. Remove the `tabs.onUpdated` listener.
   e. Allow the tab to continue navigating to the campaign workspace.

> **Note:** Using the URL hash ensures the credential string never reaches the server (hashes are client-side only), avoids needing `externally_connectable` in the manifest, and works without additional permissions beyond the existing `tabs` permission.

---

## 9. Credential & Throttle Storage Keys

| Key                                     | Content                                                      | Storage                 |
| --------------------------------------- | ------------------------------------------------------------ | ----------------------- |
| `dmlink:<externalCampaignId>:dndbeyond` | `{ campaignId, deviceCredential: { credential, deviceId } }` | `browser.storage.local` |
| `dmsync:<campaignId>`                   | `{ lastSyncAt: ISO-string }`                                 | `browser.storage.local` |

`browser.storage.local` is used (not `chrome.storage.session`) so credentials and sync timestamps survive service worker restarts and browser restarts.

---

## 10. DEV Mode Behaviour

The **DEV toggle** in the DM campaigns section is for development visibility only.

| State            | What shows                                           | Link / Launch / Sync  |
| ---------------- | ---------------------------------------------------- | --------------------- |
| **Normal**       | Campaigns where `dmId === loggedInUserId` (DM-owned) | Enabled               |
| **DEV override** | + Campaigns where user is a **member** (not DM)      | **Disabled** (locked) |

Member campaigns in DEV mode are visually distinguished (lower opacity, lock icon or greyed buttons). This allows developers to verify the full campaign list without accidentally linking/launching campaigns they don't own.

---

## 11. Full-Account Requirement Summary

| Endpoint                                       | Guest token accepted?    | Notes                                     |
| ---------------------------------------------- | ------------------------ | ----------------------------------------- |
| `POST /api/auth/extension/dm-link`             | **No** — `403 FORBIDDEN` | Full account required to hold DM identity |
| `POST /api/integrations/external/dm-sync`      | **No** — `403 FORBIDDEN` | Privileged campaign operation             |
| `POST /api/auth/extension/guest-login`         | N/A                      | Player-only; DMs must use dm-link         |
| `POST /api/auth/extension/credential/exchange` | Yes (pass-through)       | Account type checked by downstream        |
| `POST /api/integrations/external/sync`         | Yes                      | Per-player character sync                 |

The `guest-login-and-launch` message handler in background.js must **never be called for a DM**. The extension must branch on DM ownership (§3) before deciding which path to take.
