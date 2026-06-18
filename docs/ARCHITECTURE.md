For integration and onboarding flow, see [INTEGRATION.md](./INTEGRATION.md).
For D&D Beyond extraction details, see [DDB-DATA-EXTRACTION.md](./DDB-DATA-EXTRACTION.md).
For the (unofficial, experimental) D&D Beyond currency write-back, see [DDB-CURRENCY-WRITEBACK.md](./DDB-CURRENCY-WRITEBACK.md).
For Roll20 extraction details, see [ROLL20-DATA-EXTRACTION.md](./ROLL20-DATA-EXTRACTION.md).

---

# 🏗️ **ARCHITECTURE.md — VTT‑Chat Universal VTT Connector Extension**

This document defines the architecture, responsibilities, data flow, and build system for the **VTT‑Chat Universal VTT Connector** browser extension.
It is written to guide contributors and AI tools so they can safely generate, modify, and extend the project.

---

# 1. 🎯 Purpose

The extension enables **one‑click onboarding** into a self‑hosted **VTT‑Chat** server directly from supported Virtual Tabletops (VTTs).

It provides:

- Automatic detection of logged‑in users on supported VTTs
- Character list/game/campaign retrieval
- DM vs Player role detection
- Injection of a “Launch VTT‑Chat” button into VTT pages
- A unified onboarding flow for all VTTs
- Multi‑server support with invite codes
- “Reopen last session” functionality

The extension works in **Firefox**, **Chrome**, and **Edge** using a shared codebase.

---

extension/

# 2. 🧩 High‑Level Architecture

```text
extension/
│
├── src/
│   ├── content.js              # Injected into supported VTT pages
│   ├── background.js           # Service worker (MV3)
│   ├── popup.html              # Toolbar popup UI
│   ├── popup.js                # Popup logic
│   ├── manifest.base.json
│   ├── manifest.firefox.json
│   ├── manifest.chrome.json
│
├── icons/                      # User-provided icons
│   ├── icon-48.png
│   └── icon-96.png
│
└── build/
    ├── firefox/                # Build output for Firefox
    ├── chrome/                 # Build output for Chrome
    └── edge/                   # Build output for Microsoft Edge
```

---

# 3. 🧠 Core Components

## 3.1 `content.js` — Page Integration Layer

Runs on:

- D&D Beyond: `https://www.dndbeyond.com/characters/*`, `https://www.dndbeyond.com/campaigns/*`
- Roll20: `https://app.roll20.net/*` (planned)
- Foundry VTT: `https://*/game` (planned)
- Others: (planned)

Responsibilities:

- Extract logged‑in user and character/campaign/game context from each VTT
- Fetch platform-specific tokens as needed
- Fetch character/game/campaign details
- Determine DM vs Player
- Inject “Launch VTT‑Chat” button
- Send onboarding payload to background script

### Data sent to background (example):

```json
{
  "externalSystem": "dndbeyond" | "roll20" | "foundry" | ...,
  "user": { "id": "...", "displayName": "...", "avatarUrl": "..." },
  "campaignId": "...",
  "campaignName": "...",
  "isDm": true,
  "character": {
    "id": "...",
    "name": "...",
    "avatarUrl": "...",
    "race": "...",
    "className": "...",
    "level": 5
  }
}
```

---

## 3.2 `background.js` — Server Communication Layer

Responsibilities:

- Manage server list + active server
- Handle onboarding messages from content script
- POST to `/api/connect` or `/api/auth/extension/guest-login` on the VTT‑Chat server
- Open the returned session URL with `?token=...`
- Store `lastSession` for relaunch
- Provide cross‑browser compatibility (`browser` vs `chrome`)

---

## 3.3 `popup.html` + `popup.js` — Toolbar UI

Responsibilities:

- Manage list of VTT‑Chat servers
- Allow adding/editing active server
- Display server list with radio selector
- Provide “Reopen last session” button
- Use `browser.storage.local` for persistence

---

## 3.4 Manifest Files

### `manifest.base.json`

Shared across all browsers.

### `manifest.firefox.json`

Adds:

- `browser_specific_settings`
- `background.type = "module"`

### `manifest.chrome.json`

Chrome/Edge variant.

---

# 4. 🔐 Authentication & Data Flow

## 4.1 Platform Authentication

The extension uses platform-specific authentication flows:

- **D&D Beyond:**
  - `POST https://auth-service.dndbeyond.com/v1/cobalt-token` (JWT)
  - Used for character/campaign APIs
- **Roll20:**
  - Uses cookies and window-scoped tokens (see [ROLL20-DATA.md](ROLL20-DATA.md))
- **Foundry VTT:**
  - Uses session cookies and in-page context (planned)
- **Others:**
  - Platform-specific

## 4.2 Campaign/Game Details API

Each VTT has its own API for campaign/game/character details. See VTT-specific docs for details.

---

browser.runtime.sendMessage({ type: "connect", payload })

# 5. 🚀 VTT‑Chat Onboarding Flow

1. User clicks “Launch VTT‑Chat”
2. content.js gathers:

- User identity
- Character (if applicable)
- Campaign/game details
- DM flag

3. content.js → background.js

- `browser.runtime.sendMessage({ type: "connect", payload })`

4. background.js → VTT‑Chat server

- `POST /api/connect` or `/api/auth/extension/guest-login`

5. Server returns session info and token
6. background.js opens session in new tab

# 7. 🌐 Multi-VTT Roadmap

- **D&D Beyond**: Full support (character/campaign detection, onboarding, sync)
- **Roll20**: Character/campaign detection, chat log integration, onboarding (in progress)
- **Foundry VTT**: Character/game detection, onboarding (planned)
- **Other VTTs**: Community-driven support for additional platforms (planned)

