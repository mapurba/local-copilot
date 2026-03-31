/**
 * Browser Tools
 *
 * Open URLs and interact with web pages from the Node.js main process.
 * Mirrors the VS Code Copilot "browser" tool category.
 *
 * Uses Node's built-in http/https modules – no extra dependencies required.
 * Responses are capped at 500 KB to avoid flooding the LLM context.
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';

const DEFAULT_TIMEOUT_MS = 15_000; // 15 seconds
const MAX_BODY_BYTES = 500_000;    // 500 KB

export interface FetchResult {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  durationMs: number;
  truncated: boolean;
  error?: string;
}

/**
 * Fetch a URL and return its HTTP status, headers, and body.
 *
 * @param url        The URL to fetch (http:// or https://)
 * @param method     HTTP method (default: GET)
 * @param headers    Additional request headers
 * @param body       Request body string (for POST / PUT / PATCH)
 * @param timeoutMs  Request timeout in milliseconds (default: 15000)
 */
export function fetchUrl(
  url: string,
  method = 'GET',
  headers: Record<string, string> = {},
  body?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<FetchResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;

    const finish = (result: FetchResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    const fail = (error: string) =>
      finish({
        url,
        status: 0,
        statusText: 'Error',
        headers: {},
        body: '',
        durationMs: Date.now() - start,
        truncated: false,
        error,
      });

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return fail(`Invalid URL: ${url}`);
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;
    const reqHeaders: Record<string, string> = { ...headers };

    if (body) {
      reqHeaders['Content-Length'] = String(Buffer.byteLength(body, 'utf8'));
      if (!reqHeaders['Content-Type']) {
        reqHeaders['Content-Type'] = 'application/json';
      }
    }

    let req: http.ClientRequest;
    try {
      req = client.request(
        url,
        { method, headers: reqHeaders, timeout: timeoutMs },
        (res) => {
          let data = '';
          let truncated = false;

          res.on('data', (chunk: Buffer) => {
            if (truncated) return;
            data += chunk.toString('utf8');
            if (data.length > MAX_BODY_BYTES) {
              data = data.slice(0, MAX_BODY_BYTES);
              truncated = true;
              req.destroy();
            }
          });

          res.on('end', () => {
            finish({
              url,
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? '',
              headers: res.headers as Record<string, string | string[] | undefined>,
              body: data,
              durationMs: Date.now() - start,
              truncated,
            });
          });

          res.on('error', (err) => fail(err.message));
        },
      );
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }

    req.on('timeout', () => {
      req.destroy();
      fail(`Request timed out after ${timeoutMs}ms`);
    });

    req.on('error', (err) => fail(err.message));

    if (body) req.write(body, 'utf8');
    req.end();
  });
}
