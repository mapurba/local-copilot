/**
 * Deployment Tool Category
 *
 * Registers 10 deployment intelligence tools in the tool registry.
 * All tools use Zod schemas for LangChain compatibility.
 */

import { z } from 'zod';
import { toolRegistry } from '../../registry';
import { extractFromDocument } from '../../../deployment/deploymentExtractor';
import { buildDeploymentDesign } from '../../../deployment/vmPlacementEngine';
import {
  saveDesign,
  updateDesign,
  getDesign,
  listDesigns,
  getRun,
} from '../../../deployment/deploymentStore';
import { allocateIpsForDesign, IpAllocationError } from '../../../deployment/ipPoolManager';
// import { allocateFreeIp } from '../../vcdApi';
import { buildDependencyGraph } from '../../../deployment/dependencyAnalyzer';
import { generateTopologyDiagram } from '../../../deployment/mermaidGenerator';
import { generateFullRunbook } from '../../../deployment/runbookGenerator';
import { validateAllServices } from '../../../deployment/healthValidationEngine';
import { start as startDeployment, cancel as cancelDeployment } from '../../../deployment/deploymentOrchestrator';
import { DeploymentIntelligence } from '../../../deployment/types';
import { getFreeIps } from '../../../vcdApi';

export function registerDeploymentTools(): void {
  // ── deployment:analyzeAndDesign ───────────────────────────────────────────
  // PRIMARY tool for the LLM. Combines extract + design in one call so the
  // large DeploymentIntelligence object never has to flow through LLM context.
  toolRegistry.register(
    'deployment:analyzeAndDesign',
    async (args: { docId: string; modeName?: string; strategy?: string; rawContent?: string }) => {
      if (!args.docId || args.docId === 'none' || args.docId === '') {
        return {
          error: 'No docId provided. Please call docs_list to find an uploaded document, then retry with the correct docId.',
        };
      }
      const intel = await extractFromDocument(args.docId, {
        strategy: (args.strategy as 'auto' | 'single-pass' | 'chunked') ?? 'auto',
      }, args.rawContent);
      const mode = args.modeName ?? 'distributed';
      const design = buildDeploymentDesign(intel, mode);
      const id = saveDesign(design);

      // Auto-allocate IPs so the mermaid diagram always shows real IPs
      try {
        const ipAssignments = await allocateIpsForDesign(design);
        for (const vm of design.vms) {
          const ip = ipAssignments[vm.services[0]?.id];
          if (ip) vm.ip = ip;
        }
        design.ipAssignments = ipAssignments;
        design.mermaid = generateTopologyDiagram(design);
        design.runbook = generateFullRunbook(design);
        updateDesign(id, design);
      } catch (err) {
        // Partial or full failure — still return the design, just with some ?.?.?.? IPs
        if (err instanceof IpAllocationError) {
          for (const vm of design.vms) {
            const ip = err.succeeded[vm.id];
            if (ip) vm.ip = ip;
          }
          design.ipAssignments = Object.fromEntries(
            design.vms.flatMap((vm) =>
              vm.services.map((svc) => [svc.id, vm.ip ?? '?.?.?.?'])
            )
          );
          design.mermaid = generateTopologyDiagram(design);
          design.runbook = generateFullRunbook(design);
          updateDesign(id, design);
        } else {
          console.warn('[analyzeAndDesign] IP allocation failed, returning design without IPs:', err);
        }
      }

      // Return only what the LLM needs to render — not the full intel blob
      const firstProduct = intel.products?.[0];
      return {
        designId: id,
        productName: firstProduct?.name ?? 'Unknown Product',
        productVersion: firstProduct?.version,
        mode,
        vmCount: design.vms.length,
        vms: design.vms.map((v) => ({
          id: v.id,
          role: v.role,
          services: v.services.map((s) => s.name).join(', '),
          os: v.osRequirement?.type ?? 'Linux',
          vcpu: v.resourceHints?.minCpuCores ?? 4,
          ramGb: Math.round((v.resourceHints?.minMemoryMb ?? 8192) / 1024),
          diskGb: v.resourceHints?.minDiskGb ?? 40,
          ip: v.ip ?? '?.?.?.?',
        })),
        ipAssignments: design.ipAssignments ?? {},
        mermaid: design.mermaid,
        installOrder: design.dependencyGraph?.levels
          ?.flat()
          .map((svcId) => {
            const vm = design.vms.find((v) => v.services.some((s) => s.id === svcId));
            const svc = vm?.services.find((s) => s.id === svcId);
            return svc?.name ?? svcId;
          })
          .filter(Boolean) ?? [],
        runbookSummary: design.runbook?.split('\n').slice(0, 30).join('\n') ?? '',
      };
    },
    {
      category: 'deployment',
      description:
        'PRIMARY deployment tool. Given a docId and deployment mode, extracts product intelligence from the document then generates the full deployment design (VM topology, dependency graph, Mermaid diagram, runbook) in one step. Returns designId, mermaid diagram, VM list, and install order. Use this instead of calling deployment:analyzeDoc + deployment:generateDesign separately.',
      target: 'local',
      riskLevel: 'safe',
      schema: z.object({
        docId: z.string().describe('Document ID (from docs_list or from [Document: ... | docId: XXX] in context)'),
        modeName: z.string().optional().describe('Deployment mode: "distributed", "ha", or "single-node". Default: "distributed"'),
        strategy: z.enum(['auto', 'single-pass', 'chunked']).optional().describe('Extraction strategy. Default: auto'),        rawContent: z.string().optional().describe('Full document text if already available (e.g. from attached doc in context). Skips DB chunk reads for better accuracy.'),      }),
    }
  );

  // ── deployment:analyzeDoc (kept for advanced use) ─────────────────────────
  toolRegistry.register(
    'deployment:analyzeDoc',
    async (args: { docId: string; strategy?: string }) => {
      const intel = await extractFromDocument(args.docId, {
        strategy: (args.strategy as 'auto' | 'single-pass' | 'chunked') ?? 'auto',
      });
      const firstProduct = intel.products?.[0];
      // Return a compact summary instead of the full intel to avoid context overflow
      return {
        docId: args.docId,
        productName: firstProduct?.name ?? 'Unknown',
        productVersion: firstProduct?.version,
        services: firstProduct?.services?.map((s) => ({ id: s.id, name: s.name, role: s.role })) ?? [],
        modes: intel.deploymentModes?.map((m) => m.name) ?? [],
        note: 'Call deployment:analyzeAndDesign instead to generate the full design in one step.',
      };
    },
    {
      category: 'deployment',
      description:
        'Extract deployment intelligence summary from a document. Returns service list and available modes. For a full design, use deployment:analyzeAndDesign instead.',
      target: 'local',
      riskLevel: 'safe',
      schema: z.object({
        docId: z.string().describe('Document ID from the docs store'),
        strategy: z
          .enum(['auto', 'single-pass', 'chunked'])
          .optional()
          .describe('Extraction strategy. Default: auto'),
      }),
    }
  );

  // ── deployment:generateDesign ─────────────────────────────────────────────
  toolRegistry.register(
    'deployment:generateDesign',
    async (args: { intel: DeploymentIntelligence; modeName: string }) => {
      const design = buildDeploymentDesign(args.intel, args.modeName);
      const id = saveDesign(design);
      return { designId: id, mermaid: design.mermaid, vmCount: design.vms.length };
    },
    {
      category: 'deployment',
      description:
        'Generate a deployment design from a DeploymentIntelligence object. Prefer deployment:analyzeAndDesign which does both steps in one call.',
      target: 'local',
      riskLevel: 'safe',
      schema: z.object({
        intel: z.record(z.unknown()).describe('DeploymentIntelligence from deployment:analyzeDoc'),
        modeName: z.string().describe('Deployment mode name'),
      }),
    }
  );

  // ── deployment:listDesigns ────────────────────────────────────────────────
  toolRegistry.register(
    'deployment:listDesigns',
    async () => listDesigns(),
    {
      category: 'deployment',
      description: 'List all saved deployment designs with their status.',
      target: 'local',
      riskLevel: 'safe',
      schema: z.object({}),
    }
  );

  // ── deployment:getDesign ──────────────────────────────────────────────────
  toolRegistry.register(
    'deployment:getDesign',
    async (args: { designId: string }) => getDesign(args.designId),
    {
      category: 'deployment',
      description: 'Get the full details of a saved deployment design by ID.',
      target: 'local',
      riskLevel: 'safe',
      schema: z.object({
        designId: z.string().describe('Deployment design ID'),
      }),
    }
  );

  // ── deployment:updateDesign ───────────────────────────────────────────────
  toolRegistry.register(
    'deployment:updateDesign',
    async (args: { designId: string; designJson: string }) => {
      const partial = JSON.parse(args.designJson) as Partial<import('../../../deployment/types').DeploymentDesign>;
      const existing = getDesign(args.designId);

      // If services changed, rebuild dependency graph and regenerate diagram/runbook
      const merged = { ...existing, ...partial };
      if (partial.vms || partial.intelligence) {
        const allServices = merged.vms.flatMap((v) => v.services);
        merged.dependencyGraph = buildDependencyGraph(allServices);
        merged.mermaid = generateTopologyDiagram(merged);
        merged.runbook = generateFullRunbook(merged);
      }

      updateDesign(args.designId, merged);
      return { designId: args.designId, updated: true };
    },
    {
      category: 'deployment',
      description:
        'Update an existing deployment design with new data. Automatically rebuilds the dependency graph, Mermaid diagram, and runbook if VMs or services changed.',
      target: 'local',
      riskLevel: 'review',
      schema: z.object({
        designId: z.string().describe('Deployment design ID'),
        designJson: z
          .string()
          .describe('JSON string of the partial DeploymentDesign fields to update'),
      }),
    }
  );

  // ── deployment:assignIps ──────────────────────────────────────────────────
  toolRegistry.register(
    'deployment:assignIps',
    async (args: { designId: string }) => {
      const design = getDesign(args.designId);
      let ipAssignments: Record<string, string> = {};
      const partialErrors: string[] = [];
      try {
        ipAssignments = await allocateIpsForDesign(design);
      } catch (err) {
        if (err instanceof IpAllocationError) {
          // Recover partial successes (succeeded is vmId → ip)
          for (const vm of design.vms) {
            const ip = err.succeeded[vm.id];
            if (ip) {
              vm.ip = ip;
              for (const svc of vm.services) ipAssignments[svc.id] = ip;
            }
          }
          partialErrors.push(err.message);
        } else {
          throw err;
        }
      }
      // Apply IPs to VmPlans (covers full-success path)
      for (const vm of design.vms) {
        const ip = ipAssignments[vm.services[0]?.id];
        if (ip) vm.ip = ip;
      }
      design.ipAssignments = ipAssignments;
      design.mermaid = generateTopologyDiagram(design);
      design.runbook = generateFullRunbook(design);
      updateDesign(args.designId, design);
      return {
        designId: args.designId,
        ipAssignments,
        ...(partialErrors.length > 0 ? { partialErrors } : {}),
      };
    },
    {
      category: 'deployment',
      description:
        'Allocate real IPs from the IP management service (http://164.99.91.31:5100) for every VM in a saved design. Updates the design with the assigned IPs and regenerates the diagram and runbook. Use this whenever the user asks about IP requirements for a deployment design.',
      // NOTE: does NOT require VCD context — calls the standalone IP allocation API
      target: 'local',
      riskLevel: 'review',
      schema: z.object({
        designId: z.string().describe('Deployment design ID'),
      }),
    }
  );

  // ── deployment:startDeployment ────────────────────────────────────────────
  toolRegistry.register(
    'deployment:startDeployment',
    async (args: {
      designId: string;
      org: string;
      templateVmId: string;
      sshUsername: string;
      sshPassword?: string;
      sshPrivateKey?: string;
    }) => {
      const runId = await startDeployment(args.designId, {
        org: args.org,
        templateVmId: args.templateVmId,
        sshUsername: args.sshUsername,
        sshPassword: args.sshPassword,
        sshPrivateKey: args.sshPrivateKey,
      });
      return { runId, message: 'Deployment started. Monitor progress via deployment:getRunStatus or deployment:state-update IPC events.' };
    },
    {
      category: 'deployment',
      description:
        'Start an autonomous deployment run for the given design. Provisions VMs, deploys services in dependency order, validates health, and generates a summary report. Returns runId immediately.',
      target: 'local',
      riskLevel: 'dangerous',
      schema: z.object({
        designId: z.string().describe('Deployment design ID'),
        org: z.string().describe('VCD organisation name (e.g. ban2_identity_ilm)'),
        templateVmId: z.string().describe('Template VM ID from VCD catalog'),
        sshUsername: z.string().describe('SSH username for provisioned VMs'),
        sshPassword: z.string().optional().describe('SSH password'),
        sshPrivateKey: z.string().optional().describe('SSH private key (alternative to password)'),
      }),
    }
  );

  // ── deployment:getRunStatus ───────────────────────────────────────────────
  toolRegistry.register(
    'deployment:getRunStatus',
    async (args: { runId: string }) => {
      const run = getRun(args.runId);
      return {
        runId: run.runId,
        phase: run.phase,
        currentLevel: run.currentLevel,
        serviceStates: run.serviceStates,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        summaryReport: run.summaryReport,
      };
    },
    {
      category: 'deployment',
      description: 'Get the current status of a deployment run by runId.',
      target: 'local',
      riskLevel: 'safe',
      schema: z.object({
        runId: z.string().describe('Deployment run ID from deployment:startDeployment'),
      }),
    }
  );

  // ── deployment:cancelDeployment ───────────────────────────────────────────
  toolRegistry.register(
    'deployment:cancelDeployment',
    async (args: { runId: string }) => {
      await cancelDeployment(args.runId);
      return { runId: args.runId, message: 'Cancellation requested. Rollback in progress.' };
    },
    {
      category: 'deployment',
      description:
        'Cancel an in-progress deployment run. Triggers rollback to pre-deployment snapshots.',
      target: 'local',
      riskLevel: 'dangerous',
      schema: z.object({
        runId: z.string().describe('Deployment run ID to cancel'),
      }),
    }
  );

  // ── deployment:validateEndpoints ──────────────────────────────────────────
  toolRegistry.register(
    'deployment:validateEndpoints',
    async (args: { designId: string }) => {
      const design = getDesign(args.designId);
      const allResults: import('../../../deployment/types').ValidationResult[] = [];

      // Get the latest run's sessions if available
      const { getRunsForDesign } = await import('../../../deployment/deploymentStore');
      const runs = getRunsForDesign(args.designId);
      const latestRun = runs[0];

      if (!latestRun) {
        return { error: 'No deployment run found for this design.' };
      }

      for (const vm of design.vms) {
        const sessionId = latestRun.vmSessions[vm.id];
        if (!sessionId) continue;
        const results = await validateAllServices(sessionId, vm, design);
        allResults.push(...results);
      }

      return { designId: args.designId, results: allResults };
    },
    {
      category: 'deployment',
      description:
        'Run health checks for all services in a deployed design using the most recent run\'s SSH sessions.',
      target: 'local',
      riskLevel: 'safe',
      schema: z.object({
        designId: z.string().describe('Deployment design ID'),
      }),
    }
  );

  // ── deployment:previewIps ────────────────────────────────────────────────
  // Use this when the user asks about IPs without having a saved designId.
  // Allocates `count` real IPs from the IP service and shows them labelled.
  toolRegistry.register(
    'deployment:previewIps',
    async (args: { vmNames: string[] }) => {
      // Fetch all free IPs at once and slice — avoids the same-IP problem
      // that occurs when calling /allocate repeatedly (the server has no
      // per-session state and returns the same IP until one is deployed).
      const freeResult = await getFreeIps();
      if (!freeResult.success || !freeResult.ips || freeResult.ips.length === 0) {
        return { error: freeResult.error ?? 'IP pool is empty or unreachable' };
      }
      const available = [...freeResult.ips];
      const assignments = args.vmNames.map((name) => {
        const ip = available.shift() ?? null;
        return { vm: name, ip, error: ip ? undefined : 'IP pool exhausted' };
      });
      return {
        source: 'IP management service (http://164.99.91.31:5100)',
        assignments,
        note: 'These are real IPs from the VCD IP pool — not examples or placeholders.',
      };
    },
    {
      category: 'deployment',
      description:
        '⚠ REQUIRED for ALL IP requests. Allocate and preview real IPs from the IP management service for a list of VM names. ' +
        'Call this WHENEVER the user asks about IP requirements, IPs for a deployment, what IPs are needed, or show IP addresses — ' +
        'even if the deployment plan was already discussed in this conversation. ' +
        'NEVER answer an IP question without calling this tool first. ' +
        'Returns one real IP per VM name from the live IP pool at http://164.99.91.31:5100.',
      target: 'local',
      riskLevel: 'safe',
      schema: z.object({
        vmNames: z
          .array(z.string())
          .describe('List of VM/component names to allocate IPs for (e.g. ["idm-engine", "idm-apps", "idm-db"])'),
      }),
    }
  );

  // ── deployment:dryRun ─────────────────────────────────────────────────────
  // Full dry run: extract → design → allocate IPs → generate summary + mermaid + resource list
  // No VMs are created. Safe to call at any time.
  toolRegistry.register(
    'deployment:dryRun',
    async (args: { docId: string; modeName?: string; strategy?: string; rawContent?: string }) => {
      if (!args.docId || args.docId === 'none' || args.docId === '') {
        return { error: 'No docId provided. Call docs:list to find an uploaded document, then retry.' };
      }

      // 1. Extract deployment intelligence (use rawContent if provided to avoid DB re-reads)
      const intel = await extractFromDocument(
        args.docId,
        { strategy: (args.strategy as 'auto' | 'single-pass' | 'chunked') ?? 'auto' },
        args.rawContent
      );

      const mode = args.modeName ?? 'distributed';

      // 2. Build design (without IPs first)
      const design = buildDeploymentDesign(intel, mode, {});

      // 3. Allocate real IPs for each VM from the IP pool
      let ipAssignments: Record<string, string> = {};
      const ipErrors: string[] = [];
      try {
        ipAssignments = await allocateIpsForDesign(design);
        // Apply IPs back into the design
        for (const vm of design.vms) {
          const ip = ipAssignments[vm.services[0]?.id];
          if (ip) vm.ip = ip;
        }
        design.ipAssignments = ipAssignments;
        // Regenerate diagram and runbook now that IPs are assigned
        const { generateTopologyDiagram: genDiagram } = await import('../../../deployment/mermaidGenerator');
        const { generateFullRunbook: genRunbook } = await import('../../../deployment/runbookGenerator');
        design.mermaid = genDiagram(design);
        design.runbook = genRunbook(design);
      } catch (err) {
        // Recover partial successes from IpAllocationError (succeeded is vmId → ip)
        if (err instanceof IpAllocationError && Object.keys(err.succeeded).length > 0) {
          for (const vm of design.vms) {
            const ip = err.succeeded[vm.id];
            if (ip) {
              vm.ip = ip;
              for (const svc of vm.services) ipAssignments[svc.id] = ip;
            }
          }
          design.ipAssignments = ipAssignments;
        }
        ipErrors.push(err instanceof Error ? err.message : String(err));
        console.warn('[dryRun] IP allocation partial/failed:', ipErrors);
      }

      // 4. Save design (status stays 'draft' — no actual deployment)
      const designId = saveDesign(design);

      // 5. Build resource utilization list
      const firstProduct = intel.products?.[0];
      const resourceList = design.vms.map((vm) => ({
        vmId: vm.id,
        role: vm.role,
        ip: vm.ip ?? ipAssignments[vm.services[0]?.id] ?? 'pending',
        os: vm.osRequirement?.type ?? 'linux',
        vCPU: vm.resourceHints?.minCpuCores ?? 2,
        ramGb: Math.round((vm.resourceHints?.minMemoryMb ?? 4096) / 1024),
        diskGb: vm.resourceHints?.minDiskGb ?? 40,
        services: vm.services.map((s) => ({
          id: s.id,
          name: s.name,
          role: s.role,
          ports: s.ports.map((p) => `${p.port}/${p.protocol}`).join(', '),
        })),
      }));

      // 6. Build dry-run summary
      const totalVCpu = resourceList.reduce((sum, v) => sum + v.vCPU, 0);
      const totalRamGb = resourceList.reduce((sum, v) => sum + v.ramGb, 0);
      const totalDiskGb = resourceList.reduce((sum, v) => sum + v.diskGb, 0);
      const installOrder = (design.dependencyGraph?.levels ?? [])
        .flat()
        .map((svcId) => {
          const vm = design.vms.find((v) => v.services.some((s) => s.id === svcId));
          const svc = vm?.services.find((s) => s.id === svcId);
          return svc ? `${svc.name} (${vm?.role ?? 'unknown'})` : svcId;
        });

      return {
        dryRun: true,
        designId,
        productName: firstProduct?.name ?? 'Unknown Product',
        productVersion: firstProduct?.version,
        mode,
        mermaid: design.mermaid,
        resourceUtilization: {
          vmCount: design.vms.length,
          totalVCpu,
          totalRamGb,
          totalDiskGb,
          vms: resourceList,
        },
        ipAssignments: Object.keys(ipAssignments).length > 0 ? ipAssignments : null,
        ipErrors: ipErrors.length > 0 ? ipErrors : undefined,
        installOrder,
        warnings: intel.extractionWarnings,
        note: 'This is a dry run — no VMs have been created. Use deployment:startDeployment with this designId to execute.',
      };
    },
    {
      category: 'deployment',
      description:
        'DRY RUN: Analyze a document, generate a complete deployment design, allocate real IPs, and return a dry-run summary with Mermaid diagram and resource utilization table — WITHOUT creating any VMs or running any commands. ' +
        'Use this when the user says "dry run", "simulate deployment", "show me the plan", or "what would be deployed". ' +
        'Returns: designId, mermaid diagram, per-VM resource list (vCPU/RAM/disk/IPs), install order, and warnings.',
      target: 'local',
      riskLevel: 'safe',
      schema: z.object({
        docId: z.string().describe('Document ID (from docs:list or from [Document: ... | docId: XXX] in context)'),
        modeName: z.string().optional().describe('Deployment mode: "distributed", "ha", or "single-node". Default: "distributed"'),
        strategy: z.enum(['auto', 'single-pass', 'chunked']).optional().describe('Extraction strategy. Default: auto'),
        rawContent: z.string().optional().describe('Full document text if already in context (improves accuracy by skipping DB chunk reads)'),
      }),
    }
  );

  // ── deployment:getFreeIps ─────────────────────────────────────────────────
  // Returns all currently free (unallocated) IPs from the IP pool service.
  // Useful for checking how many IPs are available before a large deployment.
  toolRegistry.register(
    'deployment:getFreeIps',
    async () => {
      const result = await getFreeIps();
      if (!result.success) {
        return { error: result.error ?? 'Failed to fetch free IPs from pool' };
      }
      return {
        source: 'IP management service (http://164.99.91.31:5100/api/res-ip/free)',
        freeIpCount: result.count ?? 0,
        freeIps: result.ips ?? [],
        note: 'These IPs are currently unallocated in the VCD IP pool.',
      };
    },
    {
      category: 'deployment',
      description:
        'Get all currently free (unallocated) IPs from the IP pool service. ' +
        'Call this to check IP availability before a deployment or when the user asks how many IPs are available. ' +
        'Returns the full list of free IPs and a count.',
      target: 'local',
      riskLevel: 'safe',
      schema: z.object({}),
    }
  );

  console.log('[Deployment Tools] Registered 13 deployment tools');
}
