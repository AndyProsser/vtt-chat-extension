# 🛣️ Roadmap & Multi-VTT Improvements

This extension is evolving from a D&D Beyond-specific connector to a universal VTT onboarding tool. The following improvements and roadmap items reflect this broader scope:

## Roadmap

- [x] **D&D Beyond support** — Full integration (character/campaign detection, onboarding, sync)
- [ ] **Roll20 support** — Detect logged-in user, extract character/campaign, inject button, onboarding flow (in progress)
- [ ] **Foundry VTT support** — Detect logged-in user, extract character/game, inject button, onboarding flow (planned)
- [ ] **Other VTTs** — Community-driven support for additional platforms (planned)

- [ ] **Chat log integration** — For Roll20, extract chat log and send to VTT‑Chat
- [ ] **Session persistence** — Improve last-session restore across VTTs
- [ ] **UI polish** — Popup and in-page button styling
- [ ] **Error handling** — More granular error codes and user feedback
- [ ] **Test coverage** — Expand contract and integration tests for all VTTs

See [ARCHITECTURE.md](ARCHITECTURE.md) for technical details and VTT-specific integration notes. See [../README.md](../README.md) for project overview and roadmap.

---

For integration and onboarding flow, see [INTEGRATION.md](./INTEGRATION.md).
For D&D Beyond extraction details, see [DDB-DATA-EXTRACTION.md](./DDB-DATA-EXTRACTION.md).
For Roll20 extraction details, see [ROLL20-DATA-EXTRACTION.md](./ROLL20-DATA-EXTRACTION.md).

---

# Code Quality & DevOps Improvements

This document outlines the improvements made to the VTT-Chat DDB Connector extension and recommends further enhancements.

---

## ✅ Completed Improvements

### 1. **Git & Repository**
- Added `.gitignore` with comprehensive patterns for:
  - Node modules and dependencies
  - Build outputs (dist-*)
  - IDE and OS files
  - Environment variables and logs

### 2. **Project Configuration**
- Created `package.json` with:
  - Build scripts for Firefox and Chrome
  - Lint scripts with ESLint
  - Package scripts to create distributable ZIPs
  - ESLint configuration with browser globals for extension APIs
  - Project metadata (repository, author, license)

### 3. **Linting**
- Configured ESLint with:
  - ES6+ support
  - Browser environment
  - Extension API globals (`browser`, `chrome`)
- Fixed existing lint warnings:
  - Removed unused `sender` parameter in background.js
  - All code passes linting cleanly

### 4. **Build Improvements**
- Fixed build.js to properly resolve manifest paths
- Outputs clean dist folders ready for distribution

### 5. **GitHub Actions CI/CD**
Created `.github/workflows/ci-cd.yml` with three jobs:

#### **Lint Job**
- Runs ESLint on all source files
- Catches errors early in the pipeline

#### **Build Job** (depends on lint)
- Builds both Firefox and Chrome variants
- Uploads build artifacts for verification
- Runs on all pushes and PRs

#### **Package Job** (only on release)
- Creates distributable ZIP files for both browsers
- Automatically uploads to GitHub Releases when you create a release tag

### 6. **Updated README**
- Clearer development setup instructions
- Links to documentation
- Installation guides for both browsers
- Contributing guidelines

---

## 🚀 Setup Instructions for Your Team

### Prerequisites
```bash
node --version  # Ensure v18+
npm --version
```

### Clone & Install
```bash
git clone https://github.com/yourusername/vtt-chat-extension.git
cd vtt-chat-extension
npm install
```

### Development Workflow
```bash
# Build the extension
npm run build

# Check code quality
npm run lint

# Auto-fix linting issues
npm run lint:fix

# Clean build artifacts
npm run clean

# Package for distribution
npm run package
```

### Testing Locally

**Firefox:**
```
about:debugging → This Firefox → Load Temporary Add-on → dist-firefox/manifest.json
```

**Chrome/Edge:**
```
chrome://extensions → Developer Mode ON → Load unpacked → dist-chrome/
```

---

## 📋 Recommended Next Steps

### High Priority

