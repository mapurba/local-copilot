# VCD Agent â€” Backend Implementation TODO
## Deployment Intelligence & Autonomous Orchestration

> **How to use:** Mark items `[ ]` â†’ `[~]` as completed. Add new items under the relevant phase. Update status notes inline. Never delete completed items â€” they serve as an audit trail.

**Legend:**
- `[ ]` Not started
- `[~]` In progress
- `[x]` Done
- `[!]` Blocked / needs decision

---

## Phase 0 â€” Pre-work & Setup

- [~] **0.1** Confirm `docs/storage.ts` exports the `db` singleton (needed by `deploymentStore.ts`)
- [~] **0.2** Confirm `docs/pipeline.ts` exports `queryDocumentContext()` and LLM call helper (needed by extractor)
- [~] **0.3** Confirm `docs/storage.ts` exports `getChunks(documentId)` (needed for chunk count in auto-strategy)
- [~] **0.4** Confirm `vcdApi.ts` exports `allocateFreeIp()`, `createVmFromTemplate()`, `checkVmStatus()`, `createSnapshot()`, `revertSnapshot()`
- [~] **0.5** Confirm `tools/registry.ts` exports `toolRegistry` singleton and `initializeDefaultTools()`
- [~] **0.6** Create directory `src/main/deployment/`
- [~] **0.7** Create directory `src/main/tools/categories/deployment/`

---

## Phase 1 â€” Document Intelligence Extraction

### 1.1 â€” Types (`src/main/deployment/types.ts`)

- [~] **1.1.1** Define `OSRequirement` interface
- [~] **1.1.2** Define `PortSpec` interface
- [~] **1.1.3** Define `ConfigKey` interface
- [~] **1.1.4** Define `InstallStep` interface
- [~] **1.1.5** Define `HealthCheckSpec` interface (`type: 'port' | 'http' | 'process' | 'systemctl'`)
- [~] **1.1.6** Define `ResourceSpec` interface
- [~] **1.1.7** Define `ServiceSpec` interface (includes `requiresConfigFrom`, `configKeys`, `installSteps`)
- [~] **1.1.8** Define `DeploymentMode` interface (includes `serviceAssignments: Record<vmRole, serviceId[]>`)
- [~] **1.1.9** Define `ProductSpec` interface
- [~] **1.1.10** Define `DeploymentIntelligence` interface (includes `extractionStrategy`, `extractionWarnings`)
- [~] **1.1.11** Define `VmPlan` interface (includes `vmName?`, `ip?`)
- [~] **1.1.12** Define `DependencyEdge` interface
- [~] **1.1.13** Define `DependencyGraph` interface (includes `levels: string[][]` for parallel deployment)
- [~] **1.1.14** Define `DeploymentDesign` interface (includes `status` state machine)
- [~] **1.1.15** Define `ServiceDeployStatus` union type
- [~] **1.1.16** Define `ServiceState` interface
- [~] **1.1.17** Define `OrchestratorPhase` union type
- [~] **1.1.18** Define `DeploymentRunState` interface (includes `currentLevel`, `snapshotNames`, `currentMermaid`)
- [~] **1.1.19** Define `ValidationResult` interface
- [~] **1.1.20** Define `ExtractionOptions` interface (`strategy: 'auto' | 'single-pass' | 'chunked'`)
- [~] **1.1.21** Run `npm run build` â€” zero errors on types file alone

### 1.2 â€” Deployment Extractor (`src/main/deployment/deploymentExtractor.ts`)

- [~] **1.2.1** Implement `getChunkCount(documentId)` helper â€” calls `docs/storage.ts:getChunks()`, returns count
- [~] **1.2.2** Implement `chooseStrategy(documentId, options)` â€” auto: < 20 chunks â†’ single-pass, â‰¥ 20 â†’ chunked
- [~] **1.2.3** Implement `singlePassExtract(documentId)`:
  - Load all chunks, concatenate, truncate to 14 000 tokens
  - Single LLM call with full extraction prompt targeting `DeploymentIntelligence` schema
  - Parse JSON response, validate with Zod
