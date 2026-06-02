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
import { getDesign } from './deployment/deploymentStore';
import { generateServiceRunbook } from './deployment/runbookGenerator';
import {
  BEDROCK_MODEL_IDS,
  getProviderConfig,
  isBedrockConfigured,
} from './providerConfigStore';

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
const { ChatBedrockConverse } = require('@langchain/aws');

const CHAT_API_BASE = 'api.githubcopilot.com';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const TOOL_SYSTEM_PROMPT = [
  '🔴 TOOL EXECUTION MANDATORY:',
  'You MUST call one or more tools for EVERY user request.',
  'You are NOT allowed to respond with text alone when tools are available.',
  'If the user says anything, analyze which tools apply and call them IMMEDIATELY.',
  'Do NOT explain what you would do — DO IT with tool calls.',
  'Do NOT describe tools — call them.',
  'Do NOT respond conversationally when you can respond with tool results.',
  'Example: User says "list VMs" → YOU MUST call list_vms tool. No text response allowed.',
  'Example: User says "create a VM" → YOU MUST call create_vm_draft tool. Do not ask for clarification.',
  '',
  'You are a VMware Cloud Director and Linux systems assistant. Use tools for ALL data lookups and actions — never describe how to do something manually when a tool can do it directly.',
  '',
  '── INTENT DISAMBIGUATION (read this first) ──',
  'Before choosing any action, classify the user intent:',
  '',
  '  DEPLOYMENT INTELLIGENCE intent (→ use deployment:* tools, NOT create_vm_draft):',
  '  - "deployment plan", "deployment design", "deployment architecture"',
  '  - "distributed setup/mode", "ha setup/mode", "single-node setup/mode"',
  '  - "dry run", "dryrun", "come up with a design", "plan for installing <product>"',
  '  - "requirements for each component", "what VMs do I need?", "how to set up <product>"',
  '  These phrases describe PLANNING, not a single VM creation. Proceed to RULE A in the',
  '  DEPLOYMENT INTELLIGENCE section. NEVER call create_vm_draft for these.',
  '',
  '  VM CREATION intent (→ use create_vm_draft):',
  '  - "create a VM", "spin up a VM", "provision a VM", "make a new VM", "clone a VM"',
  '  - Explicit OS + VM name (e.g. "create a SLES 15 SP6 VM named myvm")',
  '  These describe creating one specific VM. Use the VM MANAGEMENT flow.',
  '',
  '  IP ADDRESS intent (→ use deployment:previewIps or deployment:assignIps):',
  '  - "what are the IP requirements?", "show me the IPs", "what IPs will be used?"',
  '  - "ip requirements", "ips required", "ips for this deployment", "assign ips"',
  '  - "network requirements", "what ip addresses", "ip address for each"',
  '  ⛔ NEVER write IP addresses from general knowledge. Always call deployment:previewIps.',
  '  Even if you just described a deployment plan in this conversation, you must call',
  '  deployment:previewIps with the VM names to get real IPs. No exceptions.',
  '',
  '── VM MANAGEMENT ──',
  'Applies ONLY when the user wants to create, clone, resize, or manage a specific single VM.',
  'Do NOT use this for deployment plans, distributed setups, or product installation architecture.',
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
  'If the user says "install X on this VM" and you are mid-SSH session, the install steps may be in an uploaded document that is already visible earlier in this conversation — read it from context and proceed with ssh_runCommand calls.',
  'EXCEPTION: If the user is asking for a DEPLOYMENT PLAN or DESIGN (not a running install), go to DEPLOYMENT INTELLIGENCE RULE A and call deployment:analyzeAndDesign.',
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
  '── DEPLOYMENT INTELLIGENCE ──',
  '⚠ THIS SECTION TAKES PRIORITY OVER DOCUMENT Q&A.',
  'When user intent matches any RULE below, go directly to the tool — no document pre-reading needed.',
  '',
  '⛔ ABSOLUTE PROHIBITION: A docId (format: doc-XXXXXXXXXXXXXXX) is a LOCAL DOCUMENT IDENTIFIER.',
  '   NEVER pass a docId as a vmName, vm_name, or any VCD parameter.',
  '   NEVER call list_vms, revert_snapshot, create_snapshot, list_snapshots, resize_vm,',
  '   check_vm_status, or ANY other VCD/VM tool with a docId or document filename.',
  '   If you catch yourself about to do this — STOP and use deployment:analyzeAndDesign instead.',
  '',
  '## RULE A — Deployment plan / design / dry-run request',
  'Triggers (match even with typos or partial phrasing):',
  '  "deployment plan", "deployment design", "deployment architecture"',
  '  "distributed setup/mode", "ha setup/mode", "single-node setup/mode"',
  '  "dry run", "dryrun", "simulate deployment", "show me the plan", "what would be deployed"',
  '  "plan for installing <product>", "requirements for each component"',
  '  "come up with a design", "what VMs do I need?", "how to set up <product>"',
  '',
  '⛔ When RULE A triggers: call the deployment tool ONCE and respond. Do NOT loop.',
  '   The rawContent parameter IS the document text already in the user message — no tool call needed.',
  '   ONE tool call is enough. Do NOT call any tool again after the deployment tool returns.',
  '',
  'Decide which tool to call based on the user intent:',
  '',
  '  DRY RUN (user says "dry run", "simulate", "show me the plan", "what would be deployed"):',
  '  → Call deployment:dryRun(docId, modeName, rawContent?)',
  '    This returns: designId, mermaid diagram, per-VM resource table, IP assignments, install order.',
  '    Render mermaid in ```mermaid block. Show resource table. Show IPs. Show install order.',
  '',
  '  FULL DESIGN (user says  "create deployment design", no dry-run keyword):',
  '  → Call deployment:analyzeAndDesign(docId, modeName, rawContent?)',
  '    Returns: { designId, mermaid, vms[], installOrder[], runbookSummary }',
  '',
  'For BOTH tools:',
  '1) Find the docId AND rawContent FROM THE USER MESSAGE — no tool call needed:',
  '   - Look in the message for a header like: [Document: "..." | docId: doc-XXXX]',
  '   - Extract docId from the header. The text after the header IS the rawContent — pass it directly.',
  '   - If no [Document] block is present, tell the user to attach a document first and stop.',
  '   - Do NOT call any tool to look up or fetch document content.',
  '2) Build the chatContext parameter by scanning THIS ENTIRE CONVERSATION for anything the user',
  '   stated verbally that should influence the deployment:',
  '   - Component lists or selections (e.g. "install OSP, SSPR, UA, ActiveMQ, Reporting")',
  '   - Silent properties variables or configuration values the user pasted or discussed',
  '   - OS/version preferences explicitly stated ("SLES 15 SP6", "use single node")',
  '   - Passwords, ports, database names, tree names, container names, admin DNs',
  '   - Any "use this" or "use the above" instructions that reference earlier chat content',
  '   Collect ALL such details into one plain-text block and pass as chatContext.',
  '   If the user said "use this" or "use the above", look backwards in the conversation to find',
  '   what "this" refers to and include the full content.',
  '   ⚠ If the user provided any configuration (e.g. silent.properties) in this conversation,',
  '   chatContext is NOT OPTIONAL — you MUST pass it. Omitting it means the LLM will ignore',
  '   all user-supplied specs and generate a generic plan from the document alone.',
  '3) Call the chosen tool ONCE with (docId, modeName, rawContent, chatContext).',
  '3) Render the mermaid field in a ```mermaid block — ALWAYS, immediately.',
  '4) For dry run: show resource table | VM | Role | OS | vCPU | RAM (GB) | Disk (GB) | IP |',
  '   For full design: show vms[] as table | VM | Role | OS | vCPU | RAM | Disk |',
  '5) Show installOrder[] as a numbered list.',
  'Do NOT dump raw JSON. Do NOT loop.',
  '',
  '## RULE A+B — User asks for BOTH design AND IPs in the same message',
  'Triggers: user asks for design/plan AND IPs/addresses in the same request.',
  '⛔ These are PLANNED VMs that do NOT exist in VCD yet. Do NOT call list_vms, list_vapps, or any VCD tool.',
  '   The VMs will be created later. Right now you are only planning and allocating IPs from the pool.',
  'Steps:',
  '1) If a [Document: "..." | docId: doc-XXXX] block is in this conversation:',
  '   → Call deployment:analyzeAndDesign(docId, "distributed", rawContent) ONCE.',
  '   → Use the returned designId to call deployment:assignIps(designId) ONCE.',
  '2) If NO document block is present but a designId was mentioned earlier in this conversation:',
  '   → Call deployment:assignIps(designId) directly. Skip design generation.',
  '3) If neither a document nor a prior designId exists:',
  '   → Tell the user: "Please attach your installation document using the 📎 button, then ask again."',
  '   → Do NOT call list_vms or any VCD tool.',
  'Render: mermaid diagram + VM resource table + IP table in one combined response.',
  'Do NOT loop. Maximum two tool calls (design + IPs), then respond.',,
  '',
  '## RULE B — IP requirements / IP assignment request',
  'Triggers: "ip requirements", "show me the ips", "what ips", "assign ips", "assign real ips",',
  '"what ip will", "ips for this deployment", "ips required", "network requirements", "real IPs".',
  '',
  '⛔ ABSOLUTE RULE: You MUST call a tool to get IPs. NEVER write an IP address yourself.',
  '   Do NOT produce a table with example IPs like 10.0.x.x, 192.168.x.x, or any IP.',
  '   Even if the deployment plan was just shown in this chat, do NOT invent IPs.',
  '   The only valid IPs are those returned by deployment:previewIps or deployment:assignIps.',
  '',
  '⛔ CRITICAL: These are PLANNED VMs — they do NOT exist in VCD yet.',
  '   Do NOT call list_vms, check_vm_status, or any VCD VM tool to look them up.',
  '   IPs are allocated from a pool service (NOT from VCD). Calling VCD tools here is wrong.',
  '',
  'Which tool to use:',
  '  a) If a designId was returned earlier in this conversation → call deployment:assignIps(designId).',
  '     It allocates one real IP per VM from the pool service and saves them to the design.',
  '  b) If NO designId exists (plan was discussed or just described):',
  '     → Extract VM/service names from the current conversation (e.g. "idm-engine", "idm-apps"),',
  '       then call deployment:previewIps(vmNames=[...]) with those names.',
  '     Example: vmNames=["idm-engine","idm-apps","idm-db","idm-report","idm-sspr"]',
  '     This returns real IPs from the IP pool service immediately.',
  '',
  'After the tool call, display the result as a markdown table:',
  '   | VM | Assigned IP | Role | Notes |',
  'Tell the user: "These IPs are real allocations from the VCD IP pool, not examples."',
  'If no design exists yet and the user wants a full design too, run RULE A first then call deployment:assignIps.',
  '',
  '## RULE C — Full deployment / actual rollout',
  'When the user explicitly says "deploy it", "start the deployment", "go ahead and install":',
  '1) Ensure a designId and IP assignments are already done (RULE A + RULE B first if not).',
  '2) Ask the user to confirm: org name, templateVmId, sshUsername, sshPassword/sshPrivateKey.',
  '3) Call deployment:startDeployment (DANGEROUS — requires explicit user confirmation).',
  '4) Return the runId. User can track progress with: deployment:getRunStatus.',
  '5) After completion, display the summaryReport and final Mermaid state diagram.',
  '',
  '## RULE D — Existing designs',
  'When the user refers to a previous design or asks "what designs do I have":',
  '  call deployment:listDesigns and format results as a table.',
  'When the user asks about a specific design: call deployment:getDesign with the designId.',
  '',
  '## RULE E — Update / correct / modify an existing deployment plan',
  'Triggers (ANY of these phrases, even with typos):',
  '  "update the plan", "update this plan", "update this to the current deployment plan"',
  '  "fix the plan", "correct the plan", "change the plan", "modify the plan"',
  '  "add X to the plan", "remove X from the plan", "replace X with Y in the plan"',
  '  "update the deployment design", "revise the design", "amend the design"',
  '  "update the runbook", "fix the runbook", "regenerate the runbook"',
  '  ANY request that implies changing a previously generated deployment plan/design.',
  '',
  '⛔ ABSOLUTE RULE: NEVER print the updated plan as text in the chat.',
  '   You MUST call deployment:updateDesign to persist the change. Printing is not updating.',
  '   If you print it without calling the tool, the user sees a plan that was never saved.',
  '',
  'Steps:',
  '1) Find the designId — look in this conversation for a previously returned designId.',
  '   If no designId exists in the conversation, call deployment:listDesigns and pick the most',
  '   recent one, or ask the user which design to update.',
  '2) Determine WHAT changed:',
  '   - Read the user instruction carefully.',
  '   - Scan the ENTIRE conversation for user-provided specs: properties files, component lists,',
  '     configuration values, "use this" references, and any other user-stated overrides.',
  '   - If a [Document: "..." | docId: doc-XXXX] block is present, use it as the source of truth',
  '     for updated content (e.g. updated properties file, new service list, etc.).',
  '   - Build a partial DeploymentDesign JSON containing ONLY the fields that need to change.',
  '     For VM/service changes: include the full updated "vms" array (not just the changed VM).',
  '3) Call deployment:updateDesign(designId, designJson) ONCE.',
  '   The tool automatically rebuilds the dependency graph, Mermaid diagram, and runbook.',
  '4) After the tool returns, render:',
  '   - The updated Mermaid diagram in a ```mermaid block.',
  '   - A brief summary of what changed.',
  '   - The updated VM resource table.',
  '   Do NOT re-print the raw JSON. Do NOT loop.',
  '',
  'Never describe how to deploy manually when deployment tools can do it directly.',
  'Never invent hostnames or IPs — always use what the tools return.',
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
      ilm_version: z.string().optional().describe('ILM version (e.g., latest, 1.3.0)'),
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

function extractShellScriptFromRunbook(markdown: string): string {
  if (!markdown) return '';
  const blocks: string[] = [];
  const regex = /```bash\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const block = (match[1] || '').trim();
    if (block) blocks.push(block);
  }
  return blocks.join('\n\n').trim();
}

function buildDeploymentPlanPayload(designId: string, modeName?: string): Record<string, unknown> {
  const design = getDesign(designId);
  const createdAt = new Date(design.createdAt || Date.now()).toISOString();
  const updatedAt = new Date(design.updatedAt || Date.now()).toISOString();

  const services = design.vms.flatMap((vm) => {
    const osLabel = [vm.osRequirement?.type, vm.osRequirement?.minVersion].filter(Boolean).join(' ');
    return vm.services.map((svc) => {
      const runbookMarkdown = generateServiceRunbook(svc.id, design);
      const extractedScript = extractShellScriptFromRunbook(runbookMarkdown);
      const fallbackScript = svc.installSteps
        .map((step) => step.command)
        .filter((cmd): cmd is string => Boolean(cmd))
        .join('\n');
      // Use an env-var reference when the IP is still a placeholder so the
      // health-check command is runnable even before IPs are assigned.
      const resolvedIp = vm.ip || design.ipAssignments?.[svc.id];
      const ipRef = (!resolvedIp || resolvedIp === '?.?.?.?')
        ? (svc.configKeys.find((ck) => ck.valueType === 'host' || !ck.valueType)?.key
            ? `$${svc.configKeys.find((ck) => ck.valueType === 'host' || !ck.valueType)!.key}`
            : '${TARGET_HOST}')
        : resolvedIp;
      const healthCheckCommand = svc.healthCheck?.type === 'http'
        ? `curl -f ${svc.healthCheck.target}`
        : svc.healthCheck?.type === 'port'
          ? `nc -z -w${svc.healthCheck.timeoutSeconds} ${ipRef} ${svc.healthCheck.target}`
          : svc.healthCheck?.type === 'systemctl'
            ? `systemctl is-active ${svc.healthCheck.target}`
            : svc.healthCheck?.type === 'process'
              ? `pgrep -x ${svc.healthCheck.target}`
              : undefined;

      return {
        id: svc.id,
        name: svc.name,
        description: `${svc.role} service deployed on ${vm.role}`,
        vmName: vm.vmName || vm.id,
        ip: vm.ip || design.ipAssignments?.[svc.id],
        port: svc.ports?.[0]?.port,
        vm_template_id: vm.templateId || '',
        os: osLabel || undefined,
        prerequisites: svc.installSteps
          .filter((step) => step.isPrerequisite)
          .map((step) => step.description),
        runbook: (() => {
          let script = extractedScript || fallbackScript || '';
          if (script && !script.startsWith('#!')) {
            script = `#!/bin/bash\n\n${script}`;
          }
          return script || '#!/bin/bash\n# No runbook defined yet';
        })(),
        healthCheckCommand,
        dependsOn: svc.requiresConfigFrom || [],
        status: 'pending',
      };
    });
  });

  return {
    id: `plan-${design.id}`,
    designId: design.id,
    name: `${design.intelligence.products?.[0]?.name || 'Deployment'} Plan`,
    description: 'Deployment plan generated from uploaded documentation.',
    createdAt,
    updatedAt,
    mermaidDiagram: design.mermaid || 'graph TD\n  A[No diagram available]',
    services,
    deploymentMode: modeName || design.intelligence.deploymentModes?.[0]?.name || 'distributed',
    sourceDocumentation: design.documentId,
    markdownSummary: design.runbook || '# Deployment Runbook\n\nNo runbook available.',
    status: 'draft',
  };
}

