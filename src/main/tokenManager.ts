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

  storeToken(token: string, tid?: string) {
    this.tokenData = {
      token,
      tid,
      expiresAt: Date.now() + 29 * 60 * 1000, // 29 minutes
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
            'User-Agent': 'local-copilot/1.0.0',
            'X-GitHub-Api-Version': '2023-07-07',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              console.log('[TokenManager] HTTP Response:', res.statusCode, data?.substring(0, 200));
              const parsed = JSON.parse(data) as { token?: string; expires_at?: number };
              if (!parsed?.token) {
                console.error('[TokenManager] Copilot token response missing token:', data);
                resolve(null);
                return;
              }

              const expiresAtMs = parsed.expires_at ? parsed.expires_at * 1000 : Date.now() + 29 * 60 * 1000;
              resolve({ token: parsed.token, expiresAt: expiresAtMs });
            } catch (e) {
              console.error('[TokenManager] Failed to parse copilot token response:', e);
              console.error('[TokenManager] Response data:', data?.substring(0, 500));
              resolve(null);
            }
          });
        }
      );

      req.on('error', (err) => {
        console.error('[TokenManager] Copilot token request failed:', err);
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
    try {
      // First, try to read from apps.json (newer format used by copilot-language-server)
      const appsJsonPath = this.getAppsJsonPath();
      if (fs.existsSync(appsJsonPath)) {
        const raw = fs.readFileSync(appsJsonPath, 'utf-8');
        const apps: Record<string, { oauth_token?: string; user?: string }> = JSON.parse(raw);
        
        // Look for any app entry with an oauth_token
        for (const [, appData] of Object.entries(apps)) {
          if (appData?.oauth_token) {
            console.log('[TokenManager] Read oauth_token from apps.json');
            return appData.oauth_token;
          }
        }
      }

      // Fallback to legacy hosts.json format
      const configPath = this.getHostsJsonPath();
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const hosts: HostsJson = JSON.parse(raw);

        // Look for github.com entry
        const githubEntry = hosts['github.com'] || hosts['api.github.com'];
        if (githubEntry?.oauth_token) {
          console.log('[TokenManager] Read oauth_token from hosts.json');
          return githubEntry.oauth_token;
        }
      }
    } catch (e) {
      console.error('[TokenManager] Error reading oauth_token from disk:', e);
    }
    return null;
  }

  private getAppsJsonPath(): string {
    if (process.platform === 'win32') {
      return path.join(process.env.LOCALAPPDATA || os.homedir(), 'github-copilot', 'apps.json');
    }
    return path.join(os.homedir(), '.config', 'github-copilot', 'apps.json');
  }

  private getHostsJsonPath(): string {
    if (process.platform === 'win32') {
      return path.join(process.env.LOCALAPPDATA || os.homedir(), 'github-copilot', 'hosts.json');
    }
    return path.join(os.homedir(), '.config', 'github-copilot', 'hosts.json');
  }

  /**
   * Refresh token via LSP checkStatus and read from disk
   */
  async refreshToken(): Promise<string | null> {
    try {
      await lspClient.initialize();
      const status = await lspClient.checkStatus();
      console.log('[TokenManager] refresh checkStatus returned:', status);
      
      if (status.status === 'OK' || status.status === 'AlreadySignedIn') {
        // Re-read from disk after refresh
        const refreshedDiskToken = this.readOAuthTokenFromDisk();
        if (refreshedDiskToken) {
          console.log('[TokenManager] Token refreshed from disk');
          this.storeToken(refreshedDiskToken);
          return refreshedDiskToken;
        }
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

    // 2. Check disk (apps.json or hosts.json) - oauth_token can be used directly!
    const diskToken = this.readOAuthTokenFromDisk();
    if (diskToken) {
      console.log('[TokenManager] Using oauth_token directly from disk');
      // The oauth_token (ghu_*) is already valid for Copilot API calls
      // Store it in memory for future use
      this.storeToken(diskToken);
      return diskToken;
    }

    // 3. Try refreshing via LSP checkStatus (in case LSP has updated the token)
    console.log('[TokenManager] No token found, attempting refresh via LSP');
    try {
      await lspClient.initialize();
      const status = await lspClient.checkStatus();
      console.log('[TokenManager] checkStatus returned:', status);
      
      if (status.status === 'OK' || status.status === 'AlreadySignedIn') {
        // Try reading again after refresh
        const refreshedToken = this.readOAuthTokenFromDisk();
        if (refreshedToken) {
          console.log('[TokenManager] Token available after LSP refresh');
          this.storeToken(refreshedToken);
          return refreshedToken;
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