- [~] **1.2.4** Write Pass 1 prompt (topology only â€” products, modes, service names/roles, no install steps)
- [~] **1.2.5** Write Pass 2 prompt template (per-service detail â€” ports, installSteps, healthCheck, requiresConfigFrom, configKeys)
- [~] **1.2.6** Write Pass 3 prompt (cross-check â€” verify requiresConfigFrom completeness and symmetry)
- [~] **1.2.7** Implement `chunkedExtract(documentId)`:
  - Pass 1: feed all chunks truncated to 12 000 tokens, parse topology JSON
  - Pass 2: for each service from Pass 1, call `docs/storage.ts:search(serviceId + ' install')`, get top 6 chunks, run focused LLM call â€” all services in `Promise.all()`
  - Pass 3: feed Pass 1 + Pass 2 combined services JSON (~3 000 tokens), verify dependency edges
- [~] **1.2.8** Implement Zod schema for `DeploymentIntelligence` (mirrors types.ts interfaces)
- [~] **1.2.9** Implement retry logic: on Zod validation failure, retry with stricter "JSON only" prompt, max 2 retries per pass
- [~] **1.2.10** On final retry failure: record warning in `extractionWarnings[]`, continue with partial data
- [~] **1.2.11** Export `extractFromDocument(documentId, options?: ExtractionOptions): Promise<DeploymentIntelligence>`
- [~] **1.2.12** Manual test: call with ILM PDF doc already in store â€” verify `services[]`, `supportedOS[]`, `deploymentModes[]` in output
- [~] **1.2.13** Manual test: call with `strategy: 'chunked'` on large doc â€” verify 3 LLM passes are logged and `extractionStrategy: 'chunked'` in result

### 1.3 â€” Dependency Analyzer (`src/main/deployment/dependencyAnalyzer.ts`)

- [~] **1.3.1** Build adjacency map from `ServiceSpec[].requiresConfigFrom`
- [~] **1.3.2** Implement DFS cycle detection â€” on cycle: record warning, remove longest edge creating the cycle
- [~] **1.3.3** Implement Kahn's algorithm for topological sort â†’ `deploymentOrder` (leaf-first) and `teardownOrder`
- [~] **1.3.4** Implement BFS level assignment â€” nodes at same level have no inter-dependency â†’ `levels: string[][]`
- [~] **1.3.5** Populate `DependencyEdge.configKeys` from the source service's `configKeys[]` filtered by target's `requiresConfigFrom`
- [~] **1.3.6** Export `buildDependencyGraph(services: ServiceSpec[]): DependencyGraph`
- [~] **1.3.7** Unit test: 4-service mock (Aâ†’Bâ†’C, Aâ†’D) â€” verify `levels` = `[[C, D], [B], [A]]`
- [~] **1.3.8** Unit test: circular graph (Aâ†’Bâ†’A) â€” verify warning recorded, no infinite loop, longest edge removed

---

## Phase 2 â€” Design Generation & Persistence

### 2.1 â€” Schema Extension (`src/main/tools/categories/docs/storage.ts`)

- [~] **2.1.1** Add `deployment_designs` table DDL inside existing `initDatabase()` function (after current table definitions)
- [~] **2.1.2** Add `deployment_runs` table DDL with FK to `deployment_designs`
- [~] **2.1.3** Add indexes: `idx_designs_document_id`, `idx_runs_design_id`
- [~] **2.1.4** Ensure `db` singleton is exported (or re-export for use by `deploymentStore.ts`)
- [~] **2.1.5** Run app â€” verify tables created in SQLite on startup (check with DB browser or `sqlite3` CLI)

### 2.2 â€” Deployment Store (`src/main/deployment/deploymentStore.ts`)

- [~] **2.2.1** Import `db` singleton from `docs/storage.ts`
- [~] **2.2.2** Implement `saveDesign(design): string` â€” INSERT, return generated UUID
- [~] **2.2.3** Implement `updateDesign(id, partial): void` â€” UPDATE with `updated_at = now`
- [~] **2.2.4** Implement `getDesign(id): DeploymentDesign` â€” parse `design_json` from row
- [~] **2.2.5** Implement `listDesigns(): DesignSummary[]` â€” return id, documentId, status, createdAt, updatedAt
- [~] **2.2.6** Implement `deleteDesign(id): void`
- [~] **2.2.7** Implement `saveRun(run): string` â€” INSERT, return generated UUID
- [~] **2.2.8** Implement `updateRun(id, partial): void`
- [~] **2.2.9** Implement `getRun(id): DeploymentRunState` â€” parse `state_json`
- [~] **2.2.10** Implement `getRunsForDesign(designId): DeploymentRunState[]`

### 2.3 â€” Mermaid Generator (`src/main/deployment/mermaidGenerator.ts`)

