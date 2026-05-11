/**
 * tokenManager.js — Copilot Auth
 *
 * Reads COPILOT_TOKEN or GITHUB_TOKEN from the environment.
 *   • Long token (≥100 chars) → assumed to be a Copilot JWT, used directly.
 *   • Short token             → GitHub OAuth token, exchanged for a Copilot JWT.
 *
 * Tokens are cached in memory for 29 minutes.
 *
 * Usage:
 *   const { getToken } = require('./tokenManager');
 *   const token = await getToken();  // always fresh
 */
const https = require('https');

// Endpoints tried in order when exchanging a GitHub OAuth token
const EXCHANGE_ENDPOINTS = [
  { hostname: 'api.github.com',        path: '/copilot_internal/v2/token' },
  { hostname: 'api.githubcopilot.com', path: '/token' },
];

let cache    = null; // { token: string, expiresAt: number }
let inflight = null; // dedup concurrent getToken() calls

// ── OAuth exchange ────────────────────────────────────────────────────────────

/** Try one exchange endpoint. Resolves with { token, expiresAt } or null. */
function tryExchangeEndpoint({ hostname, path }, oauthToken) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname, path, method: 'GET', timeout: 10_000,
      headers: {
        Authorization:            `token ${oauthToken}`,
        Accept:                   'application/json',
        'Editor-Version':         'vscode/1.85.0',
        'Editor-Plugin-Version':  'copilot-chat/0.12.0',
        'Copilot-Integration-Id': 'vscode-chat',
        'User-Agent':             'ai-agent-demo/1.0.0',
        'X-GitHub-Api-Version':   '2023-07-07',
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const { token, expires_at, expires_in } = JSON.parse(body);
          if (!token) return resolve(null);
          resolve({
            token,
            expiresAt: expires_at
              ? expires_at * 1000
              : Date.now() + (expires_in ?? 29 * 60) * 1000,
          });
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error',   () => resolve(null));
    req.end();
  });
}

/** Exchange a GitHub OAuth token for a Copilot JWT, trying each endpoint in turn. */
async function exchangeOAuthToken(oauthToken) {
  for (const endpoint of EXCHANGE_ENDPOINTS) {
    const result = await tryExchangeEndpoint(endpoint, oauthToken);
    if (result) {
      console.log(`[TokenManager] Exchanged OAuth token via ${endpoint.hostname}${endpoint.path}`);
      return result;
    }
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get a valid Copilot token (from cache, env, or OAuth exchange).
 * Concurrent calls are deduplicated — only one exchange runs at a time.
 *
 * @returns {Promise<string>}
 * @throws  {Error} if no token source is configured or exchange fails
 */
async function getToken() {
  // 1. Serve from cache if still fresh
  if (cache && Date.now() < cache.expiresAt - 60_000) return cache.token;

  // 2. Deduplicate concurrent refreshes
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const env = process.env.COPILOT_TOKEN || process.env.GITHUB_TOKEN;
      if (!env) throw new Error('Set COPILOT_TOKEN or GITHUB_TOKEN in .env');

      // Long token → Copilot JWT, use directly
      if (env.length >= 100) {
        cache = { token: env, expiresAt: Date.now() + 29 * 60 * 1000 };
        console.log('[TokenManager] Using COPILOT_TOKEN from env');
        return env;
      }

      // Short token → GitHub OAuth, exchange for Copilot JWT
      console.log('[TokenManager] Exchanging GITHUB_TOKEN for Copilot token...');
      const result = await exchangeOAuthToken(env);
      if (!result) throw new Error('OAuth exchange failed — check your GITHUB_TOKEN');
      cache = result;
      return result.token;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** Force-clear the cached token (e.g. after a 401 response). */
function clearToken() { cache = null; }

module.exports = { getToken, clearToken };
