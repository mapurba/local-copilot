/**
 * copilotApi.js — LangGraph Agent powered by GitHub Copilot
 *
 * Agent loop (LangGraph StateGraph):
 *
 *   START ──► [agent] ──► shouldContinue ──► [tools] ──┐
 *                │                                      │
 *                └──────────────── END ◄────────────────┘
 *
 * Public API:
 *   streamChat({ modelId, messages, onChunk, onEnd, onError, systemPrompt })
 *   getModels() → Promise<string[]>
 *
 * onChunk(text, type) types:
 *   'content'  — assistant text
 *   'tool'     — tool start/result  (JSON string)
 *   'thinking' — node transitions   (JSON string)
 *   'usage'    — token counts       (JSON string)
 */
const { getToken, clearToken } = require('./tokenManager');
const { toolRegistry }         = require('./tools/index');

const COPILOT_BASE_URL = 'https://api.githubcopilot.com';

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful AI assistant with access to tools ' +
  '(file I/O, search, shell, math, HTTP fetch, todo list, and more). ' +
  'Use tools when needed. Think step by step.';

// ── Copilot connection ────────────────────────────────────────────────────────

/** Required headers for every Copilot API request. */
function copilotHeaders() {
  return {
    'Editor-Version':         'vscode/1.85.0',
    'Editor-Plugin-Version':  'copilot-chat/0.12.0',
    'Copilot-Integration-Id': 'vscode-chat',
    'User-Agent':             'GitHubCopilot/1.1.0',
    'OpenAI-Intent':          'conversation-panel',
  };
}

/**
 * Fetch wrapper that injects a fresh Copilot Bearer token on every request.
 * Retries once on 401/403 (token may have just expired).
 */
function buildAuthFetch() {
  return async (url, init) => {
    const withAuth = async () => {
      const token   = await getToken();
      const headers = new Headers(init?.headers || {}); // handles plain obj & Headers instances
      headers.set('Authorization', `Bearer ${token}`);
      for (const [k, v] of Object.entries(copilotHeaders())) headers.set(k, v);
      return headers;
    };

    let res = await globalThis.fetch(url, { ...init, headers: await withAuth() });

    if (res.status === 401 || res.status === 403) {
      clearToken();
      res = await globalThis.fetch(url, { ...init, headers: await withAuth() });
      if (res.status === 401 || res.status === 403)
        throw new Error(`Auth failed (HTTP ${res.status}) — check COPILOT_TOKEN / GITHUB_TOKEN`);
    }
    return res;
  };
}

/** Construct a ChatOpenAI instance pointed at the Copilot API. */
function buildLLM(ChatOpenAI, { modelId, token }) {
  return new ChatOpenAI({
    model:       modelId,
    temperature: 0,
    apiKey:      token,
    configuration: {
      baseURL:        COPILOT_BASE_URL,
      defaultHeaders: copilotHeaders(),
      fetch:          buildAuthFetch(),
    },
  });
}

// ── Tool helpers ──────────────────────────────────────────────────────────────

/** Tool names must match OpenAI's ^[a-zA-Z0-9_-]+$ — sanitize colons/spaces. */
function sanitizeName(name) {
  return (name ?? '').replace(/[^a-zA-Z0-9_-]/g, '_') || '_tool';
}

/** Pull tool_calls out of an AIMessage regardless of where LangChain stores them. */
function extractToolCalls(message) {
  const calls = message?.tool_calls?.length
    ? message.tool_calls
    : (message?.additional_kwargs?.tool_calls ?? []);

  const seen = new Set();
  return calls.map((tc, i) => {
    const raw = tc?.args ?? tc?.function?.arguments ?? {};
    return {
      id:   tc?.id ?? `tc-${i}`,
      name: tc?.name ?? tc?.function?.name,
      args: typeof raw === 'string' ? tryParseJSON(raw) : raw,
    };
  }).filter(({ name, id }) => {
    const key = `${id}::${name}`;
    return name && !seen.has(key) && seen.add(key);
  });
}

