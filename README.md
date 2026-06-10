
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

- `dist-firefox/` — Firefox extension
- `dist-chrome/` — Chrome/Edge extension

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
3. Select `dist-firefox/manifest.json`

### Chrome/Edge

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable "Developer mode"
3. Click "Load unpacked" > Select `dist-chrome/`

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
