import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import https from 'https';
import { lspClient } from './lspClient';

interface CopilotToken {
  token: string;
  tid?: string;
  expiresAt?: number;
}

interface HostsJson {
  [host: string]: {
    oauth_token?: string;
    user?: string;
  };
}

type GenericObject = Record<string, unknown>;

class TokenManager {
  private tokenData: CopilotToken | null = null;

  constructor() {
    // Listen for token notifications from LSP - more comprehensive listener
    lspClient.on('notification', (msg: { method?: string; params?: unknown }) => {
      try {
        const params = msg.params as Record<string, unknown> | undefined;
        
        // Check for token in common locations
        if (params?.token && typeof params.token === 'string') {
          console.log('[TokenManager] Token found in notification:', msg.method);
          this.storeToken(params.token as string, params.tid as string | undefined);
          return;
        }

        // Check for nested token structures
        const copilotTokenObj = params?.copilotToken as Record<string, unknown> | undefined;
        if (copilotTokenObj?.token && typeof copilotTokenObj.token === 'string') {
          console.log('[TokenManager] Token found in copilotToken field');
          this.storeToken(copilotTokenObj.token, copilotTokenObj.tid as string | undefined);
          return;
        }

        // Log all notifications for debugging
        if (msg.method?.includes('token') || msg.method?.includes('Token')) {
          console.log('[TokenManager] Token-related notification:', msg.method, JSON.stringify(params)?.substring(0, 200));
        }
      } catch (e) {
        console.warn('[TokenManager] Error processing notification:', e);
      }
    });
  }

  storeToken(token: string, tid?: string, expiresAt?: number) {
    this.tokenData = {
      token,
      tid,
      expiresAt: expiresAt ?? Date.now() + 29 * 60 * 1000, // default 29 minutes
    };
    console.log('[TokenManager] Token stored, tid:', tid);
  }

