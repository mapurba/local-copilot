export type ServiceStatus = 'pending' | 'provisioning' | 'installing' | 'running' | 'failed' | 'health-check' | 'complete';

export interface ServiceNode {
  id: string;
  name: string;
  description: string;
  vmName: string;
  templateId?: string;
  templateName?: string;
  ip?: string;
  port?: number;
  os?: string;
  prerequisites: string[];
  runbook: string;
  healthCheckCommand?: string;
  healthCheckUrl?: string;
  dependsOn: string[];
  status: ServiceStatus;
  statusMessage?: string;
  deploymentLog?: string;
}

export interface DeploymentPlan {
  id: string;
  designId: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  mermaidDiagram: string;
  services: ServiceNode[];
  deploymentMode: string;
  sourceDocumentation?: string;
  markdownSummary: string;
  status: 'draft' | 'ready' | 'deploying' | 'complete' | 'failed';
  // Optional plan-level global VM template (template id and name)
  vm_template_id?: string;
  vm_template_name?: string;
}