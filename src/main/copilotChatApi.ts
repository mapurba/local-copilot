import https from 'https';
import { tokenManager } from './tokenManager';
import { lspClient } from './lspClient';
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

const CHAT_API_BASE = 'api.githubcopilot.com';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

// Define available tools
const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'set_vcd_context',
      description: 'Set or override VCD context values if needed. Usually not required after VCD login.',
      parameters: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'VCD hostname (optional override)' },
          token: { type: 'string', description: 'Bearer token (optional override)' },
          api_version: { type: 'string', description: 'VCD API version (default 38.0)' },
          org_name: { type: 'string', description: 'Org name for tenant context (optional)' },
          org_uuid: { type: 'string', description: 'Org UUID for tenant context (optional)' },
          vdc_id: { type: 'string', description: 'VDC ID for VM creation (optional)' },
          network_name: { type: 'string', description: 'Default network name (optional)' },
          gateway: { type: 'string', description: 'Default gateway (optional)' },
          dns_servers: { type: 'string', description: 'Comma-separated DNS servers (optional)' },
          storage_profile_id: { type: 'string', description: 'Default storage profile ID (optional)' },
          compute_policy_id: { type: 'string', description: 'Default compute policy ID (optional)' },
          reject_unauthorized: { type: 'boolean', description: 'Reject invalid TLS certs (default false)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_vms',
      description: 'List VMs in the current tenant.',
      parameters: {
        type: 'object',
        properties: {
          page_size: { type: 'number', description: 'Number of VMs per page (default 100)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_running_vms',
      description: 'List running VMs in the current tenant.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_stopped_vms',
      description: 'List stopped VMs in the current tenant.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_templates',
      description: 'List vApp templates. Optional name filter (e.g., "ubuntu" or "sles").',
      parameters: {
        type: 'object',
        properties: {
          name_filter: { type: 'string', description: 'Template name filter' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_vm_status',
      description: 'Check if a VM is present and return status by exact VM name.',
      parameters: {
        type: 'object',
        properties: { vm_name: { type: 'string', description: 'Exact VM name' } },
        required: ['vm_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_vm',
      description: 'Power on a VM by href.',
      parameters: {
        type: 'object',
        properties: { vm_href: { type: 'string', description: 'Full VCD VM href URL' } },
        required: ['vm_href'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_vm',
      description: 'Power off a VM by href.',
      parameters: {
        type: 'object',
        properties: { vm_href: { type: 'string', description: 'Full VCD VM href URL' } },
        required: ['vm_href'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resize_vm',
      description: 'Resize VM CPU and/or RAM (may power off temporarily).',
      parameters: {
        type: 'object',
        properties: {
          vm_name_or_href: { type: 'string', description: 'VM name or full href' },
          num_cpus: { type: 'number', description: 'Desired vCPU count (1-4)' },
          memory_mb: { type: 'number', description: 'Desired RAM in MB (512-20480)' },
        },
        required: ['vm_name_or_href'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_vm_draft',
      description: 'Prepare a VM creation draft for review.',
      parameters: {
        type: 'object',
        properties: {
          vm_name: { type: 'string', description: 'Name of the VM' },
          template_id: { type: 'string', description: 'Template UUID (vApp template)' },
          template_name: { type: 'string', description: 'Template name (used for OS detection)' },
          network_name: { type: 'string', description: 'Network name' },
          ip_allocation_mode: { type: 'string', description: 'DHCP, POOL, or MANUAL' },
          ip_address: { type: 'string', description: 'IP address if MANUAL' },
          gateway: { type: 'string', description: 'Gateway IP' },
          dns_servers: { type: 'string', description: 'Comma-separated DNS servers' },
          power_on: { type: 'boolean', description: 'Power on after creation' },
          storage_profile_id: { type: 'string', description: 'Storage profile ID' },
          compute_policy_id: { type: 'string', description: 'Compute policy ID' },
          setup_ilm: { type: 'boolean', description: 'Install ILM stack' },
          ilm_version: { type: 'string', description: 'ILM version (e.g., latest, 1.3.0)' },
        },
        required: ['vm_name', 'template_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_vm_confirmed',
      description: 'Create the VM using the last draft form.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'List recent tasks from the last N minutes.',
      parameters: {
        type: 'object',
        properties: {
          minutes_ago: { type: 'number', description: 'Minutes to look back (default 60)' },
          page_size: { type: 'number', description: 'Max tasks to return (default 50)' },
        },
        required: [],
      },
    },
  },
];

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

// Tool execution functions
async function executeTool(toolName: string, args: Record<string, unknown>): Promise<string> {
  console.log(`[TOOL] Executing: "${toolName}" with args:`, args);
  
  if (!toolName || toolName.trim() === '') {
    console.error(`[TOOL] ERROR: Tool name is empty! Args: ${JSON.stringify(args)}`);
    return `Unknown tool: (empty name provided)`;
  }

  switch (toolName) {
    case 'set_vcd_context': {
      const dns = typeof args.dns_servers === 'string' ? String(args.dns_servers).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      let current: Record<string, unknown> = {};
      try {
        current = getVcdContext() as unknown as Record<string, unknown>;
      } catch {
        current = {};
      }
      const patch: Record<string, unknown> = {
        apiVersion: String(args.api_version || current.apiVersion || '38.0'),
      };
      if (args.host) patch.host = String(args.host);
      if (args.token) patch.token = String(args.token);
      if (args.org_name) patch.orgName = String(args.org_name);
      if (args.org_uuid) patch.orgUuid = String(args.org_uuid);
      if (args.vdc_id) patch.vdcId = String(args.vdc_id);
      if (args.network_name) patch.networkName = String(args.network_name);
      if (args.gateway) patch.gateway = String(args.gateway);
      if (dns) patch.dnsServers = dns;
      if (args.storage_profile_id) patch.storageProfileId = String(args.storage_profile_id);
      if (args.compute_policy_id) patch.computePolicyId = String(args.compute_policy_id);
      if (args.reject_unauthorized !== undefined) patch.rejectUnauthorized = args.reject_unauthorized === true;

      const ctx = setVcdContext(patch);
      return JSON.stringify({ status: 'ok', context: { ...ctx, token: ctx.token ? '***' : '' } });
    }
    case 'list_vms': {
      const result = await listVms(Number(args.page_size) || 100);
      const vms = (result as { vms?: Record<string, unknown>[] }).vms || [];
      const base = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
      return JSON.stringify({
        ...base,
        vms: vms.map(normalizeVmStatus),
      });
    }
    case 'list_running_vms': {
      const result = await listVms(200);
      const vms = (result as { vms?: Record<string, unknown>[] }).vms || [];
      const running = vms.map(normalizeVmStatus).filter((vm) => vm.powered_on);
      return JSON.stringify({ count: running.length, vms: running });
    }
    case 'list_stopped_vms': {
      const result = await listVms(200);
      const vms = (result as { vms?: Record<string, unknown>[] }).vms || [];
      const stopped = vms.map(normalizeVmStatus).filter((vm) => !vm.powered_on);
      return JSON.stringify({ count: stopped.length, vms: stopped });
    }
    case 'list_templates': {
      console.log(`[TOOL] list_templates called with args:`, args);
      console.log(`[TOOL] name_filter value: ${args.name_filter}`);
      const result = await listTemplates(String(args.name_filter || ''));
      return JSON.stringify(result);
    }
    case 'check_vm_status': {
      const result = await checkVmStatus(String(args.vm_name || ''));
      return JSON.stringify(result);
    }
    case 'start_vm': {
      const result = await powerOnVm(String(args.vm_href));
      return JSON.stringify(result);
    }
    case 'stop_vm': {
      const result = await powerOffVm(String(args.vm_href));
      return JSON.stringify(result);
    }
    case 'resize_vm': {
      const result = await updateVmResources(
        String(args.vm_name_or_href),
        args.num_cpus !== undefined ? Number(args.num_cpus) : undefined,
        args.memory_mb !== undefined ? Number(args.memory_mb) : undefined
      );
      return JSON.stringify(result);
    }
    case 'create_vm_draft': {
      const form = buildCreateFormFromInput({
        vm_name: String(args.vm_name || ''),
        template_id: String(args.template_id || ''),
        template_name: args.template_name ? String(args.template_name) : undefined,
        network_name: args.network_name ? String(args.network_name) : undefined,
        ip_allocation_mode: args.ip_allocation_mode ? String(args.ip_allocation_mode) : undefined,
        ip_address: args.ip_address ? String(args.ip_address) : undefined,
        gateway: args.gateway ? String(args.gateway) : undefined,
        dns_servers: args.dns_servers ? String(args.dns_servers) : undefined,
        power_on: args.power_on !== undefined ? Boolean(args.power_on) : undefined,
        storage_profile_id: args.storage_profile_id ? String(args.storage_profile_id) : undefined,
        compute_policy_id: args.compute_policy_id ? String(args.compute_policy_id) : undefined,
        setup_ilm: args.setup_ilm !== undefined ? Boolean(args.setup_ilm) : undefined,
        ilm_version: args.ilm_version ? String(args.ilm_version) : undefined,
      });
      const result = await createVmDraft(form);
      return JSON.stringify(result);
    }
    case 'create_vm_confirmed': {
      const result = await createVmConfirmed();
      return JSON.stringify(result);
    }
    case 'list_tasks': {
      const result = await listTasks(Number(args.minutes_ago) || 60, Number(args.page_size) || 50);
      return JSON.stringify(result);
    }
    default:
      return `Unknown tool: ${toolName}`;
  }
}

function getHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Editor-Version': 'vscode/1.85.0',
    'Editor-Plugin-Version': 'copilot-chat/0.12.0',
    'Copilot-Integration-Id': 'vscode-chat',
    'User-Agent': 'GitHubCopilot/1.1.0',
    'X-GitHub-Api-Version': '2023-07-07',
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
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
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

export function streamChatCompletion(
  modelId: string,
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
  onEnd: () => void,
  onError: (err: Error) => void
): void {
  getValidToken()
    .then((token) => {
      const body = JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: TOOL_SYSTEM_PROMPT },
          ...messages,
        ],
        tools: TOOLS,
        stream: true,
      });

      const options = {
        hostname: CHAT_API_BASE,
        path: '/chat/completions',
        method: 'POST',
        headers: {
          ...getHeaders(token),
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        if (res.statusCode === 401) {
          // Token expired, try to refresh
          lspClient.checkStatus().then(() => {
            onError(new Error('Token expired. Please try again.'));
          }).catch(() => {
            onError(new Error('Token expired and refresh failed.'));
          });
          return;
        }

        let sseBuffer = '';
        let fullResponse = '';

        res.on('data', (chunk: Buffer) => {
          sseBuffer += chunk.toString();
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]') {
              if (trimmed === 'data: [DONE]') onEnd();
              continue;
            }
            if (trimmed.startsWith('data: ')) {
              const jsonStr = trimmed.slice(6);
              try {
                const parsed = JSON.parse(jsonStr);
                const content = parsed?.choices?.[0]?.delta?.content;
                if (content) {
                  onChunk(content);
                  fullResponse += content;
                }
              } catch {
                // Ignore parse errors for malformed chunks
              }
            }
          }
        });

        res.on('end', () => onEnd());
        res.on('error', onError);
      });

      req.on('error', onError);
      req.write(body);
      req.end();
    })
    .catch((err: Error) => onError(err));
}

// Streaming chat completion for tool calling (Copilot forbids non-stream responses)
function chatCompletionWithTools(
  modelId: string,
  messages: ChatMessage[],
  attempt = 0
): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> }> {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getValidToken();
      const body = JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: TOOL_SYSTEM_PROMPT },
          ...messages,
        ],
        tools: TOOLS,
        stream: true,
      });

      const options = {
        hostname: CHAT_API_BASE,
        path: '/chat/completions',
        method: 'POST',
        headers: {
          ...getHeaders(token),
          'Content-Length': Buffer.byteLength(body),
        },
      };

      let sseBuffer = '';
      let content = '';
      const toolMap: Record<string, { id: string; name: string; argsText: string }> = {};

      const req = https.request(options, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let errBody = '';
          res.on('data', (chunk: Buffer) => {
            errBody += chunk.toString();
          });
          res.on('end', async () => {
            if ((res.statusCode === 401 || res.statusCode === 403) && attempt < 1) {
              try {
                await tokenManager.refreshToken();
                const retried = await chatCompletionWithTools(modelId, messages, attempt + 1);
                resolve(retried);
                return;
              } catch (retryErr) {
                const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
                reject(new Error(`Copilot chat failed (HTTP ${res.statusCode}) and retry failed: ${retryMessage}`));
                return;
              }
            }
            reject(new Error(`Copilot chat failed (HTTP ${res.statusCode}): ${errBody}`));
          });
          return;
        }

        res.on('data', (chunk: Buffer) => {
          sseBuffer += chunk.toString();
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed === 'data: [DONE]') continue;
            if (!trimmed.startsWith('data: ')) continue;

            const jsonStr = trimmed.slice(6);
            try {
              const parsed = JSON.parse(jsonStr);
              const delta = parsed?.choices?.[0]?.delta;
              if (delta?.content) {
                content += delta.content;
              }
              if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
                for (const toolCall of delta.tool_calls) {
                  console.log(`[DEBUG RAW] Received tool_call chunk:`, JSON.stringify(toolCall).substring(0, 200));
                  
                  // OpenAI may send tool_calls with just an index initially, then fill in details
                  // Try to match on both id and index to handle streaming properly
                  let id = toolCall.id;
                  if (!id && toolCall.index !== undefined) {
                    id = `index_${toolCall.index}`;
                  }
                  if (!id) {
                    console.warn(`[DEBUG] Tool call has no id or index, skipping:`, toolCall);
                    continue;
                  }
                  
                  const entry = toolMap[id] || { id, name: '', argsText: '' };
                  
                  if (toolCall.function?.name) {
                    entry.name = toolCall.function.name;
                    console.log(`[DEBUG] Assigned name to id "${id}": ${entry.name}`);
                  }
                  if (toolCall.function?.arguments) {
                    entry.argsText += toolCall.function.arguments;
                    console.log(`[DEBUG] Assigned args to id "${id}": ${toolCall.function.arguments}`);
                  }
                  
                  toolMap[id] = entry;
                  console.log(`[DEBUG] Current toolMap state after update:`, Object.keys(toolMap).map(k => `${k}: name="${toolMap[k].name}"`));
                }
              }
            } catch (e) {
              console.error(`[DEBUG] Error parsing SSE line:`, jsonStr, e);
            }
          }
        });

        res.on('end', () => {
          console.log(`[DEBUG] Stream ended. Final toolMap entries:`, Object.entries(toolMap).map(([k, v]) => `${k}: {name:"${v.name}", argsText:"${v.argsText.substring(0, 50)}..."}`));
          
          const toolCalls = Object.values(toolMap)
            .filter(entry => entry.name) // Only include entries with names
            .map((entry) => {
            let args: Record<string, unknown> = {};
            if (entry.argsText) {
              try {
                args = JSON.parse(entry.argsText);
              } catch (e) {
                console.error(`[DEBUG] Failed to parse args for tool "${entry.name}": ${entry.argsText}`, e);
                args = {};
              }
            }
            console.log(`[DEBUG] Resolved tool call: name="${entry.name}", args=${JSON.stringify(args)}`);
            return { id: entry.id, name: entry.name, args };
          });
          
          console.log(`[DEBUG] Total tool calls resolved: ${toolCalls.length}`);
          resolve({ content, toolCalls });
        });

        res.on('error', reject);
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

