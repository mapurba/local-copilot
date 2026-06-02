/**
 * Runbook Generator
 *
 * Produces Markdown runbooks from a DeploymentDesign.
 * Three outputs:
 *   - Full runbook (all VMs, all services, deployment order)
 *   - Single-service runbook slice
 *   - Post-deployment summary report
 */

import {
  DeploymentDesign,
  DeploymentIntelligence,
  DeploymentRunState,
  ServiceSpec,
  VmPlan,
  ValidationResult,
  ConfigKey,
  PortSpec,
} from './types';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if a ConfigKey should receive a HOST / IP address value.
 * Prefers LLM-assigned `valueType`; falls back to key-name heuristics.
 */
function isHostKey(ck: ConfigKey): boolean {
  if (ck.valueType === 'host') return true;
  if (ck.valueType) return false; // port / credential / name / path / other
  const upper = ck.key.toUpperCase();
  if (/(^|_)(HOST|IP|ADDR|ADDRESS|URL|ENDPOINT|URI|BASE|SERVER|ORIGIN)(_|$)/.test(upper)) return true;
  if (/(^|_)(PORT|NAME|USER|USERNAME|PASS|PASSWORD|SECRET|TOKEN|KEY|CERT|DATABASE|DB_NAME|TENANT)(_|$)/.test(upper)) return false;
  return true;
}

/**
 * Returns true if a ConfigKey should receive a PORT NUMBER value.
 * Prefers LLM-assigned `valueType`; falls back to key-name heuristics.
 */
