# D&D Beyond Data Extraction (DCO)

This section describes how the extension extracts user, character, and campaign data from D&D Beyond (DDB) to support VTT-Chat onboarding and session sync.

## User Extraction
- The extension attempts to extract the logged-in user from multiple sources:
  - **Mega Menu DOM**: Reads attributes from `#mega-menu-target` (user-id, display-name, avatar, email, roles).
  - **Cobalt Object**: Reads from `window.Cobalt.User` if available.
  - **Next.js Flight Script**: Parses embedded JSON from script tags containing user info.
- The first available method is used, in order: Mega Menu → Cobalt → Next.js Flight.

## Character List
- After extracting the user, the extension fetches the character list via:
  - `POST https://auth-service.dndbeyond.com/v1/cobalt-token` to obtain a JWT.
  - `GET https://character-service.dndbeyond.com/character/v5/characters/list?userId=...` with the JWT.
- The character list is normalized to include id, name, level, race, class, avatar, campaignId, and campaignName.

## Campaign Details
- For campaign context, the extension fetches:
  - `GET https://api.dndbeyond.com/campaigns/v1/details/:id` with the JWT.
- Used to determine DM, members, and active characters.

## Sync & Updates
- Character/campaign changes are detected and sent to the background script for sync with the VTT-Chat server.
- All extracted data is cached in `browser.storage.local` for performance and session persistence.
