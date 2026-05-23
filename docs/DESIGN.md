# VCD Agent — Design Document

**Version:** 0.0.7  
**Date:** May 2026

---

## 1. Product Overview

### 1.1 Purpose

VCD Agent is a desktop AI assistant for VMware Cloud Director administrators. It removes the need to navigate the VCD web portal for common day-to-day operations by letting operators type natural language requests — "Create a new SLES 15 SP6 VM called testbox01, set up ILM 1.3, and use a custom .env" — and having the AI execute the task step-by-step while showing progress in real time.

### 1.2 Target Users

- VCD tenant admins managing identit and ILM/IDM product VMs
- DevOps engineers performing repetitive VM lifecycle tasks
- Support engineers who need to SSH into VMs, run diagnostics, and read logs

### 1.3 Core Value Propositions

1. **Natural language → VCD actions** without portal navigation
2. **Review-before-execute** safety model for VM creation and destructive actions
3. **Background task tracking** — start a VM boot watch and continue chatting
4. **Document-augmented operations** — upload an ILM runbook and the AI follows it
5. **Persistent SSH sessions** — saved named sessions for quick reconnect

---

## 2. System Design

### 2.1 Conceptual Model

```
User → Chat Input
         │
         ▼
    AI Model (GitHub Copilot)
         │  reasons about request
         ▼
    Tool Calls (read data / execute actions)
         │  requires approval if risk ≥ review
         ▼
    Approval Gate ──── User approves/denies
         │
         ▼
    Tool Execution (VCD API / SSH / Docs / Local)
         │
         ▼
    Result → fed back to AI → final response → rendered to user
```

The model never holds credentials or makes network calls itself. All I/O is channelled through the typed tool system in the main process, which enforces approval policies.

### 2.2 AI Integration Design

#### Model

The application uses `ChatOpenAI` from `@langchain/openai` routed to `api.githubcopilot.com`. The GitHub Copilot subscription provides model access; available models are fetched at runtime and presented in the model selector.

#### Authentication to Copilot

Copilot authentication uses the Language Server Protocol (LSP) device-flow:
1. The `@github/copilot-language-server` binary (bundled as an npm package) is spawned as a child process.
2. The LSP `signIn` flow directs the user to github.com/login/device to enter a one-time code.
3. After confirmation, the LSP emits a token notification; `TokenManager` captures and caches it with a 29-minute TTL.
4. On expiry or OAuth-style tokens, `TokenManager` exchanges via `/copilot_internal/v2/token` against `api.githubcopilot.com` or `githubcopilot.com`.

#### System Prompt Design

A detailed 60-line system prompt (`TOOL_SYSTEM_PROMPT`) instructs the model to:
- Always use tools for data lookups rather than hallucinating answers
- Follow a deterministic VM creation workflow (list templates → draft → confirm)
- Follow SSH session conventions (connect first, then command, then disconnect)
- Use `task_start` / `task_log_step` / `task_done` wrapping for multi-step ops
- Call `vm_watch` proactively for background monitoring requests
- Format list results as markdown tables, never raw JSON

#### Tool Binding

All registered tools that are not disabled by the user are bound via `chatModel.bindTools(lcTools)`. Disabled tools are excluded from the list sent to the model, preventing it from even attempting to call them.

#### Streaming

Responses are streamed chunk by chunk. Text deltas are emitted as `chat:stream-chunk` IPC events. Tool-call chunks are buffered, executed when complete, and the result is re-injected as a `ToolMessage`. This allows the UI to show live typing while tool calls happen transparently.

---

## 3. VM Management Design

### 3.1 VM Lifecycle Operations

| Operation | Path | Notes |
|---|---|---|
| List VMs | `vcd:listVms` IPC → `vcdApi.listVms()` | Also available as AI tool `list_vms` |
| Create VM | AI → `create_vm_draft` → UI form → `vcd:deployVm` IPC | Two-step: draft + confirm |
| Clone VM | AI → `create_vm_copy_draft` → UI form → `vcd:createVmCopy` IPC | Target vApp required |
| Power on/off | Direct IPC or AI tool | Immediate, no draft step |
| Delete VM | IPC with confirm dialog or AI tool (dangerous risk) | Requires explicit approval |
| Resize | AI → `resize_vm` tool → VCD API | CPU and memory in one call |
| Snapshot | Direct UI button or AI tool | Named snapshot; memory optional |
| Revert | Direct UI button or AI tool (dangerous) | Reverts to latest snapshot |