- [~] **2.3.1** Implement `generateTopologyDiagram(design: DeploymentDesign): string`
  - `graph TD` with `subgraph` per VM (label = VM name + IP)
  - Service nodes: `svc_<id>["<name>\n<ip>:<port>"]`
  - Dependency arrows: `svc_a -->|CONFIG_KEY| svc_b`
- [~] **2.3.2** Implement `generateStateDiagram(design, runState: DeploymentRunState): string`
  - Same topology as above
  - Add `classDef` for: `pending` (grey), `deploying` (orange), `healthy` (green), `failed` (red)
  - Append `:::className` to each service node based on `runState.serviceStates[id].status`
- [~] **2.3.3** Handle edge case: services not yet in `runState.serviceStates` default to `:::pending`
- [~] **2.3.4** Manual test: paste output into mermaid.live â€” VM subgraphs render; arrows are labeled

### 2.4 â€” Runbook Generator (`src/main/deployment/runbookGenerator.ts`)

- [~] **2.4.1** Implement `generateFullRunbook(design: DeploymentDesign): string`
  - Header: product name, version, mode, date
  - Environment summary table: service | VM | IP | ports
  - Deployment order section (numbered list from `dependencyGraph.deploymentOrder`)
  - Per-VM section loop â†’ per-service section loop
- [~] **2.4.2** Per-service section includes:
  - Prerequisite install steps (filtered `isPrerequisite: true`)
  - Main install steps (filtered `isPrerequisite: false`)
  - Dependency injection block: `export <configKey>=<resolvedIp>` for each `requiresConfigFrom` entry
  - Health check procedure (command matching `healthCheck.type`)
- [~] **2.4.3** Implement `generateServiceRunbook(serviceId, design): string` â€” single-service slice of the above
- [~] **2.4.4** Implement `generateSummaryReport(design, runState, validationResults: ValidationResult[]): string`
  - Deployment outcome (complete / failed)
  - Per-service status table
  - Endpoint inventory: all `isPublic: true` ports with `http(s)://<ip>:<port>`
  - Infrastructure summary: VMs created, snapshots taken
- [~] **2.4.5** Manual test: open generated markdown in preview â€” sections present, config injection block visible

---

## Phase 3 â€” Infrastructure Planning

### 3.1 â€” IP Pool Manager (`src/main/deployment/ipPoolManager.ts`)

- [~] **3.1.1** Implement `allocateIpsForDesign(design: DeploymentDesign): Promise<Record<string, string>>`
  - Identify unique VMs in `design.vms`
  - Call `vcdApi.allocateFreeIp()` for each VM concurrently via `Promise.all()`
  - Map: all services on the same VM share that VM's IP (distinct ports only)
  - Build and return `ipAssignments: Record<serviceId, ip>`
- [~] **3.1.2** On partial allocation failure: save partial allocations to `deploymentStore`, throw `IpAllocationError` with which VMs succeeded and which failed
- [~] **3.1.3** Implement `recordIpRelease(designId, vmId): void` â€” store-only (no VCD API call)
- [~] **3.1.4** Manual test: call against VCD â€” verify unique IPs returned, no collision

### 3.2 â€” VM Placement Engine (`src/main/deployment/vmPlacementEngine.ts`)

- [~] **3.2.1** Implement `planVmTopology(intel: DeploymentIntelligence, modeName: string): VmPlan[]`
  - Select `DeploymentMode` by `modeName` from `intel.products[0].deploymentModes` (or first product if multi-product)
  - Map each `serviceAssignments` entry to a `VmPlan`
  - Derive `osRequirement` from union of constituent services' `supportedOS`
  - OS conflict detection: if services on same VM have non-overlapping `supportedOS`, throw `OsConflictError`
  - Derive `resourceHints` from max of constituent services' `resourceRequirements`
- [~] **3.2.2** Implement `buildDeploymentDesign(intel, modeName, ipAssignments): DeploymentDesign`
  - Call `planVmTopology()`
  - Call `buildDependencyGraph()` from `dependencyAnalyzer.ts`
  - Assign IPs from `ipAssignments` to `VmPlan.ip` and per-service entries
  - Call `mermaidGenerator.generateTopologyDiagram()` â†’ populate `design.mermaid`
  - Call `runbookGenerator.generateFullRunbook()` â†’ populate `design.runbook`
  - Return fully composed `DeploymentDesign`
- [~] **3.2.3** Manual test: call with extracted ILM intelligence + `modeName: 'single-node'` â€” verify `vms` list, `ipAssignments`, `mermaid`, `runbook` all populated

