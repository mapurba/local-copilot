import { contextBridge, ipcRenderer } from 'electron';

export interface CopilotAPI {
  // Authentication methods
  status: () => Promise<{ status: string; user?: string }>;
  signIn: () => Promise<{ userCode: string; verificationUri: string; status: string }>;
  signInConfirm: () => Promise<{ status: string; user?: string }>;
  signOut: () => Promise<{ success: boolean }>;

  // Chat methods
  getModels: () => Promise<string[]>;
  sendChatMessage: (modelId: string, messages: Array<{ role: string; content: string }>) => Promise<{ started: boolean }>;
  onChatStream: (callback: (event: Electron.IpcRendererEvent, text: string, type?: string) => void) => () => void;
  onChatEnd: (callback: (event: Electron.IpcRendererEvent) => void) => () => void;
  onChatError: (callback: (event: Electron.IpcRendererEvent, message: string) => void) => () => void;
  onToolCalled: (callback: (event: Electron.IpcRendererEvent, data: { toolName: string; args?: any[]; result: any }) => void) => () => void;
  onToolError: (callback: (event: Electron.IpcRendererEvent, data: { toolName: string; error: string }) => void) => () => void;

  // Tools
  toolsList: () => Promise<Array<{ name: string; category: string; description: string }>>;
  callTool: (toolName: string, ...args: any[]) => Promise<any>;

  // Workspace
  workspaceGetPath: () => Promise<string>;
  workspaceSetPath: (path: string) => Promise<{ success: boolean; path?: string; error?: string }>;

  // Utility methods
  proxyRequest: (options: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; headers: Record<string, unknown>; body: string }>;
  checkForUpdate: () => void;
}

contextBridge.exposeInMainWorld('copilot', {
  // Authentication
  status: () => ipcRenderer.invoke('copilot:status'),
  signIn: () => ipcRenderer.invoke('copilot:signIn'),
  signInConfirm: () => ipcRenderer.invoke('copilot:signInConfirm'),
  signOut: () => ipcRenderer.invoke('copilot:signOut'),

  // Chat
  getModels: () => ipcRenderer.invoke('copilot:getModels'),
  sendChatMessage: (modelId: string, messages: Array<{ role: string; content: string }>) =>
    ipcRenderer.invoke('copilot:sendChatMessage', modelId, messages),
  onChatStream: (callback: (event: Electron.IpcRendererEvent, text: string, type?: string) => void) => {
    ipcRenderer.on('chat:stream-chunk', callback);
    return () => ipcRenderer.removeListener('chat:stream-chunk', callback);
  },
  onChatEnd: (callback: (event: Electron.IpcRendererEvent) => void) => {
    ipcRenderer.on('chat:stream-end', callback);
    return () => ipcRenderer.removeListener('chat:stream-end', callback);
  },
  onChatError: (callback: (event: Electron.IpcRendererEvent, message: string) => void) => {
    ipcRenderer.on('chat:stream-error', callback);
    return () => ipcRenderer.removeListener('chat:stream-error', callback);
  },

  onToolCalled: (callback: (event: Electron.IpcRendererEvent, data: { toolName: string; args?: any[]; result: any }) => void) => {
    ipcRenderer.on('chat:tool-called', callback);
    return () => ipcRenderer.removeListener('chat:tool-called', callback);
  },

  onToolError: (callback: (event: Electron.IpcRendererEvent, data: { toolName: string; error: string }) => void) => {
    ipcRenderer.on('chat:tool-error', callback);
    return () => ipcRenderer.removeListener('chat:tool-error', callback);
  },

  // Tools
  toolsList: () => ipcRenderer.invoke('tools:list'),
  callTool: (toolName: string, ...args: any[]) => ipcRenderer.invoke('tools:call', toolName, ...args),

  // Workspace
  workspaceGetPath: () => ipcRenderer.invoke('workspace:getPath'),
  workspaceSetPath: (path: string) => ipcRenderer.invoke('workspace:setPath', path),

  // Utilities
  proxyRequest: (options: { url: string; method?: string; headers?: Record<string, string>; body?: string }) =>
    ipcRenderer.invoke('proxy:http', options),
  checkForUpdate: () => ipcRenderer.send('check-for-update'),
} as unknown as CopilotAPI);
