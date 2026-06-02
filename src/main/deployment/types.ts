/**
 * Deployment Intelligence Types
 *
 * All interfaces shared across the deployment pipeline:
 * extraction → design → planning → orchestration → validation
 */

// ── Extraction ────────────────────────────────────────────────────────────────

export interface OSRequirement {
  type: string;          // 'sles' | 'rhel' | 'ubuntu' | ...
  minVersion?: string;   // '15.4'
  maxVersion?: string;
}

export interface PortSpec {
  port: number;
  protocol: 'tcp' | 'udp';
  description: string;
  isPublic: boolean;     // externally accessible endpoint
}

export interface ConfigKey {
  key: string;           // env var name this service exports (e.g. 'DB_HOST')
  description: string;
  /**
   * Semantic type assigned by the LLM during extraction.
   * - 'host'       → connection endpoint / IP address / hostname / URL
   * - 'port'       → port number
   * - 'credential' → password, secret, API key, token
   * - 'name'       → database name, schema, tenant, username, display name
   * - 'path'       → file system path or directory
   * - 'other'      → anything that does not fit the categories above
   *
   * Plans extracted before this field was added will have `valueType` undefined;
   * runbookGenerator falls back to heuristic name-matching in that case.
   */
  valueType?: 'host' | 'port' | 'credential' | 'name' | 'path' | 'other';
}

export interface InstallStep {
  osType?: string;       // undefined = applies to all OS types
  stepNumber: number;
  description: string;
  command?: string;
  isPrerequisite: boolean;
  expectedExitCode: number;
  timeoutSeconds?: number;
}

export interface HealthCheckSpec {
  type: 'port' | 'http' | 'process' | 'systemctl';
  target: string;            // port number, URL path, process name, or systemd unit
  expectedStatus?: string;   // '200', 'active', etc.
  timeoutSeconds: number;
  retryIntervalSeconds: number;
}

export interface ResourceSpec {
  minCpuCores?: number;
  minMemoryMb?: number;
  minDiskGb?: number;
}

export interface ServiceSpec {
  id: string;                      // stable slug, e.g. 'identity-service'
  name: string;
  role: 'primary' | 'dependency' | 'optional';
  deployOn: 'vm' | 'docker' | 'k8s';
  ports: PortSpec[];
  installSteps: InstallStep[];
  healthCheck: HealthCheckSpec;
  configKeys: ConfigKey[];         // what this service exposes to dependents
  requiresConfigFrom: string[];    // service IDs whose IPs/ports this service needs at startup
  resourceRequirements?: ResourceSpec;
}

export interface DeploymentMode {
  name: string;                                        // 'single-node' | 'distributed' | 'ha'
  vmCount: number;
  description: string;
  serviceAssignments: Record<string, string[]>;        // vmRole → serviceId[]
}

export interface ProductSpec {
  name: string;
  version?: string;
  supportedOS: OSRequirement[];
  services: ServiceSpec[];
}

export interface DeploymentIntelligence {
  documentId: string;
  products: ProductSpec[];
  deploymentModes: DeploymentMode[];
  extractedAt: number;
  extractionStrategy: 'single-pass' | 'chunked';
  extractionWarnings: string[];
}

// ── Extraction options ────────────────────────────────────────────────────────

export interface ExtractionOptions {
  strategy?: 'auto' | 'single-pass' | 'chunked';  // default: 'auto'
}

// ── Design ────────────────────────────────────────────────────────────────────

export interface VmPlan {
  id: string;                  // 'vm-01', 'vm-02'
  role: string;                // maps to DeploymentMode.serviceAssignments key
  services: ServiceSpec[];
  osRequirement: OSRequirement;
  resourceHints: ResourceSpec;
  vmName?: string;             // assigned during IP/infra planning
  ip?: string;                 // assigned during IP planning
  // Optional template UUID discovered from runbook/docs (e.g. TEMPLATE_ID: xxxxxxxx-xxxx...)
  templateId?: string;
}

export interface DependencyEdge {
  from: string;                // serviceId
  to: string;                  // serviceId (from depends on to)
  configKeys: string[];        // which config keys flow across this edge
}

export interface DependencyGraph {
  nodes: string[];             // serviceId[]
  edges: DependencyEdge[];
  deploymentOrder: string[];   // topological leaf-first (deploy bottom-up)
  teardownOrder: string[];     // reverse (teardown top-down)
  levels: string[][];          // services at same topological level (parallel candidates)
}

export interface DeploymentDesign {
  id: string;
  documentId: string;
  intelligence: DeploymentIntelligence;
  vms: VmPlan[];
  ipAssignments: Record<string, string>;  // serviceId → ip
  dependencyGraph: DependencyGraph;
  mermaid?: string;
  runbook?: string;
  status: 'draft' | 'approved' | 'deploying' | 'deployed' | 'failed';
  createdAt: number;
  updatedAt: number;
}

// ── Run State ─────────────────────────────────────────────────────────────────

