import { contextBridge, ipcRenderer } from 'electron';

export interface CopilotAPI {
  status: () => Promise<{ status: string; user?: string }>;
  signIn: () => Promise<{ userCode: string; verificationUri: string; status: string }>;
  signInConfirm: () => Promise<{ status: string; user?: string }>;
  signOut: () => Promise<{ success: boolean }>;
  getModels: () => Promise<string[]>;
  sendChatMessage: (modelId: string, messages: Array<{ role: string; content: string }>) => Promise<{ started: boolean }>;
  sendChatMessageWithTools: (modelId: string, messages: Array<{ role: string; content: string }>) => Promise<{ started: boolean }>;
  onChatStream: (callback: (event: Electron.IpcRendererEvent, text: string, type?: string) => void) => () => void;
  onChatEnd: (callback: (event: Electron.IpcRendererEvent) => void) => () => void;
  onChatError: (callback: (event: Electron.IpcRendererEvent, message: string) => void) => () => void;
  proxyRequest: (options: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; headers: Record<string, unknown>; body: string }>;
  vcdSignIn: (input: { host?: string; org: string; username: string; password: string; apiVersion?: string; vdcId?: string; orgUuid?: string; networkName?: string; gateway?: string; dnsServers?: string; storageProfileId?: string; computePolicyId?: string; rejectUnauthorized?: boolean }) => Promise<{ connected: boolean; user?: string; org?: string; host?: string }>;
  vcdStatus: () => Promise<{ connected: boolean; user?: string; org?: string; host?: string }>;
  vcdSignOut: () => Promise<{ connected: boolean }>;
}

contextBridge.exposeInMainWorld('copilot', {
  status: () => ipcRenderer.invoke('copilot:status'),
  signIn: () => ipcRenderer.invoke('copilot:signIn'),
  signInConfirm: () => ipcRenderer.invoke('copilot:signInConfirm'),
  signOut: () => ipcRenderer.invoke('copilot:signOut'),
  getModels: () => ipcRenderer.invoke('copilot:getModels'),
  sendChatMessage: (modelId: string, messages: Array<{ role: string; content: string }>) =>
    ipcRenderer.invoke('copilot:sendChatMessage', modelId, messages),
  sendChatMessageWithTools: (modelId: string, messages: Array<{ role: string; content: string }>) =>
    ipcRenderer.invoke('copilot:sendChatMessageWithTools', modelId, messages),
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
  proxyRequest: (options: { url: string; method?: string; headers?: Record<string, string>; body?: string }) =>
    ipcRenderer.invoke('proxy:http', options),
  vcdSignIn: (input: { host?: string; org: string; username: string; password: string; apiVersion?: string; vdcId?: string; orgUuid?: string; networkName?: string; gateway?: string; dnsServers?: string; storageProfileId?: string; computePolicyId?: string; rejectUnauthorized?: boolean }) =>
    ipcRenderer.invoke('vcd:signIn', input),
  vcdStatus: () => ipcRenderer.invoke('vcd:status'),
  vcdSignOut: () => ipcRenderer.invoke('vcd:signOut'),
  listVms: () => ipcRenderer.invoke('vcd:listVms'),
} as CopilotAPI);
