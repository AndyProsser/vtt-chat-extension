# Integration: How the Extension Launches a VTT-Chat Session

This section explains how the extension connects to a VTT-Chat server and launches a session from any supported VTT (D&D Beyond, Roll20, etc.).

## Flow

1. **User clicks "Launch VTT-Chat"** on a character, campaign, or game page.
2. The content script gathers user, character, and campaign/game data using VTT-specific extraction logic (see [DDB-DATA-EXTRACTION.md](./DDB-DATA-EXTRACTION.md) and [ROLL20-DATA-EXTRACTION.md](./ROLL20-DATA-EXTRACTION.md)).
3. The extracted data is normalized to a common payload shape:

   ```json
   {
     "externalSystem": "dndbeyond" | "roll20" | "foundry" | ...,
     "user": { "id": "...", "displayName": "...", "avatarUrl": "...", "email": "..." },
     "campaignId": "...",
     "campaignName": "...",
     "isDm": true,
     "character": {
       "id": "...",
       "name": "...",
       "avatarUrl": "...", // May be empty; VTT-Chat will insert a placeholder if so
       "race": "...",
       "className": "...",
       "level": 5
     }
   }
   ```

4. The payload is sent to the background script via `browser.runtime.sendMessage({ type: "connect", payload })`.
5. The background script:
   - Runs a preflight check with the VTT-Chat server (`/api/auth/extension/preflight`).
   - If needed, performs guest login (`/api/auth/extension/guest-login`) with the extracted data.
   - Stores the session token and context.
   - Opens a new tab to the VTT-Chat session URL (`/join/:inviteCode?token=...`).
6. The user is onboarded into the VTT-Chat session with their VTT identity and character/campaign/game context.

## Security

- All API calls use credentials (cookies/JWT/tokens) scoped to the user's browser session.
- No credentials are sent to third parties except the configured VTT-Chat server.
- Session tokens are stored only in extension memory and browser storage.

## Error Handling

- The extension provides error feedback in the popup UI if onboarding fails (e.g., invalid invite, server offline).
- All failures are logged to the console for debugging.

## Notes

- If a character or user avatar URL is empty, the VTT-Chat server is responsible for inserting a generic placeholder image.
- For VTT-specific extraction details, see:
  - [DDB-DATA-EXTRACTION.md](./DDB-DATA-EXTRACTION.md) (D&D Beyond)
  - [ROLL20-DATA-EXTRACTION.md](./ROLL20-DATA-EXTRACTION.md) (Roll20)
