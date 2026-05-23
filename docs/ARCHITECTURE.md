# VCD Agent — Architecture Document

**Version:** 0.0.7  
**Date:** May 2026  
**App ID:** `com.local.vcdagent`

---

## 1. Overview

VCD Agent is an **Electron desktop application** that combines a GitHub Copilot–powered AI chat interface with direct management of a VMware Cloud Director (VCD) environment. Users interact in natural language; the AI autonomously calls a curated tool set to list VMs, deploy new machines, snapshot, clone, resize, SSH into hosts, monitor background tasks, and answer questions about uploaded documents.

The application is distributed as a self-contained Windows installer (NSIS `.exe`), with macOS (`.dmg`) and Linux (AppImage) targets defined but not currently published.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Electron Renderer Process  (Chromium / React 19)                       │
│                                                                         │
│  App.tsx ── Sidebar ── ChatPane ── VmListPane ── TerminalPane           │
│              │           │              │              │                │
│          TaskStatus   ModelSelect   VmSidebar    FileBrowser            │
│          CreateVmForm ToolApprovalModal  DocUploadPanel  EditorPane     │
│                                                                         │
│  window.copilot  ◄──── contextBridge (preload.ts) ────►                │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │  IPC (ipcRenderer.invoke / webContents.send)
┌───────────────────────────────▼─────────────────────────────────────────┐
│  Electron Main Process  (Node.js)                                       │
│                                                                         │
│  index.ts → createWindow → registerIpcHandlers                          │
│                                                                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │  Copilot Chat    │  │  VCD API Layer   │  │  Tool System         │  │
│  │  copilotChatApi  │  │  vcdApi.ts       │  │  tools/registry.ts   │  │
│  │  tokenManager    │  │  vcdAuth.ts      │  │  tools/approval      │  │
│  │  lspClient.ts    │  │  vcdStore.ts     │  │  tools/categories/   │  │
│  └────────┬─────────┘  └────────┬─────────┘  └──────────┬───────────┘  │
│           │                     │                        │              │
│  ┌────────▼─────────────────────▼────────────────────────▼───────────┐  │
│  │                     Supporting Services                           │  │
│  │  taskTracker   vmWatcher   apiLogger   autoUpdater                │  │
│  │  terminalSessionsStore   toolResultFormatter   envRewrite         │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                         │                    │
              ┌──────────▼──────┐   ┌─────────▼──────────┐
              │ GitHub Copilot  │   │ VMware Cloud        │
              │ Language Server │   │ Director REST API   │
              │ (STDIO child)   │   │ HTTPS (port 443)    │
              └─────────────────┘   └────────────────────┘
```

---

## 3. Process Architecture

### 3.1 Main Process (`src/main/`)

Runs in Node.js with full system access. Responsibilities:

| Module | Role |
|---|---|
| `index.ts` | Bootstrap: creates `BrowserWindow`, initialises tool system, registers IPC handlers, starts update check |
| `ipcHandlers.ts` | Single registration point for all `ipcMain.handle` and `ipcMain.on` listeners |
| `copilotChatApi.ts` | Builds LangChain tool graph, streams AI responses, manages cancellation |
| `lspClient.ts` | Manages the `@github/copilot-language-server` child process over STDIO/JSON-RPC |
| `tokenManager.ts` | Caches and refreshes the Copilot bearer token; exchanges OAuth tokens |
| `vcdApi.ts` | All VCD REST calls (VM CRUD, templates, vApps, snapshots, tasks, IP allocation) |
| `vcdAuth.ts` | VCD Basic→Bearer sign-in; session persistence via `electron.safeStorage` |
| `vcdStore.ts` | In-memory singleton: current VCD context (host, token, org, VDC, network defaults) |
| `vcdConfig.ts` | Static constants: org names, VDC IDs, storage/compute policy maps |
| `taskTracker.ts` | Long-running multi-step task registry with LRU log budget |
| `vmWatcher.ts` | Poll-based background VM monitor (setInterval); delegates I/O to actions module |
| `vmWatcherActions.ts` | VCD power-state check and SSH command execution for the watcher |
| `apiLogger.ts` | Async append-only JSONL log of all outbound HTTP calls (`api-calls.log`) |
| `autoUpdater.ts` | Checks remote `latest.json`, downloads NSIS installer, launches and quits |
| `toolResultFormatter.ts` | Converts JSON tool results to markdown tables for the LLM context |
| `terminalSessionsStore.ts` | Persist saved SSH sessions to `saved-terminals.json` in userData |
| `envRewrite.ts` | Patches `.env` file content with the real VM IP before ILM/IDM setup |
| `tools/` | Pluggable tool system (see §5) |
| `scripts/` | Embedded bash scripts run post-VM-boot (network, proxy, ILM, IDM, packages, finalization) |

### 3.2 Preload Script (`src/preload/preload.ts`)

Runs in the renderer's renderer-process context before the web page. Uses Electron's `contextBridge.exposeInMainWorld` to expose a typed `window.copilot` API surface — preventing the renderer from accessing `ipcRenderer` directly, enforcing context isolation.

Every renderer → main call is a typed wrapper around `ipcRenderer.invoke(channel, ...args)`. Every main → renderer push event is subscribed via `ipcRenderer.on(channel, callback)` and returns a cleanup function.

### 3.3 Renderer Process (`src/renderer/`)

Standard React 19 SPA built with Vite. Loaded from `http://localhost:5173` in dev or from `dist/index.html` in production (via `app.isPackaged`).

