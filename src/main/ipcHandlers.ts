import { BrowserWindow, ipcMain } from 'electron';
import { lspClient } from './lspClient';
import { tokenManager } from './tokenManager';
import { getModels, streamChatCompletion, ChatMessage } from './copilotChatApi';

export function registerIpcHandlers(mainWindow: BrowserWindow) {
  // Initialize LSP on startup
  lspClient.start();
  lspClient.initialize().catch((e) => console.error('[IPC] LSP init error:', e));

  // Auth: Check status
  ipcMain.handle('copilot:status', async () => {
    try {
      const result = await lspClient.checkStatus();
      return result;
    } catch (_e) {
      return { status: 'NotAuthorized' };
    }
  });

  // Auth: Start sign-in flow
  ipcMain.handle('copilot:signIn', async () => {
    try {
      const result = await lspClient.signInInitiate();
      return result;
    } catch (_e) {
      throw new Error('Failed to initiate sign-in');
    }
  });

  // Auth: Confirm sign-in (user entered code in browser)
  ipcMain.handle('copilot:signInConfirm', async (_event, userCode: string) => {
    try {
      const result = await lspClient.signInConfirm(userCode);
      return result;
    } catch (_e) {
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
}
