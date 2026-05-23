/**
 * Runbook Generator
 *
 * Produces Markdown runbooks from a DeploymentDesign.
 * Three outputs:
 *   - Full runbook (all VMs, all services, deployment order)
 *   - Single-service runbook slice
 *   - Post-deployment summary report
 */

import {
  DeploymentDesign,
  DeploymentRunState,
  ServiceSpec,
  VmPlan,
  ValidationResult,
} from './types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function codeBlock(lang: string, content: string): string {
  return `\`\`\`${lang}\n${content}\n\`\`\``;
}

function buildDependencyInjectionBlock(
  service: ServiceSpec,
  design: DeploymentDesign
): string | null {
  if (service.requiresConfigFrom.length === 0) return null;

  const lines: string[] = [];
  for (const depId of service.requiresConfigFrom) {
    const depIp = design.ipAssignments[depId] ?? '(unknown)';
    const depVm = design.vms.find((v) => v.services.some((s) => s.id === depId));
    const depService = depVm?.services.find((s) => s.id === depId);
    if (depService) {
      for (const ck of depService.configKeys) {
        lines.push(`export ${ck.key}=${depIp}  # ${ck.description}`);
      }
      // Add port env vars for public ports
      for (const port of depService.ports.filter((p) => p.isPublic)) {
        lines.push(`export ${depId.toUpperCase().replace(/-/g, '_')}_PORT=${port.port}  # ${port.description}`);
      }
    }
  }
  return lines.length > 0 ? codeBlock('bash', lines.join('\n')) : null;
}