// Handle tool calling loop
export async function chatWithTools(
  modelId: string,
  messages: ChatMessage[],
  onChunk: (chunk: string, type: 'text' | 'tool-call' | 'tool-result') => void,
  onEnd: () => void,
  onError: (err: Error) => void
): Promise<void> {
  try {
    let conversationMessages = [...messages];
    let iterationCount = 0;
    const maxIterations = 5; // Prevent infinite loops

    while (iterationCount < maxIterations) {
      iterationCount++;
      console.log(`[CHAT_TOOLS] Iteration ${iterationCount}`);

      const response = await chatCompletionWithTools(modelId, conversationMessages);

      // Send the assistant's text response
      if (response.content) {
        onChunk(response.content, 'text');
        conversationMessages.push({
          role: 'assistant',
          content: response.content,
        });
      }

      // If no tool calls, we're done
      if (response.toolCalls.length === 0) {
        console.log('[CHAT_TOOLS] No tool calls, conversation complete');
        break;
      }

      // Process tool calls
      const toolResults = [];
      for (const toolCall of response.toolCalls) {
        console.log(`[CHAT_TOOLS] Processing tool call: "${toolCall.name}" with args:`, toolCall.args);
        if (!toolCall.name) {
          console.warn(`[CHAT_TOOLS] WARNING: Tool call has empty name! ID: ${toolCall.id}, Args: ${JSON.stringify(toolCall.args)}`);
        }
        onChunk(
          `🔧 **Tool Call**: \`${toolCall.name}(${JSON.stringify(toolCall.args)})\`\n`,
          'tool-call'
        );

        let result: string;
        try {
          result = await executeTool(toolCall.name, toolCall.args);
          console.log(`[CHAT_TOOLS] Tool result: ${result}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = `Error: ${message}`;
          console.error(`[CHAT_TOOLS] Tool error: ${message}`);
        }

        // Format the result (convert JSON to markdown tables, etc.)
        const formattedResult = formatToolResult(result);
        onChunk(`${formattedResult}\n\n`, 'tool-result');

        toolResults.push({
          role: 'user' as const,
          content: `Tool result for ${toolCall.name}(${JSON.stringify(toolCall.args)}): ${result}`,
        });
      }

      // Add tool results to conversation
      conversationMessages.push(...toolResults);
    }

    onEnd();
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}
