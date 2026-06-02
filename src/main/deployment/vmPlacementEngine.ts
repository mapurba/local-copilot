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
  InstallStep,
  PortSpec,
  ConfigKey,
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
  let mode = intel.deploymentModes.find((m) => m.name === modeName)
    ?? intel.deploymentModes[0];

  // When extraction produced no deployment modes (e.g. very short / ambiguous document),
  // synthesise a single-node fallback that colocates all services on one VM.
  if (!mode) {
    const allServiceIds = intel.products.flatMap((p) => p.services.map((s) => s.id));
    mode = {
      name: 'single-node',
      vmCount: 1,
      description: 'Single-node deployment (auto-generated — no topology was defined in the document)',
      serviceAssignments: allServiceIds.length > 0 ? { 'all-in-one': allServiceIds } : {},
    };
  }

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

// ── Single-VM consolidation ──────────────────────────────────────────────────

/**
 * When a deployment mode targets a single VM, merge all services on that VM
 * into one synthetic "all-in-one" ServiceSpec so the UI shows ONE deployable
 * unit and the runbook is a single sequential document.
 *
 * Steps are ordered by dependency relationships (dependencies first), with
 * prerequisites before main steps within each group. Duplicate commands are
 * deduplicated.
 */
function consolidateServicesForSingleNode(vm: VmPlan, productName: string): VmPlan {
  const services = vm.services;
  if (services.length <= 1) return vm;

  // Order services by dependency relationships (leaf/dependency services first)
  const depGraph = buildDependencyGraph(services);
  const orderedIds = depGraph.deploymentOrder;
  const orderedServices: ServiceSpec[] = orderedIds
    .map((id) => services.find((s) => s.id === id))
    .filter((s): s is ServiceSpec => s !== undefined);

  // Safety: append any service not captured by the graph
  for (const svc of services) {
    if (!orderedServices.find((s) => s.id === svc.id)) orderedServices.push(svc);
  }

  // Merge install steps: prerequisites first (in dep order), then main steps
  const allPrereqs: InstallStep[] = [];
  const allMainSteps: InstallStep[] = [];
  const seenCommands = new Set<string>();

  for (const svc of orderedServices) {
    for (const step of svc.installSteps) {
      const dedupeKey = (step.command ?? step.description).trim();
      if (seenCommands.has(dedupeKey)) continue;
      seenCommands.add(dedupeKey);
      if (step.isPrerequisite) {
        allPrereqs.push(step);
      } else {
        allMainSteps.push(step);
      }
    }
  }

  const mergedSteps: InstallStep[] = [
    ...allPrereqs.map((s, i) => ({ ...s, stepNumber: i + 1 })),
    ...allMainSteps.map((s, i) => ({ ...s, stepNumber: allPrereqs.length + i + 1 })),
  ];

  // Merge ports (deduplicate by port number)
  const portMap = new Map<number, PortSpec>();
  for (const svc of orderedServices) {
    for (const p of svc.ports) {
      if (!portMap.has(p.port)) portMap.set(p.port, p);
    }
  }

  // Merge configKeys (deduplicate by key name)
  const configKeyMap = new Map<string, ConfigKey>();
  for (const svc of orderedServices) {
    for (const ck of svc.configKeys) {
      if (!configKeyMap.has(ck.key)) configKeyMap.set(ck.key, ck);
    }
  }

  // Use the primary service's health check; fall back to the last ordered service
  const primary =
    orderedServices.find((s) => s.role === 'primary') ??
    orderedServices[orderedServices.length - 1];

  const consolidated: ServiceSpec = {
    id: 'all-in-one',
    name: `${productName} (All-in-One)`,
    role: 'primary',
    deployOn: 'vm',
    ports: Array.from(portMap.values()),
    installSteps: mergedSteps,
    healthCheck: primary.healthCheck,
    configKeys: Array.from(configKeyMap.values()),
    requiresConfigFrom: [], // all dependencies are now internal
    resourceRequirements: maxResourceSpec(orderedServices.map((s) => s.resourceRequirements)),
  };

  return { ...vm, services: [consolidated] };
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
  let vms = planVmTopology(intel, modeName);

  // Apply IPs to VmPlans before any consolidation so vm.ip is set
  for (const vm of vms) {
    const firstServiceIp = ipAssignments[vm.services[0]?.id];
    if (firstServiceIp) {
      vm.ip = firstServiceIp;
    }
  }

  // ── Single-VM consolidation ─────────────────────────────────────────────────
  // When the chosen deployment mode targets a single VM, merge all services
  // into one so the user gets ONE deployable unit with a single runbook instead
  // of N separate deployment steps.
  const selectedMode =
    intel.deploymentModes.find((m) => m.name === modeName) ?? intel.deploymentModes[0];
  const isSingleNode = (selectedMode?.vmCount ?? vms.length) === 1 || vms.length === 1;
  if (isSingleNode) {
    const productName = intel.products[0]?.name ?? 'Product';
    vms = vms.map((vm) => {
      const consolidated = consolidateServicesForSingleNode(vm, productName);
      // Keep the IP accessible by the consolidated service id for runbook generation
      if (vm.ip) ipAssignments[consolidated.services[0].id] = vm.ip;
      return consolidated;
    });
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
  design.mermaid = generateTopologyDiagram(design, intel);
  design.runbook = generateFullRunbook(design, intel);

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
