/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-require-imports */
// @ts-nocheck — LangChain imports are loaded dynamically to avoid TypeScript resolving
// their heavy generic type declarations at compile time (causing OOM in tsc).
import https from 'https';
import { tokenManager } from './tokenManager';
import { logApi } from './apiLogger';
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
  createVmDraft,
  // createVmConfirmed,
  listTasks,
  normalizeVmStatus,
  buildCreateFormFromInput,
  checkVmStatus,
} from './vcdApi';
import { setVcdContext, getVcdContext } from './vcdStore';
import { formatToolResult } from './toolResultFormatter';
import { toolRegistry, approvalSystem } from './tools';
import { taskTracker } from './taskTracker';
import { vmWatcher } from './vmWatcher';

// Dynamic requires — avoids TypeScript resolving @langchain/* type declarations at build time
const { ChatOpenAI } = require('@langchain/openai');
const { tool: lcTool } = require('@langchain/core/tools');
const { z } = require('zod');
const {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
} = require('@langchain/core/messages');

const CHAT_API_BASE = 'api.githubcopilot.com';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const TOOL_SYSTEM_PROMPT = [
  'You are a VMware Cloud Director and Linux systems assistant. Use tools for ALL data lookups and actions — never describe how to do something manually when a tool can do it directly.',
  '',
  '── VM MANAGEMENT ──',
  'When the user asks to create a VM, do the following in a single turn without questions:',
  '1) If the user explicitly provides a template UUID (a string matching xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx), use it directly — skip list_templates.',
  '   Otherwise call list_templates with a name_filter for the OS mentioned.',
  '   Note: "seles", "sles", "suse" all mean SUSE Linux Enterprise Server (SLES) — use name_filter="sles" for those.',
  '2) Pick the closest template by OS name/version (skip if UUID was provided directly).',
  '3) Call create_vm_draft with vm_name, template_id, template_name, and any provided params.',
  '4) Do not ask for confirmation before create_vm_draft. The draft is the review step.',
  '5) Call create_vm_confirmed only after the user explicitly confirms.',
  'When resizing CPU or memory, call resize_vm directly with vm_name_or_href and num_cpus/memory_mb.',
  'For snapshot actions: use create_snapshot, revert_snapshot, and list_snapshots tools.',
  'For recent task lookups: use list_tasks or list_recent_tasks with minutes_ago.',
  'For VM copy/clone requests in chat, call list_vapps, select a target vApp, then call create_vm_copy_draft with target_vapp_href so the UI can show an editable review form.',
  'Do not call create_vm_copy directly in chat unless the user explicitly asks to skip review.',
  '',
  '── SSH / REMOTE EXECUTION ──',
  'When the user asks to connect to a VM, run commands on a VM, or perform any remote operation:',
  '1) Call ssh_connect with the host, username, and password (or privateKey) to establish a session.',
  '2) Use the returned sessionId for all subsequent ssh_runCommand, ssh_runSudoCommand, or other ssh_* calls.',
  '3) Always call ssh_connect first — do NOT instruct the user to run SSH commands themselves.',
  '4) After completing the requested task, report the results directly from tool output.',
  '5) Call ssh_disconnect when done or when the user asks to disconnect.',
  'IMPORTANT: ssh_connect and all ssh_runCommand / ssh_runSudoCommand calls require user approval — the approval dialog will appear automatically before each execution.',
  '',
  '── LONG-RUNNING TASKS (installs, configuration, multi-step operations) ──',
  'When the user asks to perform a multi-step operation (e.g., install software, configure a server):',
  '1) Call task_start at the very beginning with a descriptive name and the SSH sessionId.',
  '2) Before EACH command, call ssh_runCommand (it will prompt for approval).',
  '3) After EACH command, call task_log_step with the description, command, output, and exit_code.',
  '4) If a step fails (exit_code != 0), assess whether to retry, skip, or abort — then call task_done.',
  '5) When all steps are complete, call task_done.',
  'If uploaded docs contain installation steps, read them with docs_ask or docs_search and follow those steps.',
  'Long command output is automatically truncated. If you need to read the full output, use task_get_log with the logId shown in the truncated output.',
  '',
  '── BACKGROUND VM MONITORING ──',
  'When the user asks to "wait for a VM to come up", "create a background task", "monitor a VM", or "notify me when a VM is ready":',
  '1) ALWAYS call vm_watch immediately — do NOT just say you will monitor it.',
  '2) Pass vm_name (exact VM name), ip (expected IP), username, password, and commands to run once up.',
  '3) vm_watch returns a taskId; confirm to the user that the real background task has been created.',
  '4) The task appears in the Tasks panel on the left. A chat notification will appear automatically when the VM is reachable and the commands have been run.',
  '5) To cancel a running watch, call vm_watch_cancel with the taskId.',
  'Default commands if the user only wants OS version: ["cat /etc/os-release"]',
  '',
  '── DOCUMENT Q&A ──',
  'When the user asks about uploaded documents: use docs_list, docs_search, docs_ask, docs_getContent.',
  'To upload a document: call docs_upload with the file path.',
  '',
  'IMPORTANT: For all tool results (especially list_vms, list_vapps, list_templates, list_tasks):',
  '- Do NOT show raw JSON responses.',
  '- Format list results as markdown tables with columns for key properties.',
  '- Use bold headers, organize data clearly, and add helpful summaries.',
  '- For VM lists: show columns like Name, Status, IP Address, Owner.',
  '- For template lists: show columns like Name, CPU, Memory, OS.',
  '- For task lists: show columns like Name, Status, Progress, Start Time.',
  '- Keep the presentation user-friendly and easy to scan.',
].join('\n');

// ── LangChain tool definitions (with Zod schemas) ────────────────────

