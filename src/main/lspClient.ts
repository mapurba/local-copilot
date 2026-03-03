import * as cp from 'child_process';
import { EventEmitter } from 'events';

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class LspClient extends EventEmitter {
  private process: cp.ChildProcess | null = null;
  private buffer = '';
  private requestId = 0;
  private pendingRequests = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private initialized = false;

  start() {
    const serverPath = require.resolve('@github/copilot-language-server/dist/language-server.js');

    this.process = cp.spawn(process.execPath, [serverPath, '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
    });

    this.process.stdout?.on('data', (data: Buffer) => this.handleData(data.toString()));
    this.process.stderr?.on('data', (data: Buffer) => console.error('[LSP stderr]', data.toString()));
    this.process.on('exit', (code) => console.log('[LSP] exited with code', code));
    this.process.on('error', (err) => console.error('[LSP] process error:', err));

    console.log('[LSP] Started copilot-language-server');
  }

  private handleData(data: string) {
    this.buffer += data;

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buffer.substring(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length: (\d+)/);
      if (!contentLengthMatch) break;

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const bodyStart = headerEnd + 4;

      if (this.buffer.length < bodyStart + contentLength) break;

      const body = this.buffer.substring(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.substring(bodyStart + contentLength);

      try {
        const msg: JsonRpcMessage = JSON.parse(body);
        this.handleMessage(msg);
      } catch (e) {
        console.error('[LSP] Failed to parse message:', e);
      }
    }
  }

  private handleMessage(msg: JsonRpcMessage) {
    if (msg.id !== undefined && !msg.method) {
      // Response
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(msg.error);
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if (msg.method) {
      // Notification or Request from server
      console.log('[LSP] Notification:', msg.method, JSON.stringify(msg.params)?.substring(0, 200));
      this.emit('notification', msg);
      this.emit(`notification:${msg.method}`, msg.params);
    }
  }

  sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const msg: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };
      this.pendingRequests.set(id, { resolve, reject });
      this.sendRaw(msg);
    });
  }

  sendNotification(method: string, params: unknown) {
    const msg: JsonRpcMessage = { jsonrpc: '2.0', method, params };
    this.sendRaw(msg);
  }

  private sendRaw(msg: JsonRpcMessage) {
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    this.process?.stdin?.write(header + body);
  }

  async initialize() {
    if (this.initialized) return;

    const result = await this.sendRequest('initialize', {
      processId: process.pid,
      clientInfo: { name: 'local-copilot', version: '1.0.0' },
      capabilities: {},
      rootUri: null,
      initializationOptions: {
        editorInfo: { name: 'local-copilot', version: '1.0.0' },
        editorPluginInfo: { name: 'local-copilot', version: '1.0.0' },
      },
    });

    this.sendNotification('initialized', {});
    this.initialized = true;

    try {
      await this.sendRequest('setEditorInfo', {
        editorInfo: { name: 'local-copilot', version: '1.0.0' },
        editorPluginInfo: { name: 'local-copilot', version: '1.0.0' },
      });
    } catch (e) {
      console.warn('[LSP] setEditorInfo failed:', e);
    }

    console.log('[LSP] Initialized:', JSON.stringify(result)?.substring(0, 200));
    return result;
  }

  async signInInitiate(): Promise<{ userCode: string; verificationUri: string; status: string }> {
    const result = await this.sendRequest('signInInitiate', {}) as { userCode: string; verificationUri: string; status: string };
    return result;
  }

  async signInConfirm(): Promise<{ status: string; user?: string }> {
    const result = await this.sendRequest('signInConfirm', {}) as { status: string; user?: string };
    return result;
  }

  async checkStatus(): Promise<{ status: string; user?: string }> {
    const result = await this.sendRequest('checkStatus', {}) as { status: string; user?: string };
    return result;
  }

  async signOut(): Promise<void> {
    await this.sendRequest('signOut', {});
  }

  stop() {
    this.process?.kill();
    this.process = null;
  }
}

export const lspClient = new LspClient();
