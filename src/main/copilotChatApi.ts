/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-require-imports */
// @ts-nocheck — LangChain imports are loaded dynamically to avoid TypeScript resolving
// their heavy generic type declarations at compile time (causing OOM in tsc).
import https from 'https';
import { tokenManager } from './tokenManager';
import { logApi } from './apiLogger';

// Dynamic requires — avoids TypeScript resolving @langchain/* type declarations at build time
const { ChatOpenAI } = require('@langchain/openai');
const { HumanMessage, AIMessage, SystemMessage } = require('@langchain/core/messages');

const CHAT_API_BASE = 'api.githubcopilot.com';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
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

function toLcMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'system':
        return new SystemMessage(m.content);
      case 'assistant':
        return new AIMessage(m.content);
      default:
        return new HumanMessage(m.content);
    }
  });
}

function buildCopilotLlm(token: string, modelId: string, streaming: boolean): ChatOpenAI {
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
    streaming,
  });
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

export function streamChatCompletion(
  modelId: string,
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
  onEnd: () => void,
  onError: (err: Error) => void,
  systemPrompt = 'You are a helpful assistant.'
): void {
  getValidToken()
    .then(async (token) => {
      const llm = buildCopilotLlm(token, modelId, true);
      const lcMessages: unknown[] = [
        new SystemMessage(systemPrompt),
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
      let errorMessage = err.message;
      if (errorMessage.includes('403')) {
        errorMessage += '\n\nThis usually means your GitHub Copilot token has expired or is invalid. Try signing out and signing back in.';
      }
      onError(new Error(errorMessage));
    });
}

function parseJsonFromResponse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Empty response from Copilot');
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenceMatch ? fenceMatch[1] : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error(`Failed to parse JSON response: ${candidate.substring(0, 200)}`);
  }
}

export async function createJsonCompletion(
  modelId: string,
  systemPrompt: string,
  userPrompt: string
): Promise<unknown> {
  const token = await getValidToken();
  const llm = buildCopilotLlm(token, modelId, false);

  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt),
  ]);

  const content = typeof response.content === 'string' ? response.content : '';
  return parseJsonFromResponse(content);
}