const setVcdContextTool = lcTool(
  async (args) => {
    const dns = args.dns_servers
      ? String(args.dns_servers).split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    let current: Record<string, unknown> = {};
    try { current = getVcdContext() as unknown as Record<string, unknown>; } catch { current = {}; }
    const patch: Record<string, unknown> = {
      apiVersion: String(args.api_version ?? current.apiVersion ?? '38.0'),
    };
    if (args.host) patch.host = args.host;
    if (args.token) patch.token = args.token;
    if (args.org_name) patch.orgName = args.org_name;
    if (args.org_uuid) patch.orgUuid = args.org_uuid;
    if (args.vdc_id) patch.vdcId = args.vdc_id;
    if (args.network_name) patch.networkName = args.network_name;
    if (args.gateway) patch.gateway = args.gateway;
    if (dns) patch.dnsServers = dns;
    if (args.storage_profile_id) patch.storageProfileId = args.storage_profile_id;
    if (args.compute_policy_id) patch.computePolicyId = args.compute_policy_id;
    if (args.reject_unauthorized !== undefined) patch.rejectUnauthorized = args.reject_unauthorized;
    const ctx = setVcdContext(patch);
    return JSON.stringify({ status: 'ok', context: { ...ctx, token: ctx.token ? '***' : '' } });
  },
  {
    name: 'set_vcd_context',
    description: 'Set or override VCD context values if needed. Usually not required after VCD login.',
    schema: z.object({
      host: z.string().optional().describe('VCD hostname (optional override)'),
      token: z.string().optional().describe('Bearer token (optional override)'),
      api_version: z.string().optional().describe('VCD API version (default 38.0)'),
      org_name: z.string().optional().describe('Org name for tenant context (optional)'),
      org_uuid: z.string().optional().describe('Org UUID for tenant context (optional)'),
      vdc_id: z.string().optional().describe('VDC ID for VM creation (optional)'),
      network_name: z.string().optional().describe('Default network name (optional)'),
      gateway: z.string().optional().describe('Default gateway (optional)'),
      dns_servers: z.string().optional().describe('Comma-separated DNS servers (optional)'),
      storage_profile_id: z.string().optional().describe('Default storage profile ID (optional)'),
      compute_policy_id: z.string().optional().describe('Default compute policy ID (optional)'),
      reject_unauthorized: z.boolean().optional().describe('Reject invalid TLS certs (default false)'),
    }),
  }
);

const listVmsTool = lcTool(
  async (args) => {
    const result = await listVms(args.page_size ?? 100);
    const vms = (result as { vms?: Record<string, unknown>[] }).vms ?? [];
    const base = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
    return JSON.stringify({ ...base, vms: vms.map(normalizeVmStatus) });
  },
  {
    name: 'list_vms',
    description: 'List VMs in the current tenant.',
    schema: z.object({
      page_size: z.number().optional().describe('Number of VMs per page (default 100)'),
    }),
  }
);

const listVappsTool = lcTool(
  async (args) => {
    const result = await listVApps(args.page_size ?? 100);
    return JSON.stringify(result);
  },
  {
    name: 'list_vapps',
    description: 'List vApps in the current tenant.',
    schema: z.object({
      page_size: z.number().optional().describe('Number of vApps per page (default 100)'),
    }),
  }
);

const listRunningVmsTool = lcTool(
  async () => {
    const result = await listVms(200);
    const vms = (result as { vms?: Record<string, unknown>[] }).vms ?? [];
    const running = vms.map(normalizeVmStatus).filter((vm) => vm.powered_on);
    return JSON.stringify({ count: running.length, vms: running });
  },
  {
    name: 'list_running_vms',
    description: 'List running VMs in the current tenant.',
    schema: z.object({}),
  }
);

const listStoppedVmsTool = lcTool(
  async () => {
    const result = await listVms(200);
    const vms = (result as { vms?: Record<string, unknown>[] }).vms ?? [];
    const stopped = vms.map(normalizeVmStatus).filter((vm) => !vm.powered_on);
    return JSON.stringify({ count: stopped.length, vms: stopped });
  },
  {
    name: 'list_stopped_vms',
    description: 'List stopped VMs in the current tenant.',
    schema: z.object({}),
  }
);

const listTemplatesTool = lcTool(
  async (args) => {
    console.log(`[TOOL] list_templates called with name_filter="${args.name_filter ?? ''}"`);
    const result = await listTemplates(args.name_filter ?? '');
    return JSON.stringify(result);
  },
  {
    name: 'list_templates',
    description: 'List vApp templates. Optional name filter (e.g., "ubuntu" or "sles").',
    schema: z.object({
      name_filter: z.string().optional().describe('Template name filter'),
    }),
  }
);

const checkVmStatusTool = lcTool(
  async (args) => {
    const result = await checkVmStatus(args.vm_name);
    return JSON.stringify(result);
  },
  {
    name: 'check_vm_status',
    description: 'Check if a VM is present and return status by exact VM name.',
    schema: z.object({
      vm_name: z.string().describe('Exact VM name'),
    }),
  }
);

const startVmTool = lcTool(
  async (args) => {
    const result = await powerOnVm(args.vm_href);
    return JSON.stringify(result);
  },
  {
    name: 'start_vm',
    description: 'Power on a VM by href.',
    schema: z.object({
      vm_href: z.string().describe('Full VCD VM href URL'),
    }),
  }
);

const stopVmTool = lcTool(
  async (args) => {
    const result = await powerOffVm(args.vm_href);
    return JSON.stringify(result);
  },
  {
    name: 'stop_vm',
    description: 'Power off a VM by href.',
    schema: z.object({
      vm_href: z.string().describe('Full VCD VM href URL'),
    }),
  }
);