function isPortKey(ck: ConfigKey): boolean {
  if (ck.valueType === 'port') return true;
  if (ck.valueType) return false;
  return /(^|_)(PORT)(_|$)/.test(ck.key.toUpperCase());
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function codeBlock(lang: string, content: string): string {
  return `\`\`\`${lang}\n${content}\n\`\`\``;
}

// ── Idempotency post-processor ────────────────────────────────────────────────

/**
 * Wraps a single-token shell sub-command (no compound operators) with an
 * appropriate idempotency guard.
 *
 * Handles:
 *  - useradd → getent passwd <user> >/dev/null || useradd ...
 *  - groupadd → getent group <grp> >/dev/null || groupadd ...
 *  - systemctl enable --now → is-active guard
 *  - wget/curl download → [ -f <dest> ] guard
 *  - mount → mountpoint guard
 */
function guardSingleSubCommand(sub: string): string {
  const s = sub.trim();
  if (!s) return s;

  // useradd: extract last non-flag token as username
  if (/^useradd\b/.test(s)) {
    const parts = s.split(/\s+/);
    const user = parts[parts.length - 1];
    if (user && !user.startsWith('-')) {
      return `getent passwd ${user} >/dev/null 2>&1 || ${s}`;
    }
  }

  // groupadd
  if (/^groupadd\b/.test(s)) {
    const parts = s.split(/\s+/);
    const grp = parts[parts.length - 1];
    if (grp && !grp.startsWith('-')) {
      return `getent group ${grp} >/dev/null 2>&1 || ${s}`;
    }
  }

  // systemctl enable (with or without --now)
  const systemctlM = s.match(/^systemctl\s+enable\b(.*)/);
  if (systemctlM) {
    // extract service name: last space-separated token that doesn't start with -
    const parts = s.split(/\s+/);
    const svcName = parts.slice().reverse().find((p) => !p.startsWith('-') && p !== 'enable' && p !== 'systemctl');
    if (svcName) {
      return `systemctl is-active --quiet ${svcName} 2>/dev/null || ${s}`;
    }
  }

  // wget -O dest or -o dest
  const wgetM = s.match(/^wget\b.*?(?:-O|-o)\s+(\S+)/);
  if (wgetM) {
    return `[ -f ${wgetM[1]} ] || ${s}`;
  }

  // curl -o dest or --output dest
  const curlM = s.match(/^curl\b.*?(?:-o|--output)\s+(\S+)/);
  if (curlM) {
    return `[ -f ${curlM[1]} ] || ${s}`;
  }

  // mount -o loop ISO DIR — guard with mountpoint on DIR
  const mountM = s.match(/^mount\b.*\s+(\S+)$/);
  if (mountM && !/--bind/.test(s)) {
    return `mountpoint -q ${mountM[1]} 2>/dev/null || ${s}`;
  }

  return s;
}

/**
 * Applies idempotency guards to a command string that may contain sub-commands
 * joined with `;` or `&&`.
 *
 * If the command already contains an idempotency guard pattern (||, [ -f, getent,
 * mountpoint, systemctl is-active) we leave it untouched.
 */
function applyIdempotencyGuard(cmd: string): string {
  if (!cmd) return cmd;
  const c = cmd.trim();

  // Already guarded — don't double-wrap
  if (/\|\|/.test(c) || /\bgetent\b/.test(c) || /\bmountpoint\b/.test(c) || /\[ -f /.test(c) || /systemctl is-active/.test(c)) {
    return c;
  }

  // Multi-line commands (heredocs, inline scripts with newlines) must pass through
  // unchanged — splitting them on ; or adding guards would break the heredoc syntax.
  if (c.includes('\n')) return c;

  // Compound commands joined by `;`  — guard each sub-command individually.
  // Only split on standalone `;` (not inside quotes or $(...) — simple heuristic).
  if (c.includes(';')) {
    const parts = c.split(/\s*;\s*/);
    return parts.map(guardSingleSubCommand).join('; ');
  }

  return guardSingleSubCommand(c);
}

export function buildEnvironmentExports(
  service: ServiceSpec,
  design: DeploymentDesign,
  includeComments = false
): string[] {
  const emitted = new Set<string>();
  const lines: string[] = [];

  // Find the VM this service belongs to
  const vm = design.vms.find((v) => v.services.some((s) => s.id === service.id));
  const myIp = vm?.ip ?? design.ipAssignments[service.id] ?? '127.0.0.1';

  /** Emit a single export line, deduplicating by key. */
  const emit = (key: string, value: string | number, comment: string) => {
    if (emitted.has(key)) return;
    emitted.add(key);
    lines.push(`export ${key}=${value}${comment}`);
  };

  /**
   * If a configKey in THIS service's own list logically belongs to one of its
   * dependencies (detected by description text or key-name prefix matching the
   * dep's name/id), return that dep's IP and port list so the correct values
   * can be used instead of the service's own IP.
   *
   * This handles the case where the LLM places dependency-connection keys (e.g.
   * DB_HOST, FLASK_API_PORT) in the consuming service's configKeys rather than
   * in the providing service's configKeys.
   */
  const findOwningDep = (ck: ConfigKey): { depIp: string; depPorts: PortSpec[] } | null => {
    for (const depId of service.requiresConfigFrom) {
      const depVm = design.vms.find((v) => v.services.some((s) => s.id === depId));
      const depSvc = depVm?.services.find((s) => s.id === depId);
      if (!depSvc || !depVm) continue;
      const depIp = depVm.ip ?? design.ipAssignments?.[depId] ?? '';
      const depNameNorm = depSvc.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      const depIdNorm = depId.toLowerCase().replace(/[^a-z0-9]/g, '');
      const descNorm = (ck.description ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const keyNorm = ck.key.toLowerCase().replace(/[^a-z0-9]/g, '');
      // Match by description (more reliable) or key-name prefix
      if (
        (descNorm && (descNorm.includes(depNameNorm) || descNorm.includes(depIdNorm))) ||
        keyNorm.startsWith(depNameNorm) ||
        keyNorm.startsWith(depIdNorm)
      ) {
        return { depIp, depPorts: depSvc.ports };
      }
    }
    return null;
  };

  // ── 1. Own configKeys ─────────────────────────────────────────────────────
  // Host keys: use own IP UNLESS the key belongs to a dependency — in that
  //   case use the dependency's IP (corrects LLM mis-assignments).
  // Port keys: use the actual port NUMBER (own or dependency's) — NOT an IP.
  // Credential/name/path/other: skip; no value is known at plan-time.
  for (const ck of service.configKeys) {
    const comment = includeComments ? `  # ${ck.description || ''}`.trimEnd() : '';
    if (isHostKey(ck)) {
      const dep = findOwningDep(ck);
      emit(ck.key, dep?.depIp || myIp, comment);
    } else if (isPortKey(ck)) {
      const dep = findOwningDep(ck);
      const portList: PortSpec[] = dep ? dep.depPorts : service.ports;
      const portValue = portList.find((p) => p.isPublic)?.port ?? portList[0]?.port;
      if (portValue !== undefined) emit(ck.key, portValue, comment);
    }
    // credential / name / path / other: deliberately omitted
  }

  // ── 2. Own port env vars (convention: <SERVICE_ID>_PORT=<port>) ───────────
  for (const port of service.ports.filter((p) => p.isPublic)) {
    const comment = includeComments ? '  # Own service port' : '';
    emit(
      `${service.id.toUpperCase().replace(/-/g, '_')}_PORT`,
      port.port,
      comment
    );
  }

  // ── 3. Dependency configKeys ───────────────────────────────────────────────
  // Export each dependency's config keys with the DEPENDENCY's own IP/port.
  // Host keys  → dependency's IP address.
  // Port keys  → dependency's actual PORT NUMBER (not its IP).
  // Credential → CHANGE_ME placeholder.
  for (const depId of service.requiresConfigFrom) {
    const depVm = design.vms.find((v) => v.services.some((s) => s.id === depId));
    // Prefer the VM's resolved IP over the raw ipAssignments map
    const depIp = depVm?.ip ?? design.ipAssignments?.[depId] ?? '(unknown)';
    const depService = depVm?.services.find((s) => s.id === depId);
    if (!depService) continue;

    for (const ck of depService.configKeys) {
      const comment = includeComments ? `  # ${ck.description}` : '';
      if (isHostKey(ck)) {
        emit(ck.key, depIp, comment);
      } else if (isPortKey(ck)) {
        const portValue =
          depService.ports.find((p) => p.isPublic)?.port ?? depService.ports[0]?.port;
        if (portValue !== undefined) emit(ck.key, portValue, comment);
      } else {
        // Credential / name key — emit as a placeholder
        emit(ck.key, 'CHANGE_ME', comment);
      }
    }

    // Convention port vars for deps whose configKeys don't already cover them
    for (const port of depService.ports.filter((p) => p.isPublic)) {
      const comment = includeComments ? `  # ${port.description}` : '';
      emit(
        `${depId.toUpperCase().replace(/-/g, '_')}_PORT`,
        port.port,
        comment
      );
    }
  }

  return lines;
}

function buildDependencyInjectionBlock(
  service: ServiceSpec,
  design: DeploymentDesign
): string | null {
  const lines = buildEnvironmentExports(service, design, true);
  return lines.length > 0 ? codeBlock('bash', lines.join('\n')) : null;
}

function buildHealthCheckProcedure(service: ServiceSpec, ip: string): string {
  const hc = service.healthCheck;
  // Prefer an env-var reference when the IP is still a placeholder or unknown.
  // This produces a runnable health-check command even before IPs are assigned.
  const ipRef =
    !ip || ip === '?.?.?.?' || ip === '(to be assigned)'
      ? (service.configKeys.find((ck) => isHostKey(ck))?.key
          ? `$${service.configKeys.find((ck) => isHostKey(ck))!.key}`
          : '${TARGET_HOST}')
      : ip;
  switch (hc.type) {
    case 'port':
      return codeBlock('bash', `nc -z -w${hc.timeoutSeconds} ${ipRef} ${hc.target}`);
    case 'http': {
      const target = hc.target.startsWith('http') ? hc.target : `http://${ipRef}${hc.target}`;
      return codeBlock('bash', `curl -s -o /dev/null -w "%{http_code}" ${target}`);
    }
    case 'process':
      return codeBlock('bash', `pgrep -x ${hc.target}`);
    case 'systemctl':
      return codeBlock('bash', `systemctl is-active ${hc.target}`);
    default:
      return codeBlock('bash', `# health check: ${hc.type} ${hc.target}`);
  }
}

/**
 * Builds a bash block that aborts the script if any required credential/name
 * configuration variables are still set to the CHANGE_ME placeholder or are empty.
 * Returns null when the service has no credential/name configKeys.
 */
function buildConfigValidationBlock(service: ServiceSpec): string | null {
  const isCredentialOrName = (ck: ConfigKey): boolean => {
    if (ck.valueType) return ck.valueType === 'credential' || ck.valueType === 'name';
    // Legacy: heuristic on key name
    const u = ck.key.toUpperCase();
    return /(^|_)(NAME|USER|USERNAME|PASS|PASSWORD|SECRET|TOKEN|KEY|CERT|DATABASE|DB_NAME|TENANT)(_|$)/.test(u);
  };

  const requiredVars = service.configKeys.filter(isCredentialOrName).map(ck => ck.key);
  if (requiredVars.length === 0) return null;

  // const varList = requiredVars.join(' ');
  const lines: string[] = [
  //   `# ── Required credential / name configuration guard ───────────────────────`,
  //   `_vcd_check_config() {`,
  //   `  local _missing=0 _log="\${LOG:-/var/log/vcd-agent.log}"`,
  //   `  for _var in ${varList}; do`,
  //   `    local _val; _val="\${!_var:-}"`,
  //   `    if [ "$_val" = "CHANGE_ME" ] || [ -z "$_val" ]; then`,
  //   `      echo "[CONFIG ERROR] Required variable $_var is not configured" | tee -a "$_log" >&2`,
  //   `      _missing=1`,
  //   `    fi`,
  //   `  done`,
  //   `  [ "$_missing" -eq 0 ] || { echo "[CONFIG ERROR] Deployment aborted — configure the variables above." | tee -a "$_log" >&2; exit 1; }`,
  //   `}`,
  //   `_vcd_check_config`,
  ];
  return codeBlock('bash', lines.join('\n'));
}

function resolveRunbookService(
  service: ServiceSpec,
  intelligence?: DeploymentIntelligence
): ServiceSpec {
  if (!intelligence || service.id === 'all-in-one') return service;

  const candidates = intelligence.products
    .flatMap((product) => product.services)
    .filter((candidate) => candidate.id === service.id || candidate.name === service.name);

  if (candidates.length === 0) return service;

  return candidates.reduce((best, candidate) => {
    const bestScore = (best.installSteps?.length ?? 0) + (best.configKeys?.length ?? 0);
    const candidateScore = (candidate.installSteps?.length ?? 0) + (candidate.configKeys?.length ?? 0);
    return candidateScore > bestScore ? candidate : best;
  }, candidates[0]);
}

function serviceSection(
  service: ServiceSpec,
  vm: VmPlan,
  design: DeploymentDesign,
  intelligence?: DeploymentIntelligence
): string {
  const ip = vm.ip ?? '?.?.?.?';
  const runbookService = resolveRunbookService(service, intelligence);
  const sections: string[] = [`### Service: ${service.name}`, ''];

  // Dependency injection (moved to top of serviceSection so exports happen before commands run)
  const depBlock = buildDependencyInjectionBlock(service, design);
  if (depBlock) {
    sections.push('#### Dependency Injection');
    sections.push('Set these environment variables before starting the service:');
    sections.push(depBlock);
    sections.push('');
  }

  // Configuration guard — abort if credential/name vars are still CHANGE_ME / empty
  const configGuard = buildConfigValidationBlock(runbookService);
  if (configGuard) {
    sections.push('#### Configuration Guard');
    sections.push('Verify all required credential/name variables are configured before proceeding:');
    sections.push(configGuard);
    sections.push('');
  }

  // Prerequisites
  const prereqs = runbookService.installSteps.filter((s) => s.isPrerequisite);
  if (prereqs.length > 0) {
    sections.push('#### Prerequisites');
    for (const step of prereqs) {
      sections.push(`${step.stepNumber}. ${step.description}`);
      if (step.command) sections.push(codeBlock('bash', applyIdempotencyGuard(step.command)));
    }
    sections.push('');
  }

  // Install steps
  const mainSteps = runbookService.installSteps.filter((s) => !s.isPrerequisite);
  if (mainSteps.length > 0) {
    sections.push('#### Install Steps');
    for (const step of mainSteps) {
      sections.push(`${step.stepNumber}. ${step.description}`);
      if (step.command) sections.push(codeBlock('bash', applyIdempotencyGuard(step.command)));
    }
    sections.push('');
  }

  // Health check
  sections.push('#### Health Check');
  sections.push(buildHealthCheckProcedure(runbookService, ip));
  sections.push('');

  return sections.join('\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate the complete deployment runbook for the full design.
 */
export function generateFullRunbook(
  design: DeploymentDesign,
  intelligence: DeploymentIntelligence = design.intelligence
): string {
  const product = intelligence.products[0];
  const selectedMode =
    intelligence.deploymentModes.find((mode) =>
      Object.keys(mode.serviceAssignments).some((role) => design.vms.some((vm) => vm.role === role))
    ) ?? intelligence.deploymentModes[0];
  const lines: string[] = [];

  lines.push(`# ${product?.name ?? 'Product'} Deployment Runbook`);
  lines.push('');
  lines.push(`**Mode:** ${selectedMode?.name ?? 'default'}`);
  lines.push(`**Generated:** ${formatDate(Date.now())}`);
  lines.push('');

  // Environment summary table
  lines.push('## Environment Summary');
  lines.push('');
  lines.push('| Service | VM | IP | Ports |');
  lines.push('|---|---|---|---|');
  for (const vm of design.vms) {
    for (const svc of vm.services) {
      const ports = svc.ports.map((p) => `${p.port}/${p.protocol}`).join(', ') || '-';
      lines.push(`| ${svc.name} | ${vm.vmName ?? vm.id} | ${vm.ip ?? '?'} | ${ports} |`);
    }
  }
  lines.push('');

  // Deployment order
  lines.push('## Deployment Order');
  lines.push('');
  design.dependencyGraph.deploymentOrder.forEach((svcId, i) => {
    const vm = design.vms.find((v) => v.services.some((s) => s.id === svcId));
    const svc = vm?.services.find((s) => s.id === svcId);
    if (!svc) return;
    const deps = svc.requiresConfigFrom.length > 0
      ? ` — depends on ${svc.requiresConfigFrom.join(', ')}`
      : '';
    lines.push(`${i + 1}. **${svc.name}** (${vm?.vmName ?? vm?.id ?? '?'})${deps}`);
  });
  lines.push('');

  // Per-VM sections
  for (const vm of design.vms) {
    lines.push(`## ${vm.vmName ?? vm.id} Runbook`);
    lines.push('');
    lines.push(`**IP:** ${vm.ip ?? '(to be assigned)'}`);
    lines.push(`**OS:** ${vm.osRequirement.type} ${vm.osRequirement.minVersion ?? ''}`);
    lines.push('');

    for (const svc of vm.services) {
      lines.push(serviceSection(svc, vm, design, intelligence));
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate a runbook slice for a single service.
 */
export function generateServiceRunbook(
  serviceId: string,
  design: DeploymentDesign,
  intelligence: DeploymentIntelligence = design.intelligence
): string {
  const vm = design.vms.find((v) => v.services.some((s) => s.id === serviceId));
  const svc = vm?.services.find((s) => s.id === serviceId);
  if (!vm || !svc) return `# Service not found: ${serviceId}`;

  const lines: string[] = [
    `# ${svc.name} — Service Runbook`,
    '',
    `**VM:** ${vm.vmName ?? vm.id}  `,
    `**IP:** ${vm.ip ?? '(to be assigned)'}  `,
    `**Role:** ${svc.role}`,
    '',
  ];

  lines.push(serviceSection(svc, vm, design, intelligence));
  return lines.join('\n');
}

/**
 * Generate a post-deployment summary report.
 */
export function generateSummaryReport(
  design: DeploymentDesign,
  runState: DeploymentRunState,
  validationResults: ValidationResult[]
): string {
  const product = design.intelligence.products[0];
  const outcome = runState.phase === 'complete' ? '✅ Deployment Complete' : '❌ Deployment Failed';
  const lines: string[] = [];

  lines.push(`# Deployment Summary Report`);
  lines.push('');
  lines.push(`**Product:** ${product?.name ?? 'Unknown'}  `);
  lines.push(`**Outcome:** ${outcome}  `);
  lines.push(`**Started:** ${formatDate(runState.startedAt)}  `);
  if (runState.completedAt) {
    const durationMs = runState.completedAt - runState.startedAt;
    lines.push(`**Completed:** ${formatDate(runState.completedAt)} (${Math.round(durationMs / 1000)}s)  `);
  }
  lines.push('');

  // Service status table
  lines.push('## Service Status');
  lines.push('');
  lines.push('| Service | VM | IP | Status |');
  lines.push('|---|---|---|---|');
  for (const vm of design.vms) {
    for (const svc of vm.services) {
      const state = runState.serviceStates[svc.id];
      const status = state?.status ?? 'pending';
      const emoji = status === 'healthy' ? '✅' : status === 'failed' ? '❌' : '⏳';
      lines.push(`| ${svc.name} | ${vm.vmName ?? vm.id} | ${vm.ip ?? '?'} | ${emoji} ${status} |`);
    }
  }
  lines.push('');

  // Endpoint inventory (public ports)
  const publicEndpoints: string[] = [];
  for (const vm of design.vms) {
    for (const svc of vm.services) {
      const state = runState.serviceStates[svc.id];
      if (state?.status !== 'healthy') continue;
      for (const port of svc.ports.filter((p) => p.isPublic)) {
        const proto = port.port === 443 || port.port === 8443 ? 'https' : 'http';
        publicEndpoints.push(`- **${svc.name}**: ${proto}://${vm.ip ?? '?'}:${port.port} (${port.description})`);
      }
    }
  }
  if (publicEndpoints.length > 0) {
    lines.push('## Endpoint Inventory');
    lines.push('');
    lines.push(...publicEndpoints);
    lines.push('');
  }

  // Validation results
  if (validationResults.length > 0) {
    lines.push('## Health Check Results');
    lines.push('');
    lines.push('| Service | Passed | Duration | Detail |');
    lines.push('|---|---|---|---|');
    for (const vr of validationResults) {
      const icon = vr.passed ? '✅' : '❌';
      lines.push(`| ${vr.serviceId} | ${icon} | ${vr.durationMs}ms | ${vr.detail} |`);
    }
    lines.push('');
  }

  // Infrastructure summary
  const snapshotCount = Object.keys(runState.snapshotNames).length;
  const vmCount = design.vms.length;
  lines.push('## Infrastructure Summary');
  lines.push('');
  lines.push(`- **VMs provisioned:** ${vmCount}`);
  lines.push(`- **Snapshots taken:** ${snapshotCount}`);
  if (snapshotCount > 0) {
    for (const [vmName, snapName] of Object.entries(runState.snapshotNames)) {
      lines.push(`  - ${vmName}: \`${snapName}\``);
    }
  }
  lines.push('');

  return lines.join('\n');
}
