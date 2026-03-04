import { BrowserWindow, ipcMain } from 'electron';
import { lspClient } from './lspClient';
import { tokenManager } from './tokenManager';
import { getModels, streamChatCompletion, chatWithTools, ChatMessage } from './copilotChatApi';
import http from 'http';
import https from 'https';
import { vcdSignIn, vcdStatus, vcdSignOut } from './vcdAuth';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export function registerIpcHandlers(mainWindow: BrowserWindow) {
    // VCD: List VMs (direct, not via LLM)
    const { listVms } = require('./vcdApi');
    ipcMain.handle('vcd:listVms', async () => {
      try {
        const result = await listVms(200);
        return result;
      } catch (err) {
        return { vms: [], error: err instanceof Error ? err.message : String(err) };
      }
    });
  // Initialize LSP on startup
  lspClient.start();
  lspClient.initialize().catch((e) => console.error('[IPC] LSP init error:', e));

  // Auth: Check status
  ipcMain.handle('copilot:status', async () => {
    try {
      await withTimeout(lspClient.initialize(), 10000, 'lspInitialize');
      const result = await lspClient.checkStatus();
      return result;
    } catch (_e) {
      console.error('[IPC] status failed:', _e);
      return { status: 'NotAuthorized' };
    }
  });

  // Auth: Start sign-in flow
  ipcMain.handle('copilot:signIn', async () => {
    try {
      await withTimeout(lspClient.initialize(), 10000, 'lspInitialize');
      const result = await withTimeout(lspClient.signInInitiate(), 15000, 'signInInitiate');
      return result;
    } catch (_e) {
      console.error('[IPC] signInInitiate failed:', _e);
      throw new Error('Failed to initiate sign-in');
    }
  });

  // Auth: Confirm sign-in (user entered code in browser)
  ipcMain.handle('copilot:signInConfirm', async () => {
    try {
      await withTimeout(lspClient.initialize(), 10000, 'lspInitialize');
      const result = await withTimeout(lspClient.signInConfirm(), 30000, 'signInConfirm');
      console.log('[IPC] signInConfirm result:', JSON.stringify(result));
      
      // After successful sign-in, refresh token with extended wait
      if (result.status === 'OK' || result.status === 'AlreadySignedIn') {
        // Wait longer for LSP to process and send token notifications
        console.log('[IPC] Waiting for token notifications...');
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // Try to refresh token via checkStatus
        try {
          const refreshResult = await tokenManager.refreshToken();
          console.log('[IPC] Token refresh result:', refreshResult ? 'Success' : 'Failed');
        } catch (e) {
          console.warn('[IPC] Token refresh after sign-in failed:', e);
        }
      }
      
      return result;
    } catch (_e) {
      console.error('[IPC] signInConfirm failed:', _e);
      throw new Error('Failed to confirm sign-in');
    }
  });

  // Auth: Sign out
  ipcMain.handle('copilot:signOut', async () => {
    try {
      await lspClient.signOut();
      tokenManager.clear();
      return { success: true };
    } catch (_e) {
      return { success: false };
    }
  });

  // Chat: Get available models
  ipcMain.handle('copilot:getModels', async () => {
    return getModels();
  });

  // Chat: Send message and stream response
  ipcMain.handle('copilot:sendChatMessage', async (_event, modelId: string, messages: ChatMessage[]) => {
    streamChatCompletion(
      modelId,
      messages,
      (chunk) => {
        mainWindow.webContents.send('chat:stream-chunk', chunk);
      },
      () => {
        mainWindow.webContents.send('chat:stream-end');
      },
      (err) => {
        mainWindow.webContents.send('chat:stream-error', err.message);
      }
    );
    return { started: true };
  });

  // Chat: Send message with tool calling support
  ipcMain.handle('copilot:sendChatMessageWithTools', async (_event, modelId: string, messages: ChatMessage[]) => {
    try {
      await chatWithTools(
        modelId,
        messages,
        (chunk, type) => {
          mainWindow.webContents.send('chat:stream-chunk', chunk, type);
        },
        () => {
          mainWindow.webContents.send('chat:stream-end');
        },
        (err) => {
          mainWindow.webContents.send('chat:stream-error', err.message);
        }
      );
      return { started: true };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      mainWindow.webContents.send('chat:stream-error', errorMsg);
      return { started: false, error: errorMsg };
    }
  });

  ipcMain.handle('vcd:signIn', async (_event, input) => {
    return vcdSignIn(input);
  });

  ipcMain.handle('vcd:status', async () => {
    return vcdStatus();
  });

  ipcMain.handle('vcd:signOut', async () => {
    return vcdSignOut();
  });

  ipcMain.handle('proxy:http', async (_event, options: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => {
    const { url, method = 'GET', headers = {}, body } = options || {};
    if (!url) {
      throw new Error('proxy:http requires a url');
    }

    const client = url.startsWith('https:') ? https : http;

    return new Promise((resolve, reject) => {
      const req = client.request(url, { method, headers }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: data,
          });
        });
      });

      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  });
}
