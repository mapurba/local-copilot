/**
 * IP Pool Manager
 *
 * Allocates IPs from the VCD IP pool for each VM in a design.
 * Strategy: fetch the full free-IP list once, then slice one IP per VM.
 * This avoids the server-side race where /allocate returns the same IP for
 * every call because none of the in-memory allocations are visible yet.
 */

import { getFreeIps } from '../vcdApi';
import { DeploymentDesign } from './types';
import { updateDesign } from './deploymentStore';

export class IpAllocationError extends Error {
  succeeded: Record<string, string>;
  failed: string[];

  constructor(message: string, succeeded: Record<string, string>, failed: string[]) {
    super(message);
    this.name = 'IpAllocationError';
    this.succeeded = succeeded;
    this.failed = failed;
  }
}

/**
 * Allocate one distinct IP per VM in the design.
 *
 * Fetches the full free-IP list once from /api/res-ip/free, then picks
 * one IP per VM by index. This guarantees distinct IPs even though the
 * /allocate endpoint has no session-level state and would otherwise return
 * the same IP for every call until a VM is actually deployed.
 *
 * Returns ipAssignments: Record<serviceId, ip> where all services on the
 * same VM share that VM's IP.
 *
 * On partial failure (not enough free IPs), saves partial results and
 * throws IpAllocationError.
 */
export async function allocateIpsForDesign(
  design: DeploymentDesign
): Promise<Record<string, string>> {
  const uniqueVms = design.vms;

  // 1. Fetch all free IPs in one shot
  const freeResult = await getFreeIps();
  if (!freeResult.success || !freeResult.ips || freeResult.ips.length === 0) {
    throw new IpAllocationError(
      `Cannot reach IP pool or pool is empty: ${freeResult.error ?? 'no free IPs returned'}`,
      {},
      uniqueVms.map((v) => v.id)
    );
  }

  const available = [...freeResult.ips]; // consume from front
  const succeeded: Record<string, string> = {}; // vmId → ip
  const failedVmIds: string[] = [];

  // 2. Assign one IP per VM by shifting off the free list
  for (const vm of uniqueVms) {
    const ip = available.shift();
    if (!ip) {
      failedVmIds.push(vm.id);
      console.error(`[IpPoolManager] IP pool exhausted — no IP available for VM '${vm.id}'`);
    } else {
      succeeded[vm.id] = ip;
      console.log(`[IpPoolManager] Assigned ${ip} → VM '${vm.id}'`);
    }
  }

  // Build serviceId → ip mapping (services on same VM share IP)
  const ipAssignments: Record<string, string> = {};
  for (const vm of uniqueVms) {
    const ip = succeeded[vm.id];
    if (ip) {
      for (const svc of vm.services) {
        ipAssignments[svc.id] = ip;
      }
    }
  }

  if (failedVmIds.length > 0) {
    // Save partial results before throwing
    try {
      updateDesign(design.id, { ipAssignments });
    } catch {
      // non-critical — best effort
    }
    throw new IpAllocationError(
      `IP allocation failed for ${failedVmIds.length} VM(s): ${failedVmIds.join(', ')}`,
      succeeded,
      failedVmIds
    );
  }

  return ipAssignments;
}

/**
 * Record that an IP was released (store-only — VCD has no explicit release API).
 */
export function recordIpRelease(designId: string, vmId: string): void {
  console.log(`[IpPoolManager] Recorded IP release for designId=${designId} vmId=${vmId}`);
  // Could store in a releases log table in future — intentionally lightweight for now
}
