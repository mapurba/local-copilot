// Deployment plan types shared between main and renderer processes

export type ServiceStatus = 'pending' | 'provisioning' | 'installing' | 'running' | 'failed' | 'health-check' | 'complete';

export interface ServiceNode {
  id: string;
  name: string;
  description: string;
  vmName: string;
  ip?: string;
  port?: number;
  os?: string;
  prerequisites: string[];
  runbook: string; // shell script content
  healthCheckCommand?: string;
  healthCheckUrl?: string;
  dependsOn: string[]; // IDs of services this depends on
  status: ServiceStatus;
  statusMessage?: string;
  deploymentLog?: string;
}

export interface DeploymentPlan {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  mermaidDiagram: string;
  services: ServiceNode[];
  deploymentMode: 'single-vm' | 'distributed' | 'custom';
  sourceDocumentation?: string;
  markdownSummary: string;
  status: 'draft' | 'ready' | 'deploying' | 'complete' | 'failed';
  ipPoolSource: string;
}

export interface DeploymentProgress {
  planId: string;
  currentServiceId?: string;
  completedServices: string[];
  failedServices: string[];
  overallProgress: number; // 0-100
  logs: Array<{ timestamp: string; serviceId: string; message: string; level: 'info' | 'warn' | 'error' }>;
}