const createSnapshotTool = lcTool(
  async (args) => {
    const snapshotName = args.name ?? args.description;
    const result = await createSnapshot(
      args.vm_name_or_href,
      snapshotName,
      args.memory ?? false,
      args.quiesce ?? false
    );
    return JSON.stringify(result);
  },
  {
    name: 'create_snapshot',
    description: 'Create a snapshot for a VM by name or href.',
    schema: z.object({
      vm_name_or_href: z.string().describe('VM name or full href'),
      name: z.string().optional().describe('Snapshot name'),
      description: z.string().optional().describe('Optional snapshot name/description (legacy)'),
      memory: z.boolean().optional().describe('Include memory in snapshot (default false)'),
      quiesce: z.boolean().optional().describe('Quiesce file system (default false)'),
    }),
  }
);

const revertSnapshotTool = lcTool(
  async (args) => {
    const result = await revertSnapshot(args.vm_name_or_href);
    return JSON.stringify(result);
  },
  {
    name: 'revert_snapshot',
    description: 'Revert a VM to its current/latest snapshot.',
    schema: z.object({
      vm_name_or_href: z.string().describe('VM name or full href'),
    }),
  }
);

const createVmCopyDraftTool = lcTool(
  async (args) => {
    const source = String(args.vm_name_or_href || '').trim();
    const draftName = String(args.new_vm_name || (source && !source.startsWith('http') ? `${source}-copy` : 'vm-copy')).trim();
    const result = {
      type: 'vm_copy_form',
      message: 'Review and confirm VM copy details.',
      form: {
        vm_name_or_href: source,
        new_vm_name: draftName,
        target_vapp_href: args.target_vapp_href ? String(args.target_vapp_href) : '',
        description: args.description ? String(args.description) : `Copy of ${source || 'source-vm'}`,
        power_on: args.power_on ?? false,
      },
    };
    return JSON.stringify(result);
  },
  {
    name: 'create_vm_copy_draft',
    description: 'Prepare a VM copy/clone draft for review in the chat UI.',
    schema: z.object({
      vm_name_or_href: z.string().describe('Source VM name or full href'),
      new_vm_name: z.string().optional().describe('Name for the cloned VM (defaults to source-name-copy)'),
      target_vapp_href: z.string().optional().describe('Target vApp href where the VM copy will be placed'),
      power_on: z.boolean().optional().describe('Power on the copied VM after clone'),
      description: z.string().optional().describe('Optional description for the copied VM'),
    }),
  }
);

const createVmCopyTool = lcTool(
  async (args) => {
    const result = await createVmCopy(
      args.vm_name_or_href,
      args.new_vm_name,
      args.target_vapp_href,
      args.power_on ?? false,
      args.description
    );
    return JSON.stringify(result);
  },
  {
    name: 'create_vm_copy',
    description: 'Create a copy/clone of a VM with a new name in a target vApp.',
    schema: z.object({
      vm_name_or_href: z.string().describe('Source VM name or full href'),
      new_vm_name: z.string().describe('Name for the cloned VM'),
      target_vapp_href: z.string().describe('Target vApp href where the VM copy will be placed'),
      power_on: z.boolean().optional().describe('Power on the copied VM after clone'),
      description: z.string().optional().describe('Optional description for the copied VM'),
    }),
  }
);

const listSnapshotsTool = lcTool(
  async (args) => {
    const result = await listAllSnapshots(args.page_size ?? 200);
    return JSON.stringify(result);
  },
  {
    name: 'list_snapshots',
    description: 'List snapshots across all VMs in the tenant.',
    schema: z.object({
      page_size: z.number().optional().describe('Max records to fetch (default 200)'),
    }),
  }
);

const resizeVmTool = lcTool(
  async (args) => {
    const result = await updateVmResources(args.vm_name_or_href, args.num_cpus, args.memory_mb);
    return JSON.stringify(result);
  },
  {
    name: 'resize_vm',
    description: 'Resize VM CPU and/or RAM (may power off temporarily).',
    schema: z.object({
      vm_name_or_href: z.string().describe('VM name or full href'),
      num_cpus: z.number().optional().describe('Desired vCPU count (1-4)'),
      memory_mb: z.number().optional().describe('Desired RAM in MB (512-20480)'),
    }),
  }
);

const createVmDraftTool = lcTool(
  async (args) => {
    const form = buildCreateFormFromInput({
      vm_name: args.vm_name,
      template_id: args.template_id,
      template_name: args.template_name,
      network_name: args.network_name,
      ip_allocation_mode: args.ip_allocation_mode,
      ip_address: args.ip_address,
      gateway: args.gateway,
      dns_servers: args.dns_servers,
      power_on: args.power_on,
      storage_profile_id: args.storage_profile_id,
      compute_policy_id: args.compute_policy_id,
      setup_ilm: args.setup_ilm,
      ilm_version: args.ilm_version,
      setup_idm: args.setup_idm,
    });
    const result = await createVmDraft(form);
    return JSON.stringify(result);
  },
  {
    name: 'create_vm_draft',
    description: 'Prepare a VM creation draft for review.',
    schema: z.object({
      vm_name: z.string().describe('Name of the VM'),
      template_id: z.string().describe('Template UUID (vApp template)'),
      template_name: z.string().optional().describe('Template name (used for OS detection)'),
      network_name: z.string().optional().describe('Network name'),
      ip_allocation_mode: z.string().optional().describe('DHCP, POOL, or MANUAL'),
      ip_address: z.string().optional().describe('IP address if MANUAL'),
      gateway: z.string().optional().describe('Gateway IP'),
      dns_servers: z.string().optional().describe('Comma-separated DNS servers'),
      power_on: z.boolean().optional().describe('Power on after creation'),
      storage_profile_id: z.string().optional().describe('Storage profile ID'),
      compute_policy_id: z.string().optional().describe('Compute policy ID'),
      setup_ilm: z.boolean().optional().describe('Install ILM stack'),
      ilm_version: z.string().optional().describe('ILM version (e.g., latest, 1.7.0)'),
      setup_idm: z.boolean().optional().describe('Install IDM stack'),
    }),
  }
);

