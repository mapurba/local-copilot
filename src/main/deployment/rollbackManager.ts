/**
 * Rollback Manager
 *
 * Takes pre-deployment snapshots and rolls them back on failure.
 * Snapshots are taken concurrently; rollback is serial (teardown order).
 */

import { createSnapshot, revertSnapshot } from '../vcdApi';
import { DeploymentDesign } from './types';
import { getDesign, getRun, updateRun } from './deploymentStore';

const SNAPSHOT_PREFIX = 'pre-deploy';

/**
 * Create a snapshot for every unique VM in the design, concurrently.
 * Returns vmName → snapshotName map.
 */
export async function snapshotBeforeDeployment(
  design: DeploymentDesign
): Promise<Record<string, string>> {
  const timestamp = Date.now();
  const snapshotNames: Record<string, string> = {};

  await Promise.all(
    design.vms.map(async (vm) => {
      const vmIdentifier = vm.vmName ?? vm.id;
      const snapName = `${SNAPSHOT_PREFIX}-${design.id.slice(0, 8)}-${timestamp}`;
      try {
        await createSnapshot(vmIdentifier, snapName, false, false);
        snapshotNames[vmIdentifier] = snapName;
        console.log(`[RollbackManager] Snapshot '${snapName}' created for VM '${vmIdentifier}'`);
      } catch (err) {
        console.error(`[RollbackManager] Snapshot failed for VM '${vmIdentifier}':`, err);
        // Record warning but don't abort — snapshot is best-effort
        snapshotNames[vmIdentifier] = `(failed) ${snapName}`;
      }
    })
  );

  return snapshotNames;
}

/**
 * Revert a single VM to its named snapshot.
 */
export async function rollbackVm(vmName: string, snapshotName: string): Promise<void> {
  if (snapshotName.startsWith('(failed)')) {
    console.warn(`[RollbackManager] Skipping rollback for '${vmName}' — snapshot was not created.`);
    return;
  }
  console.log(`[RollbackManager] Reverting '${vmName}' to snapshot '${snapshotName}'…`);
  await revertSnapshot(vmName);
}

/**
 * Roll back an entire deployment run.
 * Iterates teardownOrder (serial — order matters).
 * Updates runState.phase to 'rolledback'.
 */
export async function rollbackDeployment(runId: string): Promise<void> {
  const run = getRun(runId);
  const design = getDesign(run.designId);

  const rolledBackVms = new Set<string>();

  for (const serviceId of design.dependencyGraph.teardownOrder) {
    const vm = design.vms.find((v) => v.services.some((s) => s.id === serviceId));
    if (!vm) continue;

    const vmIdentifier = vm.vmName ?? vm.id;
    if (rolledBackVms.has(vmIdentifier)) continue; // already rolled back this VM

    const snapName = run.snapshotNames[vmIdentifier];
    if (snapName) {
      await rollbackVm(vmIdentifier, snapName);
    } else {
      console.warn(`[RollbackManager] No snapshot found for VM '${vmIdentifier}' — skipping.`);
    }
    rolledBackVms.add(vmIdentifier);
  }

  updateRun(runId, { phase: 'rolledback', completedAt: Date.now() });
  console.log(`[RollbackManager] Rollback complete for runId=${runId}`);
}