// Build a ChatBedrockConverse instance for AWS Bedrock
function buildBedrockLlm(modelId: string, bedrockCfg: { region?: string; accessKeyId?: string; secretAccessKey?: string } | undefined) {
  const resolvedRegion = bedrockCfg?.region || 'us-east-1';
  const credentials = bedrockCfg?.accessKeyId && bedrockCfg?.secretAccessKey
    ? { accessKeyId: bedrockCfg.accessKeyId, secretAccessKey: bedrockCfg.secretAccessKey }
    : undefined;
  console.log('[ChatAPI] Building Bedrock LLM with model:', modelId, 'region:', resolvedRegion);
  return new ChatBedrockConverse({
    model: modelId,
    region: resolvedRegion,
    credentials,
    temperature: 0,
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
  const cfg = getProviderConfig();
  if (cfg.provider === 'bedrock') {
    return [...BEDROCK_MODEL_IDS];
  }

  try {
    const token = await getValidToken();
    const response = await httpsGet('/models', getHeaders(token)) as { data?: Array<{ id: string }> };

    if (response?.data && Array.isArray(response.data)) {
      return response.data.map((m) => m.id);
    }

    // Fallback model list if API doesn't return expected format
    return ['gpt-5.3-codex', 'gpt-4o', 'claude-3.5-sonnet', 'o1-preview'];
  } catch (e) {
    console.error('[ChatAPI] getModels error:', e);
    return ['gpt-4.1', 'gpt-4o', 'claude-3.5-sonnet', 'o1-preview'];
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

  const cfg = getProviderConfig();
  if (cfg.provider === 'bedrock') {
    (async () => {
      try {
        const llm = buildBedrockLlm(modelId, cfg.bedrock);
        const lcMessages: BaseMessage[] = [
          new SystemMessage(TOOL_SYSTEM_PROMPT.join('\n')),
          ...toLcMessages(messages),
        ];
        const response = await llm.invoke(lcMessages);
        const text = typeof response.content === 'string' ? response.content : '';
        if (text) onChunk(text);
        onEnd();
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    })();
    return;
  }

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
  onDeploymentPlanReady?: (plan: Record<string, unknown>) => void,
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

    const cfg = getProviderConfig();

    const token = await getValidToken();
    // Docs tools are intentionally NOT bound to LangChain — document content is already
    // injected into the user message as a [Document: "..." | docId: ...] block, so the
    // LLM reads it directly from context without any tool call.
    const registryDeploymentTools = buildRegistryTools('deployment');
    const registrySshTools = buildRegistryTools('ssh');
    let allTools = [...LC_TOOLS, ...TASK_TOOLS, ...registryDeploymentTools, ...registrySshTools];
    if (disabledToolNames && disabledToolNames.length > 0) {
      const disabledSet = new Set(disabledToolNames);
      allTools = allTools.filter((t) => !disabledSet.has(t.name));
    }
    console.log('[ChatAPI] Token obtained, building LLM with', allTools.length, 'tools',
      `(${LC_TOOLS.length} VCD + ${TASK_TOOLS.length} tasks + ${registryDeploymentTools.length} deployment + ${registrySshTools.length} ssh)`);

    // ── Build LLM (Copilot or Bedrock) ────────────────────────────────────────
    const llm = cfg.provider === 'bedrock'
      ? buildBedrockLlm(modelId, cfg.bedrock).bindTools(allTools)
      : buildCopilotLlm(token, modelId).bindTools(allTools);

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

    const maxIterations = 6;
    // Track how many times each tool has been called this session to detect loops.
    const toolCallCounts: Record<string, number> = {};

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

      // ── Duplicate-tool loop guard ─────────────────────────────────────────
      // If the LLM is calling a tool it already called, it's stuck. Inject a
      // "stop and respond" message so the next iteration produces text output.
      const repeatTools = resolvedToolCalls.filter((tc) => (toolCallCounts[tc.name] ?? 0) >= 1);
      if (repeatTools.length > 0) {
        const names = repeatTools.map((t) => t.name).join(', ');
        console.warn('[LANGCHAIN] Loop detected — repeated tools:', names);
        // Still execute them so results are in context, then force a stop.
        // (fall through to execution below; stop message is added after toolMessages)
      }

      // Track call counts before executing
      for (const tc of resolvedToolCalls) {
        toolCallCounts[tc.name] = (toolCallCounts[tc.name] ?? 0) + 1;
      }
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

        if (tc.name.startsWith('deployment_') && onDeploymentPlanReady) {
          // The result may have been truncated by the OUTPUT_TRUNCATE guard, making it
          // invalid JSON. Try JSON.parse first; fall back to regex-extracting designId.
          let parsedDesign: { designId?: string; mode?: string; modeName?: string; error?: string } = {};
          try {
            parsedDesign = JSON.parse(result) as typeof parsedDesign;
          } catch {
            const m = result.match(/"designId"\s*:\s*"([^"]+)"/);
            if (m) parsedDesign = { designId: m[1] };
          }
          if (parsedDesign.designId && !parsedDesign.error) {
            const payload = buildDeploymentPlanPayload(parsedDesign.designId, parsedDesign.mode || parsedDesign.modeName);
            onDeploymentPlanReady(payload);
          } else if (!parsedDesign.designId) {
            console.warn('[DeploymentPlan] Could not extract designId from tool result');
          }
        }
      }

      lcMessages.push(...toolMessages);

      // ── Post-execution: inject stop/render instructions ──────────────────

      // 1) If a deployment design tool succeeded, tell the LLM to render now.
      const DESIGN_TOOLS = new Set(['deployment_analyzeAndDesign', 'deployment_dryRun', 'deployment_generateDesign', 'deployment_updateDesign', 'deployment_assignIps']);
      for (const tm of toolMessages) {
        const tc = resolvedToolCalls.find((c) => c.id === tm.tool_call_id);
        if (tc && DESIGN_TOOLS.has(tc.name)) {
          // Same truncation-resilient parse as above
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(typeof tm.content === 'string' ? tm.content : '{}') as Record<string, unknown>;
          } catch {
            const raw = typeof tm.content === 'string' ? tm.content : '';
            const m = raw.match(/"designId"\s*:\s*"([^"]+)"/);
            if (m) parsed = { designId: m[1] };
          }
          if (parsed.designId && !parsed.error) {
              console.log('[LANGCHAIN] Deployment design succeeded, injecting render instruction');
              lcMessages.push(new HumanMessage(
                `The deployment design is complete (designId: ${parsed.designId}). ` +
                `Render the mermaid diagram in a \`\`\`mermaid block, ` +
                `show the VM resource table (VM | Role | OS | vCPU | RAM GB | Disk GB), ` +
                `and list the install order. Do NOT call any more tools.`
              ));
            }
        }
      }

      // 2) If duplicate tools were called, inject a hard stop after their results.
      if (repeatTools.length > 0) {
        const names = repeatTools.map((t) => t.name).join(', ');
        lcMessages.push(new HumanMessage(
          `DO NOT call any more tools. You already received results for [${names}] earlier in this conversation. ` +
          `Produce your final answer right now using only the results already in context.`
        ));
        // Run one final LLM stream to produce the text response, then exit.
        if (abortController.signal.aborted) break;
        let finalContent = '';
        const finalStream = await llm.stream(lcMessages);
        for await (const chunk of finalStream) {
          const content = typeof chunk.content === 'string' ? chunk.content : '';
          if (content) { finalContent += content; onChunk(content, 'text'); }
        }
        console.log('[LANGCHAIN] Forced final response after loop break, length:', finalContent.length);
        break;
      }
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

// ── HITL Deployment Graph — re-exported for IPC handlers ─────────────────────
// Thin wrappers so ipcHandlers.ts has a single import point for everything chat-related.

export {
  startDeploymentGraph,
  resumeDeploymentGraph,
  clearDeploymentGraph,
} from './deployment/hitl/deploymentGraph';

export type {
  GraphStartInput,
  GraphResumeInput,
  GraphRunResult,
} from './deployment/hitl/deploymentGraph';
