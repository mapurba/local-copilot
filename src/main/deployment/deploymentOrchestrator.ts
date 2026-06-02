/**
 * Deployment Orchestrator
 *
 * Drives the full deployment lifecycle:
 *   Phase A — Provision all VMs in parallel (snapshot → create → power-on → SSH)
 *   Phase B — Deploy services level-by-level (leaf-first, parallel within a level)
 *   Rollback — On any failure, revert to pre-deploy snapshots
 *   Summary  — Final health validation + report generation
 *
 * VCD-specific parameters (org, template, credentials) are supplied via DeploymentParams.
 */

import { BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';

import {
  DeploymentDesign,
  DeploymentRunState,
  ServiceState,
  OrchestratorPhase,
  ValidationResult,
} from './types';
import { getDesign, saveRun, updateRun, getRun } from './deploymentStore';
import { snapshotBeforeDeployment, rollbackDeployment } from './rollbackManager';
import { validateService, validateAllServices } from './healthValidationEngine';
import { generateStateDiagram } from './mermaidGenerator';
import { generateSummaryReport, buildEnvironmentExports } from './runbookGenerator';
import { taskTracker } from '../taskTracker';
import { toolRegistry } from '../tools/registry';
import { createVmFromTemplate, checkVmStatus } from '../vcdApi';
import { getDefaultsForOrg, NETWORK_NAME, GATEWAY, DNS_SERVERS, IP_ALLOCATION_MODE, NETWORK_ADAPTER_TYPE } from '../vcdConfig';

// ── DeploymentParams ──────────────────────────────────────────────────────────

export interface DeploymentParams {
  /** VCD organisation name (e.g. 'ban2_identity_ilm') */
  org: string;
  /** Template VM ID used for all VMs in this design (fallback). If a VM has a templateId discovered in the runbook, that will be used instead. */
  templateVmId?: string;
  /** SSH username to log into provisioned VMs */
  sshUsername: string;
  /** SSH password (required unless privateKey provided) */
  sshPassword?: string;
  /** SSH private key (optional alternative to password) */
  sshPrivateKey?: string;
}

// ── Module-level cancellation registry ───────────────────────────────────────

const cancelledRuns = new Set<string>();

// ── IPC push helper ───────────────────────────────────────────────────────────

function push(channel: string, payload: unknown): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

// ── Sleep helper ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── VM provisioning helpers ───────────────────────────────────────────────────

async function waitForVmPoweredOn(vmName: string, maxWaitMs = 600000): Promise<void> {
  const startTs = Date.now();
  while (Date.now() - startTs < maxWaitMs) {
    const status = await checkVmStatus(vmName);
    const powerState = (status as Record<string, unknown>)?.status as string | undefined;
    if (powerState === 'POWERED_ON') return;
    await sleep(15000);
  }
  throw new Error(`VM '${vmName}' did not reach POWERED_ON within ${maxWaitMs / 60000} min.`);
}

async function connectSsh(
  host: string,
  username: string,
  password?: string,
  privateKey?: string
): Promise<string> {
  const result = await toolRegistry.execute<
    { host: string; port: number; username: string; password?: string; privateKey?: string },
    { sessionId: string }
  >({
    toolName: 'ssh:connect',
    args: { host, port: 22, username, password, privateKey },
    context: { approved: true },
  });
  if (!result.success || !result.result) {
    throw new Error(`SSH connect failed for ${host}: ${result.error}`);
  }
  return result.result.sessionId;
}

// ── Service installer ─────────────────────────────────────────────────────────

async function deployService(
  sessionId: string,
  serviceId: string,
  design: DeploymentDesign,
  runState: DeploymentRunState,
  taskId: string
): Promise<void> {
  const vm = design.vms.find((v) => v.services.some((s) => s.id === serviceId));
  const svc = vm?.services.find((s) => s.id === serviceId);
  if (!vm || !svc) throw new Error(`Service '${serviceId}' not found in design`);

  const step = taskTracker.beginStep(taskId, `Deploy ${svc.name}`);

  // Mark as installing
  runState.serviceStates[serviceId] = {
    serviceId,
    status: 'installing',
    vmId: vm.id,
    attempts: (runState.serviceStates[serviceId]?.attempts ?? 0) + 1,
  };

  try {
    // ── Inject dependency env vars ────────────────────────────────────────
    const envExports = buildEnvironmentExports(svc, design, false);

    runState.serviceStates[serviceId].status = 'configuring';

    // ── Run prerequisite steps ────────────────────────────────────────────
    const prereqs = svc.installSteps.filter((s) => s.isPrerequisite);
    for (const step of prereqs) {
      if (!step.command) continue;
      const command = envExports.length > 0 ? [...envExports, step.command].join('\n') : step.command;
      await toolRegistry.execute({
        toolName: 'ssh:runCommand',
        args: { sessionId, command, timeoutSecs: step.timeoutSeconds ?? 120 },
        context: { approved: true },
      });
    }

    // ── Run main install steps ─────────────────────────────────────────────
    const mainSteps = svc.installSteps.filter((s) => !s.isPrerequisite);
    let script = mainSteps.map((s) => s.command ?? `# ${s.description}`).join('\n');
    if (script.trim()) {
      if (envExports.length > 0) {
        script = [...envExports, '', script].join('\n');
      }
      await toolRegistry.execute({
        toolName: 'ssh:runScript',
        args: { sessionId, script, timeoutSecs: 600 },
        context: { approved: true },
      });
    }

    runState.serviceStates[serviceId].status = 'starting';

    // ── Health validation (retry × 3, 30 s apart) ─────────────────────────
    const result = await validateService(sessionId, svc, design);

    if (!result.passed) {
      runState.serviceStates[serviceId].status = 'failed';
      runState.serviceStates[serviceId].lastError = result.detail;
      if (step) taskTracker.completeStep(taskId, step.id, result.detail, 1);
      throw new Error(`Health check failed for '${svc.name}': ${result.detail}`);
    }

    // ── Healthy ────────────────────────────────────────────────────────────
    runState.serviceStates[serviceId].status = 'healthy';
    runState.serviceStates[serviceId].deployedAt = Date.now();
    runState.serviceStates[serviceId].healthCheckedAt = Date.now();

    runState.currentMermaid = generateStateDiagram(design, runState);
    push('deployment:state-update', {
      runId: runState.runId,
      phase: runState.phase,
      serviceStates: runState.serviceStates,
      currentMermaid: runState.currentMermaid,
    });

    if (step) taskTracker.completeStep(taskId, step.id, `${svc.name} deployed and healthy`, 0);
  } catch (err) {
    runState.serviceStates[serviceId].status = 'failed';
    if (step) {
      taskTracker.completeStep(taskId, step.id, String(err), 1, true);
    }
    throw err;
  }
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * Start a deployment run for the given designId.
 * Returns the runId immediately; execution continues asynchronously and
 * pushes IPC events as state changes.
 */
export async function start(
  designId: string,
  params: DeploymentParams
): Promise<string> {
  const design = getDesign(designId);
  const runId = randomUUID();
  const startedAt = Date.now();

  // Initialise run state
  const runState: DeploymentRunState = {
    runId,
    designId,
    taskId: '',
    serviceStates: {},
    vmSessions: {},
    snapshotNames: {},
    phase: 'idle',
    currentLevel: 0,
    currentMermaid: design.mermaid ?? '',
    startedAt,
  };

  // Seed service states as pending
  for (const vm of design.vms) {
    for (const svc of vm.services) {
      runState.serviceStates[svc.id] = {
        serviceId: svc.id,
        status: 'pending',
        vmId: vm.id,
        attempts: 0,
      };
    }
  }

  // Persist initial run
  saveRun(runState);

  // Run async — caller gets runId back immediately
  (async () => {
    try {
      // ── Create task tracker task ─────────────────────────────────────────
      const task = taskTracker.createTask(
        `Deploy ${design.intelligence.products[0]?.name ?? 'product'}`,
        `Design ${designId}`
      );
      runState.taskId = task.id;
      updateRun(runId, { taskId: task.id });

      // ── PHASE A: Provision ───────────────────────────────────────────────
      runState.phase = 'snapshotting';
      push('deployment:state-update', { runId, phase: runState.phase, serviceStates: runState.serviceStates, currentMermaid: runState.currentMermaid });

      const snaps = await snapshotBeforeDeployment(design);
      runState.snapshotNames = snaps;

      runState.phase = 'provisioning';
      push('deployment:state-update', { runId, phase: runState.phase, serviceStates: runState.serviceStates, currentMermaid: runState.currentMermaid });

      const vcdDefaults = getDefaultsForOrg(params.org);

      // Provision all VMs concurrently
      await Promise.all(
        design.vms.map(async (vm) => {
          const vmName = vm.vmName ?? `${design.intelligence.products[0]?.name ?? 'vm'}-${vm.id}`.replace(/\s+/g, '-').toLowerCase();
          vm.vmName = vmName;
          const ip = vm.ip ?? design.ipAssignments[vm.services[0]?.id];
          if (!ip) throw new Error(`No IP assigned for VM '${vmName}'`);

          const provStep = taskTracker.beginStep(task.id, `Provision ${vmName}`);
          const chosenTemplate = (vm.templateId && String(vm.templateId).trim()) ? vm.templateId : params.templateVmId;
          if (!chosenTemplate) throw new Error(`No template specified for VM '${vmName}'. Provide template via start params or include TEMPLATE_ID in the runbook.`);

          await createVmFromTemplate({
            vdc_id: vcdDefaults.vdcId,
            // Prefer per-VM template discovered during planning, fallback to the global template from params
            template_vm_id: chosenTemplate,
            vm_name: vmName,
            network_name: NETWORK_NAME,
            ip_address: ip,
            gateway: GATEWAY,
            dns_servers: DNS_SERVERS,
            power_on: true,
            ip_allocation_mode: IP_ALLOCATION_MODE,
            network_adapter_type: NETWORK_ADAPTER_TYPE,
            storage_profile_id: vcdDefaults.storageProfileId,
            compute_policy_id: vcdDefaults.computePolicyId,
            // No node-specific properties passed here — runbook generation will include required commands.
          });

          if (provStep) taskTracker.completeStep(task.id, provStep.id, `${vmName} provisioned`, 0);
        })
      );

      // Wait for all VMs to be POWERED_ON
      await Promise.all(
        design.vms.map((vm) => waitForVmPoweredOn(vm.vmName!, 600000))
      );

      // SSH connect all VMs concurrently
      runState.phase = 'connecting';
      push('deployment:state-update', { runId, phase: runState.phase, serviceStates: runState.serviceStates, currentMermaid: runState.currentMermaid });

      await Promise.all(
        design.vms.map(async (vm) => {
          const ip = vm.ip ?? design.ipAssignments[vm.services[0]?.id];
          const sessionId = await connectSsh(ip!, params.sshUsername, params.sshPassword, params.sshPrivateKey);
          runState.vmSessions[vm.id] = sessionId;
        })
      );

      // ── PHASE B: Deploy services level-by-level ──────────────────────────
      runState.phase = 'deploying';
      push('deployment:state-update', { runId, phase: runState.phase, serviceStates: runState.serviceStates, currentMermaid: runState.currentMermaid });

      for (let levelIdx = 0; levelIdx < design.dependencyGraph.levels.length; levelIdx++) {
        if (cancelledRuns.has(runId)) {
          throw new Error('Deployment cancelled by user');
        }

        const levelServices = design.dependencyGraph.levels[levelIdx];
        runState.currentLevel = levelIdx;
        updateRun(runId, { currentLevel: levelIdx });

        // Deploy all services in this level concurrently
        await Promise.all(
          levelServices.map(async (serviceId) => {
            const vm = design.vms.find((v) => v.services.some((s) => s.id === serviceId));
            if (!vm) return;
            const sessionId = runState.vmSessions[vm.id];
            if (!sessionId) throw new Error(`No SSH session for VM '${vm.id}'`);
            await deployService(sessionId, serviceId, design, runState, task.id);
          })
        );

        updateRun(runId, { serviceStates: runState.serviceStates, currentMermaid: runState.currentMermaid });
      }

      // ── Final validation ──────────────────────────────────────────────────
      runState.phase = 'validating';
      push('deployment:state-update', { runId, phase: runState.phase, serviceStates: runState.serviceStates, currentMermaid: runState.currentMermaid });

      const allResults: ValidationResult[] = [];
      for (const vm of design.vms) {
        const sessionId = runState.vmSessions[vm.id];
        if (!sessionId) continue;
        const results = await validateAllServices(sessionId, vm, design);
        allResults.push(...results);
      }

      // ── Summary ───────────────────────────────────────────────────────────
      const summaryReport = generateSummaryReport(design, runState, allResults);
      runState.summaryReport = summaryReport;
      runState.phase = 'complete';
      runState.completedAt = Date.now();
      runState.currentMermaid = generateStateDiagram(design, runState);

      updateRun(runId, {
        phase: 'complete',
        completedAt: runState.completedAt,
        summaryReport,
        currentMermaid: runState.currentMermaid,
        serviceStates: runState.serviceStates,
      });

      taskTracker.completeTask(task.id);

      push('deployment:complete', {
        runId,
        mermaid: runState.currentMermaid,
        summaryReport,
      });
    } catch (err) {
      const isCancelled = cancelledRuns.has(runId);
      console.error(`[Orchestrator] Run ${runId} failed:`, err);

      try {
        await rollbackDeployment(runId);
      } catch (rbErr) {
        console.error(`[Orchestrator] Rollback failed:`, rbErr);
      }

      updateRun(runId, { phase: 'rolledback', completedAt: Date.now() });

      push('deployment:failed', {
        runId,
        phase: 'rolledback',
        error: isCancelled ? 'cancelled' : String(err),
        serviceStates: {},
      });

      cancelledRuns.delete(runId);
    }
  })();

  return runId;
}

/**
 * Cancel an in-progress deployment run.
 * Triggers rollback and emits deployment:failed with reason='cancelled'.
 */
export async function cancel(runId: string): Promise<void> {
  cancelledRuns.add(runId);
  // Rollback will be triggered by the orchestrator loop detecting the cancellation flag
  // Also attempt an immediate rollback in case the loop is stuck waiting
  try {
    const run = getRun(runId);
    if (run.phase !== 'complete' && run.phase !== 'rolledback') {
      await rollbackDeployment(runId);
      push('deployment:failed', { runId, phase: 'rolledback', error: 'cancelled', serviceStates: {} });
    }
  } catch (err) {
    console.error(`[Orchestrator] cancel() rollback error:`, err);
  }
}
