/**
 * Health Validation Engine
 *
 * Validates services via SSH commands using registered ssh: tools.
 * Supports: port check, HTTP endpoint, process name, systemd unit.
 * Retry policy: up to 3 attempts with 30 s sleep between.
 */

import { toolRegistry } from '../tools/registry';
import { ServiceSpec, VmPlan, DeploymentDesign, ValidationResult } from './types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSshCommand(sessionId: string, command: string, timeoutSecs = 30): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await toolRegistry.execute<
    { sessionId: string; command: string; timeoutSecs: number },
    { stdout: string; stderr: string; exitCode: number }
  >({
    toolName: 'ssh:runCommand',
    args: { sessionId, command, timeoutSecs },
    context: { approved: true },
  });

  if (!result.success || !result.result) {
    return { stdout: '', stderr: result.error ?? 'unknown error', exitCode: 1 };
  }
  return result.result;
}

// ── Individual check methods ──────────────────────────────────────────────────

export async function checkPortOpen(
  sessionId: string,
  host: string,
  port: number,
  timeoutS = 5
): Promise<boolean> {
  const res = await runSshCommand(sessionId, `nc -z -w${timeoutS} ${host} ${port}`, timeoutS + 5);
  return res.exitCode === 0;
}

export async function checkHttpEndpoint(
  sessionId: string,
  url: string,
  expectedStatus = '200'
): Promise<boolean> {
  const res = await runSshCommand(
    sessionId,
    `curl -sk -o /dev/null -w "%{http_code}" --max-time 15 "${url}"`,
    20
  );
  return res.stdout.trim() === expectedStatus;
}

export async function checkProcessRunning(
  sessionId: string,
  processName: string
): Promise<boolean> {
  const res = await runSshCommand(sessionId, `pgrep -x "${processName}"`, 10);
  return res.exitCode === 0;
}

export async function checkSystemdService(
  sessionId: string,
  unit: string
): Promise<boolean> {
  const result = await toolRegistry.execute<
    { sessionId: string; serviceName: string },
    { status: string; active: boolean }
  >({
    toolName: 'ssh:checkService',
    args: { sessionId, serviceName: unit },
    context: { approved: true },
  });
  if (!result.success || !result.result) return false;
  return result.result.active === true;
}

// ── Service validator ─────────────────────────────────────────────────────────

/**
 * Validate a single service's health check with up to 3 retries (30 s apart).
 */
export async function validateService(
  sessionId: string,
  spec: ServiceSpec,
  design: DeploymentDesign
): Promise<ValidationResult> {
  const startTs = Date.now();
  const hc = spec.healthCheck;
  const ip = design.ipAssignments[spec.id] ?? 'localhost';

  let passed = false;
  let detail = '';

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      switch (hc.type) {
        case 'port': {
          const port = parseInt(hc.target, 10);
          passed = await checkPortOpen(sessionId, ip, port, hc.timeoutSeconds);
          detail = passed ? `Port ${port} open` : `Port ${port} not reachable`;
          break;
        }
        case 'http': {
          const url = hc.target.startsWith('http')
            ? hc.target
            : `http://${ip}${hc.target}`;
          passed = await checkHttpEndpoint(sessionId, url, hc.expectedStatus ?? '200');
          detail = passed ? `HTTP ${url} returned ${hc.expectedStatus ?? '200'}` : `HTTP check failed`;
          break;
        }
        case 'process': {
          passed = await checkProcessRunning(sessionId, hc.target);
          detail = passed ? `Process '${hc.target}' running` : `Process '${hc.target}' not found`;
          break;
        }
        case 'systemctl': {
          passed = await checkSystemdService(sessionId, hc.target);
          detail = passed ? `Service '${hc.target}' active` : `Service '${hc.target}' not active`;
          break;
        }
      }
    } catch (err) {
      detail = `Attempt ${attempt} error: ${err}`;
      passed = false;
    }

    if (passed) break;

    if (attempt < 3) {
      console.log(`[HealthValidator] ${spec.id} attempt ${attempt}/3 failed. Retrying in 30 s…`);
      await sleep(30000);
    }
  }

  return {
    serviceId: spec.id,
    passed,
    detail,
    durationMs: Date.now() - startTs,
  };
}

/**
 * Validate all services on a specific VM.
 */
export async function validateAllServices(
  sessionId: string,
  vmPlan: VmPlan,
  design: DeploymentDesign
): Promise<ValidationResult[]> {
  return Promise.all(vmPlan.services.map((svc) => validateService(sessionId, svc, design)));
}