  private async fetchCopilotToken(oauthToken: string): Promise<CopilotToken | null> {
    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: 'api.githubcopilot.com',
          path: '/token',
          method: 'GET',
          headers: {
            Authorization: `token ${oauthToken}`,
            Accept: 'application/json',
            'Editor-Version': 'vscode/1.85.0',
            'Editor-Plugin-Version': 'copilot-chat/0.12.0',
            'Copilot-Integration-Id': 'vscode-chat',
            'User-Agent': 'local-copilot/1.0.0',
            'X-GitHub-Api-Version': '2023-07-07',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode !== 200) {
              // 404 or other errors are expected in offline/restricted environments
              // Fall back to in-memory token instead
              console.debug(`[TokenManager] Token exchange unavailable (HTTP ${res.statusCode}), using cached token`);
              resolve(null);
              return;
            }
            try {
              const parsed = JSON.parse(data) as { token?: string; expires_at?: number };
              if (!parsed?.token) {
                console.debug('[TokenManager] Token response missing token field');
                resolve(null);
                return;
              }
              const expiresAtMs = parsed.expires_at ? parsed.expires_at * 1000 : Date.now() + 29 * 60 * 1000;
              resolve({ token: parsed.token, expiresAt: expiresAtMs });
            } catch (e) {
              console.debug('[TokenManager] Failed to parse token response:', e instanceof Error ? e.message : e);
              resolve(null);
            }
          });
        }
      );
      req.on('error', (err) => {
        console.debug('[TokenManager] Token exchange request error (expected in offline mode):', err instanceof Error ? err.message : err);
        resolve(null);
      });
      req.end();
    });
  }

  getToken(): string | null {
    if (this.tokenData && this.tokenData.expiresAt && Date.now() < this.tokenData.expiresAt) {
      return this.tokenData.token;
    }
    return null;
  }

  /**
   * Read oauth_token from the GitHub Copilot config files.
   * Checks both apps.json (newer format) and hosts.json (legacy format).
   */
  readOAuthTokenFromDisk(): string | null {
    const appsJsonPaths = this.getAppsJsonPaths();
    for (const appsJsonPath of appsJsonPaths) {
      try {
        console.log('[TokenManager] Checking for apps.json at:', appsJsonPath);
        if (!fs.existsSync(appsJsonPath)) continue;
        const raw = fs.readFileSync(appsJsonPath, 'utf-8');
        const apps = JSON.parse(raw) as GenericObject;

        const preferredKeys = Object.keys(apps).filter((k) => k === 'github.com' || k.startsWith('github.com:'));
        for (const key of preferredKeys) {
          const entry = apps[key] as GenericObject | undefined;
          if (entry && typeof entry.oauth_token === 'string' && entry.oauth_token) {
            console.log('[TokenManager] Read oauth_token from apps.json key:', key);
            return entry.oauth_token;
          }
        }

        const recursiveToken = this.findOAuthTokenRecursive(apps);
        if (recursiveToken) {
          console.log('[TokenManager] Read oauth_token from nested apps.json structure');
          return recursiveToken;
        }
      } catch (e) {
        console.warn('[TokenManager] Failed reading apps.json path:', appsJsonPath, e);
      }
    }

    try {
      // Fallback to legacy hosts.json format
      const configPath = this.getHostsJsonPath();
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const hosts: HostsJson = JSON.parse(raw);

        const githubEntry = hosts['github.com'] || hosts['api.github.com'];
        if (githubEntry?.oauth_token) {
          console.log('[TokenManager] Read oauth_token from hosts.json');
          return githubEntry.oauth_token;
        }
      }
    } catch (e) {
      console.error('[TokenManager] Error reading hosts oauth_token from disk:', e);
    }

    return null;
  }

  private getAppsJsonPaths(): string[] {
    if (process.platform === 'win32') {
      const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      return [
        path.join(local, 'github-copilot', 'apps.json'),
        path.join(roaming, 'github-copilot', 'apps.json'),
      ];
    }
    return [
      path.join(os.homedir(), '.config', 'github-copilot', 'apps.json'),
      path.join(os.homedir(), '.github-copilot', 'apps.json'),
    ];
  }

  private getHostsJsonPath(): string {
    if (process.platform === 'win32') {
      return path.join(process.env.LOCALAPPDATA || os.homedir(), 'github-copilot', 'hosts.json');
    }
    return path.join(os.homedir(), '.config', 'github-copilot', 'hosts.json');
  }

  private findOAuthTokenRecursive(value: unknown): string | null {
    if (!value) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.findOAuthTokenRecursive(item);
        if (found) return found;
      }
      return null;
    }
    if (typeof value === 'object') {
      const obj = value as GenericObject;
      if (typeof obj.oauth_token === 'string' && obj.oauth_token) {
        return obj.oauth_token;
      }
      for (const child of Object.values(obj)) {
        const found = this.findOAuthTokenRecursive(child);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Refresh token by reading from disk (app.json)
   */
  async refreshToken(): Promise<string | null> {
    try {
      const oauthToken = this.readOAuthTokenFromDisk();
      if (oauthToken) {
        // Store the token from disk directly without exchange
        this.storeToken(oauthToken, undefined, Date.now() + 29 * 60 * 1000);
        console.log('[TokenManager] Token refreshed from app.json');
        return oauthToken;
      }
    } catch (e) {
      console.error('[TokenManager] refreshToken failed:', e);
    }
    return null;
  }

  /**
   * Get the best available token: memory first, then disk, then force LSP refresh.
   */
  async getBestToken(): Promise<string | null> {
    // 1. Check in-memory token
    const memToken = this.getToken();
    if (memToken) {
      console.log('[TokenManager] Using in-memory token');
      return memToken;
    }

    // 2. Check disk (apps.json or hosts.json), then exchange oauth -> copilot token
    const oauthToken = this.readOAuthTokenFromDisk();
    if (oauthToken) {
      const copilotToken = await this.fetchCopilotToken(oauthToken);
      if (copilotToken?.token) {
        console.log('[TokenManager] Using exchanged Copilot token from disk oauth token');
        this.storeToken(copilotToken.token, copilotToken.tid, copilotToken.expiresAt);
        return copilotToken.token;
      }
      console.warn('[TokenManager] OAuth token found but /token exchange failed');
      // Last-resort fallback: some environments still accept oauth token directly.
      this.storeToken(oauthToken, undefined, Date.now() + 10 * 60 * 1000);
      return oauthToken;
    }

    // 3. Try refreshing via LSP checkStatus (in case LSP has updated the token)
    console.log('[TokenManager] No token found, attempting refresh via LSP');
    try {
      await lspClient.initialize();
      const status = await lspClient.checkStatus();
      console.log('[TokenManager] checkStatus returned:', status);
      
      if (status.status === 'OK' || status.status === 'AlreadySignedIn') {
        const refreshedOauthToken = this.readOAuthTokenFromDisk();
        if (refreshedOauthToken) {
          const refreshedCopilotToken = await this.fetchCopilotToken(refreshedOauthToken);
          if (refreshedCopilotToken?.token) {
            console.log('[TokenManager] Copilot token available after LSP refresh');
            this.storeToken(refreshedCopilotToken.token, refreshedCopilotToken.tid, refreshedCopilotToken.expiresAt);
            return refreshedCopilotToken.token;
          }
          // Last-resort fallback after refresh as well.
          this.storeToken(refreshedOauthToken, undefined, Date.now() + 10 * 60 * 1000);
          return refreshedOauthToken;
        }
      }
    } catch (e) {
      console.error('[TokenManager] LSP refresh failed:', e);
    }

    console.log('[TokenManager] Warning: No valid token available');
    return null;
  }

  clear() {
    this.tokenData = null;
  }
}

export const tokenManager = new TokenManager();
