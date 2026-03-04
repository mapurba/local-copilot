/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-require-imports */
// @ts-nocheck — LangChain imports are loaded dynamically to avoid TypeScript resolving
// their heavy generic type declarations at compile time (causing OOM in tsc).
import https from 'https';
import { tokenManager } from './tokenManager';
import {
  listVms,
  listTemplates,
  powerOnVm,
  powerOffVm,
  updateVmResources,
  createVmDraft,
  createVmConfirmed,
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
  'When resizing CPU or memory, call resize_vm directly with vm_id and num_cpus/memory_mb.',
  '',
  'IMPORTANT: For all tool results (especially list_vms, list_templates, list_tasks):',
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

const createVmConfirmedTool = lcTool(
  async () => {
    const result = await createVmConfirmed();
    return JSON.stringify(result);
  },
  {
    name: 'create_vm_confirmed',
    description: 'Create the VM using the last draft form.',
    schema: z.object({}),
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

// Ordered list of all LangChain tools
const LC_TOOLS = [
  setVcdContextTool,
  listVmsTool,
  listRunningVmsTool,
  listStoppedVmsTool,
  listTemplatesTool,
  checkVmStatusTool,
  startVmTool,
  stopVmTool,
  resizeVmTool,
  createVmDraftTool,
  createVmConfirmedTool,
  listTasksTool,
];

// ── Helpers ──────────────────────────────────────────────────────────

function getCopilotHeaders(): Record<string, string> {
  return {
    'Editor-Version': 'vscode/1.85.0',
    'Editor-Plugin-Version': 'copilot-chat/0.12.0',
    'Copilot-Integration-Id': 'vscode-chat',
    'User-Agent': 'GitHubCopilot/1.1.0',
    'X-GitHub-Api-Version': '2023-07-07',
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
  let token = await tokenManager.getBestToken();
  if (token) return token;

  // Second-chance refresh before failing hard.
  token = await tokenManager.refreshToken();
  if (token) return token;

  throw new Error('No valid Copilot token available. Please sign in (or reconnect Copilot).');
}

async function httpsGet(urlPath: string, headers: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
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
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on('error', reject);
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
  return new ChatOpenAI({
    model: modelId,
    openAIApiKey: token,
    configuration: {
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
  getValidToken()
    .then(async (token) => {
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
    .catch((err: Error) => onError(err));
}

// Agentic tool-calling loop — powered by LangChain (ChatOpenAI + bindTools)
export async function chatWithTools(
  modelId: string,
  messages: ChatMessage[],
  onChunk: (chunk: string, type: 'text' | 'tool-call' | 'tool-result') => void,
  onEnd: () => void,
  onError: (err: Error) => void
): Promise<void> {
  try {
    const token = await getValidToken();
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
        onChunk(
          `🔧 **Tool Call**: \`${tc.name}(${JSON.stringify(tc.args)})\`\n`,
          'tool-call'
        );

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
      }

      lcMessages.push(...toolMessages);
    }

    onEnd();
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}