const listTasksTool = lcTool(
  async (args) => {
    const result = await listTasks(args.minutes_ago ?? 60, args.page_size ?? 50);
    return JSON.stringify(result);
  },
  {
    name: 'list_tasks',
    description: 'List recent tasks from the last N minutes.',
    schema: z.object({
      minutes_ago: z.number().optional().describe('Minutes to look back (default 60)'),
      page_size: z.number().optional().describe('Max tasks to return (default 50)'),
    }),
  }
);

const listRecentTasksTool = lcTool(
  async (args) => {
    const result = await listTasks(args.minutes_ago ?? 60, args.page_size ?? 50);
    return JSON.stringify(result);
  },
  {
    name: 'list_recent_tasks',
    description: 'List recent tasks from the last N minutes.',
    schema: z.object({
      minutes_ago: z.number().optional().describe('Minutes to look back (default 60)'),
      page_size: z.number().optional().describe('Max tasks to return (default 50)'),
    }),
  }
);

const vmWatchTool = lcTool(
  async (args) => {
    const commands: string[] = args.commands
      ? (Array.isArray(args.commands) ? args.commands : [String(args.commands)])
      : ['cat /etc/os-release'];

    // Create a real taskTracker task so it appears in the Tasks panel
    const task = taskTracker.createTask(
      `Watch VM: ${args.vm_name}`,
      `Monitoring VM "${args.vm_name}" (${args.ip}) — will SSH and run: ${commands.join('; ')} once up.`
    );

    vmWatcher.watch({
      vmName: String(args.vm_name),
      ip: String(args.ip),
      username: String(args.username),
      password: String(args.password),
      commands,
      taskId: task.id,
      pollIntervalMs: args.poll_interval_secs ? Number(args.poll_interval_secs) * 1000 : 30_000,
      timeoutMs: 60 * 60_000, // always 60-minute ceiling — no need for user to specify
    });

    return JSON.stringify({
      taskId: task.id,
      message: `Background watch created (task ID: ${task.id}). Will poll every 30s for up to 60 minutes and retry SSH automatically after power-on. A chat notification will appear when the VM is reachable.`,
    });
  },
  {
    name: 'vm_watch',
    description: 'Create a REAL background monitoring task that polls a VM until it is powered on, then SSHes in and runs the specified commands. Use this whenever the user asks to "monitor", "watch", or "wait for" a VM to come up. Always call this instead of just describing what you would do.',
    schema: z.object({
      vm_name: z.string().describe('Exact VM name as shown in VCD'),
      ip: z.string().describe('Expected IP address of the VM (used as SSH host)'),
      username: z.string().describe('SSH username (e.g., root)'),
      password: z.string().describe('SSH password'),
      commands: z.array(z.string()).optional().describe('Commands to run once the VM is reachable (default: ["cat /etc/os-release"])'),
      poll_interval_secs: z.number().optional().describe('How often to check VM status in seconds (default 30)'),
    }),
  }
);

const vmWatchCancelTool = lcTool(
  async (args) => {
    const cancelled = vmWatcher.cancel(String(args.task_id));
    return JSON.stringify({
      cancelled,
      message: cancelled ? `Watch ${args.task_id} cancelled.` : `No active watch found for task ID ${args.task_id}.`,
    });
  },
  {
    name: 'vm_watch_cancel',
    description: 'Cancel an active background VM watch by its task ID.',
    schema: z.object({
      task_id: z.string().describe('Task ID returned by vm_watch'),
    }),
  }
);

// Ordered list of all LangChain tools
const LC_TOOLS = [
  setVcdContextTool,
  listVmsTool,
  listVappsTool,
  listRunningVmsTool,
  listStoppedVmsTool,
  listTemplatesTool,
  checkVmStatusTool,
  startVmTool,
  stopVmTool,
  createSnapshotTool,
  revertSnapshotTool,
  createVmCopyDraftTool,
  createVmCopyTool,
  listSnapshotsTool,
  resizeVmTool,
  createVmDraftTool,
  // createVmConfirmedTool,
  listTasksTool,
  listRecentTasksTool,
  vmWatchTool,
  vmWatchCancelTool,
];

// ── Task tracking LangChain tools ─────────────────────────────────────────────

const taskStartTool = lcTool(
  async (args) => {
    const task = taskTracker.createTask(
      String(args.name),
      args.description ? String(args.description) : undefined,
      args.session_id ? String(args.session_id) : undefined
    );
    return JSON.stringify({
      taskId: task.id,
      message: `Task "${task.name}" started. Use taskId "${task.id}" for step logging.`,
    });
  },
  {
    name: 'task_start',
    description: 'Start tracking a long-running multi-step task (e.g., software installation). Returns a taskId. Call this before beginning any multi-step operation.',
    schema: z.object({
      name: z.string().describe('Short descriptive task name (e.g., "Install NetIQ IDM")'),
      description: z.string().optional().describe('Longer description of what the task will do'),
      session_id: z.string().optional().describe('SSH session ID this task runs inside'),
    }),
  }
);

