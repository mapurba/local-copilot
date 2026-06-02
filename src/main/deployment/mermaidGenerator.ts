/**
 * Mermaid Generator
 *
 * Produces Mermaid.js diagram strings from a DeploymentDesign.
 * Generates:
 *   - topology diagram (static layout with VM subgraphs)
 *   - state diagram (same topology + colour classes per service status)
 */

import { DeploymentDesign, DeploymentIntelligence, DeploymentRunState } from './types';

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Generate a static topology diagram showing VM subgraphs,
 * service nodes (with IP:port), and labelled dependency arrows.
 */
export function generateTopologyDiagram(
  design: DeploymentDesign,
  intelligence: DeploymentIntelligence = design.intelligence
): string {
  const productName = intelligence.products[0]?.name ?? 'Unknown Product';
  const lines: string[] = ['graph TD', `%% Product: ${productName}`, ''];

  // Build a map: serviceId → VmPlan
  const serviceToVm = new Map<string, { vmId: string; vmName: string; ip: string }>();
  for (const vm of design.vms) {
    for (const svc of vm.services) {
      serviceToVm.set(svc.id, {
        vmId: vm.id,
        vmName: vm.vmName ?? vm.id,
        ip: vm.ip ?? '?.?.?.?',
      });
    }
  }

  // VM subgraphs
  for (const vm of design.vms) {
    const label = `${vm.vmName ?? vm.id} (${vm.ip ?? '?.?.?.?'})`;
    lines.push(`subgraph ${sanitizeId(vm.id)}["${label}"]`);
    for (const svc of vm.services) {
      const mainPort = svc.ports.find((p) => p.isPublic) ?? svc.ports[0];
      const portLabel = mainPort ? `${vm.ip ?? '?'}:${mainPort.port}` : (vm.ip ?? '?');
      lines.push(`  ${sanitizeId('svc_' + svc.id)}["${svc.name}\\n${portLabel}"]`);
    }
    lines.push('end');
    lines.push('');
  }

  // Dependency arrows
  for (const edge of design.dependencyGraph.edges) {
    const keyLabel = edge.configKeys.slice(0, 2).join(', ') || '';
    const arrow = keyLabel
      ? `${sanitizeId('svc_' + edge.from)} --> ${sanitizeId('svc_' + edge.to)}`
      : `${sanitizeId('svc_' + edge.from)} --> ${sanitizeId('svc_' + edge.to)}`;
    lines.push(arrow);
  }

  return lines.join('\n');
}

/**
 * Generate a state diagram — same topology as generateTopologyDiagram but
 * with classDef colour blocks and :::className suffixes based on run state.
 */
export function generateStateDiagram(
  design: DeploymentDesign,
  runState: DeploymentRunState
): string {
  const base = generateTopologyDiagram(design);

  const classDefs = [
    'classDef pending   fill:#888,color:#fff',
    'classDef deploying fill:#f90,color:#fff',
    'classDef healthy   fill:#2d2,color:#fff',
    'classDef failed    fill:#d22,color:#fff',
  ].join('\n');

  const classAssignments: string[] = [];
  for (const vm of design.vms) {
    for (const svc of vm.services) {
      const state = runState.serviceStates[svc.id];
      let cssClass = 'pending';
      if (state) {
        switch (state.status) {
          case 'installing':
          case 'configuring':
          case 'starting':
            cssClass = 'deploying';
            break;
          case 'healthy':
            cssClass = 'healthy';
            break;
          case 'failed':
            cssClass = 'failed';
            break;
          default:
            cssClass = 'pending';
        }
      }
      classAssignments.push(`class ${sanitizeId('svc_' + svc.id)} ${cssClass}`);
    }
  }

  return [base, '', classDefs, '', ...classAssignments].join('\n');
}