### 3.2 VM Creation Workflow (Detail)

```
User: "Create SLES 15 SP6 VM called myvm01, setup ILM 1.3"
         │
         ▼
AI: list_templates(name_filter="sles")
         │
         ▼
AI: create_vm_draft(vm_name="myvm01", template_id=<uuid>, setup_ilm=true, ilm_version="1.3.0")
         │
         ▼
IPC event: chat:vm-draft → CreateVmForm shown to user
User reviews: name, network, IP mode, storage profile, ILM version, custom .env toggle
         │
User clicks "Deploy"
         │
         ▼
IPC: vcd:deployVm(form) → Main process:
    1. vcdApi.createVmFromTemplate() — POST to VCD
    2. If setup_ilm: SSH into VM → run ILM_SETUP_SCRIPT
    3. If setup_idm: SSH into VM → run IDM_SETUP_SCRIPT
    4. Run FINALIZATION_SCRIPT
         │
         ▼
Result streamed back to chat
```

### 3.3 VCD Context

All VCD API calls read configuration from a single in-memory `VcdContext` singleton (`vcdStore.ts`):

```typescript
interface VcdContext {
  host: string;         // VCD hostname
  token: string;        // Bearer JWT
  apiVersion: string;   // "38.0"
  orgName?: string;     // Tenant org
  orgUuid?: string;
  vdcId?: string;       // Virtual Data Center ID
  networkName?: string; // Default network
  gateway?: string;
  dnsServers?: string[];
  storageProfileId?: string;
  computePolicyId?: string;
  rejectUnauthorized?: boolean;
}
```

Org-specific defaults (VDC ID, storage/compute policy, org UUID) are pre-mapped in `vcdConfig.ts` for the three known org tenants and automatically applied on login.

---

## 4. Tool System Design

### 4.1 Goals

- **Extensibility**: New tools added by dropping a file in a category folder and registering
- **Safety**: Risk classification drives approval gating; no destructive action executes without consent
- **Transparency**: Every pending tool call is visible to the user before execution
- **Auditability**: All tool invocations are logged via `apiLogger`

### 4.2 Tool Registration

Tools are registered at startup via `initializeDefaultTools()` which imports all category modules:

```typescript
toolRegistry.register('list_vms', listVmsHandler, {
  category: 'vcd',
  description: 'List VMs in the current tenant.',
  target: 'remote',
  riskLevel: 'safe',
});
```

### 4.3 Approval Flow

```
Tool call arrives from LangChain
         │
         ▼
approvalSystem.requiresApproval(toolName, riskLevel, sessionId)
         │
    ┌────┴────────────────────────────┐
   safe                          review / dangerous
    │                                │
auto-execute              requestApproval()
                                     │
                          IPC: tools:approval-request
                                     │
                          ToolApprovalModal rendered
                                     │
                    ┌────────────────┼────────────────┐
                 once             session           always
                    │                │                │
             execute once    add to session     add to preferences
                             approvals set      map (persist)
```

The approval modal shows: tool name, category, risk level, description, target (local/remote), impact assessment, and the full argument object — giving the user complete context before clicking Approve or Deny.

### 4.4 Document Tools

The `docs` category provides a lightweight RAG pipeline:
- **Ingestion**: PDF (`pdf-parse`) and DOCX (`mammoth`) files are parsed into text, chunked, and stored in SQLite
- **Search**: `docs_search` does text search across stored chunks
- **Ask**: `docs_ask` uses the model to answer a question using retrieved chunks as context
- **List**: `docs_list` returns all uploaded document metadata

---

## 5. SSH & Remote Execution Design

### 5.1 SSH Tool Flow