const taskLogStepTool = lcTool(
  async (args) => {
    const taskId = String(args.task_id);
    const step = taskTracker.beginStep(taskId, String(args.description), args.command ? String(args.command) : undefined);
    if (!step) return JSON.stringify({ error: `Task not found: ${taskId}` });
    const exitCode = typeof args.exit_code === 'number' ? args.exit_code : 0;
    taskTracker.completeStep(taskId, step.id, String(args.output ?? ''), exitCode);
    return JSON.stringify({ stepId: step.id, status: exitCode !== 0 ? 'failed' : 'done' });
  },
  {
    name: 'task_log_step',
    description: 'Record a completed step within a running task. Call after every ssh_runCommand to track progress. Stores output and handles log truncation automatically.',
    schema: z.object({
      task_id: z.string().describe('Task ID returned by task_start'),
      description: z.string().describe('Human-readable step label (e.g., "Install Java runtime")'),
      command: z.string().optional().describe('The exact command that was executed'),
      output: z.string().describe('Full stdout + stderr from the command'),
      exit_code: z.number().optional().describe('Exit code (0 = success, non-zero = failure)'),
    }),
  }
);

const taskDoneTool = lcTool(
  async (args) => {
    const task = taskTracker.completeTask(
      String(args.task_id),
      args.error ? String(args.error) : undefined
    );
    if (!task) return JSON.stringify({ error: `Task not found: ${args.task_id}` });
    return JSON.stringify({ status: task.status, message: `Task "${task.name}" ${task.status}.` });
  },
  {
    name: 'task_done',
    description: 'Mark a task as completed or failed. Always call this when all steps are done.',
    schema: z.object({
      task_id: z.string().describe('Task ID from task_start'),
      error: z.string().optional().describe('Error message if the task failed (omit on success)'),
    }),
  }
);

const taskListTool2 = lcTool(
  async () => {
    const tasks = taskTracker.listTasks(10);
    return JSON.stringify({
      count: tasks.length,
      tasks: tasks.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        totalSteps: t.steps.length,
        doneSteps: t.steps.filter((s) => s.status === 'done').length,
        failedSteps: t.steps.filter((s) => s.status === 'failed').length,
        createdAt: new Date(t.createdAt).toISOString(),
      })),
    });
  },
  {
    name: 'task_list',
    description: 'List recent agent tasks and their status',
    schema: z.object({}),
  }
);

const taskGetLogTool = lcTool(
  async (args) => {
    const result = taskTracker.getLog(String(args.log_id));
    if (!result.found) return JSON.stringify({ error: `Log not found: ${args.log_id}` });
    return JSON.stringify({ logId: args.log_id, totalBytes: result.total, tail: result.tail });
  },
  {
    name: 'task_get_log',
    description: 'Retrieve the tail of a stored command log. Use this when a step output was truncated (the logId appears in the truncated output). Useful for diagnosing failed steps.',
    schema: z.object({
      log_id: z.string().describe('Log ID shown in truncated step output'),
    }),
  }
);

const TASK_TOOLS = [taskStartTool, taskLogStepTool, taskDoneTool, taskListTool2, taskGetLogTool];

// ── Tool manifest (for renderer Configure Tools panel) ────────────────────────

export interface ToolManifestEntry {
  name: string;
  category: string;
  description: string;
}

/**
 * Returns a flat manifest of every tool available to the LLM, with its
 * category and description. Used by the renderer Configure Tools panel.
 */
export function getToolManifest(): ToolManifestEntry[] {
  // These LC_TOOLS perform SSH operations and must be gated with the ssh category
  const SSH_LC_TOOL_NAMES = new Set(['vm_watch', 'vm_watch_cancel']);

  const vcdEntries: ToolManifestEntry[] = LC_TOOLS.map((t) => ({
    name: t.name,
    category: SSH_LC_TOOL_NAMES.has(t.name) ? 'ssh' : 'vcd',
    description: t.description,
  }));

  const taskEntries: ToolManifestEntry[] = TASK_TOOLS.map((t) => ({
    name: t.name,
    category: 'tasks',
    description: t.description,
  }));

  const sanitize = (n: string) => n.replace(/[^a-zA-Z0-9_.\-]/g, '_');
  const registryEntries = toolRegistry.list().tools.map((t) => ({
    name: sanitize(t.name),
    category: t.category,
    description: t.description,
  }));

  return [...vcdEntries, ...taskEntries, ...registryEntries];
}

// ── Registry tool builder (with approval + log truncation) ────────────────────

/** Build a one-line impact description shown in the approval dialog */
function buildImpactText(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'ssh:connect') {
    return `Establish SSH connection → ${args.username}@${args.host}`;
  }
  if (toolName === 'ssh:runCommand' || toolName === 'ssh:runSudoCommand') {
    return `Execute on remote host: \`${String(args.command ?? '').slice(0, 200)}\``;
  }
  if (toolName === 'ssh:runScript') {
    const preview = String(args.script ?? '').split('\n').slice(0, 3).join(' | ');
    return `Run script on remote host: \`${preview}...\``;
  }
  if (toolName === 'docs:delete') {
    return `Permanently delete document: ${args.docId}`;
  }
  return `Execute ${toolName}: ${JSON.stringify(args).slice(0, 200)}`;
}

/**
 * Build LangChain tool wrappers for registry tools in a given category.
 * - Sanitizes names to meet OpenAI's ^[a-zA-Z0-9_.-]+$ requirement
 * - Requests human approval for non-safe (review/dangerous) tools
 * - Truncates large outputs and stores full logs via taskTracker
 */
