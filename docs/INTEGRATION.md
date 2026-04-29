# Integration: How the Extension Launches a VTT-Chat Session

This section explains how the extension connects to a VTT-Chat server and launches a session from DDB pages.

## Flow
1. **User clicks "Launch VTT-Chat"** on a character or campaign page.
2. The content script gathers user, character, and campaign data as described above.
3. A payload is sent to the background script via `browser.runtime.sendMessage({ type: "connect", payload })`.
4. The background script:
   - Runs a preflight check with the VTT-Chat server (`/api/auth/extension/preflight`).
   - If needed, performs guest login (`/api/auth/extension/guest-login`) with the extracted data.
   - Stores the session token and context.
   - Opens a new tab to the VTT-Chat session URL (`/join/:inviteCode?token=...`).
5. The user is onboarded into the VTT-Chat session with their DDB identity and character/campaign context.

## Security
- All API calls use credentials (cookies/JWT) scoped to the user's browser session.
- No credentials are sent to third parties except the configured VTT-Chat server.
- Session tokens are stored only in extension memory and browser storage.

## Error Handling
- The extension provides error feedback in the popup UI if onboarding fails (e.g., invalid invite, server offline).
- All failures are logged to the console for debugging.
