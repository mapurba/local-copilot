import * as cp from 'child_process';
import { EventEmitter } from 'events';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

class LspClient extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.buffer = '';
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.initialized = false;
  }

  start() {
    const serverPath = require.resolve('@github/copilot-language-server/dist/language-server.js');

    this.process = cp.spawn(process.execPath, [serverPath, '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (data) => this.handleData(data.toString()));
    this.process.stderr?.on('data', (data) => console.error('[LSP stderr]', data.toString()));
    this.process.on('exit', (code) => console.log('[LSP] exited with code', code));

    console.log('[LSP] Started copilot-language-server');
  }

  handleData(data) {
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
        const msg = JSON.parse(body);
        this.handleMessage(msg);
      } catch (e) {
        console.error('[LSP] Failed to parse message:', e);
      }
    }
  }

  handleMessage(msg) {
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

  sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const msg = { jsonrpc: '2.0', id, method, params };
      this.pendingRequests.set(id, { resolve, reject });
      this.sendRaw(msg);
    });
  }

  sendNotification(method, params) {
    const msg = { jsonrpc: '2.0', method, params };
    this.sendRaw(msg);
  }

  sendRaw(msg) {
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
    });

    this.sendNotification('initialized', {});
    this.initialized = true;
    console.log('[LSP] Initialized:', JSON.stringify(result)?.substring(0, 200));
    return result;
  }

  async signInInitiate() {
    return this.sendRequest('signInInitiate', {});
  }

  async signInConfirm(userCode) {
    return this.sendRequest('signInConfirm', { userCode });
  }

  async checkStatus() {
    return this.sendRequest('checkStatus', { options: {} });
  }

  async signOut() {
    await this.sendRequest('signOut', {});
  }

  stop() {
    this.process?.kill();
    this.process = null;
  }
}

export const lspClient = new LspClient();
