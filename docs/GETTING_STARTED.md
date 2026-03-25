# Getting Started

This repository is a stripped-down desktop chat client for GitHub Copilot.

## Stack

- Electron for the desktop shell
- Angular for the UI
- TypeScript across main, preload, and renderer

## Install

```bash
npm install
```

## Run In Development

```bash
npm run dev
```

This starts Angular on `http://localhost:4100` and launches Electron against it.

## Build

```bash
npm run build
npm run build:electron
```

## Main Folders

```text
src/main
  Electron app bootstrap, Copilot auth, chat IPC handlers

src/preload
  Small `window.copilot` bridge exposed to the renderer

src/renderer
  Angular app with a single chat-first screen
```

## Core Files

- `src/main/index.ts`: creates the Electron window
- `src/main/ipcHandlers.ts`: auth, chat, and proxy handlers
- `src/preload/preload.ts`: renderer API bridge
- `src/renderer/app/app.ts`: top-level shell and auth controls
- `src/renderer/app/components/chat/chat.component.ts`: chat UI logic
- `src/renderer/app/services/copilot.service.ts`: renderer wrapper around preload APIs

## Supported Flow

1. Open the app.
2. Click `Sign In`.
3. Complete GitHub device auth in the browser.
4. Click `I've Authorized`.
5. Start chatting.

## Exposed Renderer API

- `status()`
- `signIn()`
- `signInConfirm()`
- `signOut()`
- `getModels()`
- `sendChatMessage()`
- `onChatStream()`
- `onChatEnd()`
- `onChatError()`
- `proxyRequest()`
- `checkForUpdate()`

## Adding Your Own Feature

Keep the same pattern:

1. Add a new IPC handler in `src/main/ipcHandlers.ts` or a dedicated main-process module.
2. Expose it from `src/preload/preload.ts`.
3. Wrap it in `src/renderer/app/services/copilot.service.ts`.
4. Call it from an Angular component.

## Cleanup Policy

This repo intentionally avoids:

- workflow builders
- file tree viewers
- Monaco editor integration
- FormIO integration
- duplicate renderer implementations
- generated build artifacts checked into source

## Troubleshooting

- If auth fails, restart the app and retry the device login flow.
- If the UI is blank, run `npm run build` once and check terminal errors.
- If dependencies drift, delete generated output folders and run `npm install` again.