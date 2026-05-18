import fs from 'fs/promises';
import path from 'path';
import * as vscode from 'vscode';

type HeadersLike = Record<string, unknown>;

function getLogPath(): string {
  // Use VS Code's globalStorage URI for the log file
  return path.join(
    vscode.extensions.getExtension('local.vscode-vcd-agent')?.extensionPath ?? process.cwd(),
    'api-calls.log'
  );
}

/** Lazily resolved log path set by extension.ts after context is available */
let resolvedLogPath: string | null = null;

export function setLogPath(p: string): void {
  resolvedLogPath = p;
}

function logPath(): string {
  return resolvedLogPath ?? path.join(process.cwd(), 'vcd-api-calls.log');
}

function redactValue(key: string, value: unknown): unknown {
  const lower = key.toLowerCase();
  if (
    lower.includes('authorization') ||
    lower.includes('token') ||
    lower.includes('cookie') ||
    lower.includes('password')
  ) {
    return '***redacted***';
  }
  return value;
}

function redactHeaders(headers?: HeadersLike): HeadersLike | undefined {
  if (!headers) return undefined;
  const output: HeadersLike = {};
  for (const [k, v] of Object.entries(headers)) {
    output[k] = redactValue(k, v);
  }
  return output;
}

function truncateText(input: unknown, max = 1500): string {
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...<truncated>`;
}

export interface ApiLogEntry {
  source: string;
  stage: 'request' | 'response' | 'error';
  method?: string;
  url?: string;
  status?: number;
  durationMs?: number;
  headers?: HeadersLike;
  requestBody?: unknown;
  responseBody?: unknown;
  error?: unknown;
}

export function logApi(entry: ApiLogEntry): void {
  const line = {
    ts: new Date().toISOString(),
    source: entry.source,
    stage: entry.stage,
    method: entry.method,
    url: entry.url,
    status: entry.status,
    durationMs: entry.durationMs,
    headers: redactHeaders(entry.headers),
    requestBody: entry.requestBody !== undefined ? truncateText(entry.requestBody) : undefined,
    responseBody: entry.responseBody !== undefined ? truncateText(entry.responseBody) : undefined,
    error: entry.error !== undefined ? truncateText(entry.error) : undefined,
  };

  const payload = `${JSON.stringify(line)}\n`;
  const p = logPath();
  fs.mkdir(path.dirname(p), { recursive: true })
    .then(() => fs.appendFile(p, payload, 'utf8'))
    .catch((err) => {
      console.error('[ApiLogger] Failed to write log:', err instanceof Error ? err.message : String(err));
    });
}

export function getApiLogFilePath(): string {
  return logPath();
}
