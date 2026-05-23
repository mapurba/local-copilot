/**
 * VM Placement Engine
 *
 * Maps a DeploymentIntelligence + mode name to a fully-composed DeploymentDesign.
 * Handles:
 *   - VM topology planning from serviceAssignments
 *   - OS conflict detection across co-located services
 *   - IP assignment integration
 *   - Dependency graph building
 *   - Initial Mermaid + runbook generation
 */

import { randomUUID } from 'crypto';
import {
  DeploymentIntelligence,
  DeploymentDesign,
  VmPlan,
  ServiceSpec,
  OSRequirement,
  ResourceSpec,
} from './types';
import { buildDependencyGraph } from './dependencyAnalyzer';
import { generateTopologyDiagram } from './mermaidGenerator';
import { generateFullRunbook, generateServiceRunbook } from './runbookGenerator';

export class OsConflictError extends Error {
  constructor(vmRole: string, conflictingServices: string[]) {
    super(
      `OS conflict on VM '${vmRole}': services ${conflictingServices.join(', ')} have non-overlapping supportedOS requirements.`
    );
    this.name = 'OsConflictError';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mergeOsRequirements(osLists: OSRequirement[][]): OSRequirement {
  // Find the most restrictive common OS — prefer the most specific type
  const allTypes = osLists.flat().map((o) => o.type);
  const uniqueTypes = [...new Set(allTypes)];
  // If all same type, use that; otherwise use first (caller already validated no conflict)
  const type = uniqueTypes.length === 1 ? uniqueTypes[0] : uniqueTypes[0];

  // Pick the highest minVersion
  const minVersions = osLists.flat().map((o) => o.minVersion).filter(Boolean) as string[];
  const minVersion = minVersions.sort().pop();

  return { type, minVersion };
}

function maxResourceSpec(specs: (ResourceSpec | undefined)[]): ResourceSpec {
  const valid = specs.filter(Boolean) as ResourceSpec[];
  return {
    minCpuCores: Math.max(0, ...valid.map((r) => r.minCpuCores ?? 0)) || undefined,
    minMemoryMb: Math.max(0, ...valid.map((r) => r.minMemoryMb ?? 0)) || undefined,
    minDiskGb: Math.max(0, ...valid.map((r) => r.minDiskGb ?? 0)) || undefined,
  };
}

function osTypesOverlap(a: OSRequirement[], b: OSRequirement[]): boolean {
  if (a.length === 0 || b.length === 0) return true; // no constraint → compatible
  const aTypes = new Set(a.map((o) => o.type));
  return b.some((o) => aTypes.has(o.type));
}

// ── VM topology ───────────────────────────────────────────────────────────────

/**
 * Build VmPlan[] from a selected deployment mode.
 * Throws OsConflictError if co-located services have incompatible OS requirements.
 */
export function planVmTopology(
  intel: DeploymentIntelligence,
  modeName: string
): VmPlan[] {
  const mode = intel.deploymentModes.find((m) => m.name === modeName)
    ?? intel.deploymentModes[0];

  if (!mode) throw new Error(`Deployment mode '${modeName}' not found in intelligence.`);

  // Build a flat service map from all products
  const serviceMap = new Map<string, ServiceSpec>();
  for (const product of intel.products) {
    for (const svc of product.services) {
      serviceMap.set(svc.id, svc);
    }
  }

  const vmPlans: VmPlan[] = [];
  let vmIndex = 1;

  for (const [vmRole, serviceIds] of Object.entries(mode.serviceAssignments)) {
    const services = serviceIds
      .map((id) => serviceMap.get(id))
      .filter((s): s is ServiceSpec => s !== undefined);

    if (services.length === 0) continue;

    // OS conflict detection
    if (services.length > 1) {
      const osGroups = services.map((s) => {
        // Find product that owns this service
        for (const product of intel.products) {
          if (product.services.some((ps) => ps.id === s.id)) {
            return product.supportedOS;
          }
        }
        return [] as OSRequirement[];
      });

      for (let i = 0; i < osGroups.length - 1; i++) {
        for (let j = i + 1; j < osGroups.length; j++) {
          if (!osTypesOverlap(osGroups[i], osGroups[j])) {
            throw new OsConflictError(vmRole, [services[i].id, services[j].id]);
          }
        }
      }
    }

    // Determine OS from product supportedOS union
    const allOsLists = services.map((s) => {
      for (const product of intel.products) {
        if (product.services.some((ps) => ps.id === s.id)) return product.supportedOS;
      }
      return [] as OSRequirement[];
    });
    const validOsLists = allOsLists.filter((l) => l.length > 0);
    const osRequirement: OSRequirement = validOsLists.length > 0
      ? mergeOsRequirements(validOsLists)
      : { type: 'linux' };

    const resourceHints = maxResourceSpec(services.map((s) => s.resourceRequirements));

    vmPlans.push({
      id: `vm-${String(vmIndex).padStart(2, '0')}`,
      role: vmRole,
      services,
      osRequirement,
      resourceHints,
    });
    vmIndex++;
  }

  return vmPlans;
}

// ── Design builder ────────────────────────────────────────────────────────────

/**
 * Build a fully-composed DeploymentDesign ready for saving.
 *
 * @param intel          Extracted deployment intelligence
 * @param modeName       Name of the deployment mode to use
 * @param ipAssignments  serviceId → ip from ipPoolManager (can be empty for draft)
 */
export function buildDeploymentDesign(
  intel: DeploymentIntelligence,
  modeName: string,
  ipAssignments: Record<string, string> = {}
): DeploymentDesign {
  const vms = planVmTopology(intel, modeName);

  // Apply IPs to VmPlans
  for (const vm of vms) {
    const firstServiceIp = ipAssignments[vm.services[0]?.id];
    if (firstServiceIp) {
      vm.ip = firstServiceIp;
    }
  }

  // Collect all services for dependency graph
  const allServices = vms.flatMap((v) => v.services);
  const dependencyGraph = buildDependencyGraph(allServices);

  const design: DeploymentDesign = {
    id: randomUUID(),
    documentId: intel.documentId,
    intelligence: intel,
    vms,
    ipAssignments,
    dependencyGraph,
    status: 'draft',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Generate diagram and runbook now that IPs are known
  design.mermaid = generateTopologyDiagram(design);
  design.runbook = generateFullRunbook(design);

  // Attempt to discover a TEMPLATE UUID from each service's runbook and
  // attach it to the VmPlan so orchestration can prefer per-VM templates.
  try {
    for (const vm of design.vms) {
      let foundTemplate: string | null = null;

      for (const svc of vm.services) {
        try {
          const svcRb = generateServiceRunbook(svc.id, design);
          const tplRegexes = [/(?:TEMPLATE_ID|template_id|template-id|template)\s*[:=]\s*([0-9a-fA-F-]{36})/i, /template:\s*([0-9a-fA-F-]{36})/i];
          for (const r of tplRegexes) {
            const m = r.exec(svcRb);
            if (m) {
              foundTemplate = m[1].trim();
              break;
            }
          }
          if (!foundTemplate) {
            const uuids = Array.from(new Set((svcRb.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g) || [])));
            if (uuids.length === 1) foundTemplate = uuids[0];
          }
        } catch (e) {
          // ignore per-service extraction failures
        }
        if (foundTemplate) break;
      }

      if (foundTemplate) vm.templateId = foundTemplate;
    }
  } catch (e) {
    console.warn('[vmPlacementEngine] Failed to extract templateId:', e);
  }

  return design;
}