| Component | Role |
|---|---|
| `App.tsx` | Root state: Copilot auth, VCD auth, theme, tool approval queue |
| `Sidebar.tsx` | Left navigation: chat, VM list, task panel, terminal, file browser, docs |
| `ChatPane.tsx` | Primary chat UI: message history, model selector, streaming renderer, VM draft forms, doc attachments |
| `VmListPane.tsx` | Card-based VM browser: power on/off, delete, snapshot, clone, SSH launch |
| `VmSidebar.tsx` | Condensed VM sidebar view |
| `TaskStatusPanel.tsx` | Real-time step progress for long-running agent tasks |
| `TerminalPane.tsx` | xterm.js-based terminal emulator (IPC-backed) |
| `FileBrowser.tsx` | Remote file system browser (SFTP-backed; currently disabled) |
| `EditorPane.tsx` | Monaco editor for viewing/editing remote or local files |
| `AuthModal.tsx` | GitHub Copilot device-flow sign-in wizard |
| `VcdAuthModal.tsx` | VCD credential form with org presets |
| `ToolApprovalModal.tsx` | Human-in-the-loop approval dialog for risky tool calls |
| `CreateVmForm.tsx` | Editable VM creation review form surfaced from AI drafts |
| `DocUploadPanel.tsx` | Document upload; feeds into RAG pipeline |
| `ConfigureToolsPanel.tsx` | Per-tool enable/disable toggles |
| `ModelSelector.tsx` | Copilot model picker |
| `ResponseRenderer.tsx` | Markdown renderer with syntax highlighting |

---

## 4. Communication Patterns

### 4.1 IPC Channels

#### Renderer → Main (`ipcRenderer.invoke`)

| Channel | Description |
|---|---|
| `copilot:status` | Check GitHub Copilot auth status |
| `copilot:signIn` | Initiate device-flow sign-in |
| `copilot:signInConfirm` | Complete device-flow confirmation |
| `copilot:signOut` | Sign out of Copilot |
| `copilot:getModels` | List available AI models |
| `copilot:sendChatMessage` | Simple streaming chat (no tools) |
| `copilot:sendChatMessageWithTools` | Agentic chat with full tool loop |
| `copilot:cancelChat` | Cancel in-progress LangChain run |
| `tools:list` | Get all registered tools (for UI toggle) |
| `vcd:listVms` | Direct VM list (no LLM) |
| `vcd:listVapps` | Direct vApp list |
| `vcd:deployVm` | Execute confirmed VM deployment |
| `vcd:powerOnVm` | Power on a VM by href |
| `vcd:powerOffVm` | Power off a VM by href |
| `vcd:deleteVm` | Delete a VM |
| `vcd:createSnapshot` | Create VM snapshot |
| `vcd:revertSnapshot` | Revert to latest snapshot |
| `vcd:createVmCopy` | Clone a VM |
| `vcd:listSnapshots` | List all snapshots |
| `vcd:allocateFreeIp` | Request a free IP address |
| `vcd:signIn` | VCD authentication |
| `vcd:status` | VCD connection status |
| `vcd:signOut` | VCD sign-out |
| `terminal:sessions:list` | List saved SSH sessions |
| `terminal:sessions:save` | Save a new SSH session |
| `terminal:sessions:delete` | Delete a saved SSH session |
| `proxy:http` | Proxy an HTTP/S request through main |
| `tools:approval:respond` | User response to tool approval request |
| `tasks:list` | List all tracked tasks |
| `tasks:get` | Get a single task by ID |
| `tasks:getLog` | Get full command log by logId |

