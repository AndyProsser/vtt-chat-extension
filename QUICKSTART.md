# Quick Start Guide

## For Developers

### First Time Setup
```bash
git clone https://github.com/yourusername/vtt-chat-extension.git
cd vtt-chat-extension
npm install
```

### Daily Development
```bash
# Make changes in src/

# Check your code
npm run lint

# Auto-fix formatting
npm run lint:fix

# Build and test
npm run build

# Load in browser
# Firefox: about:debugging → Load Temporary Add-on → dist-firefox/
# Chrome: chrome://extensions → Load unpacked → dist-chrome/
```

### Before Committing
```bash
npm run lint      # Must pass
npm run build     # Must succeed
git status        # Review changes
git add .
git commit -m "feat: your change description"
git push
```

### Making a Release
```bash
# 1. Update version in src/manifest.base.json
# 2. Create tag (GitHub Actions handles the rest)
git tag v0.2.0
git push origin main --tags

# 3. Download ZIPs from GitHub Releases
# 4. Submit to Chrome Web Store & Firefox Add-ons
```

---

## For Code Reviewers

### Checklist
- [ ] `npm run lint` passes with no errors
- [ ] `npm run build` succeeds for both Firefox & Chrome
- [ ] No hardcoded URLs (should reference `config.js`)
- [ ] Error handling included for async operations
- [ ] Changes documented in comments or JSDoc

---

## Available Scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | Build for Firefox & Chrome |
| `npm run lint` | Check code quality |
| `npm run lint:fix` | Auto-fix style issues |
| `npm run clean` | Remove dist folders |
| `npm run package` | Create distributable ZIPs |

---

## File Locations

| Item | Location |
|------|----------|
| Source files | `src/` |
| Firefox build | `dist-firefox/` |
| Chrome build | `dist-chrome/` |
| Architecture docs | `docs/ARCHITECTURE.md` |
| Improvement recommendations | `docs/IMPROVEMENTS.md` |
| CI/CD pipeline | `.github/workflows/ci-cd.yml` |

---

## Common Issues

**Q: Build fails with "ENOENT: no such file"**
```bash
npm run clean
npm run build
```

**Q: ESLint complains about undefined variables**
→ Check `package.json`'s eslintConfig globals section has `browser` and `chrome`

**Q: Dist folders are stale**
```bash
npm run clean && npm run build
```

---

## Documentation

- **Architecture & Design**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Detailed Recommendations**: [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md)
- **This Review**: [REVIEW.md](REVIEW.md)