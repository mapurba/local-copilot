import https from 'https';
import { tokenManager } from './tokenManager';
import { logApi } from './apiLogger';
import { toolRegistry } from './tools';

const CHAT_API_BASE = 'api.githubcopilot.com';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

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

    const req = https.request(
      {
        hostname: CHAT_API_BASE,
        path: urlPath,
        method: 'GET',
        headers,
      },
      (res) => {
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
      }
    );

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

/** Sanitize a tool name so it matches the OpenAI-required pattern ^[a-zA-Z0-9_-]+$ */
function sanitizeName(name: string): string {
  return (name ?? '').replace(/[^a-zA-Z0-9_-]/g, '_') || '_tool';
}

function extractToolCallsFromAiMessage(message: any): Array<{ id: string; name: string; args: any }> {
  const directToolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const kwToolCalls = Array.isArray(message?.additional_kwargs?.tool_calls) ? message.additional_kwargs.tool_calls : [];
  // Prefer direct tool_calls when present; additional_kwargs often duplicates the same calls.
  const allToolCalls = directToolCalls.length > 0 ? directToolCalls : kwToolCalls;

  const seen = new Set<string>();

  return allToolCalls
    .map((tc: any, index: number) => {
      const id = tc?.id ?? `tool-call-${index}`;
      const name = tc?.name ?? tc?.function?.name;
      const rawArgs = tc?.args ?? tc?.function?.arguments ?? {};

      let args: any = rawArgs;
      if (typeof rawArgs === 'string') {
        try {
          args = JSON.parse(rawArgs);
        } catch {
          args = rawArgs;
        }
      }

      return {
        id,
        name,
        args,
      };
    })
    .filter((tc: { id: string; name: string; args: any }) => {
      if (!tc.name) return false;
      const key = `${tc.id}::${tc.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeToolArgs(rawArgs: any): any[] {
  if (Array.isArray(rawArgs)) {
    return rawArgs;
  }

  if (rawArgs && typeof rawArgs === 'object') {
    const maybeArgs = (rawArgs as Record<string, unknown>).args;
    if (Array.isArray(maybeArgs)) {
      return maybeArgs;
    }
    if (maybeArgs !== undefined) {
      return [maybeArgs];
    }
    return Object.values(rawArgs);
  }

  if (rawArgs === undefined || rawArgs === null) {
    return [];
  }

  return [rawArgs];
}

function extractUsageFromResponse(response: any): { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null {
  const usageMetadata = response?.usage_metadata;
  if (usageMetadata && typeof usageMetadata === 'object') {
    const promptTokens = Number(usageMetadata.input_tokens ?? usageMetadata.prompt_tokens);
    const completionTokens = Number(usageMetadata.output_tokens ?? usageMetadata.completion_tokens);
    const totalTokens = Number(usageMetadata.total_tokens);
    return {
      promptTokens: Number.isFinite(promptTokens) ? promptTokens : undefined,
      completionTokens: Number.isFinite(completionTokens) ? completionTokens : undefined,
      totalTokens: Number.isFinite(totalTokens)
        ? totalTokens
        : (Number.isFinite(promptTokens) && Number.isFinite(completionTokens)
            ? promptTokens + completionTokens
            : undefined),
    };
  }

  const tokenUsage = response?.response_metadata?.tokenUsage;
  if (tokenUsage && typeof tokenUsage === 'object') {
    const promptTokens = Number(tokenUsage.promptTokens ?? tokenUsage.prompt_tokens ?? tokenUsage.input_tokens);
    const completionTokens = Number(tokenUsage.completionTokens ?? tokenUsage.completion_tokens ?? tokenUsage.output_tokens);
    const totalTokens = Number(tokenUsage.totalTokens ?? tokenUsage.total_tokens);
    return {
      promptTokens: Number.isFinite(promptTokens) ? promptTokens : undefined,
      completionTokens: Number.isFinite(completionTokens) ? completionTokens : undefined,
      totalTokens: Number.isFinite(totalTokens)
        ? totalTokens
        : (Number.isFinite(promptTokens) && Number.isFinite(completionTokens)
            ? promptTokens + completionTokens
            : undefined),
    };
  }

  return null;
}

/**
 * Build a fetch wrapper that injects a fresh Copilot token into every HTTP request
 * made by LangChain's OpenAI client. On a 401/403 response it forces a token
 * refresh and retries once before propagating the error.
 */
function buildTokenRefreshingFetch(): (url: any, init?: any) => Promise<any> {
  return async (url: any, init?: any): Promise<any> => {
    const injectToken = async (): Promise<Record<string, string>> => {
      const fresh = await getValidToken();
      const base: Record<string, string> = {};
      if (init?.headers && typeof init.headers === 'object') {
        Object.assign(base, init.headers);
      }
      base['Authorization'] = `Bearer ${fresh}`;
      // Always stamp required Copilot headers on every outbound request
      Object.assign(base, getCopilotHeaders());
      return base;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const globalFetch = (globalThis as any).fetch as (url: any, init?: any) => Promise<any>;
    const response = await globalFetch(url, { ...init, headers: await injectToken() });

    // On 401/403 force a full token refresh and retry once
    if (response.status === 401 || response.status === 403) {
      console.warn('[LangGraph] Token rejected (HTTP ' + response.status + ') — forcing refresh and retrying');
      tokenManager.clear();
      const retryResponse = await globalFetch(url, { ...init, headers: await injectToken() });
      if (retryResponse.status === 401 || retryResponse.status === 403) {
        throw new Error(`Token refresh failed after retry (HTTP ${retryResponse.status}). Please sign out and sign back in.`);
      }
      return retryResponse;
    }

    return response;
  };
}

async function streamChatCompletionViaLangGraph(
  modelId: string,
  messages: ChatMessage[],
  onChunk: (chunk: string, type?: 'content' | 'thinking' | 'tool' | 'usage') => void,
  onToolCall?: (toolName: string, args: any) => Promise<any>,
  systemPrompt = 'You are a helpful assistant. You have access to various tools for math calculations and other tasks. When a user asks a question that can be solved with a tool, use the appropriate tool and explain the result.'
): Promise<void> {
  const [{ ChatOpenAI }, messagesModule, langGraphModule] = await Promise.all([
    import('@langchain/openai'),
    import('@langchain/core/messages'),
    import('@langchain/langgraph'),
  ]);

  const { HumanMessage, AIMessage, SystemMessage, ToolMessage } = messagesModule as any;
  const { StateGraph, START, END, Annotation } = langGraphModule as any;

  // Get an initial valid token just so ChatOpenAI's constructor is satisfied;
  // actual per-request tokens are injected by the custom fetch wrapper.
  const initialToken = await getValidToken();

  const lcMessages = [
    new SystemMessage(systemPrompt),
    ...messages.map((msg) => {
      if (msg.role === 'assistant') {
        return new AIMessage(msg.content);
      }
      return new HumanMessage(msg.content);
    }),
  ];

  // Build a reverse map from sanitized → original so we can dispatch correctly
  const sanitizedToOriginal: Record<string, string> = {};
  const registeredTools = toolRegistry.list();
  const openAiTools = registeredTools.map((tool) => {
    const safeName = sanitizeName(tool.name);
    sanitizedToOriginal[safeName] = tool.name;
    return {
      type: 'function' as const,
      function: {
        name: safeName,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: {
            args: {
              type: 'array',
              description: 'Arguments to pass to the tool',
              items: {
                anyOf: [
                  { type: 'string' },
                  { type: 'number' },
                  { type: 'boolean' },
                  { type: 'object', additionalProperties: true },
                  { type: 'array', items: { type: 'string' } },
                  { type: 'null' },
                ],
              },
            },
          },
        },
      },
    };
  });

  const llm = new ChatOpenAI({
    model: modelId,
    temperature: 0,
    apiKey: initialToken,
    configuration: {
      baseURL: `https://${CHAT_API_BASE}`,
      defaultHeaders: getCopilotHeaders(),
      // Dynamic fetch: injects a fresh token on every LLM request inside the graph loop
      fetch: buildTokenRefreshingFetch(),
    },
  } as any);

  // Use bindTools() — the proper LangChain API that correctly handles raw OpenAI tool format.
  // Fall back to plain llm if no tools are registered (tool_choice: 'auto' on an empty list errors).
  const llmWithTools = openAiTools.length > 0
    ? (llm as any).bindTools(openAiTools, { tool_choice: 'auto' })
    : llm;

  const AgentState = Annotation.Root({
    messages: Annotation({
      reducer: (x: any[], y: any[]) => x.concat(y),
      default: () => [],
    }),
  });

  const shouldContinue = (state: any) => {
    const lastMessage = state.messages[state.messages.length - 1];
    const toolCalls = extractToolCallsFromAiMessage(lastMessage);
    return toolCalls.length > 0 ? 'tools' : END;
  };

  const callModel = async (state: any) => {
    onChunk(JSON.stringify({ node: 'agent', messageCount: state.messages.length }), 'thinking');
    const response = await llmWithTools.invoke(state.messages);

    const usage = extractUsageFromResponse(response);
    if (usage) {
      onChunk(JSON.stringify(usage), 'usage');
    }

    const content = response?.content;
    if (typeof content === 'string' && content.trim()) {
      onChunk(content, 'content');
    } else if (Array.isArray(content)) {
      const text = content
        .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
        .join('')
        .trim();
      if (text) {
        onChunk(text, 'content');
      }
    }

    return { messages: [response] };
  };

  const callTools = async (state: any) => {
    const lastMessage = state.messages[state.messages.length - 1];
    const toolCalls = extractToolCallsFromAiMessage(lastMessage);
    onChunk(JSON.stringify({ node: 'tools', toolCount: toolCalls.length, tools: toolCalls.map((tc: any) => sanitizedToOriginal[tc.name] ?? tc.name) }), 'thinking');
    const toolMessages: any[] = [];

    for (const toolCall of toolCalls) {
      // Resolve sanitized name back to the original registry name
      const originalName = sanitizedToOriginal[toolCall.name] ?? toolCall.name;
      const normalizedArgs = normalizeToolArgs(toolCall.args);
      // Emit structured tool-start chunk with name and args
      onChunk(JSON.stringify({ phase: 'start', name: originalName, args: normalizedArgs }), 'tool');

      let result: any;
      if (onToolCall) {
        result = await onToolCall(originalName, normalizedArgs);
      } else {
        result = await toolRegistry.call(originalName, ...normalizedArgs);
      }

      // Emit structured tool-result chunk
      onChunk(JSON.stringify({ phase: 'result', name: originalName, args: normalizedArgs, result }), 'tool');

      toolMessages.push(
        new ToolMessage({
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        })
      );
    }

    return { messages: toolMessages };
  };

  const workflow = new StateGraph(AgentState)
    .addNode('agent', callModel)
    .addNode('tools', callTools)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', shouldContinue)
    .addEdge('tools', 'agent');

  const app = workflow.compile();
  await app.invoke({ messages: lcMessages });
}

