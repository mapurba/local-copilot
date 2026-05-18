import * as vscode from 'vscode';
import {
  listVms,
  listVApps,
  listTemplates,
  powerOnVm,
  powerOffVm,
  deleteVm,
  getVmDetails,
  checkVmStatus,
  createSnapshot,
  revertSnapshot,
  listAllSnapshots,
  createVmCopy,
  updateVmResources,
  listTasks,
  normalizeVmStatus,
  createVmDraft,
  createVmConfirmed,
  allocateFreeIp,
  buildCreateFormFromInput,
} from '../vcdApi';
import { getVcdContext, setVcdContext } from '../vcdStore';

function ok(data: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(data)),
  ]);
}

function err(message: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify({ error: message })),
  ]);
}

export function registerVcdTools(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    // ── listVms ─────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ page_size?: number }>('vcd-agent_listVms', {
      async invoke(params) {
        const result = await listVms(params.input.page_size ?? 100);
        const vms = ((result as Record<string, unknown>).vms as Record<string, unknown>[] | undefined) ?? [];
        return ok({ ...(result as object), vms: vms.map(normalizeVmStatus) });
      },
    }),

    // ── listVapps ────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ page_size?: number }>('vcd-agent_listVapps', {
      async invoke(params) {
        return ok(await listVApps(params.input.page_size ?? 100));
      },
    }),

    // ── listTemplates ────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ name_filter?: string }>('vcd-agent_listTemplates', {
      async invoke(params) {
        return ok(await listTemplates(params.input.name_filter ?? ''));
      },
    }),

    // ── getVmDetails ─────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ vm_id: string }>('vcd-agent_getVmDetails', {
      async invoke(params) {
        return ok(await getVmDetails(params.input.vm_id));
      },
    }),

    // ── checkVmStatus ────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ vm_name: string }>('vcd-agent_checkVmStatus', {
      async invoke(params) {
        return ok(await checkVmStatus(params.input.vm_name));
      },
    }),

    // ── listTasks ────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ minutes_ago?: number; page_size?: number }>('vcd-agent_listTasks', {
      async invoke(params) {
        return ok(await listTasks(params.input.minutes_ago ?? 60, params.input.page_size ?? 50));
      },
    }),

    // ── powerOnVm ────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ vm_href: string }>('vcd-agent_powerOnVm', {
      prepareInvocation(params) {
        return {
          confirmationMessages: {
            title: 'Power On VM',
            message: new vscode.MarkdownString(`Power on **${params.input.vm_href}**?`),
          },
        };
      },
      async invoke(params) {
        return ok(await powerOnVm(params.input.vm_href));
      },
    }),

    // ── powerOffVm ───────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ vm_href: string }>('vcd-agent_powerOffVm', {
      prepareInvocation(params) {
        return {
          confirmationMessages: {
            title: 'Power Off VM',
            message: new vscode.MarkdownString(`Power off **${params.input.vm_href}**?`),
          },
        };
      },
      async invoke(params) {
        return ok(await powerOffVm(params.input.vm_href));
      },
    }),

    // ── deleteVm ─────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ vm_href: string; powered_on?: boolean }>('vcd-agent_deleteVm', {
      prepareInvocation(params) {
        return {
          confirmationMessages: {
            title: '⚠ Delete VM',
            message: new vscode.MarkdownString(
              `**Permanently delete** VM \`${params.input.vm_href}\`? This cannot be undone.`
            ),
          },
        };
      },
      async invoke(params) {
        return ok(await deleteVm(params.input.vm_href));
      },
    }),

    // ── createSnapshot ───────────────────────────────────────────────────────
    vscode.lm.registerTool<{ vm_name_or_href: string; description?: string; memory?: boolean; quiesce?: boolean }>('vcd-agent_createSnapshot', {
      prepareInvocation(params) {
        return {
          confirmationMessages: {
            title: 'Create Snapshot',
            message: new vscode.MarkdownString(`Create snapshot for **${params.input.vm_name_or_href}**?`),
          },
        };
      },
      async invoke(params) {
        return ok(await createSnapshot(
          params.input.vm_name_or_href,
          params.input.description,
          params.input.memory,
          params.input.quiesce
        ));
      },
    }),

    // ── revertSnapshot ───────────────────────────────────────────────────────
    vscode.lm.registerTool<{ vm_name_or_href: string }>('vcd-agent_revertSnapshot', {
      prepareInvocation(params) {
        return {
          confirmationMessages: {
            title: '⚠ Revert Snapshot',
            message: new vscode.MarkdownString(
              `Revert **${params.input.vm_name_or_href}** to latest snapshot? All changes since the snapshot will be lost.`
            ),
          },
        };
      },
      async invoke(params) {
        return ok(await revertSnapshot(params.input.vm_name_or_href));
      },
    }),

    // ── listSnapshots ────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ page_size?: number }>('vcd-agent_listSnapshots', {
      async invoke(params) {
        return ok(await listAllSnapshots(params.input.page_size ?? 200));
      },
    }),

    // ── copyVm ───────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{
      vm_name_or_href: string;
      new_vm_name: string;
      target_vapp_href?: string;
      description?: string;
      power_on?: boolean;
    }>('vcd-agent_copyVm', {
      prepareInvocation(params) {
        return {
          confirmationMessages: {
            title: 'Copy VM',
            message: new vscode.MarkdownString(
              `Copy **${params.input.vm_name_or_href}** → **${params.input.new_vm_name}**?`
            ),
          },
        };
      },
      async invoke(params) {
        return ok(await createVmCopy(
          params.input.vm_name_or_href,
          params.input.new_vm_name,
          params.input.target_vapp_href ?? '',
          params.input.power_on,
          params.input.description
        ));
      },
    }),

    // ── resizeVm ─────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ vm_name_or_href: string; num_cpus?: number; memory_mb?: number }>('vcd-agent_resizeVm', {
      prepareInvocation(params) {
        return {
          confirmationMessages: {
            title: 'Resize VM',
            message: new vscode.MarkdownString(
              `Resize **${params.input.vm_name_or_href}**: CPUs=${params.input.num_cpus ?? 'unchanged'}, Memory=${params.input.memory_mb ? params.input.memory_mb + ' MB' : 'unchanged'}?`
            ),
          },
        };
      },
      async invoke(params) {
        return ok(await updateVmResources(
          params.input.vm_name_or_href,
          params.input.num_cpus,
          params.input.memory_mb
        ));
      },
    }),

    // ── allocateFreeIp ───────────────────────────────────────────────────────
    vscode.lm.registerTool('vcd-agent_allocateFreeIp', {
      prepareInvocation() {
        return {
          confirmationMessages: {
            title: 'Allocate Free IP',
            message: new vscode.MarkdownString('Allocate a free IP from the VCD network pool?'),
          },
        };
      },
      async invoke() {
        return ok(await allocateFreeIp());
      },
    }),

    // ── getContext ───────────────────────────────────────────────────────────
    vscode.lm.registerTool('vcd-agent_getContext', {
      async invoke() {
        try {
          const ctx = getVcdContext();
          return ok({ ...ctx, token: ctx.token ? '***' : '' });
        } catch {
          return err('Not connected to VCD. Run /connect first.');
        }
      },
    }),

    // ── setContext ───────────────────────────────────────────────────────────
    vscode.lm.registerTool<{
      host?: string; token?: string; api_version?: string; org_name?: string;
      org_uuid?: string; vdc_id?: string; network_name?: string; gateway?: string;
      dns_servers?: string; storage_profile_id?: string; compute_policy_id?: string;
      reject_unauthorized?: boolean;
    }>('vcd-agent_setContext', {
      prepareInvocation() {
        return {
          confirmationMessages: {
            title: 'Update VCD Context',
            message: new vscode.MarkdownString('Update VCD connection context values?'),
          },
        };
      },
      async invoke(params) {
        const dns = params.input.dns_servers
          ? params.input.dns_servers.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined;
        let current: Record<string, unknown> = {};
        try { current = getVcdContext() as unknown as Record<string, unknown>; } catch { /* not connected yet */ }
        const patch: Record<string, unknown> = {
          apiVersion: String(params.input.api_version ?? current.apiVersion ?? '38.0'),
        };
        if (params.input.host) patch.host = params.input.host;
        if (params.input.token) patch.token = params.input.token;
        if (params.input.org_name) patch.orgName = params.input.org_name;
        if (params.input.org_uuid) patch.orgUuid = params.input.org_uuid;
        if (params.input.vdc_id) patch.vdcId = params.input.vdc_id;
        if (params.input.network_name) patch.networkName = params.input.network_name;
        if (params.input.gateway) patch.gateway = params.input.gateway;
        if (dns) patch.dnsServers = dns;
        if (params.input.storage_profile_id) patch.storageProfileId = params.input.storage_profile_id;
        if (params.input.compute_policy_id) patch.computePolicyId = params.input.compute_policy_id;
        if (params.input.reject_unauthorized !== undefined) patch.rejectUnauthorized = params.input.reject_unauthorized;
        const ctx = setVcdContext(patch);
        return ok({ status: 'ok', context: { ...ctx, token: ctx.token ? '***' : '' } });
      },
    }),

    // ── createVmDraft ────────────────────────────────────────────────────────
    vscode.lm.registerTool<{
      vm_name: string; template_id: string; template_name?: string;
      network_name?: string; ip_allocation_mode?: string; ip_address?: string;
      gateway?: string; dns_servers?: string; power_on?: boolean;
      storage_profile_id?: string; compute_policy_id?: string;
      setup_ilm?: boolean; ilm_version?: string; custom_env_content?: string;
    }>('vcd-agent_createVmDraft', {
      async invoke(params) {
        // Merge provided input with context defaults so the form is fully populated
        const fullForm = buildCreateFormFromInput(params.input as Parameters<typeof buildCreateFormFromInput>[0]);
        await createVmDraft(fullForm);
        // NOTE: do NOT call vscode.commands or open UI here — VS Code forbids
        // webview creation inside a tool invoke callback.  The participant will
        // detect this tool call and open the form panel after invokeTool returns.
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(JSON.stringify({
            status: 'draft_ready',
            form: fullForm,
            message: 'VM creation review form is ready. STOP — do not call any more tools. Tell the user to review the VM details in the panel and click Deploy to confirm.',
          })),
        ]);
      },
    }),

    // ── createVmConfirmed ────────────────────────────────────────────────────
    vscode.lm.registerTool('vcd-agent_createVmConfirmed', {
      prepareInvocation() {
        return {
          confirmationMessages: {
            title: 'Deploy VM',
            message: new vscode.MarkdownString('Deploy the VM from the current draft?'),
          },
        };
      },
      async invoke() {
        return ok(await createVmConfirmed());
      },
    })
  );
}
