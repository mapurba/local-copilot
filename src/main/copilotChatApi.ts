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
  'You are a VMware Cloud Director assistant. Use tools for all data lookups and actions.',
  'When the user asks to create a VM, do the following in a single turn without questions:',
  '1) Call list_templates with a name_filter matching the OS mentioned.',
  '2) Pick the closest template by OS name/version.',
  '3) Call create_vm_draft with vm_name, template_id, template_name, and any provided params.',
  '4) Do not ask for confirmation before create_vm_draft. The draft is the review step.',
  '5) Call create_vm_confirmed only after the user explicitly confirms.',
  'When resizing CPU or memory, call resize_vm directly with vm_name_or_href and num_cpus/memory_mb.',
  'For snapshot actions: use create_snapshot, revert_snapshot, and list_snapshots tools.',
  'For recent task lookups: use list_tasks or list_recent_tasks with minutes_ago.',
  'For VM copy/clone requests in chat, call list_vapps, select a target vApp, then call create_vm_copy_draft with target_vapp_href so the UI can show an editable review form.',
  'Do not call create_vm_copy directly in chat unless the user explicitly asks to skip review.',
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
    if ((args as Record<string, unknown>).access_token) patch.accessToken = (args as Record<string, unknown>).access_token as string;
    if ((args as Record<string, unknown>).session_token) patch.sessionToken = (args as Record<string, unknown>).session_token as string;
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
      token: z.string().optional().describe('Bearer access token (optional override)'),
      access_token: z.string().optional().describe('Bearer access token (optional override)'),
      session_token: z.string().optional().describe('x-vcloud-authorization session token (optional override)'),
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
];

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

// Agentic tool-calling loop — powered by LangChain (ChatOpenAI + bindTools)
export async function chatWithTools(
  modelId: string,
  messages: ChatMessage[],
  onChunk: (chunk: string, type: 'text' | 'tool-call' | 'tool-result') => void,
  onEnd: () => void,
  onError: (err: Error) => void,
  onVmDraft?: (form: Record<string, unknown>) => void,
  onVmCopyDraft?: (form: Record<string, unknown>) => void
): Promise<void> {
  try {
    console.log('[ChatAPI] chatWithTools starting - model:', modelId, 'messages:', messages.length);
    const token = await getValidToken();
    console.log('[ChatAPI] Token obtained, building LLM with', LC_TOOLS.length, 'tools');
    const llm = buildCopilotLlm(token, modelId).bindTools(LC_TOOLS);

    const lcMessages: BaseMessage[] = [
      new SystemMessage(TOOL_SYSTEM_PROMPT),
      ...toLcMessages(messages),
    ];

    const maxIterations = 10;
    for (let i = 0; i < maxIterations; i++) {
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
      const toolMap = Object.fromEntries(LC_TOOLS.map((t) => [t.name, t]));
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
  }
}