/** The LLM may wrap args as { args: [...] }, a plain array, or a single value. */
function normalizeArgs(raw) {
  if (Array.isArray(raw))             return raw;
  if (raw && typeof raw === 'object') return Array.isArray(raw.args) ? raw.args : Object.values(raw);
  return raw == null ? [] : [raw];
}

function extractUsage(response) {
  const u = response?.usage_metadata ?? response?.response_metadata?.tokenUsage;
  if (!u) return null;
  const p = Number(u.input_tokens    ?? u.promptTokens    ?? u.prompt_tokens);
  const c = Number(u.output_tokens   ?? u.completionTokens ?? u.completion_tokens);
  const t = Number(u.total_tokens    ?? u.totalTokens);
  return {
    promptTokens:     Number.isFinite(p) ? p : undefined,
    completionTokens: Number.isFinite(c) ? c : undefined,
    totalTokens:      Number.isFinite(t) ? t : (Number.isFinite(p + c) ? p + c : undefined),
  };
}

function tryParseJSON(str) {
  try { return JSON.parse(str); } catch { return str; }
}

/** Convert the tool registry into the OpenAI function-calling schema. */
function buildOpenAITools(registry) {
  const sanitizedToOriginal = {};
  const tools = registry.list().map((tool) => {
    const safeName = sanitizeName(tool.name);
    sanitizedToOriginal[safeName] = tool.name;
    return {
      type: 'function',
      function: {
        name:        safeName,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: {
            args: {
              type:        'array',
              description: 'Positional arguments for the tool',
              items: {
                anyOf: [
                  { type: 'string' }, { type: 'number' }, { type: 'boolean' },
                  { type: 'object', additionalProperties: true },
                  { type: 'array', items: {} }, { type: 'null' },
                ],
              },
            },
          },
        },
      },
    };
  });
  return { tools, sanitizedToOriginal };
}

// ── LangGraph agent loop ──────────────────────────────────────────────────────

/**
 * Build and compile a LangGraph StateGraph for the agent loop.
 *
 * Graph structure:
 *
 *   START ──► [agent] ──► shouldContinue ──► [tools] ──► [agent] ──► ...
 *                │
 *                └──► END  (when LLM returns no tool calls)
 *
 * Nodes:
 *   agent  — calls the LLM; emits content/usage chunks
 *   tools  — executes every tool call the LLM requested; emits tool chunks
 *
 * State:
 *   { messages: BaseMessage[] }  — append-only via the built-in reducer
 */
