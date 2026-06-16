# D&D Beyond Currency Write-Back (Experimental, Unofficial)

> ⚠️ **CAUTION — Read before implementing anything from this document.**
>
> This describes an **undocumented, reverse-engineered D&D Beyond endpoint** discovered by inspecting
> network traffic from the live character sheet. It is not part of any published DDB API.
>
> - It almost certainly violates the [D&D Beyond Terms of Service](https://www.dndbeyond.com/terms-and-conditions)
>   (automated/programmatic access, write access outside the official UI).
> - DDB can change, rate-limit, or block this endpoint at any time without notice, and may suspend
>   accounts that abuse it.
> - This is a **write** path — a bug in our request construction can silently corrupt a player's or
>   campaign's gold/currency totals with no DDB-side undo.
> - **Do not ship this as a default-on feature.** If it is built at all, it must be explicit,
>   opt-in, clearly labeled as unofficial/experimental, and require active campaign-owner consent
>   per [§5e Campaign Inventory Sync Policy](EXTENSION-INTEGRATION.md#5e-campaign-inventory-sync-policy).
> - Treat this document as a research note, not an approved design. No implementation should proceed
>   without an explicit decision (see [Open Questions](#3-open-questions--risks) below).

This is the inverse of [DDB-DATA-EXTRACTION.md](DDB-DATA-EXTRACTION.md): instead of _reading_ character/party
currency from D&D Beyond, this describes how vtt-chat could theoretically _write_ currency changes back to DDB,
so a DM/player updating gold in vtt-chat sees it reflected on the DDB character sheet too.

---

## 1. Discovered Endpoint

```http
PUT https://character-service.dndbeyond.com/character/v5/inventory/currency/transaction
Authorization: Bearer <cobalt-token>
Content-Type: application/json
```

The `Bearer` token is the same short-lived JWT obtained via `POST /v1/cobalt-token` (see
[DDB-DATA-EXTRACTION.md](DDB-DATA-EXTRACTION.md#character-list)), itself derived from the `CobaltSession`
cookie on dndbeyond.com. There is no separate API key — auth is entirely tied to the logged-in browser
session, which is part of why this only works from the extension's content/background script context
(it cannot be called server-to-server without the user's live DDB session).

### Request Body

```json
{
  "characterId": 150276899,
  "ep": -1,
  "destinationEntityId": 150276899,
  "destinationEntityTypeId": 1581111423
}
```

| Field                     | Meaning                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `characterId`             | The DDB character ID the transaction is recorded against / initiated by.              |
| `<denomination key>`      | One or more of `cp`/`sp`/`ep`/`gp`/`pp`. Confirmed **signed delta** — see note below. |
| `destinationEntityId`     | The ID of the entity receiving/holding the currency after the transaction.            |
| `destinationEntityTypeId` | Enum identifying _what kind_ of entity `destinationEntityId` refers to (see below).   |

**Confirmed: the denomination field is keyed by abbreviation, not fixed to `ep`, and multiple denominations
can be sent in the same call.** The captured sample sent `"ep": -1`; the matching response (below) shows the
character's `ep` balance landed on `1` after the call — consistent with a **signed delta** applied to the
existing balance, not an absolute target. Multiple keys can be combined in one request to add/remove several
denominations at once, e.g.:

```json
{
  "characterId": 150276899,
  "pp": 0,
  "gp": 10,
  "ep": -1,
  "sp": -5,
  "cp": 12,
  "destinationEntityId": 150276899,
  "destinationEntityTypeId": 1581111423
}
```

Omitted denominations are left unchanged; a denomination key with value `0` is presumably a no-op but
hasn't been explicitly confirmed.

### `destinationEntityTypeId` Values (observed)

| Value        | Meaning         | `destinationEntityId` should be   |
| ------------ | --------------- | --------------------------------- |
| `1581111423` | Player currency | The character's own `characterId` |
| `618115330`  | Party currency  | The campaign ID                   |

These look like opaque hashed/obfuscated enum values rather than sequential IDs — there are likely other
`destinationEntityTypeId` values for other entity kinds that haven't been observed yet (e.g. NPC/loot
container currency, if DDB's data model supports it). Treat this table as a partial, observed subset, not
a complete enum. The request/response shapes below were captured against `1581111423` (player currency)
only — the party currency (`618115330`) path is assumed to behave the same way but **has not been verified**.

### Response Body

```json
{
  "id": 150276899,
  "success": true,
  "message": "Transaction applied.",
  "data": { "cp": 29, "sp": 120, "gp": 370, "ep": 1, "pp": 0 },
  "pagination": null
}
```

| Field        | Meaning                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `id`         | Echoes the `characterId` from the request.                                                                         |
| `success`    | `true`/`false` — whether the transaction was applied.                                                              |
| `message`    | Human-readable status, e.g. `"Transaction applied."`                                                               |
| `data`       | The resulting **absolute** balance for all 5 denominations after the transaction (not just the ones that changed). |
| `pagination` | Always `null` in observed samples — likely a shared response envelope reused from list endpoints.                  |

`data` is the important part for a write-back implementation: it hands back the authoritative post-transaction
wallet in one shot, so the extension doesn't need a separate read call to confirm what landed on the DDB side
— the `PUT` response itself can be used to update the diff/confirmation UI and the audit log entry described
in [§2](#2-proposed-architecture-theoretical). The error-response shape (4xx/5xx, conflict/race-condition
behaviour) has **not** been captured — see [Open Questions](#3-open-questions--risks).

---

## 2. Proposed Architecture (Theoretical)

If this is pursued, the write-back should **not** be initiated by directly replaying a raw cookie/JWT from
inside the browser extension's privileged context without guardrails. Proposed shape:

```text
1. User clicks "Push Currency to D&D Beyond" button
   (injected on the character sheet / campaign inventory panel, alongside the existing
   "Launch Chat" button — see EXTENSION-INTEGRATION.md §3)

2. Button only renders when:
   - The extension already holds a live DDB session (cobalt-token derivable from the page)
   - The user explicitly opted in to write-back for this character/campaign
     (separate, off-by-default setting — NOT governed by the existing read-only
     extensionSyncPolicy / extensionCurrencySyncEnabled settings, which only ever
     describe DDB → vtt-chat sync direction today)

3. content.js / background.js builds the PUT request using the session's own
   cobalt-token (never the vtt-chat backend's credentials — vtt-chat does not
   have its own DDB account to act under)

4. background.js calls a new vtt-chat backend endpoint first, to fetch the
   *current* authoritative currency state for the character/party:

       GET /api/integrations/external/currency/:campaignId/:externalCharacterId

   (server returns vtt-chat's last-known wallet so the extension can compute
   a diff/confirmation prompt before writing anything to DDB)

5. Extension shows a confirmation diff ("DDB: 42 gp → vtt-chat: 50 gp — push
   +8 gp to DDB?") before firing the PUT — this is a destructive, hard-to-undo
   external write and must never happen silently in the background.

6. On confirm, background.js issues the PUT directly to
   character-service.dndbeyond.com using the live session token.

7. Result (success/failure) is reported back to the vtt-chat backend via a
   lightweight audit log call, e.g.:

       POST /api/integrations/external/currency/writeback-log
       { campaignId, externalCharacterId, direction: "VTT_TO_DDB",
         before, after, success, ddbResponseStatus }

   so DMs have a record of when/whether a push actually happened, independent
   of DDB's own (inaccessible) history.
```

### New Server-Side Pieces Needed

| Component                                                                  | Purpose                                                                                                                                                                                       |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/integrations/external/currency/:campaignId/:externalCharacterId` | Returns vtt-chat's current wallet for the character or party, for the extension to diff against DDB before pushing.                                                                           |
| `POST /api/integrations/external/currency/writeback-log`                   | Audit-only. Records that a write-back was attempted/succeeded/failed. The backend never makes the DDB call itself — it has no DDB session to do so.                                           |
| Campaign setting: `extensionCurrencyWritebackEnabled` (default `false`)    | Separate from `extensionCurrencySyncEnabled` (§5e of EXTENSION-INTEGRATION.md), which governs DDB→vtt-chat reads. This new flag governs the opposite, riskier direction and must default off. |

The backend is deliberately kept out of the write path itself (no server-side DDB credentials, no
proxying the PUT) — the write always happens client-side, from the extension, using the user's own
live DDB session, the same way the existing read-only extraction does.

---

## 3. Open Questions / Risks

- **Success request/response is now confirmed for player currency** (single- and multi-denomination, see
  §1 above). **Party currency (`destinationEntityTypeId: 618115330`) has not been captured** — confirm the
  request/response shape against a real party-purse edit before assuming it matches.
- **Error/conflict response shape is unconfirmed.** What does DDB return on a stale/conflicting transaction
  (e.g. someone else edited gold in the DDB app a moment earlier, or the delta would push a denomination
  negative)? Need a captured 4xx/5xx sample before the extension can handle failures gracefully instead of
  just trusting `success: true`.
- **Session lifetime.** The `cobalt-token` JWT in the sample expires in 5 minutes (`nbf`/`exp` ~300s apart).
  Any write-back flow needs a fresh token at write time, not a cached one.
- **ToS / ban risk.** This should be treated as a "use at your own risk" feature for the user's _own_
  account only, never something vtt-chat does automatically or in bulk, and never something exposed to
  users who haven't explicitly acknowledged the risk.
- **No DDB-side audit trail we can read.** If a push goes wrong, there's no API to read DDB's transaction
  history to verify or roll back — only the in-app UI. The writeback-log above is our only safety net.
- **Scope creep risk.** The same `/inventory/currency/transaction` shape suggests item write-back may also
  be technically possible — out of scope for this document, but worth flagging that the same caution
  applies if it's investigated later.

---

## 4. Recommendation

The player-currency request/response shape is now confirmed (§1), but given the ToS exposure this should
still stay **documented but unimplemented** until:

1. The party-currency path and the error/conflict response shape are captured and confirmed, and
2. There's an explicit, separate go/no-go decision (not bundled into a routine sync-policy change) on
   whether vtt-chat ships an unofficial write-back feature at all.
