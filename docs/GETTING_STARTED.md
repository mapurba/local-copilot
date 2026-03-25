# Getting Started

## Prerequisites

- Node.js 18+
- A GitHub account with Copilot access

## Install & Run

```bash
npm install
npm run dev
```

This compiles TypeScript, starts the Angular renderer on `http://localhost:4100`, and launches the Electron shell. Both processes hot-reload on file changes.

## Build for production

```bash
npm run build          # compiles everything
npm run build:electron # Electron main process only
```

## Sign in

1. Click **Sign In** in the app
2. A device code is shown — open the verification URL in your browser and enter the code
3. Click **I've Authorized** back in the app
4. The app authenticates via GitHub Copilot LSP and stores the token

## Architecture in 60 seconds

This is an **Electron + Angular** app. The process boundary is important:

```
Renderer (Angular)         Preload          Main (Node/Electron)
─────────────────    ─────────────────    ─────────────────────
ChatComponent         window.copilot       ipcHandlers.ts
CopilotService    ←── contextBridge    ←── toolRegistry
DebugPanelComponent   (preload.ts)         copilotChatApi.ts
                                           lspClient.ts
```

- **Renderer** cannot call Node APIs directly — it goes through `window.copilot`
- **Preload** (`src/preload/preload.ts`) exposes typed methods via `contextBridge`
- **Main** (`src/main/ipcHandlers.ts`) receives `ipcRenderer.invoke(...)` calls and runs privileged code
- **Tools** live entirely in the main process (`src/main/tools/`) and are invoked by the LLM during chat

## Key source files

| File | Role |
|---|---|
| `src/main/index.ts` | Electron entry, creates BrowserWindow |
| `src/main/ipcHandlers.ts` | All IPC channels: auth, chat, tools, proxy |
| `src/main/copilotChatApi.ts` | GitHub Copilot API streaming, tool dispatch |
| `src/main/tools/registry.ts` | Tool registration and call dispatch |
| `src/main/tools/math.ts` | Built-in math tools (example implementation) |
| `src/preload/preload.ts` | `window.copilot` bridge with full TypeScript types |
| `src/renderer/app/services/copilot.service.ts` | Angular service wrapping the bridge API |
| `src/renderer/app/components/chat/chat.component.ts` | Main chat UI, streams LLM responses |
| `src/renderer/app/components/debug-panel/` | Debug/log panel (toggleable, resizable) |

## Debug panel

The debug panel (bottom or right side) shows all tool calls, thinking chains, and API logs in real time. Toggle it with the button in the top-right of the chat UI. It can be dragged to resize and moved between bottom and right positions.