```
User: "Connect to 10.71.39.10 as root and check disk space"
         │
         ▼
AI: ssh_connect(host="10.71.39.10", username="root", password="...")
    ← requires approval (review)
         │
         ▼
AI: ssh_runCommand(sessionId=<id>, command="df -h")
    ← requires approval (review)
         │
         ▼
AI: reports output, then ssh_disconnect(sessionId=<id>)
```

SSH sessions are managed via the `ssh2` library. Each active session is tracked by a UUID session ID. The `ssh_runSudoCommand` variant is classified `dangerous` and always requires approval.

### 5.2 Background VM Watcher

`vmWatcher.ts` implements a durable background monitor:

1. `vm_watch` tool called by AI with vm_name, IP, credentials, and post-boot commands
2. `setInterval` at configurable poll rate (default 30 s, max 60 min timeout)
3. Each tick checks `vmWatcherActions.isVmPoweredOn()` via VCD API
4. Once powered on, attempts SSH; retries on transient errors with exponential backoff
5. On success: runs commands, logs output to `taskTracker`, sends `chat:watch-notification` to renderer
6. Cancellable at any time via `vm_watch_cancel(taskId)`

This design allows the user to dispatch a watch, close the chat pane, and receive a notification toast when the VM is ready.

---

## 6. Task Tracker Design

Long-running multi-step operations (installs, configurations) use a structured task model:

```
Task {
  id, name, status: running | completed | failed | cancelled
  sshSessionId
  steps: TaskStep[]
}

TaskStep {
  id, description, command?
  status: pending | running | done | failed | skipped
  output: string (truncated to 1200 chars for UI/LLM)
  logId: string → full output in LRU log store (5 MB budget)
  exitCode?: number
}
```

The AI follows the pattern:
1. `task_start` → creates a Task, stores the SSH session
2. `task_log_step` after each command → updates step status, emits `task:updated` IPC
3. `task_get_log(logId)` if it needs to read full output from a step
4. `task_done` → marks task complete or failed

The `TaskStatusPanel` in the renderer subscribes to `task:updated` and renders a live step tree with status indicators.

---

## 7. Session Persistence Design

### 7.1 VCD Session

VCD tokens are short-lived JWTs. The session file stores:
- Encrypted bearer token (for in-session use)
- Encrypted password (for auto-reauth on 401)
- Connection metadata (host, org, VDC, network defaults)

Encryption uses `electron.safeStorage` which delegates to the OS keychain (DPAPI on Windows, Keychain on macOS, libsecret on Linux). If encryption is unavailable, data is stored as plain JSON (flagged in the file).

### 7.2 SSH Terminal Sessions

Saved terminal sessions store connection metadata in a plain JSON file. Passwords are stored in plaintext — this is a known limitation and is acceptable for the internal enterprise deployment context.

---

## 8. Update Mechanism Design

The auto-updater is a custom implementation (not electron-updater):

1. On startup (3-second delay) and on user trigger, fetch `https://164.99.91.32/vcd-agent/latest.json`
2. Compare `latest.version` against `app.getVersion()` using semver comparison
3. If newer: show native dialog with release notes
4. On approval: download `.exe` to OS temp dir, stream `update-download-progress` events
5. Spawn installer with `detached: true` and call `app.quit()`
6. On decline: emit `update-cancelled` to hide progress toast

---

## 9. Logging Design

`apiLogger.ts` provides a structured audit trail for all outbound network calls:

- **Format**: Append-only JSONL, one entry per line
- **Location**: `<userData>/api-calls.log`
- **Fields**: timestamp, source module, stage (request/response/error), method, URL, status code, duration, redacted headers, truncated body (1500 chars)
- **Security**: Authorization, token, cookie, and password headers are automatically replaced with `***redacted***`
- **Non-blocking**: All writes are fire-and-forget `fs.appendFile` promises; failures are logged to console only (no recursive failure loops)

---

## 10. UI/UX Design Principles

### 10.1 Layout

The application uses a three-zone layout:
- **Left sidebar**: Navigation tabs (Chat, VMs, Tasks, Terminal, Files, Docs) plus auth status indicators
- **Main content area**: Active panel (chat, VM list, task panel, etc.)
- **Modal overlays**: Auth, VCD login, tool approval, VM deploy confirmation

