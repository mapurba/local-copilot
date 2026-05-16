/**
 * VCD Tools Category
 * Wraps existing VCD API functions into the tool registry.
 */

import { toolRegistry } from '../../registry';
import { z } from 'zod';
import {
  listVms,
  listVApps,
  listTemplates,
  powerOnVm,
  powerOffVm,
  createSnapshot,
  revertSnapshot,
  createVmCopy,
  listAllSnapshots,
  updateVmResources,
  listTasks,
  normalizeVmStatus,
  getVmDetails,
  deleteVm,
  allocateFreeIp,
  checkVmStatus,
} from '../../../vcdApi';
import { getVcdContext, setVcdContext } from '../../../vcdStore';

export function registerVcdTools() {
  // ── vcd:listVms ───────────────────────────────────────────────────────────
  toolRegistry.register(
    'vcd:listVms',
    async (args: { pageSize?: number }) => {
      const result = await listVms(args.pageSize ?? 100);
      const vms = (result as { vms?: Record<string, unknown>[] }).vms ?? [];
      return { ...(result as object), vms: vms.map(normalizeVmStatus) };
    },
    {
      category: 'vcd',
      description: 'List all VMs in the current VCD tenant',
      target: 'remote',
      riskLevel: 'safe',
      schema: z.object({
        pageSize: z.number().optional().describe('Number of VMs per page (default 100)'),
      }),
    }
  );

  // ── vcd:listVapps ─────────────────────────────────────────────────────────
  toolRegistry.register(
    'vcd:listVapps',
    async (args: { pageSize?: number }) => {
      return await listVApps(args.pageSize ?? 100);
    },
    {
      category: 'vcd',
      description: 'List all vApps in the current VCD tenant',
      target: 'remote',
      riskLevel: 'safe',
      schema: z.object({
        pageSize: z.number().optional().describe('Number of vApps per page (default 100)'),
      }),
    }
  );

  // ── vcd:listTemplates ─────────────────────────────────────────────────────
  toolRegistry.register(
    'vcd:listTemplates',
    async (args: { nameFilter?: string }) => {
      return await listTemplates(args.nameFilter);
    },
    {
      category: 'vcd',
      description: 'List VM templates in VCD, optionally filtered by name',
      target: 'remote',
      riskLevel: 'safe',
      schema: z.object({
        nameFilter: z.string().optional().describe('Filter templates by name substring'),
      }),
    }
  );

  // ── vcd:getVmDetails ──────────────────────────────────────────────────────
  toolRegistry.register(
    'vcd:getVmDetails',
    async (args: { vmNameOrHref: string }) => {
      return await getVmDetails(args.vmNameOrHref);
    },
    {
      category: 'vcd',
      description: 'Get detailed information about a specific VM',
      target: 'remote',
      riskLevel: 'safe',
      schema: z.object({
        vmNameOrHref: z.string().describe('VM name or HREF'),
      }),
    }
  );

  // ── vcd:checkVmStatus ─────────────────────────────────────────────────────
  toolRegistry.register(
    'vcd:checkVmStatus',
    async (args: { vmNameOrHref: string }) => {
      return await checkVmStatus(args.vmNameOrHref);
    },
    {
      category: 'vcd',
      description: 'Check the current power status of a VM',
      target: 'remote',
      riskLevel: 'safe',
      schema: z.object({
        vmNameOrHref: z.string().describe('VM name or HREF'),
      }),
    }
  );

  // ── vcd:listTasks ─────────────────────────────────────────────────────────
  toolRegistry.register(
    'vcd:listTasks',
    async (args: { minutesAgo?: number; pageSize?: number }) => {
      return await listTasks(args.minutesAgo ?? 60, args.pageSize ?? 25);
    },
    {
      category: 'vcd',
      description: 'List recent VCD tasks (default: last 60 minutes)',
      target: 'remote',
      riskLevel: 'safe',
      schema: z.object({
        minutesAgo: z.number().optional().describe('How many minutes back to look (default 60)'),
        pageSize: z.number().optional().describe('Max number of tasks (default 25)'),
      }),
    }
  );

  // ── vcd:powerOnVm ─────────────────────────────────────────────────────────
  toolRegistry.register(
    'vcd:powerOnVm',
    async (args: { vmHref: string }) => {
      return await powerOnVm(args.vmHref);
    },
    {
      category: 'vcd',
      description: 'Power on a VM in VCD',
      target: 'remote',
      riskLevel: 'review',
      schema: z.object({
        vmHref: z.string().describe('VM HREF'),
      }),
    }
  );

  // ── vcd:powerOffVm ────────────────────────────────────────────────────────
  toolRegistry.register(
    'vcd:powerOffVm',
    async (args: { vmHref: string }) => {
      return await powerOffVm(args.vmHref);
    },
    {
      category: 'vcd',
      description: 'Power off a VM in VCD',
      target: 'remote',
      riskLevel: 'dangerous',
      schema: z.object({
        vmHref: z.string().describe('VM HREF'),
      }),
    }
  );

  // ── vcd:deleteVm ──────────────────────────────────────────────────────────
  toolRegistry.register(
    'vcd:deleteVm',
    async (args: { href: string; poweredOn?: boolean }) => {
      return await deleteVm(args.href);
    },
    {
      category: 'vcd',
      description: 'Delete a VM from VCD (irreversible)',
      target: 'remote',
      riskLevel: 'dangerous',
      schema: z.object({
        href: z.string().describe('VM HREF'),
        poweredOn: z.boolean().optional().describe('Whether the VM is currently powered on'),
      }),
    }
  );

  // ── vcd:createSnapshot ────────────────────────────────────────────────────
  toolRegistry.register(
    'vcd:createSnapshot',
    async (args: { vmNameOrHref: string; name?: string; description?: string; memory?: boolean; quiesce?: boolean }) => {
      return await createSnapshot(args.vmNameOrHref, args.name, args.memory ?? false, args.quiesce ?? false);
    },
    {
      category: 'vcd',
      description: 'Create a snapshot of a VM',
      target: 'remote',
      riskLevel: 'review',
      schema: z.object({
        vmNameOrHref: z.string().describe('VM name or HREF'),
        name: z.string().optional().describe('Snapshot name'),
        description: z.string().optional().describe('Snapshot description'),
        memory: z.boolean().optional().describe('Include memory in snapshot'),
        quiesce: z.boolean().optional().describe('Quiesce the VM before snapshotting'),
      }),
    }
  );

  // ── vcd:revertSnapshot ────────────────────────────────────────────────────
  toolRegistry.register(
    'vcd:revertSnapshot',
    async (args: { vmNameOrHref: string }) => {
      return await revertSnapshot(args.vmNameOrHref);
    },
    {
      category: 'vcd',
      description: 'Revert a VM to its latest snapshot',
      target: 'remote',
      riskLevel: 'dangerous',
      schema: z.object({
        vmNameOrHref: z.string().describe('VM name or HREF'),
      }),
    }
  );

  // ── vcd:listSnapshots ─────────────────────────────────────────────────────
  toolRegistry.register(
    'vcd:listSnapshots',
    async () => {
      return await listAllSnapshots();
    },
    {
      category: 'vcd',
      description: 'List all snapshots across all VMs in the current VDC',
      target: 'remote',
      riskLevel: 'safe',
      schema: z.object({}),
    }
  );

  // ── vcd:copyVm ────────────────────────────────────────────────────────────
  toolRegistry.register(
    'vcd:copyVm',
    async (args: { vmNameOrHref: string; newVmName: string; targetVappHref: string; powerOn?: boolean; description?: string }) => {
      return await createVmCopy(
        args.vmNameOrHref,
        args.newVmName,
        args.targetVappHref,
        args.powerOn ?? false,
        args.description,
      );
    },
    {
      category: 'vcd',
      description: 'Create a copy/clone of a VM into a target vApp',
      target: 'remote',
      riskLevel: 'review',
      schema: z.object({
        vmNameOrHref: z.string().describe('Source VM name or HREF'),
        newVmName: z.string().describe('Name for the new VM copy'),
        targetVappHref: z.string().describe('Target vApp HREF to deploy into'),
        powerOn: z.boolean().optional().describe('Power on after copy'),
        description: z.string().optional().describe('Description for the new VM'),
      }),
    }
  );

  // ── vcd:resizeVm ──────────────────────────────────────────────────────────
  toolRegistry.register(
    'vcd:resizeVm',
    async (args: { vmNameOrHref: string; numCpus?: number; memoryMb?: number }) => {
      return await updateVmResources(args.vmNameOrHref, args.numCpus, args.memoryMb);
    },
    {
      category: 'vcd',
      description: 'Resize VM CPU and/or memory',
      target: 'remote',
      riskLevel: 'review',
      schema: z.object({
        vmNameOrHref: z.string().describe('VM name or HREF'),
        numCpus: z.number().optional().describe('Number of CPUs'),
        memoryMb: z.number().optional().describe('Memory in MB'),
      }),
    }
  );

  // ── vcd:allocateFreeIp ────────────────────────────────────────────────────
  toolRegistry.register(
    'vcd:allocateFreeIp',
    async () => {
      return await allocateFreeIp();
    },
    {
      category: 'vcd',
      description: 'Allocate a free IP address from the VCD network pool',
      target: 'remote',
      riskLevel: 'review',
      schema: z.object({}),
    }
  );

  // ── vcd:getContext ────────────────────────────────────────────────────────
  toolRegistry.register(
    'vcd:getContext',
    async () => {
      const ctx = getVcdContext();
      // Mask the token for security
      return { ...ctx, token: ctx.token ? '***' : '' };
    },
    {
      category: 'vcd',
      description: 'Get the current VCD connection context (host, org, vDC, network)',
      target: 'local',
      riskLevel: 'safe',
      schema: z.object({}),
    }
  );

  // ── vcd:setContext ────────────────────────────────────────────────────────
  toolRegistry.register(
    'vcd:setContext',
    async (args: { vdcId?: string; networkName?: string; gateway?: string; dnsServers?: string }) => {
      const dns = args.dnsServers
        ? String(args.dnsServers).split(',').map(s => s.trim()).filter(Boolean)
        : undefined;
      const patch: Record<string, unknown> = {};
      if (args.vdcId) patch.vdcId = args.vdcId;
      if (args.networkName) patch.networkName = args.networkName;
      if (args.gateway) patch.gateway = args.gateway;
      if (dns) patch.dnsServers = dns;
      const ctx = setVcdContext(patch);
      return { ...ctx, token: ctx.token ? '***' : '' };
    },
    {
      category: 'vcd',
      description: 'Update VCD context settings (vDC, network, gateway, DNS)',
      target: 'local',
      riskLevel: 'review',
      schema: z.object({
        vdcId: z.string().optional().describe('VDC ID'),
        networkName: z.string().optional().describe('Default network name'),
        gateway: z.string().optional().describe('Default gateway IP'),
        dnsServers: z.string().optional().describe('Comma-separated DNS servers'),
      }),
    }
  );

  console.log('[VCD Tools] Registered: 16 tools');
}