export type ServiceDeployStatus =
  | 'pending' | 'installing' | 'configuring' | 'starting'
  | 'healthy' | 'failed' | 'skipped';

export interface ServiceState {
  serviceId: string;
  status: ServiceDeployStatus;
  vmId: string;
  attempts: number;
  lastError?: string;
  deployedAt?: number;
  healthCheckedAt?: number;
}

export type OrchestratorPhase =
  | 'idle' | 'snapshotting' | 'provisioning' | 'connecting'
  | 'deploying' | 'validating' | 'complete' | 'failed' | 'rolledback';

export interface DeploymentRunState {
  runId: string;
  designId: string;
  taskId: string;                          // links to taskTracker
  serviceStates: Record<string, ServiceState>;
  vmSessions: Record<string, string>;      // vmId → sshSessionId
  snapshotNames: Record<string, string>;   // vmName → snapshotName
  phase: OrchestratorPhase;
  currentLevel: number;                    // topological level being deployed
  currentMermaid: string;
  startedAt: number;
  completedAt?: number;
  summaryReport?: string;
}

// ── Validation ────────────────────────────────────────────────────────────────

export interface ValidationResult {
  serviceId: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

// ── Design summary (for listing) ──────────────────────────────────────────────

export interface DesignSummary {
  id: string;
  documentId: string;
  status: DeploymentDesign['status'];
  createdAt: number;
  updatedAt: number;
}

// ── HITL Graph State ──────────────────────────────────────────────────────────

/**
 * The five phases of the HITL deployment state machine.
 *
 *   classifyIntent       → CHECKPOINT 1: OS / VM template?
 *   generateArchitecture → CHECKPOINT 2: Architecture approval?
 *   allocateNetwork      → CHECKPOINT 3: IPs / hostname?
 *   generateScripts      → CHECKPOINT 4: Credential env var acknowledgement?
 *   finalizeAndVisualize → CHECKPOINT 5: Final "Approve"?
 */
export type CheckpointPhase =
  | 'classifyIntent'
  | 'generateArchitecture'
  | 'allocateNetwork'
  | 'generateScripts'
  | 'finalizeAndVisualize'
  | 'complete';

/**
 * Full state object passed between nodes in the LangGraph deployment graph.
 * All fields are optional; each node reads what it needs and returns only
 * what it changes.
 */
export interface DeploymentGraphState {
  // ── Inputs ──────────────────────────────────────────────────────────────
  /** Original user prompt */
  userPrompt: string;
  /** Document ID from docs store */
  docId: string;
  /** Raw document text (if available in context — skips DB reads) */
  rawContent?: string;
  /** User-stated config/preferences collected from chat so far */
  chatContext?: string;

  // ── Checkpoint 1 answers ─────────────────────────────────────────────────
  /** Target OS extracted or confirmed by user (e.g. 'RHEL 8', 'SLES 15') */
  osPreference?: string;
  /** VCD VM template UUID for provisioning */
  vmTemplate?: string;

  // ── Checkpoint 2 answers ─────────────────────────────────────────────────
  /** Deployment mode selected/confirmed by user */
  modeName?: string;
  /** Whether the user approved the architecture draft */
  architectureApproved?: boolean;
  /** designId after initial build (may lack IPs at this stage) */
  draftDesignId?: string;

  // ── Checkpoint 3 answers ─────────────────────────────────────────────────
  /** User-supplied network details (if they want to provide their own IPs) */
  networkDetails?: {
    usePoolIps: boolean;                     // true = allocate from pool
    staticIps?: Record<string, string>;      // vmId → ip (when usePoolIps is false)
    hostname?: string;
    subnet?: string;
    gateway?: string;
  };

  // ── Checkpoint 4 answers ─────────────────────────────────────────────────
  /** Env var names the user must configure before running the install (never values) */
  credentialVarNames?: string[];
  /** Whether user acknowledged the credential vars list */
  credentialVarsAcknowledged?: boolean;

  // ── Checkpoint 5 answers ─────────────────────────────────────────────────
  /** Whether user gave final approval to save the plan */
  finalApproved?: boolean;

  // ── Internal graph state ─────────────────────────────────────────────────
  /** Current processing phase */
  phase: CheckpointPhase;
  /** Saved deployment design ID (set after architecture is saved to disk) */
  designId?: string;
  /** Non-fatal warnings accumulated during processing */
  warnings: string[];
  /** The question the graph emits when it pauses at a checkpoint */
  checkpointQuestion?: string;
  /** Structured data the UI needs to render the current checkpoint form */
  checkpointPayload?: Record<string, unknown>;
}

/**
 * The payload emitted over IPC when the graph pauses at a checkpoint.
 * The renderer uses this to show the correct input form.
 */
export interface DeploymentCheckpointPayload {
  threadId: string;
  phase: CheckpointPhase;
  /** The human-readable question to show the user */
  question: string;
  /** Extra structured data for the UI (e.g. available OS list, draft VM topology) */
  data?: Record<string, unknown>;
}