---

## Phase 4 â€” Deployment Orchestration

### 4.1 â€” Health Validation Engine (`src/main/deployment/healthValidationEngine.ts`)

- [~] **4.1.1** Implement `checkPortOpen(sessionId, host, port, timeoutS): Promise<boolean>`
  - SSH command: `nc -z -w<timeoutS> <host> <port>`
  - Returns true if exit code 0
- [~] **4.1.2** Implement `checkHttpEndpoint(sessionId, url, expectedStatus): Promise<boolean>`
  - SSH command: `curl -s -o /dev/null -w "%{http_code}" <url>`
  - Returns true if response matches `expectedStatus`
- [~] **4.1.3** Implement `checkProcessRunning(sessionId, processName): Promise<boolean>`
  - SSH command: `pgrep -x <processName>`
  - Returns true if exit code 0
- [~] **4.1.4** Implement `checkSystemdService(sessionId, unit): Promise<boolean>`
  - Delegates to existing `ssh:checkService` tool via `toolRegistry.execute()`
- [~] **4.1.5** Implement `validateService(sessionId, spec, design): Promise<ValidationResult>`
  - Dispatch to correct check based on `spec.healthCheck.type`
  - Retry up to 3Ã—, 30 s sleep between attempts
  - Return `{ serviceId, passed, detail, durationMs }`
- [~] **4.1.6** Implement `validateAllServices(sessionId, vmPlan, design): Promise<ValidationResult[]>`
- [~] **4.1.7** Unit test: `checkPortOpen` against known open port on test VM â†’ `true`
- [~] **4.1.8** Unit test: `checkPortOpen` against closed port â†’ `false` after timeout

### 4.2 â€” Rollback Manager (`src/main/deployment/rollbackManager.ts`)

- [~] **4.2.1** Implement `snapshotBeforeDeployment(design): Promise<Record<string, string>>`
  - For each unique VM in `design.vms`: call `vcdApi.createSnapshot()` concurrently via `Promise.all()`
  - Snapshot name: `pre-deploy-<designId>-<timestamp>`
  - Return `vmName â†’ snapshotName` map
- [~] **4.2.2** Implement `rollbackVm(vmName, snapshotName): Promise<void>`
  - Call `vcdApi.revertSnapshot({ vmNameOrHref: vmName })`
- [~] **4.2.3** Implement `rollbackDeployment(runId): Promise<void>`
  - Load run from `deploymentStore.getRun(runId)`
  - Load design from `deploymentStore.getDesign(run.designId)`
  - Iterate `design.dependencyGraph.teardownOrder`, call `rollbackVm()` per unique VM name
  - Execute serially (teardown order matters)
  - Update `runState.phase = 'rolledback'`

### 4.3 â€” Deployment Orchestrator (`src/main/deployment/deploymentOrchestrator.ts`)

- [~] **4.3.1** Implement `cancelledRuns: Set<string>` module-level cancellation flag
- [~] **4.3.2** Implement `start(designId: string): Promise<string>` â€” returns `runId`
- [~] **4.3.3** **Phase A â€” Provision (parallel):**
  - [~] **4.3.3a** `taskTracker.createTask()` â€” store `taskId` in `runState`
  - [~] **4.3.3b** `rollbackManager.snapshotBeforeDeployment(design)` â€” concurrent snapshots
  - [~] **4.3.3c** `vcdApi.createVmFromTemplate()` for each `VmPlan` â€” all concurrent via `Promise.all()`
  - [~] **4.3.3d** Poll `vcdApi.checkVmStatus()` every 15 s (max 10 min) for all VMs to reach `POWERED_ON`
  - [~] **4.3.3e** SSH connect all VMs concurrently via `ssh:connect` â€” store in `runState.vmSessions`
  - [~] **4.3.3f** Emit `deployment:state-update` IPC event (`phase: 'connecting'`)
- [~] **4.3.4** **Phase B â€” Deploy services (level-by-level):**
  - [~] **4.3.4a** Iterate `dependencyGraph.levels[]` (leaf-first, index 0 = deepest leaves)
  - [~] **4.3.4b** For each level: `Promise.all()` all services in that level
  - [~] **4.3.4c** Per service: `taskTracker.beginStep()`, inject dependency env vars, run prerequisites, run install script
  - [~] **4.3.4d** Per service: `healthValidationEngine.validateService()` â€” retry Ã— 3, 30 s backoff
  - [~] **4.3.4e** On health pass: update `serviceState.status = 'healthy'`, regenerate Mermaid, emit `deployment:state-update`
  - [~] **4.3.4f** On health fail: update `serviceState.status = 'failed'`, emit `deployment:state-update`, throw to trigger rollback
  - [~] **4.3.4g** Check `cancelledRuns` at the start of each level iteration
  - [~] **4.3.4h** Update `runState.currentLevel` before each level