export function streamChatCompletion(
  modelId: string,
  messages: ChatMessage[],
  onChunk: (chunk: string, type?: 'content' | 'thinking' | 'tool' | 'usage') => void,
  onEnd: () => void,
  onError: (err: Error) => void,
  onToolCall?: (toolName: string, args: any) => Promise<any>,
  systemPrompt = 'You are a helpful assistant. You have access to various tools for math calculations and other tasks. When a user asks a question that can be solved with a tool, use the appropriate tool and explain the result.'
): void {
  void (async () => {
    try {
      await streamChatCompletionViaLangGraph(modelId, messages, onChunk, onToolCall, systemPrompt);
      onEnd();
    } catch (err) {
      let errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.includes('403')) {
        errorMessage += '\n\nThis usually means your GitHub Copilot token has expired or is invalid. Try signing out and signing back in.';
      }
      onError(new Error(errorMessage));
    }
  })();
}

export async function getModels(): Promise<string[]> {
  try {
    const token = await getValidToken();
    const response = await httpsGet('/models', getHeaders(token)) as { data?: Array<{ id: string }> };

    if (response?.data && Array.isArray(response.data)) {
      return response.data.map((m) => m.id);
    }

    return ['gpt-4', 'gpt-4o', 'claude-3.5-sonnet', 'o1-preview'];
  } catch (e) {
    console.error('[ChatAPI] getModels error:', e);
    return ['gpt-4', 'gpt-4o', 'claude-3.5-sonnet', 'o1-preview'];
  }
}

