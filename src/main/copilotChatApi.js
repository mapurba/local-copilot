import https from 'https';
import { tokenManager } from './tokenManager.js';
import { lspClient } from './lspClient.js';

const CHAT_API_BASE = 'api.githubcopilot.com';

function getHeaders(token) {
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

async function getValidToken() {
  const token = await tokenManager.getBestToken();
  if (!token) {
    throw new Error('No valid Copilot token available. Please sign in.');
  }
  return token;
}

function httpsGet(urlPath, headers) {
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

export async function getModels() {
  try {
    const token = await getValidToken();
    const response = await httpsGet('/models', getHeaders(token));

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

export function streamChatCompletion(modelId, messages, onChunk, onEnd, onError) {
  getValidToken()
    .then((token) => {
      const body = JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: 'You are a helpful coding assistant.' },
          ...messages,
        ],
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

        res.on('data', (chunk) => {
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
                if (content) onChunk(content);
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
    .catch((err) => onError(err));
}
