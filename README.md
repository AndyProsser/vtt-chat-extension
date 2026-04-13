# VTT‑Chat D&D Beyond Connector (Browser Extension)

A cross‑browser extension (Firefox, Chrome, Edge) that lets DMs and players
launch a VTT‑Chat session directly from D&D Beyond character and campaign pages.

This extension:

- Detects logged‑in DDB users
- Fetches character lists and campaign details using real DDB auth tokens
- Determines DM vs player from the campaign API
- Injects a "Launch VTT‑Chat" button into:
  - Character pages you own
  - Campaign pages you are a member of
- Sends a unified onboarding payload to your VTT‑Chat server
- Supports multiple servers with invite codes
- Supports "Reopen last session" from the popup

---

## 🔧 Development

### Prerequisites

- Node.js 18+
- Git

### Setup

```bash
git clone https://github.com/yourusername/vtt-chat-extension.git
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

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed technical documentation.

---

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch
3. Make changes
4. Run `npm run lint && npm run build`
5. Submit a PR

---

## 📄 License

MIT