function buildRegistryTools(category: string) {
  const OUTPUT_TRUNCATE = 3000;
  const registryTools = toolRegistry.getToolsForLangChain(category as never);

  return registryTools.map((t) => {
    const safeName = t.name.replace(/[^a-zA-Z0-9_.\-]/g, '_');
    const toolMeta = toolRegistry.get(t.name);
    const riskLevel = toolMeta?.metadata.riskLevel ?? 'review';

    return lcTool(
      async (args: Record<string, unknown>) => {
        // ── Human-in-the-loop approval ────────────────────────────────────
        if (riskLevel !== 'safe') {
          const needsApproval = approvalSystem.requiresApproval(t.name, riskLevel);
          if (needsApproval) {
            try {
              const response = await approvalSystem.requestApproval(
                t.name,
                toolMeta!.metadata,
                args,
                String(toolMeta!.metadata.target),
                buildImpactText(t.name, args)
              );
              if (!response.approved) {
                return JSON.stringify({
                  denied: true,
                  reason: response.denialReason ?? 'User denied execution',
                });
              }
            } catch (approvalErr) {
              return JSON.stringify({ denied: true, reason: String(approvalErr) });
            }
          }
        }

        // ── Execute tool ──────────────────────────────────────────────────
        const result = await toolRegistry.execute({ toolName: t.name, args, context: { approved: true } });
        if (!result.success) {
          return JSON.stringify({ error: result.error ?? 'Tool execution failed' });
        }

        // ── Log truncation ────────────────────────────────────────────────
        let output = typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);

        if (output.length > OUTPUT_TRUNCATE) {
          const logId = taskTracker.storeLog(output);
          const head = output.slice(0, 1200);
          const tail = output.slice(-500);
          output =
            head +
            `\n...[output truncated — ${output.length} bytes total, logId: "${logId}" — use task_get_log to read full output]...\n` +
            tail;
        }

        return output;
      },
      { name: safeName, description: t.description, schema: t.schema }
    );
  });
}

// ── Helpers ──────────────────────────────────────────────────────────

function getCopilotHeaders(): Record<string, string> {
  return {
    'Editor-Version': 'vscode/1.85.0',
    'Editor-Plugin-Version': 'copilot-chat/0.12.0',
    'Copilot-Integration-Id': 'vscode-chat',
    'User-Agent': 'GitHubCopilot/1.1.0',
    'X-GitHub-Api-Version': '2023-07-07',
    'OpenAI-Intent': 'conversation-panel',
  };
}

function getHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...getCopilotHeaders(),
  };
}

async function getValidToken(): Promise<string> {
  const looksLikeOAuthToken = (value: string) => value.length < 100;

  let token = await tokenManager.getBestToken();
  if (token) {
    if (looksLikeOAuthToken(token)) {
      console.warn('[ChatAPI] Rejecting short OAuth-like token from getBestToken; forcing refresh');
    } else {
      return token;
    }
  }

  // Second-chance refresh before failing hard.
  token = await tokenManager.refreshToken();
  if (token) {
    if (looksLikeOAuthToken(token)) {
      console.warn('[ChatAPI] refreshToken returned OAuth-like token; rejecting for chat API');
    } else {
      return token;
    }
  }

  throw new Error('No valid Copilot token available. Please sign in (or reconnect Copilot).');
}

async function httpsGet(urlPath: string, headers: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const fullUrl = `https://${CHAT_API_BASE}${urlPath}`;
    logApi({
      source: 'copilotChatApi.httpsGet',
      stage: 'request',
      method: 'GET',
      url: fullUrl,
      headers,
    });

    const options = {
      hostname: CHAT_API_BASE,
      path: urlPath,
      method: 'GET',
      headers,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        logApi({
          source: 'copilotChatApi.httpsGet',
          stage: 'response',
          method: 'GET',
          url: fullUrl,
          status: res.statusCode || 0,
          durationMs: Date.now() - startedAt,
          headers: res.headers as Record<string, unknown>,
          responseBody: data,
        });
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on('error', (err) => {
      logApi({
        source: 'copilotChatApi.httpsGet',
        stage: 'error',
        method: 'GET',
        url: fullUrl,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      reject(err);
    });
    req.end();
  });
}

// Helper: convert plain ChatMessage[] to LangChain BaseMessage[]
function toLcMessages(messages: ChatMessage[]): BaseMessage[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'system': return new SystemMessage(m.content);
      case 'assistant': return new AIMessage(m.content);
      default: return new HumanMessage(m.content);
    }
  });
}

// Build a ChatOpenAI instance pointed at the Copilot API
function buildCopilotLlm(token: string, modelId: string): ChatOpenAI {
  console.log('[ChatAPI] Building LLM with model:', modelId);
  console.log('[ChatAPI] Token available:', !!token, 'length:', token?.length || 0);
  console.log('[ChatAPI] Base URL:', `https://${CHAT_API_BASE}`);
  
  return new ChatOpenAI({
    model: modelId,
    apiKey: token,
    baseURL: `https://${CHAT_API_BASE}`,
    defaultHeaders: getCopilotHeaders(),
    configuration: {
      apiKey: token,
      baseURL: `https://${CHAT_API_BASE}`,
      defaultHeaders: getCopilotHeaders(),
    },
    temperature: 0,
    streaming: true,
  });
}

export async function getModels(): Promise<string[]> {
  try {
    const token = await getValidToken();
    const response = await httpsGet('/models', getHeaders(token)) as { data?: Array<{ id: string }> };

    if (response?.data && Array.isArray(response.data)) {
      return response.data.map((m) => m.id);
    }

    // Fallback model list if API doesn't return expected format
    return ['gpt-4', 'gpt-4o', 'claude-3.5-sonnet', 'o1-preview'];
  } catch (e) {
    console.error('[ChatAPI] getModels error:', e);
    return ['gpt-4', 'gpt-4o', 'claude-3.5-sonnet', 'o1-preview'];
  }
}

