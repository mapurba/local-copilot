Now I have a thorough picture of the existing backend. Let me compile the plan. 

Created memory file [](file:///c%3A/Users/amondal/AppData/Roaming/Code/User/workspaceStorage/6b80397d22929f54d69a8a056a850938/GitHub.copilot-chat/memory-tool/memories/Mzg1OWUxN2EtZDBjMC00ZWY3LWExMzEtZjlmODQ4MDE0NmEy/plan.md)

Here is the full, backend-focused implementation plan:

---

## Plan: Backend-First Deployment Intelligence

**TL;DR:** Build five sequential backend phases — document extraction, design generation, infrastructure planning, deployment orchestration, and tool/IPC integration — all within main. The renderer is explicitly out of scope. Every phase builds on confirmed existing modules (no duplication).

---

### Key Existing Assets (confirmed from code)

| Module | What it provides |
|---|---|
| `docs/parser.ts` | PDF/DOCX/MD section splitting, already in production |
| `docs/pipeline.ts` | LLM calls to `gpt-4o` via Copilot API, proven JSON-response pattern |
| `docs/storage.ts` | SQLite `better-sqlite3`, `documents` + `chunks` tables, search engine |
| `ssh/command.ts` | `ssh:runCommand`, `ssh:runScript`, `ssh:startBackground` (24 tools) |
| `ssh/session.ts` | Connect/disconnect with 3-retry, 60s timeout, session ID store |
| `ssh/system.ts` | `ssh:checkService`, `ssh:manageService`, `ssh:systemInfo` |
| taskTracker.ts | Task/step CRUD, LRU 5 MB log store, IPC notify |
| vcdApi.ts | `createVmFromTemplate`, `allocateFreeIp`, `listTemplates` |
| `tools/registry.ts` | `register(name, handler, metadata)` + approval-gate `execute()` |
| copilotChatApi.ts | LangChain tool loop, streaming, `TOOL_SYSTEM_PROMPT` |

---

## Phase 1 — Document Intelligence Extraction

*Goal: Turn uploaded docs into structured deployment intelligence*

**Step 1.1 — Define types** — Create `src/main/deployment/types.ts`

Core interfaces:
```
DeploymentIntelligence {
  documentId: string
  products: ProductSpec[]
  deploymentModes: DeploymentMode[]       // e.g. "single-node" | "distributed" | "ha"
  extractedAt: number
}

ProductSpec {
  name: string
  version?: string
  supportedOS: OSRequirement[]            // [{ type: 'sles', minVersion: '15.4' }]
  services: ServiceSpec[]
}

ServiceSpec {
  id: string                              // stable slug e.g. "identity-service"
  name: string
  role: 'primary' | 'dependency' | 'optional'
  deployOn: 'vm' | 'docker' | 'k8s'
  ports: PortSpec[]                       // [{ port: 8443, protocol: 'tcp', description: 'API' }]
  installSteps: InstallStep[]             // per OS type
  healthCheck: HealthCheckSpec
  configKeys: ConfigKey[]                 // env vars this service exposes
  requiresConfigFrom: string[]            // service IDs whose IPs/ports this needs
  resourceRequirements?: ResourceSpec     // CPU/RAM hints from docs
}

DeploymentMode {
  name: string                            // "single-node"
  vmCount: number
  description: string
  serviceAssignments: Record<string, string[]>  // vmRole → serviceIds[]
}

InstallStep {
  osType?: string                         // null = all OS
  stepNumber: number
  description: string
  command?: string
  isPrerequisite: boolean
  expectedExitCode: number
}

HealthCheckSpec {
  type: 'port' | 'http' | 'process' | 'systemctl'
  target: string                          // port number, URL path, process name, service unit
  expectedStatus?: string
  timeoutSeconds: number
}
```

**Step 1.2 — Build extractor** — Create `src/main/deployment/deploymentExtractor.ts`

- Calls `docs/storage.ts:getChunks(documentId)` to load existing chunks (no re-parsing)
- Calls `docs/pipeline.ts` LLM infrastructure (`queryDocumentContext`) with a structured extraction prompt
- Extraction prompt asks for JSON matching `DeploymentIntelligence` schema
- Parse and validate the JSON response with Zod
- Handles multi-call strategy: first extract services list, then per-service details, then dependencies (avoids token limits)
- Returns `DeploymentIntelligence` object

**Step 1.3 — Build dependency analyzer** — Create `src/main/deployment/dependencyAnalyzer.ts`

- Accepts a `ProductSpec[]` from the extractor
- Builds a directed acyclic graph: nodes = `ServiceSpec.id`, edges = `requiresConfigFrom`
- Detects cycles (report as warnings, break at longest edge)
- Computes topological sort (two orderings: leaf-first for bottom-up deployment, root-first for teardown)
- Outputs `DependencyGraph { nodes, edges, deploymentOrder: string[], teardownOrder: string[] }`

*Depends on: types.ts (1.1), docs/storage.ts (existing)*

---

## Phase 2 — Design Generation & Storage

*Goal: Persist the design, generate Mermaid and runbooks*

**Step 2.1 — Extend SQLite schema** — Modify storage.ts

Add two tables to the existing `better-sqlite3` database initialisation:

```sql
CREATE TABLE IF NOT EXISTS deployment_designs (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  design_json TEXT NOT NULL,           -- serialised DeploymentDesign
  mermaid_diagram TEXT,
  runbook_markdown TEXT,
  status TEXT DEFAULT 'draft',         -- draft | approved | deploying | deployed | failed
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS deployment_runs (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL,
  task_id TEXT,                        -- links to existing taskTracker
  state_json TEXT NOT NULL,            -- serialised DeploymentRunState
  started_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (design_id) REFERENCES deployment_designs(id)
);
```

**Step 2.2 — Build design store** — Create `src/main/deployment/deploymentStore.ts`

- `saveDesign(design: DeploymentDesign): string` — insert, return ID
- `updateDesign(id, partial)` — update fields, bump `updated_at`
- `getDesign(id): DeploymentDesign`
- `listDesigns(): DesignSummary[]`
- `saveRun(run): string` / `updateRun(id, partial)` / `getRun(id)`
- Reuses the `db` singleton from `docs/storage.ts` (same file, same connection)

**Step 2.3 — Build Mermaid generator** — Create `src/main/deployment/mermaidGenerator.ts`

- `generateTopologyDiagram(design: DeploymentDesign): string`
  - Renders `graph TD` with VM subgraphs, service nodes, and dependency arrows
  - Service node label includes: name, IP, port list
  - Arrow label shows config key being wired (e.g. `DB_HOST`)
- `generateStateDiagram(design: DeploymentDesign, runState: DeploymentRunState): string`
  - Same topology but service nodes get status suffix and CSS class:
    - `:::pending`, `:::deploying`, `:::healthy`, `:::failed`
  - Called by orchestrator on every state change to regenerate live diagram

**Step 2.4 — Build runbook generator** — Create `src/main/deployment/runbookGenerator.ts`

- `generateRunbook(design: DeploymentDesign): string`
  - Top-level markdown: product name, version, deployment mode, IP table
  - Per-VM section: OS, IP, services list
  - Per-service section: prerequisite installs, main install steps, config injection steps, health check procedure
  - Config injection step template: `export SERVICE_B_IP=<assigned-ip>; export SERVICE_B_PORT=<port>`
  - Dependency check section: steps to verify inter-service connectivity
- `generateServiceRunbook(service: ServiceSpec, design: DeploymentDesign): string` (per-service slice)

*Depends on: types.ts (1.1), deploymentStore.ts (2.2)*

---

## Phase 3 — Infrastructure Planning

*Goal: Assign IPs, determine VM topology, attach to design*

**Step 3.1 — Build IP pool manager** — Create `src/main/deployment/ipPoolManager.ts`

- `allocateIpsForDesign(design: DeploymentDesign): Record<string, string>` — serviceId → ip
  - For each service with `deployOn: 'vm'`, calls existing `vcdApi.ts:allocateFreeIp()`
  - Serialises allocations into `design.ipAssignments`
  - On failure, releases already-allocated IPs and throws
- `releaseIpsForDesign(design: DeploymentDesign): void` — placeholder (VCD doesn't support explicit IP release; records in store as released)
- Stores `ipAssignments` map in `deployment_designs.design_json`

**Step 3.2 — Build VM placement engine** — Create `src/main/deployment/vmPlacementEngine.ts`

- `planVmTopology(intel: DeploymentIntelligence, modeName: string): VmPlan[]`
  - Selects `DeploymentMode` by name from intelligence
  - Maps service assignments to concrete `VmPlan` objects
  - Each `VmPlan`: `{ id, role, services: ServiceSpec[], osRequirement, resourceHints }`
  - Checks OS compatibility: if services on the same VM have conflicting `supportedOS`, flags conflict
- `buildDeploymentDesign(intel, modeName, ipAssignments): DeploymentDesign`
  - Composes final `DeploymentDesign` from VM plans + IP assignments + dependency graph
  - This is the central composition function that produces the persistable design

*Depends on: types.ts (1.1), ipPoolManager.ts (3.1), dependencyAnalyzer.ts (1.3)*

---

## Phase 4 — Deployment Orchestration

*Goal: Execute the design against real infrastructure, track state, validate health*

**Step 4.1 — Build health validation engine** — Create `src/main/deployment/healthValidationEngine.ts`

All checks run via existing `ssh/command.ts` tools (registered tools, called directly):

- `checkPortOpen(sessionId, host, port, timeoutS): boolean` — `nc -z -w<timeout> <host> <port>`
- `checkHttpEndpoint(sessionId, url, expectedStatus): boolean` — `curl -s -o /dev/null -w "%{http_code}" <url>`
- `checkProcessRunning(sessionId, processName): boolean` — `pgrep -x <process>`
- `checkSystemdService(sessionId, unitName): boolean` — delegates to existing `ssh:checkService` tool
- `validateService(sessionId, spec: ServiceSpec, design: DeploymentDesign): ValidationResult`
  - Runs the check matching `spec.healthCheck.type`
  - Returns `{ service, passed, detail, durationMs }`
- `validateAllServices(sessionId, vmPlan, design): ValidationResult[]`

**Step 4.2 — Build rollback manager** — Create `src/main/deployment/rollbackManager.ts`

- `snapshotBeforeDeployment(design: DeploymentDesign): Record<string, string>` — per VM, calls `vcdApi.createSnapshot()` via IPC, stores snapshot names in `deployment_runs.state_json`
- `rollbackVm(vmName, snapshotName): Promise<void>` — calls `vcdApi.revertSnapshot()`
- `rollbackDeployment(runId): Promise<void>` — reverts all VMs in reverse deployment order

**Step 4.3 — Build deployment orchestrator** — Create `src/main/deployment/deploymentOrchestrator.ts`

This is the core execution engine. Key design:

```
DeploymentRunState {
  runId: string
  designId: string
  serviceStates: Record<string, ServiceState>    // serviceId → state
  vmSessions: Record<string, string>             // vmId → sshSessionId
  taskId: string                                 // taskTracker task
  currentMermaid: string                         // regenerated on each state change
  phase: 'provisioning' | 'deploying' | 'validating' | 'complete' | 'failed' | 'rolledback'
}

ServiceState {
  status: 'pending' | 'installing' | 'configuring' | 'starting' | 'healthy' | 'failed'
  attempts: number
  lastError?: string
  deployedAt?: number
}
```

Execution algorithm:
1. Load design from `deploymentStore`
2. Create `taskTracker` task (links progress to UI)
3. `snapshotBeforeDeployment()` — safety net
4. Provision all required VMs via `vcdApi.createVmFromTemplate()` (parallel where no dependency)
5. SSH connect to each VM (`ssh:connect`) — store session IDs
6. Walk `dependencyGraph.deploymentOrder` (topological leaf-first):
   - For each service's VM:
     a. `taskTracker.beginStep` for this service
     b. Run prerequisite install steps via `ssh:runCommand`
     c. Inject dependency IPs as env vars: `ssh:runCommand("export KEY=value")`
     d. Run install steps via `ssh:runCommand` or `ssh:runScript`
     e. `healthValidationEngine.validateService()` — retry up to 3× with 30s backoff
     f. On health pass: mark `ServiceState.status = 'healthy'`, regenerate Mermaid, IPC push `deployment:state-update`
     g. On persistent failure: `rollbackManager.rollbackDeployment()`, mark run failed
7. Final endpoint validation across all services
8. Generate summary report markdown
9. IPC push `deployment:complete` with report + final Mermaid

State changes are pushed to renderer via `mainWindow.webContents.send('deployment:state-update', { runId, mermaid, serviceStates })`

*Depends on: all Phase 1–3 modules, healthValidationEngine.ts (4.1), rollbackManager.ts (4.2), taskTracker.ts (existing), ssh/command.ts (existing), vcdApi.ts (existing)*

---

## Phase 5 — Tool & IPC Integration

*Goal: Wire new backend into LangChain tools and IPC so the AI and UI can use it*

**Step 5.1 — Create deployment tool category** — Create `src/main/tools/categories/deployment/index.ts`

Register these LangChain-callable tools in `toolRegistry`:

| Tool name | Risk | Description |
|---|---|---|
| `deployment:analyzeDoc` | `safe` | Extract `DeploymentIntelligence` from an uploaded doc by docId |
| `deployment:generateDesign` | `safe` | Build topology + Mermaid + runbook from extracted intelligence + mode name |
| `deployment:listDesigns` | `safe` | List all saved designs |
| `deployment:getDesign` | `safe` | Get a design + Mermaid + runbook by designId |
| `deployment:updateDesign` | `review` | Accept user-modified Mermaid/JSON, re-run dependency analysis, update design |
| `deployment:assignIps` | `review` | Run IP allocation for a design |
| `deployment:startDeployment` | `dangerous` | Begin full orchestrated deployment for an approved design |
| `deployment:getRunStatus` | `safe` | Get current `DeploymentRunState` for a run |
| `deployment:cancelDeployment` | `dangerous` | Cancel and rollback a running deployment |
| `deployment:validateEndpoints` | `safe` | Run final endpoint validation on a deployed design |

**Step 5.2 — Add IPC channels** — Extend ipcHandlers.ts

| Channel | Direction | Handler |
|---|---|---|
| `deployment:analyze` | invoke | `deploymentExtractor.extractFromDocument(docId)` |
| `deployment:generate` | invoke | `vmPlacementEngine.buildDeploymentDesign(intel, mode)` |
| `deployment:list` | invoke | `deploymentStore.listDesigns()` |
| `deployment:get` | invoke | `deploymentStore.getDesign(id)` |
| `deployment:update` | invoke | Re-analyze modified design JSON |
| `deployment:assignIps` | invoke | `ipPoolManager.allocateIpsForDesign(design)` |
| `deployment:start` | invoke | `deploymentOrchestrator.start(designId)` |
| `deployment:runStatus` | invoke | `deploymentStore.getRun(runId)` |
| `deployment:cancel` | invoke | `deploymentOrchestrator.cancel(runId)` |
| `deployment:state-update` | send (push) | Emitted by orchestrator on state change |
| `deployment:complete` | send (push) | Emitted by orchestrator on success |
| `deployment:failed` | send (push) | Emitted by orchestrator on failure/rollback |

**Step 5.3 — Extend `TOOL_SYSTEM_PROMPT`** — Modify copilotChatApi.ts

Add a `── DEPLOYMENT INTELLIGENCE ──` section to the existing system prompt covering:
- When user uploads docs and asks about deployment: call `deployment:analyzeDoc` first
- After analysis, call `deployment:generateDesign` with the recommended mode
- Present the Mermaid diagram and runbook to the user
- If user modifies the diagram: call `deployment:updateDesign` with modified content
- To deploy: call `deployment:assignIps` then `deployment:startDeployment` (requires user approval)
- To check status: call `deployment:getRunStatus`

**Step 5.4 — Register deployment tools at startup** — Modify `src/main/tools/registry.ts:initializeDefaultTools()`

Add `registerDeploymentTools()` import and call alongside existing `registerSshTools()`, `registerVcdTools()`, `registerDocsTools()`, `registerLocalTools()`.

---

## Relevant Files

**New files to create (11 files):**
- src/main/deployment/types.ts — all data model interfaces
- src/main/deployment/deploymentExtractor.ts — LLM extraction
- src/main/deployment/dependencyAnalyzer.ts — DAG builder + topo sort
- src/main/deployment/deploymentStore.ts — SQLite CRUD
- src/main/deployment/mermaidGenerator.ts — diagram generation
- src/main/deployment/runbookGenerator.ts — markdown runbooks
- src/main/deployment/ipPoolManager.ts — IP allocation
- src/main/deployment/vmPlacementEngine.ts — topology composition
- src/main/deployment/deploymentOrchestrator.ts — execution engine
- src/main/deployment/healthValidationEngine.ts — health checks
- src/main/deployment/rollbackManager.ts — snapshot + revert
- src/main/tools/categories/deployment/index.ts — tool registration

**Files to modify (3 files):**
- storage.ts — add two new tables
- ipcHandlers.ts — add 10 new channels
- copilotChatApi.ts — extend system prompt + bind new tools

---

## Verification

1. **Unit path** — TypeScript compiles with `npm run build` (zero new tsc errors) after each phase
2. **Phase 1** — Call `deployment:analyzeDoc` with a real ILM PDF already in the docs store; verify returned `DeploymentIntelligence` JSON has `services`, `supportedOS`, `deploymentModes`
3. **Phase 2** — Call `deployment:generateDesign`; verify Mermaid string renders in Mermaid Live Editor with correct VM subgraphs and dependency arrows
4. **Phase 2** — Verify runbook markdown contains ordered per-VM install steps and a config injection section for dependent services
5. **Phase 3** — Call `deployment:assignIps`; verify each service in `ipAssignments` has a real non-overlapping IP from the VCD pool
6. **Phase 4 (isolated)** — Unit test `dependencyAnalyzer` with a hardcoded 4-service graph; verify topological order is leaf-first
7. **Phase 4 (integration)** — Start a deployment against a test VM; verify `taskTracker` task steps appear; verify health check passes after install; verify `deployment:state-update` IPC event fires with updated Mermaid
8. **Phase 5** — Ask AI in chat: "Analyze the uploaded ILM guide and generate a deployment design"; verify it calls `deployment:analyzeDoc` → `deployment:generateDesign` and returns a Mermaid diagram in the response

---

## Decisions & Scope

- **Renderer is out of scope** — all new IPC events are emitted but no renderer components are built in this plan
- **Preload additions minimal** — only new IPC channels need corresponding `contextBridge` wrappers; done last in Phase 5
- **No new external databases** — SQLite only; Neo4j/Redis from the high-level plan are deferred
- **No Docker/K8s engines** — `deployOn: 'docker'` and `'k8s'` are modelled in types but orchestrator handles only `'vm'` (SSH-based) in this plan
- **No vector embeddings** — existing keyword-search in `docs/storage.ts` is sufficient for Phase 1; semantic search is a follow-on
- **Circular dependency handling** — flagged as warning, longest edge broken (not fatal)
- **IP release** — VCD has no explicit IP release API; pool manager records allocations as "released" in the store only

## Further Considerations
1. **LLM extraction quality** — complex multi-product docs may require a multi-call chunked extraction strategy (extract services list first, then per-service detail). The extractor should support a `fullExtract` flag for single-pass vs `chunkedExtract` for large docs.
2. **VM provisioning parallel vs serial** — the orchestrator can provision all VMs first (parallel), then deploy services in dependency order. This reduces total wall-clock time significantly.
3. **Mermaid edit round-trip** — when a user modifies the Mermaid diagram, parsing it back to the design graph is non-trivial. A simpler UX may be to have the user modify a structured JSON form, with the Mermaid regenerated from it. This should be clarified before implementing `deployment:updateDesign`.
</thinking>

Here is the full, backend-focused implementation plan:

---

## Plan: Deployment Intelligence — Backend-First Implementation

**TL;DR:** Build a new `src/main/deployment/` module in five sequential phases. Each phase produces testable output before the next begins. No renderer work is included. Everything is wired into the existing `ToolRegistry`, `taskTracker`, `SQLite store`, and `copilotChatApi` — minimal new infrastructure.

---

### What Already Exists (Zero Re-implementation)

| Module | Re-used capability |
|---|---|
| `docs/parser.ts` | PDF/DOCX/MD parsing, section splitting |
| `docs/pipeline.ts` | LLM calls to `gpt-4o` via Copilot API, proven JSON-response pattern |
| `docs/storage.ts` | SQLite `better-sqlite3`, search, chunk retrieval |
| `ssh/command.ts` | `ssh:runCommand`, `ssh:runScript`, `ssh:startBackground` |
| `ssh/session.ts` | SSH connect/disconnect with 3-retry, session ID map |
| `ssh/system.ts` | `ssh:checkService`, `ssh:manageService`, `ssh:systemInfo` |
| taskTracker.ts | Task/step CRUD with LRU log, IPC push on state change |
| vcdApi.ts | `createVmFromTemplate`, `allocateFreeIp` |
| `tools/registry.ts` | `register()` + approval-gated `execute()` |

---

## Phase 1 — Document Intelligence Extraction

*Build the extraction pipeline that turns uploaded docs into structured deployment intelligence.*

**Step 1.1** — Create `src/main/deployment/types.ts`

All shared data model interfaces. Key structures:

- `DeploymentIntelligence { documentId, products: ProductSpec[], deploymentModes: DeploymentMode[], extractedAt }`
- `ProductSpec { name, version, supportedOS: OSRequirement[], services: ServiceSpec[] }`
- `ServiceSpec { id, name, role, deployOn: 'vm'|'docker'|'k8s', ports: PortSpec[], installSteps: InstallStep[], healthCheck: HealthCheckSpec, configKeys: ConfigKey[], requiresConfigFrom: string[], resourceRequirements? }`
- `InstallStep { osType?, stepNumber, description, command?, isPrerequisite, expectedExitCode }`
- `HealthCheckSpec { type: 'port'|'http'|'process'|'systemctl', target, expectedStatus?, timeoutSeconds }`
- `DeploymentMode { name, vmCount, description, serviceAssignments: Record<vmRole, serviceId[]> }`
- `DeploymentDesign { id, documentId, vms: VmPlan[], services: ServiceSpec[], ipAssignments: Record<serviceId, ip>, dependencyGraph: DependencyGraph, mermaid?, runbook?, status }`
- `DependencyGraph { nodes: string[], edges: DependencyEdge[], deploymentOrder: string[], teardownOrder: string[] }`
- `DeploymentRunState { runId, designId, taskId, serviceStates: Record<serviceId, ServiceState>, vmSessions: Record<vmId, sshSessionId>, phase, currentMermaid }`

**Step 1.2** — Create `src/main/deployment/deploymentExtractor.ts`

- `extractFromDocument(documentId: string): Promise<DeploymentIntelligence>`
- Calls `docs/storage.ts:getChunks(documentId)` — no re-parsing
- Uses `docs/pipeline.ts` LLM infrastructure with a structured JSON extraction prompt targeting the `DeploymentIntelligence` schema
- Multi-call strategy to stay within token limits:
  1. First call: extract `products[]`, `deploymentModes[]`, top-level service list
  2. Per-service calls: extract `installSteps`, `ports`, `healthCheck`, `requiresConfigFrom`
- Validates JSON output with Zod against `DeploymentIntelligence` schema
- Stores result in `deployment_designs` table (status: `extracted`)

**Step 1.3** — Create `src/main/deployment/dependencyAnalyzer.ts`

- `buildDependencyGraph(services: ServiceSpec[]): DependencyGraph`
- Nodes = `ServiceSpec.id`, edges = `requiresConfigFrom` relationships
- Cycle detection with longest-edge break (warn, don't throw)
- Topological sort: two orderings — `deploymentOrder` (leaf-first) and `teardownOrder` (root-first)

*Depends on: types.ts — parallel with nothing else*

---

## Phase 2 — Design Generation & Persistence

*Persist the design, generate Mermaid topology and per-service runbooks.*

**Step 2.1** — Extend storage.ts

Add two tables to the existing `initDatabase()` function (same SQLite file, same `db` singleton):

```sql
CREATE TABLE IF NOT EXISTS deployment_designs (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  design_json TEXT NOT NULL,
  mermaid_diagram TEXT,
  runbook_markdown TEXT,
  status TEXT DEFAULT 'draft',   -- draft | approved | deploying | deployed | failed
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS deployment_runs (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL,
  task_id TEXT,
  state_json TEXT NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (design_id) REFERENCES deployment_designs(id)
);
```

**Step 2.2** — Create `src/main/deployment/deploymentStore.ts`

- `saveDesign(design)`, `updateDesign(id, partial)`, `getDesign(id)`, `listDesigns()`
- `saveRun(run)`, `updateRun(id, partial)`, `getRun(id)`, `getRunsForDesign(designId)`
- Imports `db` from `docs/storage.ts` — no new database connection

**Step 2.3** — Create `src/main/deployment/mermaidGenerator.ts`

- `generateTopologyDiagram(design: DeploymentDesign): string`
  - Renders `graph TD` with VM `subgraph` blocks
  - Each service node shows: name, IP, port list
  - Arrows between dependent services labeled with the config key being wired (e.g. `DB_HOST`)
- `generateStateDiagram(design, runState: DeploymentRunState): string`
  - Same structure + CSS class per service: `:::pending`, `:::deploying`, `:::healthy`, `:::failed`
  - Called by orchestrator on every state transition; result stored in `runState.currentMermaid`

**Step 2.4** — Create `src/main/deployment/runbookGenerator.ts`

- `generateFullRunbook(design: DeploymentDesign): string` — complete markdown doc:
  - Header: product name, version, deployment mode, IP assignment table
  - Per-VM section: OS, IP, services to deploy
  - Per-service section:
    1. Prerequisite install steps (commands)
    2. Main install steps
    3. Config injection block — `export DEPENDENT_SERVICE_IP=<ip>; export DEPENDENT_SERVICE_PORT=<port>`
    4. Health check procedure
    5. Dependencies: how to verify inter-service connectivity
- `generateServiceRunbook(serviceId, design): string` — single-service slice for incremental use

*Depends on: types.ts (1.1), deploymentStore.ts (2.2) — parallel with Phase 1*

---

## Phase 3 — Infrastructure Planning

*Assign IPs from the VCD pool, determine VM topology, compose the final DeploymentDesign.*

**Step 3.1** — Create `src/main/deployment/ipPoolManager.ts`

- `allocateIpsForDesign(design: DeploymentDesign): Promise<Record<string, string>>`
  - For each service with `deployOn: 'vm'`, calls `vcdApi.allocateFreeIp()`
  - On any allocation failure: releases already-allocated IPs (recorded in store), throws
- `recordIpRelease(designId, serviceId)` — store-only (VCD has no explicit IP release API)

**Step 3.2** — Create `src/main/deployment/vmPlacementEngine.ts`

- `planVmTopology(intel: DeploymentIntelligence, modeName: string): VmPlan[]`
  - Selects `DeploymentMode` by name
  - Maps `serviceAssignments` to concrete `VmPlan` objects
  - OS compatibility check: if services on the same VM have conflicting `supportedOS`, emit conflict error
- `buildDeploymentDesign(intel, modeName, ipAssignments): DeploymentDesign`
  - Composes `VmPlan[]` + IP assignments + `DependencyGraph` (from dependencyAnalyzer) into a full `DeploymentDesign`
  - This is the single composition function that produces the persistable design object

*Depends on: types.ts (1.1), ipPoolManager.ts (3.1), dependencyAnalyzer.ts (1.3)*

---

## Phase 4 — Deployment Orchestration

*Execute the design against real infrastructure, track state, validate health, rollback on failure.*

**Step 4.1** — Create `src/main/deployment/healthValidationEngine.ts`

All checks execute via the existing registered `ssh/command.ts` tools (call `toolRegistry.execute()` directly):

- `checkPortOpen(sessionId, host, port, timeoutS)` → `nc -z -w<t> <host> <port>`
- `checkHttpEndpoint(sessionId, url, expectedStatus)` → `curl -s -o /dev/null -w "%{http_code}" <url>`
- `checkProcessRunning(sessionId, processName)` → `pgrep -x <name>`
- `checkSystemdService(sessionId, unit)` → delegates to existing `ssh:checkService` tool
- `validateService(sessionId, spec, design): ValidationResult` — dispatches to correct check based on `spec.healthCheck.type`
- `validateAllServices(sessionId, vmPlan, design): ValidationResult[]`

**Step 4.2** — Create `src/main/deployment/rollbackManager.ts`

- `snapshotBeforeDeployment(design): Promise<Record<vmId, snapshotName>>` — calls `vcdApi.createSnapshot()` per VM; stores names in run state
- `rollbackVm(vmName, snapshotName)` — calls `vcdApi.revertSnapshot()`
- `rollbackDeployment(runId)` — reverts all VMs in `teardownOrder` using stored snapshot names

**Step 4.3** — Create `src/main/deployment/deploymentOrchestrator.ts`

Core execution algorithm:
1. Load design from `deploymentStore`
2. Create `taskTracker.createTask(name, description)` — ties progress to UI task panel
3. `rollbackManager.snapshotBeforeDeployment()` — safety snapshots
4. Provision required VMs via `vcdApi.createVmFromTemplate()` — parallel where no dependency
5. SSH connect to each VM via `ssh:connect` — store `sessionId` per VM in `runState.vmSessions`
6. Walk `dependencyGraph.deploymentOrder` (leaf-first topological):
   - For each service:
     - `taskTracker.beginStep(taskId, "Deploy <service> on <vm>")`
     - Run prerequisite commands via `ssh:runCommand` (approval-gated)
     - Inject dependency IPs: `ssh:runCommand("export KEY=<resolved-ip>")`
     - Execute main install steps via `ssh:runScript`
     - `healthValidationEngine.validateService()` — retry up to 3× with 30 s backoff
     - On pass: `serviceState.status = 'healthy'`, regenerate Mermaid via `mermaidGenerator.generateStateDiagram()`, push `deployment:state-update` IPC event
     - On persistent failure: `rollbackManager.rollbackDeployment()`, push `deployment:failed`
7. Final endpoint validation of all service URLs
8. `runbookGenerator` generates summary report
9. Push `deployment:complete` with final Mermaid + report markdown

*Depends on: all Phase 1–3 modules + healthValidationEngine (4.1) + rollbackManager (4.2) + taskTracker + vcdApi + ssh tools*

---

## Phase 5 — Tool & IPC Integration

*Wire everything into the LangChain tool loop and IPC surface.*

**Step 5.1** — Create `src/main/tools/categories/deployment/index.ts`

Register 10 tools in `toolRegistry`:

| Tool | Risk | Calls |
|---|---|---|
| `deployment:analyzeDoc` | `safe` | `deploymentExtractor.extractFromDocument(docId)` |
| `deployment:generateDesign` | `safe` | `vmPlacementEngine.buildDeploymentDesign(intel, mode)` + `mermaidGenerator` + `runbookGenerator` |
| `deployment:listDesigns` | `safe` | `deploymentStore.listDesigns()` |
| `deployment:getDesign` | `safe` | `deploymentStore.getDesign(id)` |
| `deployment:updateDesign` | `review` | Accept modified design JSON → re-run `dependencyAnalyzer` → regenerate Mermaid + runbook → `deploymentStore.updateDesign()` |
| `deployment:assignIps` | `review` | `ipPoolManager.allocateIpsForDesign()` |
| `deployment:startDeployment` | `dangerous` | `deploymentOrchestrator.start(designId)` |
| `deployment:getRunStatus` | `safe` | `deploymentStore.getRun(runId)` |
| `deployment:cancelDeployment` | `dangerous` | `deploymentOrchestrator.cancel(runId)` → `rollbackManager.rollbackDeployment()` |
| `deployment:validateEndpoints` | `safe` | `healthValidationEngine.validateAllServices()` on completed design |

**Step 5.2** — Extend ipcHandlers.ts

Add 10 `ipcMain.handle` channels (matching tool names above). Add 3 push events that the orchestrator emits:
- `deployment:state-update` — fired on every service state change (carries updated Mermaid + `serviceStates`)
- `deployment:complete` — carries final report markdown + Mermaid
- `deployment:failed` — carries error detail + rollback status

**Step 5.3** — Extend copilotChatApi.ts

Add `── DEPLOYMENT INTELLIGENCE ──` block to `TOOL_SYSTEM_PROMPT`:
- On doc upload + deployment question: call `deployment:analyzeDoc` first, then `deployment:generateDesign`
- Present Mermaid and runbook summary to user
- If user modifies design: call `deployment:updateDesign` with the changed content
- Before deploy: call `deployment:assignIps`, then `deployment:startDeployment` (approval required)
- For status: call `deployment:getRunStatus`

**Step 5.4** — Extend `src/main/tools/registry.ts:initializeDefaultTools()`

Add `registerDeploymentTools()` call alongside existing category registrations.

---

## Files Modified / Created

**New (12 files):**
- src/main/deployment/types.ts — all interfaces (Phase 1.1)
- src/main/deployment/deploymentExtractor.ts — LLM extraction (Phase 1.2)
- src/main/deployment/dependencyAnalyzer.ts — DAG + topo sort (Phase 1.3)
- src/main/deployment/deploymentStore.ts — SQLite CRUD (Phase 2.2)
- src/main/deployment/mermaidGenerator.ts — diagram generation (Phase 2.3)
- src/main/deployment/runbookGenerator.ts — markdown runbooks (Phase 2.4)
- src/main/deployment/ipPoolManager.ts — IP allocation (Phase 3.1)
- src/main/deployment/vmPlacementEngine.ts — topology + design composition (Phase 3.2)
- src/main/deployment/deploymentOrchestrator.ts — execution engine (Phase 4.3)
- src/main/deployment/healthValidationEngine.ts — health checks (Phase 4.1)
- src/main/deployment/rollbackManager.ts — snapshot + revert (Phase 4.2)
- src/main/tools/categories/deployment/index.ts — 10 tools (Phase 5.1)

**Modified (3 files):**
- storage.ts — add 2 tables to `initDatabase()` (Phase 2.1)
- ipcHandlers.ts — 10 new invoke channels + 3 push events (Phase 5.2)
- copilotChatApi.ts — extend system prompt + bind new tools (Phase 5.3)

---

## Verification

1. `npm run build` compiles with zero new errors after each phase
2. **Phase 1:** Call `deployment:analyzeDoc` with the existing ILM PDF in the docs store — verify returned JSON contains `services[]`, `supportedOS[]`, `deploymentModes[]`
3. **Phase 1.3:** Unit test `dependencyAnalyzer` with a hard-coded 4-service graph — verify `deploymentOrder` is leaf-first
4. **Phase 2.3:** Paste generated Mermaid string into mermaid.live — verify VM subgraphs appear with services, IPs, and labeled arrows
5. **Phase 2.4:** Open generated runbook markdown — verify per-service sections exist with ordered commands and a config injection block
6. **Phase 3:** Call `deployment:assignIps` — verify each service in `ipAssignments` has a unique VCD-allocated IP
7. **Phase 4 integration:** Start a deployment on a test VM — verify `taskTracker` task steps update live, health check passes after install, `deployment:state-update` IPC event fires with a regenerated Mermaid diagram
8. **Phase 5:** Chat prompt "Analyze the uploaded ILM guide and generate a deployment design" — verify AI calls `deployment:analyzeDoc` → `deployment:generateDesign` and the Mermaid diagram appears in the response

---

## Decisions & Scope Boundaries

- **Renderer out of scope** — IPC push events are emitted; no new React components are built here
- **VM-only orchestration** — `deployOn: 'docker'` and `'k8s'` are typed and modelled but orchestrator only handles `'vm'` (SSH-based) in this plan
- **No new databases** — SQLite only; Neo4j/vector DB from the high-level plan are deferred
- **No vector embeddings** — existing keyword-search in `docs/storage.ts` is sufficient for extraction; semantic RAG is a follow-on
- **IP release** — VCD has no explicit IP release API; pool manager records allocations as released in the store only

## Further Considerations

1. **Mermaid round-trip editing** — parsing user-modified Mermaid back into the design graph is non-trivial. Simpler alternative: expose a structured JSON editor for the design, regenerate Mermaid from it. Recommend clarifying this UX before implementing `deployment:updateDesign` in Phase 5.1.

2. **LLM extraction quality for complex docs** — multi-product documents or docs with ambiguous structure may need a chunked multi-call extraction (list services first, then per-service detail). The extractor should expose a `strategy: 'single-pass' | 'chunked'` parameter tunable at call time.

3. **VM provisioning parallelism** — provision all VMs first (in parallel) before executing the deployment DAG. This reduces total wall-clock time significantly. Orchestrator should separate the "provision" phase from the "deploy services" phase.