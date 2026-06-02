/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-require-imports */
// @ts-nocheck — LangChain imports are loaded dynamically to avoid heavy type declarations.
import { tokenManager } from './tokenManager';

const { ChatOpenAI } = require('@langchain/openai');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');

const CHAT_API_BASE = 'api.githubcopilot.com';

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

async function getValidToken(): Promise<string> {
  const looksLikeOAuthToken = (value: string) => value.length < 100;

  let token = await tokenManager.getBestToken();
  if (token && !looksLikeOAuthToken(token)) {
    return token;
  }

  token = await tokenManager.refreshToken();
  if (token && !looksLikeOAuthToken(token)) {
    return token;
  }

  throw new Error('No valid Copilot token available. Please sign in (or reconnect Copilot).');
}

type LlmInvoker = { invoke: (messages: unknown[]) => Promise<{ content?: unknown }> };

function buildCopilotLlm(token: string, modelId: string): LlmInvoker {
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
    streaming: false,
  }) as unknown as LlmInvoker;
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match && match[0]) {
    return match[0];
  }
  throw new Error('Failed to find JSON object in LLM response.');
}

export async function rewriteEnvWithVmIp(envContent: string, ipAddress: string, modelId = 'gpt-4.1'): Promise<{
  updatedEnv: string;
  changesSummary: string;
  rationale: string;
}> {
  const token = await getValidToken();
  const llm = buildCopilotLlm(token, modelId);

  const system = new SystemMessage([
    'You update .env content for ILM deployments.',
    'Return the FULL .env content with only the specified keys updated.',
    'Replace hostnames in the following keys with the provided VM IP:',
    'TENANT_OSP_REDIRECT_URL, CALLBACK_SERVER, SECRETS_URL, ILM_CORE_REST_URL.',
    'Keep schemes, ports, paths, and all other lines intact.',
    'Return JSON only with keys: updatedEnv, changesSummary, rationale.',
    'changesSummary should be a short list of key updates.',
    'rationale must be brief and high-level (no chain-of-thought).',
  ].join(' '));

  const user = new HumanMessage([
    `VM_IP=${ipAddress}`,
    '---ENV---',
    envContent,
  ].join('\n'));

  const response = await llm.invoke([system, user]);
  const content = typeof response?.content === 'string' ? response.content : '';
  const jsonText = extractJsonObject(content);
  const parsed = JSON.parse(jsonText) as { updatedEnv?: string; changesSummary?: string; rationale?: string };

  if (!parsed.updatedEnv || typeof parsed.updatedEnv !== 'string') {
    throw new Error('LLM did not return updatedEnv content.');
  }

  return {
    updatedEnv: parsed.updatedEnv,
    changesSummary: typeof parsed.changesSummary === 'string' ? parsed.changesSummary : '',
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
  };
}
