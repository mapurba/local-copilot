# GitHub Copilot API Integration — One-Pager

> **Audience:** Engineers and stakeholders who want to understand how this Electron app uses the GitHub Copilot API instead of OpenAI directly, how authentication works, and how LangChain fits into the picture.

---

## What This App Does

**Local Copilot** is a desktop (Electron) app that lets users chat with an AI assistant to manage VMware Cloud Director (VCD) resources — listing VMs, starting/stopping them, resizing, deploying from templates, etc.

The AI backend is **GitHub Copilot** (not a raw OpenAI API key). This means users need an active GitHub Copilot subscription; no separate API key is required.

---

## Why GitHub Copilot API, Not OpenAI Directly?

| | OpenAI API | GitHub Copilot API |
|---|---|---|
| **Auth** | Static API key (paid per token) | GitHub OAuth → short-lived Copilot JWT |
| **Cost model** | Billed to the API key holder | Covered by the user's existing GitHub Copilot subscription |
| **Base URL** | `https://api.openai.com` | `https://api.githubcopilot.com` |
| **Models** | OpenAI-only (GPT-4, etc.) | OpenAI + Anthropic (Claude 3.5 Sonnet), etc. |
| **Who signs in** | Nobody — key is embedded | The end user authenticates with their GitHub account |
| **Token lifetime** | Permanent (until revoked) | ~29 minutes, then automatically refreshed |

In short: the user's GitHub Copilot subscription is the "API key". The app never stores a static secret.

---

## How the Token Is Obtained

Token acquisition is a **two-step process** handled by `src/main/tokenManager.ts`:

```
┌─────────────────────────────────────────────────────────────────┐
│  Step 1 – Read the GitHub OAuth token from disk                 │
│                                                                 │
│  When a user has GitHub Copilot installed (VS Code extension,   │
│  GitHub CLI, etc.), it writes an OAuth token to disk:           │
│                                                                 │
│  • macOS/Linux:  ~/.config/github-copilot/apps.json             │
│  •               ~/.github-copilot/apps.json (fallback)         │
│  • Windows:      %LOCALAPPDATA%\github-copilot\apps.json        │
│  • Legacy:       ~/.config/github-copilot/hosts.json            │
└─────────────────────────────────────────────────────────────────┘
                          │  oauth_token (~40 chars)
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 2 – Exchange OAuth token for a short-lived Copilot JWT    │
│                                                                 │
│  POST https://api.github.com/copilot_internal/v2/token          │
│  Authorization: token <oauth_token>                             │
│  Editor-Version: vscode/1.85.0                                  │
│  Copilot-Integration-Id: vscode-chat                            │
│                                                                 │
│  Response: { "token": "<JWT>", "expires_at": <unix_ts> }        │
│  The JWT is 200+ characters and valid for ~29 minutes.          │
│                                                                 │
│  Fallback endpoints tried in order:                             │
│    1. api.github.com/copilot_internal/v2/token   ✓ primary      │
│    2. api.githubcopilot.com/token                               │
│    3. api.githubcopilot.com/v2/token                            │
└─────────────────────────────────────────────────────────────────┘
                          │  Copilot JWT
                          ▼
                   Used for all chat API calls
```

### Token Priority (`getBestToken`)

1. **In-memory cache** — reuse the JWT if it has not expired yet
2. **Disk read + exchange** — re-read `apps.json` and exchange for a fresh JWT
3. **LSP checkStatus** — ask the `@github/copilot-language-server` (running as a child process) to verify auth, then retry disk read

If the user has never signed in, a GitHub Device Flow sign-in is triggered via the LSP (`signInInitiate` / `signInConfirm`).

---

## How LangChain Is Used

The app uses **LangChain** (`@langchain/openai` + `@langchain/core`) to:

1. **Wrap the Copilot API behind the standard `ChatOpenAI` interface** — pointing `baseURL` at `https://api.githubcopilot.com` instead of OpenAI.
2. **Define typed tools** using `lcTool()` + Zod schemas so the model can call VCD operations.
3. **Run a streaming agentic loop** that iterates until the model stops requesting tool calls.

### LLM Setup (`copilotChatApi.ts`)