// Simple streaming (no tools) — uses LangChain ChatOpenAI streaming
export function streamChatCompletion(
  modelId: string,
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
  onEnd: () => void,
  onError: (err: Error) => void
): void {
  console.log('[ChatAPI] streamChatCompletion starting - model:', modelId);
  getValidToken()
    .then(async (token) => {
      console.log('[ChatAPI] Token obtained for streaming');
      const llm = buildCopilotLlm(token, modelId);
      const lcMessages: BaseMessage[] = [
        new SystemMessage(TOOL_SYSTEM_PROMPT),
        ...toLcMessages(messages),
      ];
      const stream = await llm.stream(lcMessages);
      for await (const chunk of stream) {
        const content = typeof chunk.content === 'string' ? chunk.content : '';
        if (content) onChunk(content);
      }
      onEnd();
    })
    .catch((err: Error) => {
      console.error('[ChatAPI] streamChatCompletion error:', err);
      let errorMessage = err.message;
      if (errorMessage.includes('403')) {
        errorMessage += '\n\nThis usually means your GitHub Copilot token has expired or is invalid. Try signing out and signing back in.';
      }
      onError(new Error(errorMessage));
    });
}

// Module-level abort controller for the currently-running chatWithTools call
let _activeChatAbort: AbortController | null = null;

/** Cancel any in-progress chatWithTools request. Safe to call when idle. */
export function cancelChatWithTools(): void {
  if (_activeChatAbort) {
    _activeChatAbort.abort();
    _activeChatAbort = null;
  }
}

