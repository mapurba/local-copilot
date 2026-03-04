import https from 'https';
import { tokenManager } from './tokenManager';
import { lspClient } from './lspClient';

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
      name: 'add',
      description: 'Add two numbers',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'First number' },
          b: { type: 'number', description: 'Second number' },
        },
        required: ['a', 'b'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'subtract',
      description: 'Subtract second number from first number',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'First number' },
          b: { type: 'number', description: 'Second number' },
        },
        required: ['a', 'b'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'multiply',
      description: 'Multiply two numbers',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'First number' },
          b: { type: 'number', description: 'Second number' },
        },
        required: ['a', 'b'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'divide',
      description: 'Divide first number by second number',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'First number (dividend)' },
          b: { type: 'number', description: 'Second number (divisor)' },
        },
        required: ['a', 'b'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'log',
      description: 'Log a message to the console',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Message to log' },
        },
        required: ['message'],
      },
    },
  },
];

// Tool execution functions
function executeTool(toolName: string, args: Record<string, unknown>): string {
  console.log(`[TOOL] Executing: ${toolName} with args:`, args);
  
  switch (toolName) {
    case 'add': {
      const a = args.a as number;
      const b = args.b as number;
      const result = a + b;
      console.log(`[TOOL] add(${a}, ${b}) = ${result}`);
      return result.toString();
    }
    case 'subtract': {
      const a = args.a as number;
      const b = args.b as number;
      const result = a - b;
      console.log(`[TOOL] subtract(${a}, ${b}) = ${result}`);
      return result.toString();
    }
    case 'multiply': {
      const a = args.a as number;
      const b = args.b as number;
      const result = a * b;
      console.log(`[TOOL] multiply(${a}, ${b}) = ${result}`);
      return result.toString();
    }
    case 'divide': {
      const a = args.a as number;
      const b = args.b as number;
      if (b === 0) {
        console.log(`[TOOL] divide(${a}, ${b}) = Error: Division by zero`);
        return 'Error: Division by zero';
      }
      const result = a / b;
      console.log(`[TOOL] divide(${a}, ${b}) = ${result}`);
      return result.toString();
    }
    case 'log': {
      const message = args.message as string;
      console.log(`[TOOL] log: ${message}`);
      return `Logged: ${message}`;
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
  const token = await tokenManager.getBestToken();
  if (!token) {
    throw new Error('No valid Copilot token available. Please sign in.');
  }
  return token;
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
          { role: 'system', content: 'You are a helpful coding assistant. You have access to tools to perform calculations and logging. Use them when the user asks for mathematical operations.' },
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

// Non-streaming chat completion for tool calling
function chatCompletionWithTools(
  modelId: string,
  messages: ChatMessage[]
): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> }> {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getValidToken();
      const body = JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: 'You are a helpful coding assistant. You have access to tools to perform calculations and logging. Use them when the user asks for mathematical operations.' },
          ...messages,
        ],
        tools: TOOLS,
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

      let responseData = '';

      const req = https.request(options, (res) => {
        res.on('data', (chunk: Buffer) => {
          responseData += chunk.toString();
        });

        res.on('end', () => {
          try {
            const response = JSON.parse(responseData);
            const message = response?.choices?.[0]?.message;
            const content = message?.content || '';
            const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];

            // Handle tool calls if present
            if (message?.tool_calls && Array.isArray(message.tool_calls)) {
              for (const toolCall of message.tool_calls) {
                console.log(`[TOOL_CALL] Tool: ${toolCall.function.name}, Args:`, toolCall.function.arguments);
                toolCalls.push({
                  id: toolCall.id,
                  name: toolCall.function.name,
                  args: typeof toolCall.function.arguments === 'string'
                    ? JSON.parse(toolCall.function.arguments)
                    : toolCall.function.arguments,
                });
              }
            }

            resolve({ content, toolCalls });
          } catch (e) {
            reject(new Error(`Failed to parse response: ${responseData}`));
          }
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
        console.log(`[CHAT_TOOLS] Processing tool call: ${toolCall.name}`);
        onChunk(
          `🔧 **Tool Call**: \`${toolCall.name}(${JSON.stringify(toolCall.args)})\`\n`,
          'tool-call'
        );

        const result = executeTool(toolCall.name, toolCall.args);
        console.log(`[CHAT_TOOLS] Tool result: ${result}`);
        onChunk(
          `✅ **Result**: ${result}\n`,
          'tool-result'
        );

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
