import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';

import type { DeploymentPlan, ServiceStatus } from '../renderer/deploymentTypes';

const serviceStatusSchema = z.enum(['pending', 'provisioning', 'installing', 'running', 'failed', 'health-check', 'complete']);

const serviceNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  vmName: z.string(),
  ip: z.string().optional(),
  port: z.number().optional(),
  os: z.string().optional(),
  prerequisites: z.array(z.string()),
  runbook: z.string(),
  healthCheckCommand: z.string().optional(),
  healthCheckUrl: z.string().optional(),
  dependsOn: z.array(z.string()),
  status: serviceStatusSchema,
  statusMessage: z.string().optional(),
  deploymentLog: z.string().optional(),
});

const deploymentPlanSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  mermaidDiagram: z.string(),
  services: z.array(serviceNodeSchema),
  deploymentMode: z.enum(['single-vm', 'distributed', 'custom']),
  sourceDocumentation: z.string().optional(),
  markdownSummary: z.string(),
  status: z.enum(['draft', 'ready', 'deploying', 'complete', 'failed']),
  ipPoolSource: z.string(),
});

const DEPLOYING_SERVICE_STATUSES: ServiceStatus[] = ['provisioning', 'installing', 'health-check'];

function parseDeploymentPlan(data: string): DeploymentPlan | null {
  try {
    const parsed = deploymentPlanSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function getStorePath(): string {
  const userDataPath = app.getPath('userData');
  const dir = path.join(userDataPath, 'deployment-plans');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function saveDeploymentPlan(plan: DeploymentPlan): void {
  const filePath = path.join(getStorePath(), `${plan.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(plan, null, 2), 'utf-8');
}

export function loadDeploymentPlan(planId: string): DeploymentPlan | null {
  const filePath = path.join(getStorePath(), `${planId}.json`);
  if (!fs.existsSync(filePath)) return null;
  const data = fs.readFileSync(filePath, 'utf-8');
  return parseDeploymentPlan(data);
}

export function listDeploymentPlans(): Array<Pick<DeploymentPlan, 'id' | 'name' | 'createdAt' | 'status'>> {
  const dir = getStorePath();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  return files.reduce<Array<Pick<DeploymentPlan, 'id' | 'name' | 'createdAt' | 'status'>>>((plans, fileName) => {
    const data = parseDeploymentPlan(fs.readFileSync(path.join(dir, fileName), 'utf-8'));
    if (data) {
      plans.push({ id: data.id, name: data.name, createdAt: data.createdAt, status: data.status });
    }
    return plans;
  }, []);
}

export function deleteDeploymentPlan(planId: string): boolean {
  const filePath = path.join(getStorePath(), `${planId}.json`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

export function updateServiceStatus(
  planId: string,
  serviceId: string,
  status: ServiceStatus,
  statusMessage?: string,
  deploymentLog?: string
): DeploymentPlan | null {
  const plan = loadDeploymentPlan(planId);
  if (!plan) return null;
  const service = plan.services.find(s => s.id === serviceId);
  if (!service) return null;
  service.status = status;
  if (statusMessage !== undefined) service.statusMessage = statusMessage;
  if (deploymentLog !== undefined) service.deploymentLog = (service.deploymentLog || '') + deploymentLog;
  plan.updatedAt = new Date().toISOString();

  // Update overall plan status
  const allComplete = plan.services.every(s => s.status === 'complete');
  const anyFailed = plan.services.some(s => s.status === 'failed');
  const anyDeploying = plan.services.some(s => DEPLOYING_SERVICE_STATUSES.includes(s.status));
  if (allComplete) plan.status = 'complete';
  else if (anyFailed) plan.status = 'failed';
  else if (anyDeploying) plan.status = 'deploying';

  saveDeploymentPlan(plan);
  return plan;
}
