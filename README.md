
# VTT‑Chat Universal VTT Connector (Browser Extension)

A cross‑browser extension (Firefox, Chrome, Edge) that lets DMs and players launch a VTT‑Chat session directly from supported Virtual Tabletops (VTTs).

**Supported VTTs:**

- D&D Beyond (full integration)

**Planned/Upcoming:**

- Roll20 (in progress)
- Foundry VTT (planned)
- Additional web-based tabletops (planned)

This extension:

- Detects logged‑in users on supported VTTs
- Fetches character lists and campaign/campaign details using real platform tokens
- Determines DM vs player from the VTT API or page context
- Injects a "Launch VTT‑Chat" button into:
  - Character sheets you own
  - Campaign/game pages you are a member of
- Sends a unified onboarding payload to your VTT‑Chat server
- Supports multiple servers with invite codes
- Supports "Reopen last session" from the popup

---

## 🔧 Development

### Prerequisites

- Node.js 24+
- Git

### Setup

```bash
git clone https://github.com/AndyProsser/vtt-chat-extension.git
cd vtt-chat-extension
npm install
```

### Build

```bash
npm run build
```

This generates:

- `build/firefox/` — Firefox extension
- `build/chrome/` — Chrome extension
- `build/edge/` — Microsoft Edge extension

### Lint

```bash
npm run lint
npm run lint:fix  # Auto-fix issues
```

### Package

```bash
npm run package  # Creates ZIP files for distribution
```

---

## 🚀 Installation

### Firefox

1. Open `about:debugging`
2. Click "This Firefox" > "Load Temporary Add-on"
3. Select `build/firefox/manifest.json`

### Chrome

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" > Select `build/chrome/`

### Microsoft Edge

1. Open `edge://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" > Select `build/edge/`

---

## 📋 Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for technical details and VTT-specific integration notes.

---

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch
3. Make changes
4. Run `npm run lint && npm run build`
5. Submit a PR

---

## 🗺️ Roadmap

- **D&D Beyond**: Full support (character/campaign detection, onboarding, sync)
- **Roll20**: Character/campaign detection, chat log integration, onboarding (in progress)
- **Foundry VTT**: Character/game detection, onboarding (planned)
- **Other VTTs**: Community-driven support for additional platforms (planned)

See [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md) for feature ideas and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for integration details.

## 📄 License

MIT

---

## A note to Wizards of the Coast / D&D Beyond

We want to be transparent about what this extension does and why.

VTT-Chat is a companion chat system for tabletop RPG sessions. This extension connects D&D Beyond to VTT-Chat so that players and DMs can carry their character data — names, stats, HP, conditions — directly into our chat experience without manual entry. The goal is simply to make the game more enjoyable.

**What we do:**

- Read character and campaign data that the logged-in user already has access to, using their own session credentials
- Observe character saves (via the browser's `webRequest` API) to keep synced stats up to date in our system
- We only contact D&D Beyond's API when a player is actively on their character sheet **and** has an active VTT-Chat session with other players connected — we deliberately avoid unnecessary API calls

**What we do not do:**

- Scrape, bulk-collect, or store DDB content beyond what is needed to run a single user's session
- Modify any DDB data (with the narrow exception of the experimental currency write-back feature, which is opt-in and clearly marked as unofficial, nor implemented at this time)
- Circumvent authentication — we use the user's own session, not bots or scrapers
- Resell, republish, or cache DDB content

We recognise this extension relies on unofficial API access and fully accept that WotC / DDB may require us to change or remove functionality at any time. If you would like us to adjust our approach, or if an official API integration path exists or becomes available, we would be genuinely delighted to work with you.

You can reach us by opening an issue on this repository or via the contact details on the VTT-Chat project.