- [~] **4.3.5** **Rollback on failure:**
  - [~] **4.3.5a** Catch thrown error from Phase B
  - [~] **4.3.5b** Call `rollbackManager.rollbackDeployment(runId)`
  - [~] **4.3.5c** Set `runState.phase = 'rolledback'`
  - [~] **4.3.5d** Emit `deployment:failed` IPC event
- [~] **4.3.6** **Final validation:**
  - [~] **4.3.6a** Call `healthValidationEngine.validateAllServices()` for all VMs
  - [~] **4.3.6b** Collect all `ValidationResult[]`
- [~] **4.3.7** **Summary:**
  - [~] **4.3.7a** Call `runbookGenerator.generateSummaryReport(design, runState, results)`
  - [~] **4.3.7b** Set `runState.summaryReport`, `runState.phase = 'complete'`, `runState.completedAt`
  - [~] **4.3.7c** `deploymentStore.updateRun(runId, runState)`
  - [~] **4.3.7d** Emit `deployment:complete` IPC event with `{ runId, mermaid, summaryReport }`
- [~] **4.3.8** Implement `cancel(runId: string): Promise<void>`
  - Add `runId` to `cancelledRuns`
  - Call `rollbackManager.rollbackDeployment(runId)`
  - Emit `deployment:failed` with reason `'cancelled'`
- [~] **4.3.9** Integration test: deploy 2-VM design â€” verify both VMs provisioned concurrently (< 5 s apart)
- [~] **4.3.10** Integration test: deploy with 2 leaf services â€” verify install steps begin concurrently
- [~] **4.3.11** Integration test: inject health check failure â€” verify rollback triggered, `deployment:failed` received
- [~] **4.3.12** Integration test: cancel mid-deployment â€” verify `deployment:failed` with reason `'cancelled'`

---

## Phase 5 â€” Tool & IPC Integration

### 5.1 â€” Deployment Tool Category (`src/main/tools/categories/deployment/index.ts`)

- [~] **5.1.1** Register `deployment:analyzeDoc` â€” safe, calls `extractFromDocument(docId, { strategy: 'auto' })` â€” Zod schema: `{ docId: string, strategy?: string }`
- [~] **5.1.2** Register `deployment:generateDesign` â€” safe, calls `buildDeploymentDesign(intel, modeName)` + `deploymentStore.saveDesign()` â€” Zod schema: `{ intel: object, modeName: string }`
- [~] **5.1.3** Register `deployment:listDesigns` â€” safe, calls `deploymentStore.listDesigns()` â€” no args
- [~] **5.1.4** Register `deployment:getDesign` â€” safe, calls `deploymentStore.getDesign(id)` â€” Zod schema: `{ designId: string }`
- [~] **5.1.5** Register `deployment:updateDesign` â€” review, accepts modified design JSON, re-runs `buildDependencyGraph()`, regenerates Mermaid + runbook, saves â€” Zod schema: `{ designId: string, designJson: string }`
- [~] **5.1.6** Register `deployment:assignIps` â€” review, calls `ipPoolManager.allocateIpsForDesign()` + `deploymentStore.updateDesign()` â€” Zod schema: `{ designId: string }`
- [~] **5.1.7** Register `deployment:startDeployment` â€” dangerous, calls `deploymentOrchestrator.start(designId)` â€” Zod schema: `{ designId: string }`
- [~] **5.1.8** Register `deployment:getRunStatus` â€” safe, calls `deploymentStore.getRun(runId)` â€” Zod schema: `{ runId: string }`
- [~] **5.1.9** Register `deployment:cancelDeployment` â€” dangerous, calls `deploymentOrchestrator.cancel(runId)` â€” Zod schema: `{ runId: string }`
- [~] **5.1.10** Register `deployment:validateEndpoints` â€” safe, calls `healthValidationEngine.validateAllServices()` â€” Zod schema: `{ designId: string }`
- [~] **5.1.11** Export `registerDeploymentTools()` function

### 5.2 â€” IPC Handlers (`src/main/ipcHandlers.ts`)

