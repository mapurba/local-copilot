# Mermaid Flow Editor — User Stories

## Context & Scope

This document covers the planning for an interactive Mermaid flow diagram editor integrated into the VCD Agent desktop application. The feature enables users to:

1. View AI-generated Mermaid deployment architecture diagrams directly in the chat interface
2. Open a full visual editor (Excalidraw-like) to modify the diagram
3. Define orchestration flow order (start node, step numbering, link directions)
4. Export the diagram as Mermaid syntax + a structured JSON describing the orchestration flow

### Current State

- **No mermaid library** is installed (`package.json` has no `mermaid` dependency)
- **ResponseRenderer** renders ` ```mermaid ` blocks as plain syntax-highlighted text — no SVG rendering
- **App layout** is a two-panel split (Sidebar + ChatPane) with no router; new views must be added as tabs, panels, or modals
- **Tech stack**: React 19, Electron 40, TypeScript, Tailwind CSS, Monaco Editor, Vite
- **Preload API** exposes IPC methods on `window.copilot`; new editor features will need new IPC channels for persistence

### Integration Points

| Area | Current Component | Integration Required |
|------|-------------------|----------------------|
| Chat rendering | `ResponseRenderer.tsx` | Detect `language-mermaid` code blocks → render as interactive SVG with "Edit" button |
| App layout | `App.tsx` / `ResizablePanels` | New tab or full-screen overlay for the visual editor workspace |
| Sidebar | `Sidebar.tsx` | Potentially a new "Diagrams" tab or entry point |
| Preload/IPC | `preload.ts` / `ipcHandlers.ts` | New channels for save/load/export diagram data |
| Backend store | (new) | Persist diagram state (mermaid source + JSON metadata) |

---

## Epic 1: Mermaid Diagram Rendering in Chat

> As a user, when the AI generates a Mermaid diagram in the chat, I want to see it rendered as a visual diagram instead of raw text.

### US-1.1: Install and configure Mermaid rendering library

**Priority**: P0 (blocker for all other stories)

**Description**: Add the `mermaid` npm package to the project and configure it for use within the React renderer process.

**Acceptance Criteria**:
- [ ] `mermaid` package is added to `package.json` dependencies
- [ ] Mermaid is initialized with a configuration that respects the app's light/dark theme
- [ ] Mermaid rendering works within the Electron renderer process (CSP-compatible)
- [ ] A reusable `MermaidRenderer` React component exists that accepts mermaid source and outputs an SVG

**Technical Notes**:
- Use `mermaid.render()` API for on-demand rendering (not auto-init)
- Must handle theme switching (dark/light) — re-render SVG when theme changes
- Component location: `src/renderer/components/mermaid-editor/MermaidRenderer.tsx`

---

### US-1.2: Detect and render Mermaid code blocks in chat messages

**Priority**: P0

**Description**: Modify `ResponseRenderer.tsx` to detect ` ```mermaid ` fenced code blocks and render them as interactive SVG diagrams instead of syntax-highlighted text.