```typescript
// LangChain's ChatOpenAI accepts a custom baseURL — this is the key
// to swapping OpenAI for the Copilot API with zero other changes.
const llm = new ChatOpenAI({
  model: modelId,          // e.g. "gpt-4o", "claude-3.5-sonnet"
  apiKey: copilotJWT,      // the short-lived Copilot JWT, not an OpenAI key
  baseURL: 'https://api.githubcopilot.com',
  defaultHeaders: {
    'Editor-Version':         'vscode/1.85.0',
    'Editor-Plugin-Version':  'copilot-chat/0.12.0',
    'Copilot-Integration-Id': 'vscode-chat',
    'User-Agent':             'GitHubCopilot/1.1.0',
    'X-GitHub-Api-Version':   '2023-07-07',
    'OpenAI-Intent':          'conversation-panel',
  },
  temperature: 0,
  streaming: true,
});
```

> **Why `@langchain/openai` works here:** The GitHub Copilot chat API is OpenAI-compatible (same `/chat/completions` wire format). LangChain just needs to know the different `baseURL` and auth header.

### Tools Defined

Eleven tools are registered with Zod input schemas:

| Tool | What it does |
|---|---|
| `set_vcd_context` | Override VCD host / token / org settings |
| `list_vms` | List all VMs |
| `list_running_vms` | Filter to running VMs only |
| `list_stopped_vms` | Filter to stopped VMs only |
| `list_templates` | List available VM templates |
| `check_vm_status` | Get the current power state of a VM |
| `start_vm` | Power on a VM |
| `stop_vm` | Power off a VM |
| `resize_vm` | Change CPU / memory of a VM |
| `create_vm_draft` | Prepare a VM creation form for user review |
| `list_tasks` | List recent VCD tasks |

### Agentic Loop

```
User message
    │
    ▼
llm.bindTools(LC_TOOLS).stream(messages)
    │
    ├─ text chunks ──────────────► stream to UI in real time
    │
    └─ tool_call_chunks
           │
           ▼ (after stream ends)
     execute tools against VCD API
           │
           ▼
     append ToolMessage to conversation
           │
           ▼ (loop back, max 10 iterations)
     llm.stream(updated messages)
           │
    no more tool calls
           │
           ▼
        onEnd()
```

---

## End-to-End Request Flow

```
[User types a message in the UI]
           │  IPC (Electron contextBridge)
           ▼
[ipcHandlers.ts]  →  chatWithTools()
           │
           ▼
[tokenManager.getBestToken()]
  read apps.json → exchange for Copilot JWT
           │  JWT
           ▼
[LangChain ChatOpenAI]
  POST https://api.githubcopilot.com/chat/completions
  Authorization: Bearer <JWT>
  (streaming response)
           │  tool_call or text
           ▼
[Tool execution against VCD REST API]
           │  result
           ▼
[LangChain loops again if more tool calls needed]
           │  final text
           ▼
[UI streams the assistant reply]
```

---

## Key Files

| File | Purpose |
|---|---|
| `src/main/tokenManager.ts` | OAuth → Copilot JWT exchange, in-memory caching, disk read |
| `src/main/lspClient.ts` | Wraps `@github/copilot-language-server` for sign-in and auth checks |
| `src/main/copilotChatApi.ts` | LangChain setup, tool definitions, streaming agent loop |
| `src/main/vcdApi.ts` | VCD REST API calls (called by LangChain tools) |
| `src/main/ipcHandlers.ts` | Electron IPC bridge between renderer (React UI) and main process |

---

## Summary

- **No OpenAI key needed.** The user's GitHub Copilot subscription is the credential.
- **Token flow:** `apps.json` (written by VS Code / GitHub CLI) → OAuth token → exchange with GitHub API → short-lived Copilot JWT.
- **LangChain acts as the glue:** `ChatOpenAI` with `baseURL` pointing at `api.githubcopilot.com` gives us streaming, tool-calling, and multi-turn conversation management without writing a custom HTTP client.
- **The Copilot API is OpenAI-compatible** on the wire, so switching back to direct OpenAI would only require changing `baseURL` and `apiKey`.