#### 1. **Constants & Configuration**
Create `src/config.js`:
```javascript
export const CONFIG = {
  API: {
    COBALT_TOKEN: 'https://auth-service.dndbeyond.com/v1/cobalt-token',
    CHARACTER_LIST: 'https://character-service.dndbeyond.com/character/v5/characters/list',
    CAMPAIGN_DETAILS: 'https://api.dndbeyond.com/campaigns/v1/details'
  },
  CACHE_TTL_MS: 5 * 60 * 1000,
  RELAUNCH_MAX_AGE_MS: 3 * 24 * 60 * 60 * 1000,
  DOM_SELECTORS: {
    MEGA_MENU_TARGET: '#mega-menu-target',
    CHARACTER_HEADER: '[data-testid="character-header"]',
    CAMPAIGN_DETAIL_HEADER: '.ddb-campaigns-detail-header'
  }
};
```

Benefits:
- Single source of truth for magic strings
- Easier to update if DDB changes API endpoints
- Better maintainability

#### 2. **Error Handling & User Feedback**
Improve error messages in popup:
- Show connection status
- Display error details (server unreachable, invalid config)
- Add retry mechanism

#### 3. **Input Validation**
In `popup.js`, add URL validation:
```javascript
function isValidUrl(str) {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}
```

#### 4. **Module Extraction**
Break up large content.js into logical modules:
- `src/extractors/` - User data extraction
- `src/api/` - DDB API calls
- `src/ui/` - DOM manipulation

### Medium Priority

#### 5. **Chrome Web Store & Firefox Add-ons**
Create `RELEASE_NOTES.md`:
```markdown
## Version 0.1.0 (Initial Release)

### Features
- Launch VTT-Chat from D&D Beyond character pages
- Multi-server support with invite codes
- "Reopen last session" functionality
- Cross-browser support (Firefox, Chrome, Edge)

### Known Limitations
- Requires D&D Beyond login
- Session link valid for 3 days
```

#### 6. **Testing**
Add Jest configuration:
```bash
npm install --save-dev jest
```

Create `src/__tests__/extractors.test.js` to mock DOM and test user extraction.

#### 7. **Documentation**
Add JSDoc comments to all functions:
```javascript
/**
 * Extracts DDB user from multiple data sources with fallbacks
 * @returns {Object|null} User object or null if not found
 */
function extractDdbUser() { ... }
```

### Lower Priority

#### 8. **Browser-Specific Features**
- Add context menu option: "Launch VTT-Chat with this character"
- Add browser notifications for session launch success/failure

#### 9. **Analytics & Monitoring**
Consider lightweight telemetry (optional, privacy-respecting):
- Track successful connections
- Error rates by browser
- Feature usage (for prioritizing updates)

#### 10. **Automated Distribution**
Extend CI/CD to auto-submit to:
- Chrome Web Store API
- Firefox Add-ons (AMO)

---

## 🔒 Security Checklist

- [x] ESLint configured and passing
- [x] Safe DOM manipulation (using `textContent`, `createElement`)
- [ ] Add Content Security Policy (CSP) in manifest
- [ ] Review all fetch calls for CORS and credential handling
- [ ] Add token encryption for sensitive storage
- [ ] Rate-limit API calls to DDB
- [ ] Validate all API responses

---

## 📊 Project Statistics

| Metric | Value |
|--------|-------|
| Files | 9 main files |
| Lines of Code | ~450 |
| Build Time | <1s |
| Browser Support | Firefox, Chrome, Edge |
| Manifest Version | 3 |

---

## 🔄 Deployment Workflow

### For Development
```bash
npm run build && npm run lint
```

### For Release
1. Update version in `src/manifest.base.json`
2. Update `RELEASE_NOTES.md`
3. Commit and tag: `git tag v0.2.0`
4. Push: `git push origin main --tags`
5. GitHub Actions automatically packages and uploads ZIPs

### After Release
Download ZIPs from GitHub Releases and submit to:
- **Chrome Web Store**: developer.chrome.com/webstore
- **Firefox Add-ons**: addons.mozilla.org

---

## 🤝 Team Guidelines

### Code Review Checklist
- [ ] Linting passes (`npm run lint`)
- [ ] Builds successfully (`npm run build`)
- [ ] Changes documented in comments
- [ ] No hardcoded URLs or selectors
- [ ] Error handling for all async operations

### Commit Messages
```
feat: Add server error handling in popup
fix: Correct XPath selector for campaign header
docs: Update API reference
refactor: Extract DDB API calls to separate module
```

---

## 📞 Support & Questions

For detailed extension architecture, see [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

For GitHub Actions CI/CD details, see [.github/workflows/ci-cd.yml](../.github/workflows/ci-cd.yml).