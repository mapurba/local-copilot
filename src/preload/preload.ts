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
  onVmDraft: (callback: (event: Electron.IpcRendererEvent, form: Record<string, unknown>) => void) => () => void;
  deployVm: (form: Record<string, unknown>) => Promise<{ success: boolean; result?: unknown; error?: string }>;
  listVms: () => Promise<{ count?: number; vms?: Array<Record<string, unknown>>; error?: string }>;
  powerOnVm: (vmHref: string) => Promise<{ success: boolean; result?: unknown; error?: string }>;
  powerOffVm: (vmHref: string) => Promise<{ success: boolean; result?: unknown; error?: string }>;
  deleteVm: (input: { href: string; powered_on?: boolean }) => Promise<{ success: boolean; result?: unknown; error?: string }>;
  allocateFreeIp: () => Promise<{ success: boolean; ip?: string; error?: string }>;
  proxyRequest: (options: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; headers: Record<string, unknown>; body: string }>;
  vcdSignIn: (input: { host?: string; org: string; username: string; password: string; apiVersion?: string; vdcId?: string; orgUuid?: string; networkName?: string; gateway?: string; dnsServers?: string; storageProfileId?: string; computePolicyId?: string; rejectUnauthorized?: boolean }) => Promise<{ connected: boolean; user?: string; org?: string; host?: string }>;
  vcdStatus: () => Promise<{ connected: boolean; user?: string; org?: string; host?: string }>;
  vcdSignOut: () => Promise<{ connected: boolean }>;
  terminalCreate: (options: { terminalId: string; cols: number; rows: number; command?: string }) => Promise<{ success: boolean; terminalId?: string; error?: string }>;
  terminalInput: (options: { terminalId: string; data: string }) => Promise<{ success: boolean; error?: string }>;
  terminalResize: (options: { terminalId: string; cols: number; rows: number }) => Promise<{ success: boolean; error?: string }>;
  terminalClose: (options: { terminalId: string }) => Promise<{ success: boolean; error?: string }>;
  onTerminalData: (callback: (event: Electron.IpcRendererEvent, data: { terminalId: string; data: string }) => void) => () => void;
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
  onVmDraft: (callback: (event: Electron.IpcRendererEvent, form: Record<string, unknown>) => void) => {
    ipcRenderer.on('chat:vm-draft', callback);
    return () => ipcRenderer.removeListener('chat:vm-draft', callback);
  },
  deployVm: (form: Record<string, unknown>) => ipcRenderer.invoke('vcd:deployVm', form),
  listVms: () => ipcRenderer.invoke('vcd:listVms'),
  powerOnVm: (vmHref: string) => ipcRenderer.invoke('vcd:powerOnVm', vmHref),
  powerOffVm: (vmHref: string) => ipcRenderer.invoke('vcd:powerOffVm', vmHref),
  deleteVm: (input: { href: string; powered_on?: boolean }) => ipcRenderer.invoke('vcd:deleteVm', input),
  allocateFreeIp: () => ipcRenderer.invoke('vcd:allocateFreeIp'),
  vcdSignIn: (input: { host?: string; org: string; username: string; password: string; apiVersion?: string; vdcId?: string; orgUuid?: string; networkName?: string; gateway?: string; dnsServers?: string; storageProfileId?: string; computePolicyId?: string; rejectUnauthorized?: boolean }) =>
    ipcRenderer.invoke('vcd:signIn', input),
  vcdStatus: () => ipcRenderer.invoke('vcd:status'),
  vcdSignOut: () => ipcRenderer.invoke('vcd:signOut'),
  terminalCreate: (options: { terminalId: string; cols: number; rows: number; command?: string }) =>
    ipcRenderer.invoke('terminal:create', options),
  terminalInput: (options: { terminalId: string; data: string }) =>
    ipcRenderer.invoke('terminal:input', options),
  terminalResize: (options: { terminalId: string; cols: number; rows: number }) =>
    ipcRenderer.invoke('terminal:resize', options),
  terminalClose: (options: { terminalId: string }) =>
    ipcRenderer.invoke('terminal:close', options),
  onTerminalData: (callback: (event: Electron.IpcRendererEvent, data: { terminalId: string; data: string }) => void) => {
    ipcRenderer.on('terminal:data', callback);
    return () => ipcRenderer.removeListener('terminal:data', callback);
  },
} as CopilotAPI);