// Agentic tool-calling loop — powered by LangChain (ChatOpenAI + bindTools)
export async function chatWithTools(
  modelId: string,
  messages: ChatMessage[],
  onChunk: (chunk: string, type: 'text' | 'tool-call' | 'tool-result') => void,
  onEnd: () => void,
  onError: (err: Error) => void,
  onVmDraft?: (form: Record<string, unknown>) => void,
  onVmCopyDraft?: (form: Record<string, unknown>) => void,
  disabledToolNames?: string[]
): Promise<void> {
  // Set up cancellation for this request
  const abortController = new AbortController();
  _activeChatAbort = abortController;

  // Snapshot tasks that were already running so we can auto-complete any tasks the
  // agent starts during this conversation but forgets to call task_done on.
  const runningBefore = new Set(
    taskTracker.listTasks(50).filter((t) => t.status === 'running').map((t) => t.id)
  );

  try {
    console.log('[ChatAPI] chatWithTools starting - model:', modelId, 'messages:', messages.length);
    const token = await getValidToken();
    const registryDocTools = buildRegistryTools('docs');
    const registrySshTools = buildRegistryTools('ssh');
    let allTools = [...LC_TOOLS, ...TASK_TOOLS, ...registryDocTools, ...registrySshTools];
    if (disabledToolNames && disabledToolNames.length > 0) {
      const disabledSet = new Set(disabledToolNames);
      allTools = allTools.filter((t) => !disabledSet.has(t.name));
    }
    console.log('[ChatAPI] Token obtained, building LLM with', allTools.length, 'tools',
      `(${LC_TOOLS.length} VCD + ${TASK_TOOLS.length} tasks + ${registryDocTools.length} docs + ${registrySshTools.length} ssh)`);
    const llm = buildCopilotLlm(token, modelId).bindTools(allTools);

    // Build dynamic addendum listing exactly what is/isn't available
    const toolNames = new Set(allTools.map((t) => t.name));
    const sshAvailable = toolNames.has('ssh_connect') || toolNames.has('ssh:connect');

    // Derive disabled categories from the manifest vs. what's actually in allTools
    const manifest = getToolManifest();
    const disabledSet2 = new Set(disabledToolNames ?? []);
    const disabledByCategory: Record<string, string[]> = {};
    for (const entry of manifest) {
      if (disabledSet2.has(entry.name)) {
        if (!disabledByCategory[entry.category]) disabledByCategory[entry.category] = [];
        disabledByCategory[entry.category].push(entry.name);
      }
    }
    const disabledCategories = Object.keys(disabledByCategory);

    let dynamicAddendum = '';
    if (disabledCategories.length > 0) {
      const lines = [
        '',
        '── TOOL AVAILABILITY NOTICE ──',
        'The following tool groups have been DISABLED by the user and are NOT available to you:',
        ...disabledCategories.map((cat) => `  • ${cat}: ${disabledByCategory[cat].join(', ')}`),
        '',
        'Rules for disabled tools:',
        '  • Do NOT attempt to use any of the disabled tools above.',
        '  • If the user asks for an action that requires a disabled tool, immediately say which',
        '    tool group is turned off and instruct them to re-enable it via the Configure Tools (⚙) button.',
        sshAvailable ? '' : '  • SSH/remote-execution is disabled — do NOT call check_vm_status in a loop as a workaround.',
      ].filter((l) => l !== undefined);
      dynamicAddendum = lines.join('\n');
    }

    const lcMessages: BaseMessage[] = [
      new SystemMessage(TOOL_SYSTEM_PROMPT + dynamicAddendum),
      ...toLcMessages(messages),
    ];

    const maxIterations = 10;
    for (let i = 0; i < maxIterations; i++) {
      if (abortController.signal.aborted) break;
      // Stream the LLM response, accumulating content and tool calls
      let responseContent = '';
      const toolCallChunks: Record<number, { id: string; name: string; argsText: string }> = {};

      const stream = await llm.stream(lcMessages);
      for await (const chunk of stream) {
        // Collect text content
        const content = typeof chunk.content === 'string' ? chunk.content : '';
        if (content) {
          responseContent += content;
          onChunk(content, 'text');
        }
        // Accumulate tool call chunks (streamed incrementally by index)
        const rawCalls = (chunk as { tool_call_chunks?: Array<{ index?: number; id?: string; name?: string; args?: string }> }).tool_call_chunks;
        if (rawCalls && Array.isArray(rawCalls)) {
          for (const tc of rawCalls) {
            const idx = tc.index ?? 0;
            if (!toolCallChunks[idx]) {
              toolCallChunks[idx] = { id: tc.id ?? `call_${idx}`, name: tc.name ?? '', argsText: '' };
            }
            if (tc.name) toolCallChunks[idx].name = tc.name;
            if (tc.id) toolCallChunks[idx].id = tc.id;
            if (tc.args) toolCallChunks[idx].argsText += tc.args;
          }
        }
      }

      // Build resolved tool calls
      const resolvedToolCalls = Object.values(toolCallChunks)
        .filter((tc) => tc.name)
        .map((tc) => {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.argsText || '{}'); } catch { args = {}; }
          return { id: tc.id, name: tc.name, args };
        });

      // Add assistant message to history
      const assistantMsg = new AIMessage({
        content: responseContent,
        tool_calls: resolvedToolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          args: tc.args,
          type: 'tool_call' as const,
        })),
      });
      lcMessages.push(assistantMsg);

      // If no tool calls, conversation is complete
      if (resolvedToolCalls.length === 0) {
        console.log('[LANGCHAIN] No tool calls, conversation complete');
        break;
      }

      // Execute each tool and feed results back as ToolMessages
      const toolMap = Object.fromEntries(allTools.map((t) => [t.name, t]));
      const toolMessages: ToolMessage[] = [];

      for (const tc of resolvedToolCalls) {
        console.log(`[LANGCHAIN] Tool call: ${tc.name}`, tc.args);
        // onChunk(
        //   `🔧 **Tool Call**: \`${tc.name}(${JSON.stringify(tc.args)})\`\n`,
        //   'tool-call'
        // );

        let result: string;
        try {
          const toolFn = toolMap[tc.name];
          if (!toolFn) throw new Error(`Unknown tool: ${tc.name}`);
          const rawResult = await toolFn.invoke(tc.args);
          result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
          console.log(`[LANGCHAIN] Tool result (${tc.name}): ${result.substring(0, 200)}`);
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          console.error(`[LANGCHAIN] Tool error (${tc.name}): ${result}`);
        }

        const formattedResult = formatToolResult(result);
        onChunk(`${formattedResult}\n\n`, 'tool-result');

        toolMessages.push(new ToolMessage({ content: result, tool_call_id: tc.id }));

        // If create_vm_draft succeeded, emit form to renderer and stop the loop
        if (tc.name === 'create_vm_draft' && onVmDraft) {
          console.log('[VM DRAFT] Detected create_vm_draft tool call');
          console.log('[VM DRAFT] Raw result:', result.substring(0, 500));
          try {
            const parsed = JSON.parse(result) as { type?: string; form?: Record<string, unknown> };
            console.log('[VM DRAFT] Parsed type:', parsed?.type);
            console.log('[VM DRAFT] Has form:', !!parsed?.form);
            if (parsed?.type === 'vm_create_form' && parsed.form) {
              console.log('[VM DRAFT] ✓ Emitting form via onVmDraft callback');
              onVmDraft(parsed.form);
              lcMessages.push(...toolMessages);
              onEnd();
              return;
            } else {
              console.log('[VM DRAFT] ✗ Type or form missing, not emitting');
            }
          } catch (err) {
            console.error('[VM DRAFT] Parse error:', err);
          }
        }

        // If create_vm_copy_draft succeeded, emit copy form to renderer and stop the loop
        if (tc.name === 'create_vm_copy_draft' && onVmCopyDraft) {
          console.log('[VM COPY DRAFT] Detected create_vm_copy_draft tool call');
          try {
            const parsed = JSON.parse(result) as { type?: string; form?: Record<string, unknown> };
            if (parsed?.type === 'vm_copy_form' && parsed.form) {
              console.log('[VM COPY DRAFT] ✓ Emitting form via onVmCopyDraft callback');
              onVmCopyDraft(parsed.form);
              lcMessages.push(...toolMessages);
              onEnd();
              return;
            }
          } catch (err) {
            console.error('[VM COPY DRAFT] Parse error:', err);
          }
        }
      }

      lcMessages.push(...toolMessages);
    }

    onEnd();
  } catch (err) {
    // Treat user-initiated abort as a clean end, not an error
    if (abortController.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      console.log('[ChatAPI] chatWithTools cancelled by user');
      onEnd();
      return;
    }
    console.error('[ChatAPI] chatWithTools error:', err);
    
    // Enhanced error logging for debugging
    if (err && typeof err === 'object') {
      const errObj = err as Record<string, unknown>;
      console.error('[ChatAPI] Error details:', {
        message: errObj.message,
        name: errObj.name,
        status: errObj.status,
        statusCode: errObj.statusCode,
        code: errObj.code,
        response: errObj.response ? JSON.stringify(errObj.response).substring(0, 500) : undefined,
      });
    }
    
    // Provide more helpful error message for 403
    let errorMessage = err instanceof Error ? err.message : String(err);
    if (errorMessage.includes('403')) {
      errorMessage += '\n\nThis usually means your GitHub Copilot token has expired or is invalid. Try signing out and signing back in.';
    }
    
    onError(err instanceof Error ? new Error(errorMessage) : new Error(String(err)));
  } finally {
    // Clear the active abort controller now that we're done
    if (_activeChatAbort === abortController) _activeChatAbort = null;
    // Auto-complete any tasks started during this conversation that the agent didn't
    // explicitly close — prevents tasks from being stuck in "running" forever.
    // vmWatcher tasks are legitimate background tasks; skip them.
    const activeWatches = new Set(vmWatcher.listActive());
    for (const task of taskTracker.listTasks(50)) {
      if (task.status === 'running' && !runningBefore.has(task.id) && !activeWatches.has(task.id)) {
        console.log(`[ChatAPI] Auto-abandoning orphaned task: ${task.id} "${task.name}"`);
        taskTracker.completeTask(task.id, 'Task not completed by agent — abandoned when conversation ended');
      }
    }
  }
}