function buildHealthCheckProcedure(service: ServiceSpec, ip: string): string {
  const hc = service.healthCheck;
  switch (hc.type) {
    case 'port':
      return codeBlock('bash', `nc -z -w${hc.timeoutSeconds} ${ip} ${hc.target}`);
    case 'http':
      return codeBlock('bash', `curl -s -o /dev/null -w "%{http_code}" ${hc.target.startsWith('http') ? hc.target : `http://${ip}${hc.target}`}`);
    case 'process':
      return codeBlock('bash', `pgrep -x ${hc.target}`);
    case 'systemctl':
      return codeBlock('bash', `systemctl is-active ${hc.target}`);
    default:
      return codeBlock('bash', `# health check: ${hc.type} ${hc.target}`);
  }
}

function serviceSection(service: ServiceSpec, vm: VmPlan, design: DeploymentDesign): string {
  const ip = vm.ip ?? '?.?.?.?';
  const sections: string[] = [`### Service: ${service.name}`, ''];

  // Prerequisites
  const prereqs = service.installSteps.filter((s) => s.isPrerequisite);
  if (prereqs.length > 0) {
    sections.push('#### Prerequisites');
    for (const step of prereqs) {
      sections.push(`${step.stepNumber}. ${step.description}`);
      if (step.command) sections.push(codeBlock('bash', step.command));
    }
    sections.push('');
  }

  // Install steps
  const mainSteps = service.installSteps.filter((s) => !s.isPrerequisite);
  if (mainSteps.length > 0) {
    sections.push('#### Install Steps');
    for (const step of mainSteps) {
      sections.push(`${step.stepNumber}. ${step.description}`);
      if (step.command) sections.push(codeBlock('bash', step.command));
    }
    sections.push('');
  }

  // Dependency injection
  const depBlock = buildDependencyInjectionBlock(service, design);
  if (depBlock) {
    sections.push('#### Dependency Injection');
    sections.push('Set these environment variables before starting the service:');
    sections.push(depBlock);
    sections.push('');
  }

  // Health check
  sections.push('#### Health Check');
  sections.push(buildHealthCheckProcedure(service, ip));
  sections.push('');

  return sections.join('\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate the complete deployment runbook for the full design.
 */
export function generateFullRunbook(design: DeploymentDesign): string {
  const product = design.intelligence.products[0];
  const lines: string[] = [];

  lines.push(`# ${product?.name ?? 'Product'} Deployment Runbook`);
  lines.push('');
  lines.push(`**Mode:** ${design.intelligence.deploymentModes[0]?.name ?? 'default'}`);
  lines.push(`**Generated:** ${formatDate(Date.now())}`);
  lines.push('');

  // Environment summary table
  lines.push('## Environment Summary');
  lines.push('');
  lines.push('| Service | VM | IP | Ports |');
  lines.push('|---|---|---|---|');
  for (const vm of design.vms) {
    for (const svc of vm.services) {
      const ports = svc.ports.map((p) => `${p.port}/${p.protocol}`).join(', ') || '-';
      lines.push(`| ${svc.name} | ${vm.vmName ?? vm.id} | ${vm.ip ?? '?'} | ${ports} |`);
    }
  }
  lines.push('');

  // Deployment order
  lines.push('## Deployment Order');
  lines.push('');
  design.dependencyGraph.deploymentOrder.forEach((svcId, i) => {
    const vm = design.vms.find((v) => v.services.some((s) => s.id === svcId));
    const svc = vm?.services.find((s) => s.id === svcId);
    if (!svc) return;
    const deps = svc.requiresConfigFrom.length > 0
      ? ` — depends on ${svc.requiresConfigFrom.join(', ')}`
      : '';
    lines.push(`${i + 1}. **${svc.name}** (${vm?.vmName ?? vm?.id ?? '?'})${deps}`);
  });
  lines.push('');

  // Per-VM sections
  for (const vm of design.vms) {
    lines.push(`## ${vm.vmName ?? vm.id} Runbook`);
    lines.push('');
    lines.push(`**IP:** ${vm.ip ?? '(to be assigned)'}`);
    lines.push(`**OS:** ${vm.osRequirement.type} ${vm.osRequirement.minVersion ?? ''}`);
    lines.push('');

    for (const svc of vm.services) {
      lines.push(serviceSection(svc, vm, design));
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate a runbook slice for a single service.
 */
export function generateServiceRunbook(serviceId: string, design: DeploymentDesign): string {
  const vm = design.vms.find((v) => v.services.some((s) => s.id === serviceId));
  const svc = vm?.services.find((s) => s.id === serviceId);
  if (!vm || !svc) return `# Service not found: ${serviceId}`;

  const lines: string[] = [
    `# ${svc.name} — Service Runbook`,
    '',
    `**VM:** ${vm.vmName ?? vm.id}  `,
    `**IP:** ${vm.ip ?? '(to be assigned)'}  `,
    `**Role:** ${svc.role}`,
    '',
    serviceSection(svc, vm, design),
  ];
  return lines.join('\n');
}

/**
 * Generate a post-deployment summary report.
 */
export function generateSummaryReport(
  design: DeploymentDesign,
  runState: DeploymentRunState,
  validationResults: ValidationResult[]
): string {
  const product = design.intelligence.products[0];
  const outcome = runState.phase === 'complete' ? '✅ Deployment Complete' : '❌ Deployment Failed';
  const lines: string[] = [];

  lines.push(`# Deployment Summary Report`);
  lines.push('');
  lines.push(`**Product:** ${product?.name ?? 'Unknown'}  `);
  lines.push(`**Outcome:** ${outcome}  `);
  lines.push(`**Started:** ${formatDate(runState.startedAt)}  `);
  if (runState.completedAt) {
    const durationMs = runState.completedAt - runState.startedAt;
    lines.push(`**Completed:** ${formatDate(runState.completedAt)} (${Math.round(durationMs / 1000)}s)  `);
  }
  lines.push('');

  // Service status table
  lines.push('## Service Status');
  lines.push('');
  lines.push('| Service | VM | IP | Status |');
  lines.push('|---|---|---|---|');
  for (const vm of design.vms) {
    for (const svc of vm.services) {
      const state = runState.serviceStates[svc.id];
      const status = state?.status ?? 'pending';
      const emoji = status === 'healthy' ? '✅' : status === 'failed' ? '❌' : '⏳';
      lines.push(`| ${svc.name} | ${vm.vmName ?? vm.id} | ${vm.ip ?? '?'} | ${emoji} ${status} |`);
    }
  }
  lines.push('');

  // Endpoint inventory (public ports)
  const publicEndpoints: string[] = [];
  for (const vm of design.vms) {
    for (const svc of vm.services) {
      const state = runState.serviceStates[svc.id];
      if (state?.status !== 'healthy') continue;
      for (const port of svc.ports.filter((p) => p.isPublic)) {
        const proto = port.port === 443 || port.port === 8443 ? 'https' : 'http';
        publicEndpoints.push(`- **${svc.name}**: ${proto}://${vm.ip ?? '?'}:${port.port} (${port.description})`);
      }
    }
  }
  if (publicEndpoints.length > 0) {
    lines.push('## Endpoint Inventory');
    lines.push('');
    lines.push(...publicEndpoints);
    lines.push('');
  }

  // Validation results
  if (validationResults.length > 0) {
    lines.push('## Health Check Results');
    lines.push('');
    lines.push('| Service | Passed | Duration | Detail |');
    lines.push('|---|---|---|---|');
    for (const vr of validationResults) {
      const icon = vr.passed ? '✅' : '❌';
      lines.push(`| ${vr.serviceId} | ${icon} | ${vr.durationMs}ms | ${vr.detail} |`);
    }
    lines.push('');
  }

  // Infrastructure summary
  const snapshotCount = Object.keys(runState.snapshotNames).length;
  const vmCount = design.vms.length;
  lines.push('## Infrastructure Summary');
  lines.push('');
  lines.push(`- **VMs provisioned:** ${vmCount}`);
  lines.push(`- **Snapshots taken:** ${snapshotCount}`);
  if (snapshotCount > 0) {
    for (const [vmName, snapName] of Object.entries(runState.snapshotNames)) {
      lines.push(`  - ${vmName}: \`${snapName}\``);
    }
  }
  lines.push('');

  return lines.join('\n');
}