#### Main → Renderer (`webContents.send`)

| Event | Description |
|---|---|
| `chat:stream-chunk` | A streamed text or tool-call chunk |
| `chat:stream-end` | Chat response complete |
| `chat:stream-error` | Chat error |
| `chat:vm-draft` | AI produced a VM creation draft form |
| `chat:vm-copy-draft` | AI produced a VM clone draft form |
| `chat:watch-notification` | Background VM watcher completed |
| `task:updated` | Task tracker state changed |
| `tools:approval-request` | Tool requires user approval |
| `vcd:session-expired` | VCD token expired |
| `update-download-progress` | Update download progress (0-100) |
| `update-cancelled` | User declined update |

### 4.2 GitHub Copilot Language Server (LSP)

The Copilot Language Server (`@github/copilot-language-server`) runs as a child process communicating over **STDIO** using the Language Server Protocol (JSON-RPC 2.0 with `Content-Length` framing). The `LspClient` class wraps this process, providing:

- `initialize()` — LSP handshake
- `checkStatus()` — auth state query
- `signInInitiate()` / `signInConfirm()` — device-flow OAuth
- `signOut()` — clear session
- Token extraction from LSP `notification` events (watched by `TokenManager`)

### 4.3 VCD REST API

All VCD calls use raw `https.request` (no SDK). Calls are made with `Accept: application/json;version=38.0` and `Authorization: Bearer <token>`. The `httpsRequest` helper enforces configurable TLS verification (default: off for self-signed enterprise certs) and a 30-second timeout. Auto-reauthentication is attempted on 401 responses.

---

## 5. Tool System

### 5.1 Design

The tool system is a pluggable, registry-based framework for AI-callable functions. It maps directly to the LangChain tool graph used in `copilotChatApi.ts`.

```
ToolRegistry (singleton)
    register(name, handler, metadata)
    execute(request) → result
         ↓
    ApprovalSystem.requiresApproval(name, riskLevel)
         ↓ if required
    requestApproval() → IPC → ToolApprovalModal → user response
         ↓ approved
    handler(args, context) → result
```

### 5.2 Risk Levels

| Level | Approval | Examples |
|---|---|---|
| `safe` | Auto-allow | `list_vms`, `get_vm_details`, `docs_search` |
| `review` | Show preview UI | `create_snapshot`, `ssh_runCommand`, `task_start` |
| `dangerous` | Explicit user approval | `delete_vm`, `ssh_runSudoCommand`, `revert_snapshot` |

### 5.3 Tool Categories

| Category | Location | Tools |
|---|---|---|
| `vcd` | `tools/categories/vcd/` | list_vms, list_vapps, list_templates, create_vm_draft, create_vm_confirmed, power_on/off, delete_vm, resize_vm, create_snapshot, revert_snapshot, create_vm_copy_draft, list_tasks, check_vm_status, build_create_form, allocate_ip |
| `ssh` | `tools/categories/ssh/` | ssh_connect, ssh_disconnect, ssh_runCommand, ssh_runSudoCommand, ssh_listSessions |
| `docs` | `tools/categories/docs/` | docs_upload, docs_list, docs_search, docs_ask, docs_getContent |
| `local` | `tools/categories/local/` | task_start, task_log_step, task_done, task_get_log, vm_watch, vm_watch_cancel, list_recent_tasks |

### 5.4 Session Permissions

`SessionPermissionsManager` tracks per-session "always allow" grants to avoid repeated approval prompts for the same tool in the same conversation.

---

## 6. Authentication Flows

### 6.1 GitHub Copilot Authentication

```
Renderer                  Main                      LSP Child Process
    │                       │                              │
    ├── copilot:status ─────►│                              │
    │                       ├── lspClient.checkStatus() ──►│
    │                       │◄─ {status, user} ────────────┤
    │◄── {status: 'NotAuthorized'} ──┤                      │
    │                       │                              │
    ├── copilot:signIn ─────►│                              │
    │                       ├── lspClient.signInInitiate()─►│
    │                       │◄─ {userCode, verificationUri}─┤
    │◄── {userCode, verificationUri} ┤                      │
    │ [user visits URI, enters code] │                      │
    ├── copilot:signInConfirm ──────►│                      │
    │                       ├── lspClient.signInConfirm() ─►│
    │                       │◄─ {status: 'OK', user} ───────┤
    │                       │   TokenManager ◄── token notification
    │◄── {status: 'OK'} ────┤                              │
```

### 6.2 VCD Authentication

