#!/usr/bin/env node
/**
 * get-token.js — Get a GitHub OAuth token via Device Flow
 *
 * 1. Prints a one-time code and a browser URL.
 * 2. You open the URL, log in to GitHub, and paste the code.
 * 3. The script polls GitHub until you approve, then prints your token.
 *
 * Usage:
 *   node get-token.js
 */

const https = require('https');

// GitHub OAuth App client ID used by the VS Code GitHub/Copilot extension
const CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const SCOPE = 'read:user';

// ── helpers ──────────────────────────────────────────────────────────────────

function post(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const payload = new URLSearchParams(body).toString();
    const req = https.request({
      hostname, path, method: 'POST', timeout: 15_000,
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Accept':        'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent':    'get-github-token/1.0.0',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { reject(new Error(`Invalid JSON: ${data}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Step 1: request a device code
  const { status: s1, body: d1 } = await post('github.com', '/login/device/code', {
    client_id: CLIENT_ID,
    scope: SCOPE,
  });

  if (s1 !== 200 || !d1.device_code) {
    console.error('Failed to get device code:', d1);
    process.exit(1);
  }

  const { device_code, user_code, verification_uri, expires_in, interval = 5 } = d1;

  console.log('\n========================================');
  console.log('  Open this URL in your browser:');
  console.log(`  ${verification_uri}`);
  console.log('\n  Enter this code when prompted:');
  console.log(`  ${user_code}`);
  console.log('========================================\n');
  console.log('Waiting for you to authorize...');

  // Step 2: poll for the access token
  const deadline = Date.now() + expires_in * 1000;
  let pollInterval = interval * 1000;

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    const { body: d2 } = await post('github.com', '/login/oauth/access_token', {
      client_id:   CLIENT_ID,
      device_code,
      grant_type:  'urn:ietf:params:oauth:grant-type:device_code',
    });

    if (d2.access_token) {
      console.log('\nSuccess! Your GitHub token:\n');
      console.log(d2.access_token);
      console.log('\nAdd it to your .env file as:');
      console.log(`GITHUB_TOKEN=${d2.access_token}`);
      return;
    }

    switch (d2.error) {
      case 'authorization_pending': break; // keep polling
      case 'slow_down': pollInterval += 5000; break;
      case 'expired_token': console.error('Code expired. Re-run the script.'); process.exit(1); break;
      case 'access_denied': console.error('Access denied by user.'); process.exit(1); break;
      default: console.error('Unexpected error:', d2); process.exit(1);
    }
  }

  console.error('Timed out waiting for authorization.');
  process.exit(1);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