**Acceptance Criteria**:
- [ ] When a chat message contains a ` ```mermaid ` code block, it is rendered as a visual SVG diagram
- [ ] The raw Mermaid source is accessible via a "View Source" toggle
- [ ] Invalid Mermaid syntax shows a graceful error message with the raw source as fallback
- [ ] Multiple Mermaid blocks in a single message each render independently
- [ ] Surrounding markdown content (before/after the mermaid block) renders normally

**Technical Notes**:
- In `ResponseRenderer.tsx`, the `code` component override currently handles `language-json` and falls through to `SyntaxHighlighter`. Add a `language-mermaid` branch that delegates to `<MermaidRenderer>`
- Mermaid rendering is async — need a loading state while SVG generates

---

### US-1.3: Add "Open in Editor" action to rendered Mermaid diagrams

**Priority**: P0

**Description**: Each rendered Mermaid diagram in the chat should have an action button that opens the diagram in the full visual editor workspace.

**Acceptance Criteria**:
- [ ] An "Edit Diagram" button/icon appears on hover over the rendered Mermaid diagram
- [ ] A "Copy Mermaid" button copies the raw source to clipboard
- [ ] Clicking "Edit Diagram" opens the visual Mermaid editor (Epic 3) pre-loaded with the diagram source
- [ ] The transition from chat view to editor view is smooth (no full page reload)

**Technical Notes**:
- State transfer: pass mermaid source string to the editor via React context or a shared store
- Editor could open as a new tab in the right panel area (alongside Chat tab) or as a full-screen overlay

---

## Epic 2: Mermaid Import Support

> As a user, I want to import existing Mermaid diagrams from text or files so I can visualize and edit them in the editor.

### US-2.1: Import Mermaid from text paste

**Priority**: P1

**Description**: Provide a text input area in the Mermaid editor where users can paste raw Mermaid syntax to load it into the visual editor.

**Acceptance Criteria**:
- [ ] The editor has an "Import" button/menu option
- [ ] Clicking "Import" opens a modal with a text area for pasting Mermaid syntax
- [ ] Pasted syntax is validated before import — errors shown inline
- [ ] On successful import, the visual editor renders the diagram and all nodes become editable
- [ ] Import replaces the current diagram (with confirmation if unsaved changes exist)

---

### US-2.2: Import Mermaid from file

**Priority**: P2

**Description**: Allow users to open a `.mmd` or `.md` file containing Mermaid syntax from disk.

**Acceptance Criteria**:
- [ ] "Import from File" option in the editor toolbar
- [ ] Opens a native Electron file dialog filtered to `.mmd`, `.md`, `.txt` files
- [ ] Extracts Mermaid content from the file (for `.md`, extracts from fenced mermaid blocks)
- [ ] Validates and loads the diagram into the visual editor

**Technical Notes**:
- Requires a new IPC channel: `dialog:openMermaidFile` → uses Electron's `dialog.showOpenDialog`
- File reading happens in the main process; content is sent to renderer via IPC

---

### US-2.3: Import Mermaid from chat history

**Priority**: P1

**Description**: Allow users to pick any previously generated Mermaid diagram from chat history and open it in the editor.

**Acceptance Criteria**:
- [ ] When chat contains one or more Mermaid diagrams, a "diagrams" indicator/counter appears
- [ ] User can browse/select from all Mermaid diagrams in the current chat session
- [ ] Selected diagram loads into the visual editor

---

## Epic 3: Visual Mermaid Editor Workspace

> As a user, I want an Excalidraw-like visual editor where I can see, drag, connect, and edit diagram nodes on a canvas.

### US-3.1: Create Mermaid Editor subfolder and component scaffold

**Priority**: P0 (blocker for all editor stories)

**Description**: Create a dedicated subfolder `src/renderer/components/mermaid-editor/` with the core component structure for the visual editor.

**Acceptance Criteria**:
- [ ] Folder structure created:
  ```
  src/renderer/components/mermaid-editor/
    MermaidEditor.tsx          — Main editor workspace component
    MermaidRenderer.tsx        — Read-only SVG renderer (from US-1.1)
    Canvas.tsx                 — Interactive canvas with pan/zoom
    NodeComponent.tsx          — Draggable node element
    EdgeComponent.tsx          — Connection line between nodes
    Toolbar.tsx                — Editor toolbar (add node, import, export, etc.)
    NodeEditModal.tsx          — Modal for editing node name/description
    FlowOrderPanel.tsx         — Panel for marking start node and flow numbering
    types.ts                   — TypeScript types for graph data model
    parser.ts                  — Mermaid text ↔ graph data model conversion
    exporters.ts               — Export to Mermaid + JSON
    useGraphState.ts           — Custom hook for graph state management
    useDragAndDrop.ts          — Custom hook for drag interactions
    useCanvasControls.ts       — Custom hook for pan/zoom controls
  ```
- [ ] Each component has a minimal stub implementation
- [ ] The main `MermaidEditor` component can be mounted in the app

**Technical Notes**:
- Consider using a canvas library for rendering: **React Flow** (`reactflow`) is the strongest candidate — it provides nodes, edges, drag-and-drop, zoom/pan, minimap, and custom node/edge types out of the box
- Alternative: SVG-based custom implementation using mermaid's parsed AST + drag handlers
- Recommendation: **Use React Flow** for the interactive canvas and **Mermaid** only for parsing import and generating export syntax

---

### US-3.2: Integrate editor workspace into app layout

**Priority**: P0

**Description**: Add the Mermaid editor as a new view in the application, accessible from the chat and sidebar.

**Acceptance Criteria**:
- [ ] A new "Editor" tab appears in the right panel tab bar (alongside "Chat") when a diagram is being edited
- [ ] Clicking the tab switches between Chat and Editor views without losing state in either
- [ ] The editor can also be opened full-screen (hiding sidebar) via a maximize button
- [ ] Closing the editor tab returns to chat view
- [ ] Unsaved changes trigger a confirmation dialog before closing

**Technical Notes**:
- Modify `App.tsx` to add tab state: `activeRightTab: 'chat' | 'editor'`
- Both `<ChatPane>` and `<MermaidEditor>` stay mounted (use CSS display toggle, not conditional rendering) to preserve state
- Pass diagram data via a shared context: `MermaidEditorContext`

---

### US-3.3: Parse Mermaid syntax into editable graph data model

**Priority**: P0

**Description**: Implement a parser that converts Mermaid flowchart syntax into a structured graph data model that the visual editor can manipulate.

**Acceptance Criteria**:
- [ ] Parser handles Mermaid `graph TD`, `graph LR`, `flowchart TD`, `flowchart LR` syntax
- [ ] Nodes are extracted with: `id`, `label`, `shape` (rectangle, rounded, diamond, etc.)
- [ ] Edges are extracted with: `sourceId`, `targetId`, `label`, `type` (arrow, dotted, thick)
- [ ] Subgraphs are extracted as group containers
- [ ] The parsed model is a TypeScript interface:
  ```typescript
  interface GraphModel {
    direction: 'TD' | 'LR' | 'TB' | 'RL';
    nodes: GraphNode[];
    edges: GraphEdge[];
    subgraphs: SubGraph[];
    flowOrder: FlowOrderConfig;
    metadata: DiagramMetadata;
  }
  
  interface GraphNode {
    id: string;
    label: string;
    description: string;
    shape: 'rect' | 'rounded' | 'diamond' | 'circle' | 'stadium' | 'subroutine' | 'hexagon';
    position: { x: number; y: number };
    size: { width: number; height: number };
    style?: Record<string, string>;
    data?: Record<string, unknown>;  // arbitrary metadata
  }
  
  interface GraphEdge {
    id: string;
    source: string;
    target: string;
    label?: string;
    type: 'arrow' | 'dotted' | 'thick' | 'invisible';
    animated?: boolean;
  }
  
  interface SubGraph {
    id: string;
    label: string;
    nodeIds: string[];
  }
  
  interface FlowOrderConfig {
    startNodeId: string | null;
    stepOrder: string[];  // ordered list of node IDs representing execution sequence
  }
  
  interface DiagramMetadata {
    title?: string;
    createdAt: string;
    modifiedAt: string;
    version: number;
  }
  ```
- [ ] Round-trip fidelity: parse → serialize → parse produces equivalent graph

**Technical Notes**:
- Use Mermaid's own parser (`mermaid.parse()`) to get the AST, then transform to our `GraphModel`
- Alternatively, use `mermaid`'s `mermaidAPI.getDiagramFromText()` for structured data
- Fallback: regex-based parser for simple flowcharts if Mermaid's internal parser API is unstable

---

### US-3.4: Render graph model on interactive canvas

**Priority**: P0

**Description**: Render the parsed `GraphModel` on an interactive canvas where nodes and edges are visually displayed.

**Acceptance Criteria**:
- [ ] Nodes render as styled boxes showing their label text
- [ ] Edges render as lines/arrows between connected nodes
- [ ] Edge labels are displayed on the connection lines
- [ ] Subgraphs render as labeled bounding boxes around their child nodes
- [ ] Canvas supports zoom in/out (scroll wheel + toolbar buttons)
- [ ] Canvas supports pan (click-drag on empty space)
- [ ] A minimap shows the overall diagram overview for large diagrams
- [ ] Auto-layout positions nodes intelligently when first loaded (using dagre or elkjs layout algorithm)

**Technical Notes**:
- If using React Flow: map `GraphNode` → React Flow `Node`, `GraphEdge` → React Flow `Edge`
- React Flow provides zoom, pan, minimap, and auto-layout (via `dagre` or `elkjs`) out of the box
- Custom node component should show label + step number badge (from FlowOrderConfig)

---

### US-3.5: Drag nodes to reposition on canvas

**Priority**: P0

**Description**: Users can click and drag nodes to reposition them on the canvas.

**Acceptance Criteria**:
- [ ] Click-and-drag on a node moves it to a new position
- [ ] Connected edges follow the node and re-route automatically
- [ ] Node positions are persisted in the graph model
- [ ] Multiple selection (Shift+click or drag-select) allows moving groups of nodes together
- [ ] Snap-to-grid option available in toolbar (toggle on/off)

---

### US-3.6: Add new nodes via toolbar or canvas

**Priority**: P1

**Description**: Users can add new nodes to the diagram.

**Acceptance Criteria**:
- [ ] Toolbar has an "Add Node" button that places a new node on the canvas
- [ ] New nodes are placed at the center of the current viewport
- [ ] Double-click on empty canvas space creates a new node at that position
- [ ] New nodes have a default label "New Node" and open the edit modal immediately
- [ ] User can choose the node shape from a dropdown (rectangle, diamond, rounded, etc.)

---

### US-3.7: Add connection edges between nodes

**Priority**: P1

**Description**: Users can draw connection lines between nodes to define relationships.

**Acceptance Criteria**:
- [ ] Each node has connection handle points (top, bottom, left, right)
- [ ] Click-and-drag from a handle to another node creates a new edge
- [ ] Edge type can be selected: solid arrow, dotted, thick
- [ ] Edge labels can be added by clicking on the edge
- [ ] Edges can be deleted by selecting and pressing Delete key
- [ ] Self-referencing edges (node to itself) are supported

---

### US-3.8: Delete nodes and edges

**Priority**: P1

**Description**: Users can remove nodes and edges from the diagram.

**Acceptance Criteria**:
- [ ] Select a node or edge and press Delete/Backspace to remove it
- [ ] Deleting a node also removes all connected edges
- [ ] Confirmation dialog for node deletion if the node has connections
- [ ] Undo support (Ctrl+Z) restores deleted elements
- [ ] Multi-select + delete works for batch removal

---

## Epic 4: Node Editing (Double-Click to Edit)

> As a user, I want to double-click a node to edit its name, description, and properties.

### US-4.1: Double-click node to open edit modal

**Priority**: P0

**Description**: Double-clicking a node opens a modal/panel where the user can edit the node's properties.

**Acceptance Criteria**:
- [ ] Double-click on a node opens the `NodeEditModal`
- [ ] Modal displays editable fields:
  - **Name/Label** (text input, required) — the display text on the node
  - **Description** (text area) — detailed description of what this step does
  - **Node ID** (read-only, auto-generated, shown for reference)
  - **Shape** (dropdown: rectangle, rounded, diamond, circle, stadium, etc.)
  - **Custom Data** (key-value pairs for arbitrary metadata)
- [ ] Changes are reflected on the canvas in real-time (live preview)
- [ ] "Save" confirms changes; "Cancel" reverts to previous state
- [ ] Pressing Escape closes the modal without saving

---

### US-4.2: Inline label editing

**Priority**: P2

**Description**: Allow quick label editing directly on the canvas without opening a modal.

**Acceptance Criteria**:
- [ ] Single-click on a node label text makes it editable inline (contenteditable or input overlay)
- [ ] Press Enter to confirm; press Escape to cancel
- [ ] Inline edit only changes the label; full edit modal is still available via double-click

---

### US-4.3: Edit edge labels

**Priority**: P2

**Description**: Allow editing labels on connection edges.

**Acceptance Criteria**:
- [ ] Double-click on an edge label opens an inline editor
- [ ] Edge label text appears on the connection line
- [ ] Empty label hides the label display on the edge

---

## Epic 5: Flow Ordering and Orchestration Sequencing

> As a user, I want to mark the start of the deployment flow and number the execution sequence so the orchestration engine knows the order.

### US-5.1: Mark start node

**Priority**: P0

**Description**: Allow the user to designate one node as the "start" of the orchestration flow.

**Acceptance Criteria**:
- [ ] Right-click context menu on a node includes "Set as Start Node"
- [ ] The start node has a distinct visual indicator (green border, play icon badge, or special shape)
- [ ] Only one node can be the start node at a time — setting a new start removes the old one
- [ ] The start node is persisted in `FlowOrderConfig.startNodeId`
- [ ] A toolbar button highlights the current start node on the canvas

---

### US-5.2: Define and display flow step order

**Priority**: P0

**Description**: Allow users to define the sequential order in which nodes are executed during orchestration.

**Acceptance Criteria**:
- [ ] Each node in the execution flow displays a numbered badge (1, 2, 3, ...) indicating its order
- [ ] The flow order panel (`FlowOrderPanel`) shows an ordered list of steps that can be reordered via drag-and-drop
- [ ] Nodes not in the flow order have no number badge (they are informational/non-executable)
- [ ] The flow order follows the directed edges by default (topological sort from start node)
- [ ] Users can manually override the auto-generated order
- [ ] Visual flow path: animated arrows or a highlighted path shows the execution sequence on the canvas

**Technical Notes**:
- Default ordering: BFS/DFS traversal from the start node following edge directions
- Manual override: drag-and-drop reorder in the FlowOrderPanel sidebar
- Store in `FlowOrderConfig.stepOrder: string[]`

---

### US-5.3: Flow validation

**Priority**: P1

**Description**: Validate the flow configuration for common issues before export.

**Acceptance Criteria**:
- [ ] Warning if no start node is set
- [ ] Warning if the flow has unreachable nodes (not connected to the start)
- [ ] Error if the flow has circular dependencies that would cause infinite loops
- [ ] Warning if a node in the step order has no edges
- [ ] Validation results shown in a panel or as inline indicators on affected nodes
- [ ] "Validate" button in toolbar runs all checks

---

## Epic 6: Export — Mermaid + JSON

> As a user, I want to export the diagram as Mermaid syntax and a structured JSON file that the orchestration engine can consume.

### US-6.1: Export as Mermaid syntax

**Priority**: P0

**Description**: Serialize the current graph model back to valid Mermaid flowchart syntax.

**Acceptance Criteria**:
- [ ] "Export Mermaid" generates valid Mermaid syntax from the current graph state
- [ ] Exported syntax includes nodes, edges, edge labels, and subgraphs
- [ ] Exported syntax respects the graph direction (TD/LR)
- [ ] Output can be copied to clipboard via a button
- [ ] Output can be saved as a `.mmd` file via Electron save dialog
- [ ] Re-importing the exported Mermaid produces an identical diagram (round-trip fidelity)

**Technical Notes**:
- Serializer in `exporters.ts`: iterate `GraphModel.nodes` → generate node declarations, iterate `GraphModel.edges` → generate edge declarations, wrap subgraphs
- Shape mapping: `rect` → `[label]`, `rounded` → `(label)`, `diamond` → `{label}`, etc.

---

### US-6.2: Export as orchestration JSON

**Priority**: P0

**Description**: Generate a structured JSON file containing the flow definition, node descriptions, and execution order for the orchestration engine.

**Acceptance Criteria**:
- [ ] "Export JSON" generates a JSON file with the following structure:
  ```json
  {
    "version": "1.0",
    "title": "Deployment Architecture",
    "direction": "TD",
    "startNode": "node_1",
    "flowOrder": [
      {
        "step": 1,
        "nodeId": "node_1",
        "label": "Prepare VM",
        "description": "Provision base VM with SLES 15 SP6",
        "dependsOn": []
      },
      {
        "step": 2,
        "nodeId": "node_2",
        "label": "Install Prerequisites",
        "description": "Install required packages and libraries",
        "dependsOn": ["node_1"]
      }
    ],
    "nodes": [
      {
        "id": "node_1",
        "label": "Prepare VM",
        "description": "Provision base VM with SLES 15 SP6",
        "shape": "rounded",
        "metadata": {}
      }
    ],
    "edges": [
      {
        "source": "node_1",
        "target": "node_2",
        "label": "on success"
      }
    ],
    "subgraphs": [
      {
        "id": "sg_1",
        "label": "VM Boundary - host1",
        "nodeIds": ["node_1", "node_2"]
      }
    ],
    "metadata": {
      "createdAt": "2026-05-23T10:00:00Z",
      "modifiedAt": "2026-05-23T12:30:00Z",
      "exportedFrom": "VCD Agent Mermaid Editor v1.0"
    }
  }
  ```
- [ ] Each node in `flowOrder` includes its `dependsOn` array derived from incoming edges
- [ ] JSON can be copied to clipboard or saved as a `.json` file
- [ ] JSON schema is documented for consumption by the orchestration engine

---

### US-6.3: Export as image (PNG/SVG)

**Priority**: P3 (nice-to-have)

**Description**: Allow exporting the current diagram as a static image for documentation.

**Acceptance Criteria**:
- [ ] "Export Image" option in toolbar with PNG and SVG sub-options
- [ ] Exported image includes the full diagram at high resolution
- [ ] SVG export preserves vector quality

---

## Epic 7: Persistence and State Management

> As a user, I want my diagram edits to be saved and restored across sessions.

### US-7.1: Auto-save diagram state

**Priority**: P1

**Description**: Automatically save the current diagram state so it persists across editor/tab switches and app restarts.

**Acceptance Criteria**:
- [ ] Diagram state is auto-saved to local storage or SQLite (existing `better-sqlite3`) on every change (debounced, ~1s delay)
- [ ] Reopening the editor restores the last diagram state
- [ ] Multiple diagrams can be saved and listed (diagram library)
- [ ] Each diagram has a title, last modified timestamp, and preview thumbnail

**Technical Notes**:
- Store serialized `GraphModel` as JSON in the existing SQLite database
- New IPC channels: `diagram:save`, `diagram:load`, `diagram:list`, `diagram:delete`
- New table: `diagrams(id TEXT PRIMARY KEY, title TEXT, mermaid_source TEXT, graph_model TEXT, created_at TEXT, modified_at TEXT)`

---

### US-7.2: Undo/Redo support

**Priority**: P1

**Description**: Support undo and redo for all editor operations.

**Acceptance Criteria**:
- [ ] Ctrl+Z undoes the last operation (node move, add, delete, edge add, property change)
- [ ] Ctrl+Y / Ctrl+Shift+Z redoes the last undone operation
- [ ] Undo/Redo buttons in toolbar with disabled state when stack is empty
- [ ] History stack preserves at least 50 operations

**Technical Notes**:
- Implement command pattern or state snapshot stack in `useGraphState.ts`
- Each mutation to `GraphModel` pushes a snapshot to the undo stack

---

## Epic 8: Integration with Chat Agent and Orchestration Pipeline

> As a user, I want the diagram I create/edit to flow back into the AI chat and orchestration pipeline.

### US-8.1: Send edited diagram back to chat context

**Priority**: P1

**Description**: After editing a diagram, allow the user to send the updated version back to the chat for the AI to re-analyze.

**Acceptance Criteria**:
- [ ] "Send to Chat" button in the editor toolbar
- [ ] Inserts the current Mermaid source as a user message in the chat (formatted as a mermaid code block)
- [ ] The AI can then re-analyze the modified architecture and update deployment plans
- [ ] Switches view back to the Chat tab after sending

---

### US-8.2: Attach exported JSON to orchestration request

**Priority**: P1

**Description**: When the user initiates deployment orchestration, the exported JSON from the diagram editor is automatically attached as context.

**Acceptance Criteria**:
- [ ] If an active diagram exists, its JSON export is included in the orchestration context
- [ ] The chat message shows an attachment indicator for the diagram
- [ ] The orchestration engine uses `flowOrder` and `dependsOn` for deployment sequencing

---

---

## Implementation Priority & Phasing

### Phase 1 — Foundation (Must Have)
| Story | Title | Priority |
|-------|-------|----------|
| US-1.1 | Mermaid rendering library setup | P0 |
| US-1.2 | Mermaid code block detection in chat | P0 |
| US-3.1 | Editor subfolder and component scaffold | P0 |
| US-3.3 | Mermaid parser → graph data model | P0 |
| US-3.4 | Interactive canvas rendering | P0 |
| US-3.5 | Drag nodes to reposition | P0 |
| US-3.2 | Editor workspace integration in app layout | P0 |

### Phase 2 — Core Editing (Must Have)
| Story | Title | Priority |
|-------|-------|----------|
| US-1.3 | "Open in Editor" action from chat | P0 |
| US-4.1 | Double-click node edit modal | P0 |
| US-5.1 | Mark start node | P0 |
| US-5.2 | Flow step ordering and numbering | P0 |
| US-6.1 | Export as Mermaid syntax | P0 |
| US-6.2 | Export as orchestration JSON | P0 |

### Phase 3 — Enhanced Editing (Should Have)
| Story | Title | Priority |
|-------|-------|----------|
| US-2.1 | Import from text paste | P1 |
| US-2.3 | Import from chat history | P1 |
| US-3.6 | Add new nodes | P1 |
| US-3.7 | Add connection edges | P1 |
| US-3.8 | Delete nodes and edges | P1 |
| US-5.3 | Flow validation | P1 |
| US-7.1 | Auto-save diagram state | P1 |
| US-7.2 | Undo/Redo support | P1 |
| US-8.1 | Send diagram back to chat | P1 |
| US-8.2 | Attach JSON to orchestration | P1 |

### Phase 4 — Polish (Nice to Have)
| Story | Title | Priority |
|-------|-------|----------|
| US-2.2 | Import from file | P2 |
| US-4.2 | Inline label editing | P2 |
| US-4.3 | Edit edge labels | P2 |
| US-6.3 | Export as image (PNG/SVG) | P3 |

---

## Key Technical Decisions to Make

### 1. Canvas Library Selection

| Option | Pros | Cons |
|--------|------|------|
| **React Flow** (`reactflow`) | Battle-tested, nodes/edges/drag/zoom built-in, TypeScript, active community, minimap, custom nodes | Adds ~150KB bundle, opinionated styling |
| **Custom SVG + drag** | Full control, no new deps, lightweight | Significant development effort, reinventing wheel |
| **Excalidraw** (embed) | Rich editor, familiar UX | Heavy (~1MB+), not designed for structured flowcharts, hard to extract graph data |

**Recommendation**: **React Flow** — it provides 90% of the canvas features out of the box (drag, zoom, pan, minimap, connection handles, custom nodes, auto-layout via dagre). Mermaid is used only for import parsing and export generation.

### 2. State Management

| Option | Notes |
|--------|-------|
| React Context + `useReducer` | Sufficient for single-editor state; simple, no new deps |
| Zustand | Lightweight, good for cross-component access; already familiar pattern in project |
| Redux | Overkill for this scope |

**Recommendation**: `useReducer` inside a `MermaidEditorContext` provider, with a custom `useGraphState` hook that exposes actions (addNode, removeNode, moveNode, addEdge, etc.) and undo/redo stack.

### 3. Mermaid Parsing Strategy

| Approach | Notes |
|----------|-------|
| `mermaid.parse()` + AST walk | Uses Mermaid's own parser; accurate but internal API may change between versions |
| Regex-based custom parser | Predictable, no dep on internal API; limited to simple flowchart syntax |
| Hybrid | Use `mermaid.parse()` for validation, custom regex for data extraction |

**Recommendation**: Start with Mermaid's `mermaidAPI` for parsing and rendering. If the internal AST proves unstable, fall back to regex for the subset of flowchart syntax we need.

### 4. Layout Algorithm

For auto-positioning nodes when importing a mermaid diagram (which has no position data):

| Option | Notes |
|--------|-------|
| **dagre** | Standard hierarchical layout, used by React Flow examples |
| **elkjs** | More layout options (layered, force, stress), WebAssembly build |

**Recommendation**: **dagre** for initial implementation — simpler, well-documented, and integrates with React Flow's layout examples.

---

## New NPM Dependencies Required

| Package | Purpose | Approx Size |
|---------|---------|-------------|
| `mermaid` | Parse and validate Mermaid syntax, render SVG for read-only views | ~1.5MB |
| `@xyflow/react` (React Flow v12) | Interactive canvas with nodes, edges, drag, zoom, pan | ~150KB |
| `dagre` | Graph layout algorithm for auto-positioning | ~30KB |
| `@types/dagre` | TypeScript types for dagre | dev only |

---

## File Structure — New Files

```
src/renderer/components/mermaid-editor/
├── MermaidEditor.tsx            # Main editor workspace (orchestrates all sub-components)
├── MermaidRenderer.tsx          # Read-only SVG rendering via mermaid library
├── Canvas.tsx                   # React Flow wrapper with custom config
├── nodes/
│   ├── BaseNode.tsx             # Custom React Flow node with label, badge, handles
│   ├── DiamondNode.tsx          # Decision/diamond shape node
│   └── SubgraphNode.tsx         # Group/subgraph container node
├── edges/
│   └── LabeledEdge.tsx          # Custom edge with editable label
├── panels/
│   ├── Toolbar.tsx              # Top toolbar (add node, import, export, validate, undo/redo)
│   ├── FlowOrderPanel.tsx       # Side panel showing ordered step list
│   └── NodeEditModal.tsx        # Modal for editing node properties
├── context/
│   └── MermaidEditorContext.tsx  # React context + provider for editor state
├── hooks/
│   ├── useGraphState.ts         # Graph state management + undo/redo
│   └── useAutoLayout.ts         # Auto-layout via dagre
├── utils/
│   ├── parser.ts                # Mermaid text → GraphModel
│   ├── serializer.ts            # GraphModel → Mermaid text
│   ├── jsonExporter.ts          # GraphModel → orchestration JSON
│   └── validation.ts            # Flow validation logic
└── types.ts                     # All TypeScript interfaces for the editor
```

**Backend additions** (for persistence):
```
src/main/
├── diagramStore.ts              # SQLite CRUD for saved diagrams
```

**IPC additions** (preload + handlers):
```
New IPC channels:
  diagram:save          — Save/update a diagram
  diagram:load          — Load a diagram by ID
  diagram:list          — List all saved diagrams
  diagram:delete        — Delete a diagram
  diagram:openFile      — Open file dialog for .mmd import
  diagram:saveFile      — Save dialog for .mmd / .json export
```