function buildAgentGraph({ Annotation, StateGraph, START, END, ToolMessage, llmWithTools, onChunk, sanitizedToOriginal, onApproval }) {
  // Shared state: a growing list of LangChain messages
  const AgentState = Annotation.Root({
    messages: Annotation({ reducer: (x, y) => x.concat(y), default: () => [] }),
  });

  // ── Node: agent ─────────────────────────────────────────────────────────
  // Calls the LLM (with tools bound). The LLM either replies with text
  // or requests one or more tool calls — both are stored in state.messages.
  const agentNode = async (state) => {
    onChunk(JSON.stringify({ node: 'agent', messageCount: state.messages.length }), 'thinking');

    // Stream tokens so the bubble updates immediately instead of waiting for the full response
    let response;
    for await (const chunk of await llmWithTools.stream(state.messages)) {
      response = response ? response.concat(chunk) : chunk;
      const raw  = chunk?.content ?? '';
      const text = typeof raw === 'string' ? raw : raw.map((p) => p?.text ?? '').join('');
      if (text) onChunk(text, 'content');
    }

    const usage = extractUsage(response);
    if (usage) onChunk(JSON.stringify(usage), 'usage');

    return { messages: [response] };
  };

  // ── Node: tools ─────────────────────────────────────────────────────────
  // Executes every tool call the LLM requested (sequentially to preserve order)
  // and wraps results as ToolMessages so the LLM sees them in the next turn.
  const toolsNode = async (state) => {
    const toolCalls = extractToolCalls(state.messages.at(-1));
    onChunk(JSON.stringify({ node: 'tools', count: toolCalls.length }), 'thinking');

    const toolMessages = [];
    for (const tc of toolCalls) {
      const name = sanitizedToOriginal[tc.name] ?? tc.name;
      const args = normalizeArgs(tc.args);

      // ── Human-in-the-loop approval ──────────────────────────────────
      // If an onApproval callback is provided, pause and ask the user.
      // onApproval resolves to true (allow) or false (deny).
      if (onApproval) {
        const approved = await onApproval({ id: tc.id, name, args });
        if (!approved) {
          onChunk(JSON.stringify({ phase: 'denied', name, args }), 'tool');
          toolMessages.push(new ToolMessage({
            tool_call_id: tc.id,
            content: JSON.stringify({ denied: true, message: 'User denied this tool call.' }),
          }));
          continue;
        }
      }

      onChunk(JSON.stringify({ phase: 'start', name, args }), 'tool');

      let result;
      try   { result = await toolRegistry.call(name, ...args); }
      catch (err) { result = { error: err.message }; }

      onChunk(JSON.stringify({ phase: 'result', name, args, result }), 'tool');
      toolMessages.push(new ToolMessage({ tool_call_id: tc.id, content: JSON.stringify(result) }));
    }
    return { messages: toolMessages };
  };

  // ── Router: continue to tools, or end? ──────────────────────────────────
  const shouldContinue = (state) =>
    extractToolCalls(state.messages.at(-1)).length > 0 ? 'tools' : END;

  // ── Assemble the graph ───────────────────────────────────────────────────
  return new StateGraph(AgentState)
    .addNode('agent', agentNode)
    .addNode('tools', toolsNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', shouldContinue)
    .addEdge('tools', 'agent')
    .compile();
}

// ── Public API ────────────────────────────────────────────────────────────────

async function streamChat({ modelId, messages, onChunk, onEnd, onError, systemPrompt = DEFAULT_SYSTEM_PROMPT, onApproval = null }) {
  try {
    // Lazy-load LangChain packages (keeps server startup fast)
    const [{ ChatOpenAI }, { HumanMessage, AIMessage, SystemMessage, ToolMessage }, { StateGraph, START, END, Annotation }] =
      await Promise.all([
        import('@langchain/openai'),
        import('@langchain/core/messages'),
        import('@langchain/langgraph'),
      ]);

    const token          = await getToken();
    const llm            = buildLLM(ChatOpenAI, { modelId, token });
    const { tools, sanitizedToOriginal } = buildOpenAITools(toolRegistry);
    const llmWithTools   = tools.length > 0 ? llm.bindTools(tools, { tool_choice: 'auto' }) : llm;
    const graph          = buildAgentGraph({ Annotation, StateGraph, START, END, ToolMessage, llmWithTools, onChunk, sanitizedToOriginal, onApproval });

    const lcMessages = [
      new SystemMessage(systemPrompt),
      ...messages.map((m) => m.role === 'assistant' ? new AIMessage(m.content) : new HumanMessage(m.content)),
    ];

    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    await Promise.race([
      graph.invoke({ messages: lcMessages }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Agent timed out after 5 minutes. The LLM did not respond.')), TIMEOUT_MS)
      ),
    ]);
    onEnd();
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err))
      + (String(err).includes('403') ? '\n\nCheck COPILOT_TOKEN / GITHUB_TOKEN.' : '');
    onError(new Error(msg));
  }
}

async function getModels() {
  try {
    const token = await getToken();
    const res   = await globalThis.fetch(`${COPILOT_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...copilotHeaders() },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data?.data)) return data.data.map((m) => m.id);
    if (Array.isArray(data))       return data.map((m) => m.id ?? m);
    throw new Error('Unexpected /models response shape');
  } catch (err) {
    console.warn('[CopilotAPI] getModels failed, using fallback list:', err.message);
    return ['gpt-4.1', 'gpt-4o', 'gpt-4', 'claude-3.5-sonnet', 'o1-preview'];
  }
}

module.exports = { streamChat, getModels };