```
VcdAuthModal → vcd:signIn IPC → vcdAuth.vcdSignIn()
    POST https://<host>/cloudapi/1.0.0/sessions
    Authorization: Basic base64(user@org:password)
    ← x-vmware-vcloud-access-token: <jwt>

Token + metadata serialized via electron.safeStorage → userData/vcd-session.json
setVcdContext({ host, token, org, vdcId, ... }) → vcdStore singleton

On 401 → attemptAutoReauth() → re-POST with stored credentials → update token
On failure → notifySessionExpired() → IPC event → VcdAuthModal shown
```

---

## 7. LangChain Integration

`copilotChatApi.ts` uses `@langchain/openai` `ChatOpenAI` pointed at `api.githubcopilot.com` with a dynamically refreshed bearer token. The tool loop:

1. Construct `ChatOpenAI` with all active (non-disabled) tools as LangChain `tool()` definitions using Zod schemas.
2. Bind tools and call `.stream(messages)` with the system prompt and conversation history.
3. Accumulate streamed chunks; emit `chat:stream-chunk` for text deltas.
4. On `tool_use` chunks: look up tool in `ToolRegistry`, run approval check, execute handler, format result, feed back as `ToolMessage`.
5. Continue the loop until the model issues no more tool calls (max iterations guarded).
6. Emit `chat:stream-end`.

Special callbacks handle the VM draft workflow: when `create_vm_draft` or `create_vm_copy_draft` tools fire, the draft form object is sent to the renderer via `chat:vm-draft` or `chat:vm-copy-draft` events, where the user can review and confirm before the actual deployment IPC call.

---

## 8. Data Persistence

| Data | Format | Location |
|---|---|---|
| VCD session (token + credentials) | `safeStorage`-encrypted JSON | `<userData>/vcd-session.json` |
| Saved SSH terminal sessions | Plain JSON | `<userData>/saved-terminals.json` |
| API call log | Append-only JSONL | `<userData>/api-calls.log` |
| Document store | SQLite via `better-sqlite3` | `<userData>/docs.db` (inferred) |
| Disabled tools list | `localStorage` | Renderer local storage |
| Theme preference | `localStorage` | Renderer local storage |
| In-memory state | JS heap | Cleared on app restart |

---

## 9. Build & Distribution

| Phase | Tool | Output |
|---|---|---|
| TypeScript compile (main) | `tsc -p tsconfig.electron.json` | `dist-electron/` |
| Renderer build | `vite build` | `dist/` |
| Package | `electron-builder` | `release/VCD-Agent-<version>.exe` |
| Native rebuild | `electron-rebuild -f -w better-sqlite3` | Rebuilds SQLite for Electron ABI |

Dev mode uses `concurrently` to run Vite dev server (`localhost:5173`) and Electron in parallel, with `wait-on` ensuring Electron waits for Vite to be ready.

---

## 10. Security Considerations

| Concern | Mitigation |
|---|---|
| Renderer sandbox | `contextIsolation: true`, `nodeIntegration: false` enforced |
| IPC surface | All renderer calls go through typed `contextBridge` whitelist |
| VCD credentials | Encrypted at rest via `electron.safeStorage` (OS keychain-backed) |
| TLS verification | Configurable per-session; defaults to `false` for enterprise self-signed certs |
| Token redaction | `apiLogger` scrubs `authorization`, `token`, `cookie`, `password` headers |
| Tool approval | Risk-based human-in-the-loop gate before destructive operations |
| SSH secrets | Not logged; passed in-memory via IPC only |
| AV compatibility | Terminal/SFTP PTY disabled to avoid antivirus quarantine of process spawning |

---

## 11. Key Dependencies

| Package | Purpose |
|---|---|
| `electron` v40 | Desktop application host |
| `@github/copilot-language-server` | GitHub Copilot auth and token vending |
| `@langchain/openai` + `@langchain/langgraph` | AI tool-calling loop |
| `@langchain/core` | Message types, tool primitives |
| `zod` | Tool argument schema validation |
| `react` v19 | Renderer UI framework |
| `@ux-aspects-universal/react` | HPE UX Aspects design system components |
| `@monaco-editor/react` | Code editor |
| `better-sqlite3` | Document storage database |
| `ssh2` | SSH client for remote VM operations |
| `fast-xml-parser` | VCD XML response parsing |
| `react-markdown` + `remark-gfm` | Chat response rendering |
| `pdf-parse` + `mammoth` | Document ingestion (PDF, DOCX) |
| `vite` | Renderer build toolchain |
| `electron-builder` | App packaging and distribution |



