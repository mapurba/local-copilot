import https from 'https';
import { tokenManager } from './tokenManager';
import { logApi } from './apiLogger';

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

function httpsPost<T>(urlPath: string, headers: Record<string, string>, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const startedAt = Date.now();
    const fullUrl = `https://${CHAT_API_BASE}${urlPath}`;

    logApi({
      source: 'copilotChatApi.httpsPost',
      stage: 'request',
      method: 'POST',
      url: fullUrl,
      headers,
      requestBody: payload,
    });

    const req = https.request(
      {
        hostname: CHAT_API_BASE,
        path: urlPath,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(payload).toString(),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          logApi({
            source: 'copilotChatApi.httpsPost',
            stage: 'response',
            method: 'POST',
            url: fullUrl,
            status: res.statusCode || 0,
            durationMs: Date.now() - startedAt,
            headers: res.headers as Record<string, unknown>,
            responseBody: data,
          });

          if ((res.statusCode || 500) >= 400) {
            reject(new Error(`Chat request failed (${res.statusCode}): ${data}`));
            return;
          }

          try {
            resolve(JSON.parse(data) as T);
          } catch {
            reject(new Error(`Failed to parse response: ${data}`));
          }
        });
      }
    );

    req.on('error', (err) => {
      logApi({
        source: 'copilotChatApi.httpsPost',
        stage: 'error',
        method: 'POST',
        url: fullUrl,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}

function extractChunkContent(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as {
      choices?: Array<{
        delta?: { content?: string };
        message?: { content?: string };
      }>;
    };
    const choice = parsed.choices?.[0];
    return choice?.delta?.content ?? choice?.message?.content ?? '';
  } catch {
    return '';
  }
}

function createChatBody(modelId: string, messages: ChatMessage[]) {
  return {
    model: modelId,
    temperature: 0,
    stream: false,
    messages,
  };
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
    .then((token) => {
      const body = JSON.stringify({
        model: modelId,
        temperature: 0,
        stream: true,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
      });
      const startedAt = Date.now();
      const fullUrl = `https://${CHAT_API_BASE}/chat/completions`;

      logApi({
        source: 'copilotChatApi.streamChatCompletion',
        stage: 'request',
        method: 'POST',
        url: fullUrl,
        headers: getHeaders(token),
        requestBody: body,
      });

      const req = https.request(
        {
          hostname: CHAT_API_BASE,
          path: '/chat/completions',
          method: 'POST',
          headers: {
            ...getHeaders(token),
            Accept: 'text/event-stream',
            'Content-Length': Buffer.byteLength(body).toString(),
          },
        },
        (res) => {
          if ((res.statusCode || 500) >= 400) {
            let errorBody = '';
            res.on('data', (chunk) => (errorBody += chunk.toString()));
            res.on('end', () => {
              onError(new Error(`Chat request failed (${res.statusCode}): ${errorBody}`));
            });
            return;
          }

          let buffer = '';
          res.on('data', (chunk) => {
            buffer += chunk.toString();

            let separatorIndex = buffer.indexOf('\n\n');
            while (separatorIndex !== -1) {
              const eventBlock = buffer.slice(0, separatorIndex);
              buffer = buffer.slice(separatorIndex + 2);

              const dataLines = eventBlock
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .filter(Boolean);

              for (const dataLine of dataLines) {
                if (dataLine === '[DONE]') {
                  logApi({
                    source: 'copilotChatApi.streamChatCompletion',
                    stage: 'response',
                    method: 'POST',
                    url: fullUrl,
                    status: res.statusCode || 0,
                    durationMs: Date.now() - startedAt,
                    headers: res.headers as Record<string, unknown>,
                  });
                  onEnd();
                  return;
                }

                const content = extractChunkContent(dataLine);
                if (content) {
                  onChunk(content);
                }
              }

              separatorIndex = buffer.indexOf('\n\n');
            }
          });

          res.on('end', () => {
            onEnd();
          });
        }
      );

      req.on('error', (err) => {
        logApi({
          source: 'copilotChatApi.streamChatCompletion',
          stage: 'error',
          method: 'POST',
          url: fullUrl,
          durationMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        });
        onError(err instanceof Error ? err : new Error(String(err)));
      });

      req.write(body);
      req.end();
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
  const response = await httpsPost<{
    choices?: Array<{ message?: { content?: string } }>;
  }>('/chat/completions', getHeaders(token), createChatBody(modelId, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]));

  const content = response.choices?.[0]?.message?.content ?? '';
  return parseJsonFromResponse(content);
}
