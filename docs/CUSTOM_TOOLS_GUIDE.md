# Custom Tools Guide

Tools are functions the **LLM can call autonomously** during a chat response, and also functions you can call directly from the Angular renderer. This guide explains both paths end-to-end.

---

## How tools work

When the LLM decides to use a tool it emits a JSON tool-call chunk. `copilotChatApi.ts` intercepts it and calls `toolRegistry.call(toolName, ...args)`. The result is returned to the LLM so it can continue the response. The debug panel shows every tool call and result in real time.

```
LLM response stream
  └─ tool call chunk detected (copilotChatApi.ts)
       └─ toolRegistry.call(name, ...args)  (registry.ts)
            └─ your handler function         (your file.ts)
                 └─ result emitted via IPC → renderer debug panel
```

For **renderer-initiated** calls (e.g., a button click):

```
Angular component
  └─ CopilotService.invokeTool(name, args)
       └─ window.copilot.callTool(name, ...args)   (preload bridge)
            └─ ipcMain 'tools:call'  (ipcHandlers.ts)
                 └─ toolRegistry.call(name, ...args)
                      └─ your handler
```

---

## Step 1 — Create your tool file

Create `src/main/tools/mytools.ts`. Each exported function is one tool. Return plain JSON-serializable objects.

```ts
// src/main/tools/mytools.ts

/** Reverse a string */
export function stringReverse(input: string): { result: string } {
  return { result: input.split('').reverse().join('') };
}

/** Word count for text */
export function stringWordCount(text: string): { words: number; chars: number } {
  return {
    words: text.trim().split(/\s+/).filter(Boolean).length,
    chars: text.length,
  };
}

/** Fetch and return plain text from a URL (main process has Node access) */
export async function webFetch(url: string): Promise<{ body: string; status: number }> {
  const https = await import('https');
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ body: data, status: res.statusCode ?? 0 }));
    }).on('error', reject);
  });
}
```

Rules:
- Functions **must** return `{ ... }` objects (not primitives) so the LLM gets structured output
- Validate/guard edge cases inside the function and return `{ error: '...' }` rather than throwing for expected failures
- Async is fine — the registry always awaits the result

---

## Step 2 — Register in the registry

Open `src/main/tools/registry.ts`, import your file, and add `toolRegistry.register(...)` calls inside `initializeDefaultTools()`.

```ts
// registry.ts — add import at the top
import * as myTools from './mytools';

// inside initializeDefaultTools()
toolRegistry.register('custom:stringReverse',  myTools.stringReverse,  'strings', 'Reverse a string');
toolRegistry.register('custom:stringWordCount', myTools.stringWordCount, 'strings', 'Count words and characters');
toolRegistry.register('custom:webFetch',        myTools.webFetch,        'web',     'Fetch URL contents');
```

`register(name, handler, category, description)`

| Param | Convention |
|---|---|
| `name` | Always prefix `custom:` + camelCase topic |
| `handler` | Direct function reference — no wrapper needed |
| `category` | Short group label (`math`, `strings`, `files`, `web`, …) |
| `description` | One line shown in the debug panel and tool listings |

---

## Step 3 — Expose via IPC (already done for you)

The generic `tools:call` and `tools:list` IPC channels in `ipcHandlers.ts` route all tool calls through the registry automatically — **you do not need to add new IPC handlers** for tools:

```ts
// ipcHandlers.ts — already present, no changes needed
ipcMain.handle('tools:call', async (_event, toolName, ...args) => {
  return toolRegistry.call(toolName, ...args);
});
ipcMain.handle('tools:list', async () => toolRegistry.list());
```

The preload bridge (`src/preload/preload.ts`) already exposes `window.copilot.callTool` and `window.copilot.toolsList` — also no changes needed.

---

## Step 4 — Call from the renderer (optional)

Use `CopilotService` from any Angular component:

```ts
// In a component or service
constructor(private copilot: CopilotService) {}

async reverseWord(word: string) {
  // invokeTool accepts either positional array or named object
  const result = await this.copilot.invokeTool('custom:stringReverse', [word]);
  console.log(result.result); // reversed string
}

async countWords(text: string) {
  const { words, chars } = await this.copilot.invokeTool('custom:stringWordCount', [text]);
}
```

Or call `getAvailableTools()` to list all registered tools dynamically:

```ts
const tools = await this.copilot.getAvailableTools();
// [{ name: 'custom:stringReverse', category: 'strings', description: '...' }, ...]
```

---

## Step 5 — Let the LLM use the tool

The LLM discovers tools via the registered name and description. In `copilotChatApi.ts`, the registered tools are passed to the Copilot API as the `tools` array. The LLM will call `custom:stringReverse` when the user asks to reverse something, automatically.

You can also prompt it explicitly: *"Use the stringReverse tool to reverse 'hello'"*. The debug panel will show the call and result.

---

## File checklist for a new tool file

```
1. src/main/tools/mytools.ts          ← create, export functions
2. src/main/tools/registry.ts         ← import + register in initializeDefaultTools()
```

That's all that's required. IPC, preload, and service wiring already exist.

---

## Naming conventions

| Item | Pattern | Example |
|---|---|---|
| Tool name | `custom:categoryVerb` | `custom:stringReverse` |
| File | category noun | `strings.ts` |
| Function | camelCase verb+noun | `stringReverse` |
| Category | one lowercase word | `strings` |

---

## Verification

```bash
npm run dev
```

1. Open the app and check the debug panel — registered tools appear in the tool list
2. Send a message asking the LLM to use your tool; watch the debug panel for the call + result
3. Call it from a component button to verify the renderer path
4. `npm run build` — confirm zero TypeScript errors