Panels are resizable via `ResizablePanels` drag handles.

### 10.2 Theme

Light/dark theme toggle, persisted to `localStorage`. UI components from the HPE UX Aspects Universal design system (`@ux-aspects-universal/react`) plus Tailwind CSS for custom layout.

### 10.3 Chat Design

- Conversation history maintained in component state as `Message[]` with `role`, `content`, `type`, and optional `attachments`
- Streaming responses append to the last assistant message in real time
- Tool calls rendered with a distinct visual style (`tool-call` type) separate from text
- VM draft forms (`CreateVmForm`) injected inline in the chat thread when AI produces a draft
- Attached documents shown as chips; content injected into the system message context
- Disabled tools configurable via a slide-out panel without leaving chat

### 10.4 Tool Approval UX

When a tool execution requires approval, the chat stream is paused and the `ToolApprovalModal` is displayed with:
- Tool name and category badge
- Risk level indicator (color-coded)
- Human-readable description and impact assessment
- Full argument dump (formatted JSON)
- Three response options: **Approve Once**, **Approve for Session**, **Always Approve**
- Deny option to cancel the operation

This gives operators full transparency and control while keeping the workflow non-disruptive for trusted repeated operations (session/always approve).

---

## 11. Error Handling Design

### 11.1 IPC Errors

All `ipcMain.handle` callbacks catch exceptions and return `{ success: false, error: string }` structures rather than letting rejections propagate to the renderer as unhandled.

### 11.2 VCD API Errors

- **401**: Triggers `attemptAutoReauth()` — re-POST with stored credentials, update token in context
- **401 after reauth failure**: Emits `vcd:session-expired` IPC → renderer shows `VcdAuthModal`
- **Timeout** (30 s default): `httpsRequest` destroys the socket and rejects with a descriptive error
- **TLS errors**: Suppressed globally (`NODE_TLS_REJECT_UNAUTHORIZED=0`) for enterprise self-signed cert environments

### 11.3 LangChain / Tool Errors

- Tool execution failures are caught, formatted as error strings, and returned as `ToolMessage` content so the AI can reason about the failure and attempt recovery or report back
- A global cancellation flag allows in-flight `chatWithTools()` calls to be aborted cleanly

### 11.4 LSP Errors

LSP initialization errors are caught per IPC call. If the LSP process is unresponsive, a 10-second `withTimeout` wrapper rejects cleanly and returns `{ status: 'NotAuthorized' }` to the renderer.

---

## 12. Known Limitations & Disabled Features

| Feature | Status | Reason |
|---|---|---|
| PTY Terminal (`terminalManager.ts`) | Disabled | Antivirus quarantine of `node-pty` / child process spawning |
| SFTP file browser (`sftpManager.ts`) | Disabled | Same antivirus concern as terminal |
| `create_vm_confirmed` tool | Commented out | Replaced by the two-step draft → `vcd:deployVm` IPC pattern |
| VCD token auto-reauth | Best-effort | Depends on credentials being stored in the encrypted session file |
| Linux/macOS packaging | Defined but untested | Primary deployment target is Windows |

---

## 13. Configuration Reference

### vcdConfig.ts Constants

| Constant | Value | Description |
|---|---|---|
| `VCD_HOST` | `ban-vcd.otxlab.net` | Default VCD hostname |
| `DEFAULT_ORG` | `ban2_identity_ilm` | Default tenant org |
| `API_VERSION` | `38.0` | VCD REST API version |
| `NETWORK_NAME` | `BAN2_Vlan90_lr0` | Default VM network |
| `GATEWAY` | `10.71.39.254` | Default gateway |
| `DNS_SERVERS` | `['15.122.222.53']` | Default DNS |
| `IP_ALLOCATION_MODE` | `DHCP` | Default IP mode |

### Org-to-Resource Maps

Three tenant organisations are pre-configured with their VDC IDs, org UUIDs, storage profile IDs, and compute policy IDs in `VDC_ID_MAP`, `ORG_UUID_MAP`, `STORAGE_PROFILE_ID_MAP`, and `COMPUTE_POLICY_ID_MAP`. Selecting an org at login automatically populates these defaults in `VcdContext`.