- [~] **5.2.1** Add `ipcMain.handle('deployment:analyze', ...)` â†’ `extractFromDocument(docId, options)`
- [~] **5.2.2** Add `ipcMain.handle('deployment:generate', ...)` â†’ `buildDeploymentDesign(intel, mode)`
- [~] **5.2.3** Add `ipcMain.handle('deployment:list', ...)` â†’ `deploymentStore.listDesigns()`
- [~] **5.2.4** Add `ipcMain.handle('deployment:get', ...)` â†’ `deploymentStore.getDesign(id)`
- [~] **5.2.5** Add `ipcMain.handle('deployment:update', ...)` â†’ re-analyze + regenerate design
- [~] **5.2.6** Add `ipcMain.handle('deployment:assignIps', ...)` â†’ `ipPoolManager.allocateIpsForDesign()`
- [~] **5.2.7** Add `ipcMain.handle('deployment:start', ...)` â†’ `deploymentOrchestrator.start(designId)`
- [~] **5.2.8** Add `ipcMain.handle('deployment:runStatus', ...)` â†’ `deploymentStore.getRun(runId)`
- [~] **5.2.9** Add `ipcMain.handle('deployment:cancel', ...)` â†’ `deploymentOrchestrator.cancel(runId)`
- [~] **5.2.10** Add `ipcMain.handle('deployment:validateEndpoints', ...)` â†’ `healthValidationEngine.validateAllServices()`

### 5.3 â€” System Prompt Extension (`src/main/copilotChatApi.ts`)

- [~] **5.3.1** Add `â”€â”€ DEPLOYMENT INTELLIGENCE â”€â”€` section to `TOOL_SYSTEM_PROMPT`
- [~] **5.3.2** Add tool bindings for all 10 deployment tools in `chatWithTools()` alongside existing VCD/SSH/docs tools

### 5.4 â€” Tool Registry (`src/main/tools/registry.ts`)

- [~] **5.4.1** Import `registerDeploymentTools` from `./categories/deployment`
- [~] **5.4.2** Call `registerDeploymentTools()` inside `initializeDefaultTools()`

---

## Phase 6 â€” Build Verification

- [~] **6.1** `npm run build` â€” zero new TypeScript compile errors
- [~] **6.2** All 10 deployment tools appear in `window.copilot.listTools()` response
- [~] **6.3** `deployment:analyze` IPC call returns structured JSON for existing ILM doc
- [~] **6.4** Generated Mermaid renders correctly in mermaid.live
- [~] **6.5** Generated runbook has all VM sections, install steps, dependency injection block
- [~] **6.6** `deployment:assignIps` allocates unique IPs from VCD pool
- [~] **6.7** Full end-to-end: upload doc â†’ analyze â†’ generate design â†’ assign IPs â†’ start deployment â†’ monitor `deployment:state-update` events â†’ verify `deployment:complete`
- [~] **6.8** Chat prompt "Analyze the uploaded ILM guide and generate a deployment design" â†’ AI calls `deployment:analyzeDoc` then `deployment:generateDesign`
- [~] **6.9** Chat prompt "Deploy it" â†’ AI calls `deployment:assignIps` (approval) then `deployment:startDeployment` (approval)

---

## Discovered During Implementation

> Add new todos here as they surface during coding. Include the date and a brief reason.
### Discovered During Implementation — 2025-05-21

- [~] **D.1** storage.ts exports getDocumentDb() not raw db — deploymentStore.ts uses getDocumentDb() instead
- [~] **D.2** pipeline.ts callLlm() was not exported — added export to enable reuse by extractor
- [~] **D.3** ToolCategory did not include 'deployment' — added to src/main/tools/types.ts
- [~] **D.4** Search function is searchChunksByText() not search() — updated extractor accordingly
- [~] **D.5** createVmFromTemplate() requires VCD-specific infra params — added DeploymentParams interface to orchestrator

- [ ] _(example) **D.1** [2026-05-21] Fix: `docs/storage.ts` does not export `db` â€” need to add export_

---

## Deferred / Out of Scope

> Items explicitly out of scope for this plan. Do not implement unless the plan is updated.

- [ ] ~~Renderer components (frontend phase)~~
- [ ] ~~Docker/K8s orchestration (`deployOn: 'docker'|'k8s'` modelled in types only)~~
- [ ] ~~Vector embeddings / semantic search~~
- [ ] ~~Neo4j / Redis external storage~~
- [ ] ~~Multi-product multi-doc extraction~~
- [ ] ~~IP release via VCD API~~

