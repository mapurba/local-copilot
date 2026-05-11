/**
 * Browser Tools
 * Fetch URLs using Node's built-in http/https modules.
 * No extra dependencies required.
 */
const http  = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 15_000; // 15 seconds
const MAX_BODY_BYTES      = 500_000; // 500 KB

/**
 * Fetch a URL and return its HTTP status, headers, and body.
 *
 * @param {string} url        URL to fetch (http:// or https://)
 * @param {string} [method]   HTTP method (default: GET)
 * @param {object} [headers]  Additional request headers
 * @param {string} [body]     Request body (for POST/PUT/PATCH)
 * @param {number} [timeoutMs] Timeout in ms (default: 15000)
 */
function fetchUrl(url, method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;

    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    const fail = (error) => finish({ url, status: 0, statusText: 'Error', headers: {}, body: '', durationMs: Date.now() - start, truncated: false, error });

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return fail(`Invalid URL: ${url}`);
    }

    const client = parsedUrl.protocol === 'https:' ? https : http;
    const reqHeaders = { ...headers };
    if (body) {
      reqHeaders['Content-Length'] = String(Buffer.byteLength(body, 'utf8'));
      if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
    }

    let req;
    try {
      req = client.request(url, { method, headers: reqHeaders, timeout: timeoutMs }, (res) => {
        let data = '';
        let truncated = false;
        res.on('data', (chunk) => {
          if (truncated) return;
          data += chunk.toString('utf8');
          if (data.length > MAX_BODY_BYTES) {
            data = data.slice(0, MAX_BODY_BYTES);
            truncated = true;
            req.destroy();
          }
        });
        res.on('end', () => finish({ url, status: res.statusCode ?? 0, statusText: res.statusMessage ?? '', headers: res.headers, body: data, durationMs: Date.now() - start, truncated }));
        res.on('error', (err) => fail(err.message));
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }

    req.on('timeout', () => { req.destroy(); fail(`Request timed out after ${timeoutMs}ms`); });
    req.on('error', (err) => fail(err.message));
    if (body) req.write(body, 'utf8');
    req.end();
  });
}

module.exports = { fetchUrl };
