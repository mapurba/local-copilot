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
