# Copilot Chat

Minimal Electron + Angular desktop client for GitHub Copilot chat.

## Quick Start

- Install: npm install
- Dev: npm run dev
- Build renderer: npm run build
- Build Electron package: npm run build:electron

## Docs

- Setup: docs/GETTING_STARTED.md
- Custom tools: docs/CUSTOM_TOOLS_GUIDE.md
- Thinking logs: docs/THINKING_LOGS_QUICK_REFERENCE.md
- Dedup logs: docs/LOG_DEDUPLICATION_SUMMARY.md

## Structure

- src/main: Electron main process (auth, IPC, chat stream)
- src/preload: secure bridge exposed to renderer
- src/renderer: Angular UI

## Notes

- Dev renderer runs on http://localhost:4100
- Renderer build output: dist/renderer-angular
- Safe to delete generated folders: dist, dist-electron, release
