/**
 * Graph Helpers
 *
 * Utility functions shared between the HITL deployment graph and the IPC layer.
 * Extracted here to avoid a circular dependency with copilotChatApi.ts.
 */

import { getDesign } from '../deploymentStore';
import { generateServiceRunbook } from '../runbookGenerator';

// ── Shell script extractor ────────────────────────────────────────────────────

function extractShellScriptFromRunbook(markdown: string): string {
  if (!markdown) return '';
  const blocks: string[] = [];
  const regex = /```bash\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const block = (match[1] || '').trim();
    if (block) blocks.push(block);
  }
  return blocks.join('\n\n').trim();
}

// ── Payload builder ───────────────────────────────────────────────────────────

/**
 * Build the `deployment:planReady` IPC payload from a saved design.
 * Mirrors the same function in copilotChatApi.ts so both code paths
 * emit identical payloads to the renderer.
 */
export function buildDeploymentPlanPayload(
  designId: string,
  modeName?: string
): Record<string, unknown> {
  const design = getDesign(designId);
  const createdAt = new Date(design.createdAt || Date.now()).toISOString();
  const updatedAt = new Date(design.updatedAt || Date.now()).toISOString();

  const services = design.vms.flatMap((vm) => {
    const osLabel = [vm.osRequirement?.type, vm.osRequirement?.minVersion]
      .filter(Boolean)
      .join(' ');

    return vm.services.map((svc) => {
      const runbookMarkdown = generateServiceRunbook(svc.id, design);
      const extractedScript = extractShellScriptFromRunbook(runbookMarkdown);
      const fallbackScript = svc.installSteps
        .map((step) => step.command)
        .filter((cmd): cmd is string => Boolean(cmd))
        .join('\n');

      const resolvedIp = vm.ip || design.ipAssignments?.[svc.id];
      const ipRef =
        !resolvedIp || resolvedIp === '?.?.?.?'
          ? svc.configKeys.find((ck) => ck.valueType === 'host' || !ck.valueType)?.key
            ? `$${svc.configKeys.find((ck) => ck.valueType === 'host' || !ck.valueType)!.key}`
            : '${TARGET_HOST}'
          : resolvedIp;

      const healthCheckCommand =
        svc.healthCheck?.type === 'http'
          ? `curl -f ${svc.healthCheck.target}`
          : svc.healthCheck?.type === 'port'
          ? `nc -z -w${svc.healthCheck.timeoutSeconds} ${ipRef} ${svc.healthCheck.target}`
          : svc.healthCheck?.type === 'systemctl'
          ? `systemctl is-active ${svc.healthCheck.target}`
          : svc.healthCheck?.type === 'process'
          ? `pgrep -x ${svc.healthCheck.target}`
          : undefined;

      return {
        id: svc.id,
        name: svc.name,
        description: `${svc.role} service deployed on ${vm.role}`,
        vmName: vm.vmName || vm.id,
        ip: vm.ip || design.ipAssignments?.[svc.id],
        port: svc.ports?.[0]?.port,
        vm_template_id: vm.templateId || '',
        os: osLabel || undefined,
        prerequisites: svc.installSteps
          .filter((step) => step.isPrerequisite)
          .map((step) => step.description),
        runbook: (() => {
          let script = extractedScript || fallbackScript || '';
          if (script && !script.startsWith('#!')) script = `#!/bin/bash\n\n${script}`;
          return script || '#!/bin/bash\n# No runbook defined yet';
        })(),
        healthCheckCommand,
        dependsOn: svc.requiresConfigFrom || [],
        status: 'pending',
      };
    });
  });

  return {
    id: `plan-${design.id}`,
    designId: design.id,
    name: `${design.intelligence.products?.[0]?.name || 'Deployment'} Plan`,
    description: 'Deployment plan generated via HITL workflow.',
    createdAt,
    updatedAt,
    mermaidDiagram: design.mermaid || 'graph TD\n  A[No diagram available]',
    services,
    deploymentMode:
      modeName || design.intelligence.deploymentModes?.[0]?.name || 'distributed',
    sourceDocumentation: design.documentId,
    markdownSummary: design.runbook || '# Deployment Runbook\n\nNo runbook available.',
    status: 'approved',
  };
}
