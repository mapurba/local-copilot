# Copilot Chat

Minimal Electron plus Angular boilerplate for GitHub Copilot sign-in and chat.

## Quick Start

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run build:electron
```

## What Stays In This Repo

- Electron main process for auth, IPC, and chat streaming
- Angular renderer with a single chat screen
- Preload bridge exposing a small API surface
- One concise setup guide in [docs/GETTING_STARTED.md](./docs/GETTING_STARTED.md)
- Beginner custom tool guide in [docs/CUSTOM_TOOLS_GUIDE.md](./docs/CUSTOM_TOOLS_GUIDE.md)

## Project Layout

```text
src/
  main/       Electron main process
  preload/    secure renderer bridge
  renderer/   Angular UI
docs/
  GETTING_STARTED.md
```

## Runtime Scripts

```bash
npm run dev
npm run start
npm run build
npm run build:watch
npm run build:electron
npm run lint
```

## Notes

- The app opens on port `4100` in development.
- Production renderer output is `dist/renderer-angular`.
- Generated folders like `dist`, `dist-electron`, and `release` are safe to delete.

## License

MIT
