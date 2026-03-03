import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { lspClient } from './lspClient.js';

class TokenManager {
  constructor() {
    this.tokenData = null;

    // Listen for token notifications from LSP
    lspClient.on('notification', (msg) => {
      if (msg.method === 'statusNotification' || msg.method === '$/copilot/tokenUpdate') {
        const params = msg.params;
        if (params?.token && typeof params.token === 'string') {
          this.storeToken(params.token, params.tid);
        }
      }
    });
  }

  storeToken(token, tid) {
    this.tokenData = {
      token,
      tid,
      expiresAt: Date.now() + 29 * 60 * 1000, // 29 minutes
    };
    console.log('[TokenManager] Token stored, tid:', tid);
  }

  getToken() {
    if (this.tokenData && this.tokenData.expiresAt && Date.now() < this.tokenData.expiresAt) {
      return this.tokenData.token;
    }
    return null;
  }

  /**
   * Read oauth_token from the GitHub Copilot config file.
   * This is the fallback method used after successful sign-in.
   */
  readOAuthTokenFromDisk() {
    try {
      const configPath = this.getHostsJsonPath();
      if (!fs.existsSync(configPath)) return null;

      const raw = fs.readFileSync(configPath, 'utf-8');
      const hosts = JSON.parse(raw);

      // Look for github.com entry
      const githubEntry = hosts['github.com'] || hosts['api.github.com'];
      if (githubEntry?.oauth_token) {
        console.log('[TokenManager] Read oauth_token from disk');
        return githubEntry.oauth_token;
      }
    } catch (e) {
      console.error('[TokenManager] Error reading hosts.json:', e);
    }
    return null;
  }

  getHostsJsonPath() {
    if (process.platform === 'win32') {
      return path.join(process.env.LOCALAPPDATA || os.homedir(), 'github-copilot', 'hosts.json');
    }
    return path.join(os.homedir(), '.config', 'github-copilot', 'hosts.json');
  }

  /**
   * Get the best available token: memory first, then disk, then force LSP refresh.
   */
  async getBestToken() {
    // 1. Check in-memory token
    const memToken = this.getToken();
    if (memToken) return memToken;

    // 2. Check disk (hosts.json)
    const diskToken = this.readOAuthTokenFromDisk();
    if (diskToken) return diskToken;

    // 3. Try refreshing via LSP checkStatus
    try {
      const status = await lspClient.checkStatus();
      if (status.status === 'OK' || status.status === 'AlreadySignedIn') {
        // Re-read from disk after refresh
        return this.readOAuthTokenFromDisk();
      }
    } catch (e) {
      console.error('[TokenManager] checkStatus failed:', e);
    }

    return null;
  }

  clear() {
    this.tokenData = null;
  }
}

export const tokenManager = new TokenManager();