See [../README.md](../README.md) and [IMPROVEMENTS.md](IMPROVEMENTS.md) for more details.

---

# 🏗️ **6. Build System (Corrected & AI‑Guided)**

The extension uses a **single Node.js build script** (`build.js`) to generate browser‑specific output bundles for **Firefox** and **Chrome/Edge** from a shared `src/` directory.

The build system is intentionally simple and deterministic so AI tools can safely modify or extend it.

---

## 📁 **6.1 Source Layout**

All editable source files live in:

```text
src/
  manifest.base.json
  manifest.firefox.json
  manifest.chrome.json
  content.js
  background.js
  popup.html
  popup.js
  icons/
```

You manually place your icons inside:

```text
src/icons/icon-48.png
src/icons/icon-96.png
```

---

## ⚙️ **6.2 Build Script (`build.js`)**

This script:

1. Loads `manifest.base.json`
2. Merges it with the browser-specific override:
   - `manifest.firefox.json` → `build/firefox/`
   - `manifest.chrome.json` → `build/chrome/`
   - `manifest.chrome.json` → `build/edge/` (Edge uses the same Chromium manifest format)
3. Copies all extension assets from `src/` into each output folder

Here is the **exact build script** used by the project:

```js
import fs from "fs";
import path from "path";

function load(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function write(dir, file, data) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), data);
}

function copy(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(src, destDir, { recursive: true });
}

function build(target, overrideFile) {
  const base = load("manifest.base.json");
  const override = load(overrideFile);
  const manifest = { ...base, ...override };

  const srcDir = "src";
  const outDir = `build/${target}`;
  write(outDir, "manifest.json", JSON.stringify(manifest, null, 2));

  copy(`${srcDir}/icons`, `${outDir}/icons`);
  copy(`${srcDir}/content.js`, `${outDir}/content.js`);
  copy(`${srcDir}/background.js`, `${outDir}/background.js`);
  copy(`${srcDir}/popup.html`, `${outDir}/popup.html`);
  copy(`${srcDir}/popup.js`, `${outDir}/popup.js`);
}

build("firefox", "manifest.firefox.json");
build("chrome", "manifest.chrome.json");
build("edge", "manifest.chrome.json");
```

---

## 🧪 **6.3 Build Output**

Running:

```text
node build.js
```

Produces:

```text
build/
  firefox/
    manifest.json  content.js  background.js  popup.html  popup.js  icons/
  chrome/
    manifest.json  content.js  background.js  popup.html  popup.js  icons/
  edge/
    manifest.json  content.js  background.js  popup.html  popup.js  icons/
```

These folders are **load‑ready** in their respective browsers.

---

## 🦊 **6.4 Firefox Build**

Load via:

```text
about:debugging → This Firefox → Load Temporary Add-on → build/firefox/
```

Firefox uses:

- `manifest.firefox.json` overrides
- `"background": { "type": "module" }`
- `"browser_specific_settings"`

---

## 🟦 **6.5 Chrome Build**

Load via:

```text
chrome://extensions → Developer Mode → Load unpacked → build/chrome/
```

---

## 🔷 **6.6 Microsoft Edge Build**

Load via:

```text
edge://extensions → Developer Mode → Load unpacked → build/edge/
```

Edge is Chromium-based and uses the same `manifest.chrome.json` overrides and `service_worker` background as Chrome.

---

## 🔁 **6.7 How AI Tools Should Modify the Build System**

To ensure safe modifications:

### AI MUST:

- Keep the `src/` → `build/` structure intact
- Preserve the manifest merge logic
- Preserve the file copy logic
- Keep the build script idempotent
- Keep browser‑specific manifests separate

### AI MUST NOT:

- Inline manifest overrides into the base manifest
- Change output folder names
- Remove or rename `src/`
- Introduce bundlers unless explicitly requested
- Change the MV3 service worker structure

---

# 7. 🌐 Browser Compatibility

The extension supports:

- Firefox (MV3)
- Chrome (MV3)
- Edge (MV3)

Compatibility is achieved via:

```js
if (typeof browser === "undefined") var browser = chrome;
```

---

# 8. 🧪 Testing Strategy

### Test on DDB:

- Character page (owned)
- Character page (not owned)
- Campaign page (DM)
- Campaign page (player)
- Campaign page (not a member)

### Test server flows:

- Valid serverCode
- Invalid serverCode
- Missing server
- Multiple servers
- Relaunch last session

---

# 9. 📌 Constraints & Rules for AI Tools

To ensure safe and correct generation:

### AI MUST:

- Preserve the MV3 structure
- Preserve the polyfill (`browser` vs `chrome`)
- Preserve the `/api/connect` payload shape
- Preserve the DDB API calls
- Preserve the build scripts
- Keep content/background scripts separate
- Keep manifests separate

### AI MUST NOT:

- Inline code into manifest files
- Change the onboarding flow
- Remove the serverCode requirement
- Modify the JWT handling
- Add new permissions without explicit instruction
- Change the URL matching patterns
- Break cross‑browser compatibility

---

# 10. 📚 Future Extensions

- TypeScript migration
- Vite/ESBuild bundling
- LiveKit token endpoint integration
- Automatic server discovery
- Character portrait sync
- Campaign notes sync

---

If you'd like, I can also generate:

- A **CONTRIBUTING.md**
- A **DEVELOPING.md** (for extension developers)
- A **SECURITY.md**
- A **CHANGELOG.md**

Just tell me what you want next.
