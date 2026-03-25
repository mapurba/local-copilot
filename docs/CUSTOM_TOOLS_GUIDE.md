# Custom Tools Guide 

This guide shows how to add a new tool end-to-end in this app.

## Overview

Tools in this project are organized in a dedicated folder with a clean registry system:

```text
src/main/tools/
  ├── index.ts          # Main export point
  ├── registry.ts       # Tool registry (simplified & elegant)
  ├── math.ts           # Math tools (add, subtract, quadratic, etc.)
  └── [future]/ string/, file/, etc.
```

Tool calls flow:

1. **UI component** → calls `CopilotService.mathSolveLineEquation(5, 5, 20)`
2. **Service** → calls `window.copilot.mathSolveLineEquation(5, 5, 20)`
3. **Preload** → maps to `ipcRenderer.invoke('custom:mathSolveLineEquation', 5, 5, 20)`
4. **Main process** → dispatches to `toolRegistry.call('custom:mathSolveLineEquation', 5, 5, 20)`
5. **Tool handler** → returns `{ x: 3 }`

## Worked Example: Line Equation Solver

This app includes a real working tool: **Solve Line Equations** (`ax + b = c`).

### What It Does

Solves equations like:
- `5x + 5 = 20` → `x = 3`
- `2x + 10 = 30` → `x = 10`  
- Handles edge cases: no solution, infinite solutions

### Try It Now

From any Angular component:

```ts
constructor(private copilot: CopilotService) {}

async solveEquation() {
  // Solve: 5x + 5 = 20
  const result = await this.copilot.mathSolveLineEquation(5, 5, 20);
  if (result.error) {
    console.log('Error:', result.error);
  } else {
    console.log('x =', result.x); // 3
  }
}
```

### How It Was Built

#### 1. Tool Logic (Main Process)

```ts
async getProjectSummary(options: { includeFiles?: boolean }): Promise<{ summary: string; fileCount: number }> {
  if (!this.api?.projectSummary) {
    throw new Error('Project summary API is not available');
  }
  return this.api.projectSummary(options);
}
```

Why this layer helps:

1. Keeps UI components simple.
2. Centralizes API errors and fallback logic.
3. Makes future refactors easier.

## 6. Use It in a Component

In your component:

1. Inject `CopilotService`.
2. Call service method on user action.
3. Show loading, success, and error states.

```ts
isLoading = false;
summary = '';
error = '';

async loadSummary() {
  this.isLoading = true;
  this.error = '';
  try {
    const result = await this.copilot.getProjectSummary({ includeFiles: true });
    this.summary = result.summary;
  } catch (e) {
    this.error = e instanceof Error ? e.message : 'Failed to load summary';
  } finally {
    this.isLoading = false;
  }
}
```

## 7. Add Streaming Tools (Optional)

Use the same pattern as chat when tool output is large:

1. Main sends chunks with `mainWindow.webContents.send(...)`.
2. Preload exposes `onXxxStream`, `onXxxEnd`, `onXxxError` listeners.
3. Service aggregates chunks into final output.
4. Component renders progressive updates.

Reference stream events in [src/main/ipcHandlers.ts](../src/main/ipcHandlers.ts):

- `chat:stream-chunk`
- `chat:stream-end`
- `chat:stream-error`

## 8. How to Design Custom Implementations

When the feature is not obvious, use this framework:

1. Start from user intent, not from API shape.
2. Build the smallest useful version first.
3. Add one extension point at a time.
4. Keep transport contract stable; evolve internals freely.

A practical sequence:

1. V1 returns static/mock data.
2. V2 wires real data source.
3. V3 adds validation + retry + timeout.
4. V4 adds observability (logging, timing, metrics).

## 9. Interaction with Code (Safe Pattern)

If your tool needs to inspect or modify project code:

1. Do code scanning in main process only.
2. Never expose raw filesystem power to renderer directly.
3. Add narrowly scoped preload methods.
4. Return concise structured results to UI.

Good example method names:

- `custom:listProjectFiles`
- `custom:searchInProject`
- `custom:generatePatchPreview`

Avoid broad methods like:

- `custom:runAnyCommand`
- `custom:readAnyPath`

## 10. Manual Test Checklist

After adding a tool:

1. Start app with `npm run dev`.
2. Trigger the feature from UI.
3. Confirm success path response.
4. Confirm error path behavior (bad input or no auth).
5. Confirm no renderer crash when API is unavailable.
6. Run `npm run build`.

## 11. Naming and Conventions

Use these conventions for consistency:

1. IPC channel: `custom:<featureName>`
2. Preload method: camelCase (`projectSummary`)
3. Service method: verb-based (`getProjectSummary`, `runProjectSummary`)
4. Result objects: include explicit fields, avoid ambiguous strings

## 12. Common Mistakes

1. Adding handler in main but forgetting preload exposure.
2. Adding preload method but forgetting service wrapper.
3. Returning non-serializable objects over IPC.
4. Skipping error handling in component state.
5. Using unclear channel names.

## 13. Quick Template

Copy this sequence each time:

1. Main: add `ipcMain.handle('custom:feature', ...)`.
2. Preload: add `feature(...) => ipcRenderer.invoke('custom:feature', ...)`.
3. Service: add typed wrapper `runFeature(...)`.
4. Component: call wrapper and render states.
5. Build: run `npm run build`.

This keeps custom tool development predictable and easy for new contributors.
