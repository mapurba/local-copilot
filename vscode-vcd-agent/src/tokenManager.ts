import https from 'https';
import * as vscode from 'vscode';
import { logApi } from './apiLogger';

interface CopilotToken {
  token: string;
  tid?: string;
  expiresAt?: number;
}

class TokenManager {
  private tokenData: CopilotToken | null = null;

  storeToken(token: string, tid?: string, expiresAt?: number): void {
    this.tokenData = {
      token,
      tid,
      expiresAt: expiresAt ?? Date.now() + 29 * 60 * 1000,
    };
  }

  private isOAuthToken(token: string): boolean {
    return token.startsWith('ghu_') || token.startsWith('ghp_') || token.length < 100;
  }

  private isExpired(): boolean {
    return !this.tokenData || (this.tokenData.expiresAt != null && Date.now() >= this.tokenData.expiresAt);
  }

  private async fetchCopilotToken(oauthToken: string): Promise<CopilotToken | null> {
    const tryEndpoint = async (hostname: string, pathName: string): Promise<CopilotToken | null> => {
      return new Promise((resolve) => {
        const startedAt = Date.now();
        const requestUrl = `https://${hostname}${pathName}`;
        logApi({
          source: 'tokenManager.exchange',
          stage: 'request',
          method: 'GET',
          url: requestUrl,
        });

        const req = https.request(
          {
            hostname,
            path: pathName,
            method: 'GET',
            headers: {
              Authorization: `token ${oauthToken}`,
              Accept: 'application/json',
              'Editor-Version': 'vscode/1.90.0',
              'Editor-Plugin-Version': 'copilot-chat/0.12.0',
              'Copilot-Integration-Id': 'vscode-chat',
              'User-Agent': 'vscode-vcd-agent/0.1.0',
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              logApi({
                source: 'tokenManager.exchange',
                stage: 'response',
                method: 'GET',
                url: requestUrl,
                status: res.statusCode ?? 0,
                durationMs: Date.now() - startedAt,
                responseBody: data,
              });
              try {
                const parsed = JSON.parse(data) as Record<string, unknown>;
                if (typeof parsed.token === 'string') {
                  resolve({
                    token: parsed.token,
                    tid: typeof parsed.tid === 'string' ? parsed.tid : undefined,
                    expiresAt: typeof parsed.expires_at === 'number'
                      ? parsed.expires_at * 1000
                      : Date.now() + 29 * 60 * 1000,
                  });
                } else {
                  resolve(null);
                }
              } catch {
                resolve(null);
              }
            });
          }
        );
        req.on('error', (err) => {
          logApi({ source: 'tokenManager.exchange', stage: 'error', url: requestUrl, error: err.message });
          resolve(null);
        });
        req.end();
      });
    };

    for (const [host, p] of [
      ['api.github.com', '/copilot_internal/v2/token'],
      ['api.githubcopilot.com', '/token'],
      ['api.githubcopilot.com', '/v2/token'],
    ] as [string, string][]) {
      const result = await tryEndpoint(host, p);
      if (result) return result;
    }
    return null;
  }

  async getBestToken(): Promise<string> {
    // 1. Return valid in-memory Copilot token
    if (this.tokenData && !this.isExpired() && !this.isOAuthToken(this.tokenData.token)) {
      return this.tokenData.token;
    }

    // 2. Get GitHub session via VS Code authentication API
    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await vscode.authentication.getSession('github', ['read:user'], { createIfNone: false });
    } catch {
      // Ignore — fall through to error
    }

    if (!session) {
      // Prompt user to sign in
      session = await vscode.authentication.getSession('github', ['read:user'], { createIfNone: true });
    }

    const oauthToken = session.accessToken;
    const copilot = await this.fetchCopilotToken(oauthToken);
    if (copilot) {
      this.storeToken(copilot.token, copilot.tid, copilot.expiresAt);
      return copilot.token;
    }

    throw new Error('Could not obtain a Copilot API token. Make sure GitHub Copilot is active.');
  }
}

export const tokenManager = new TokenManager();
