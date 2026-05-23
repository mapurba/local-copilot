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
  onVmCopyDraft: (callback: (event: Electron.IpcRendererEvent, form: Record<string, unknown>) => void) => () => void;
  deployVm: (form: Record<string, unknown>) => Promise<{ success: boolean; result?: unknown; error?: string }>;
  listVms: () => Promise<{ count?: number; vms?: Array<Record<string, unknown>>; error?: string }>;
  listVapps: () => Promise<{ count?: number; vapps?: Array<Record<string, unknown>>; error?: string }>;
  powerOnVm: (vmHref: string) => Promise<{ success: boolean; result?: unknown; error?: string }>;
  powerOffVm: (vmHref: string) => Promise<{ success: boolean; result?: unknown; error?: string }>;
  deleteVm: (input: { href: string; powered_on?: boolean }) => Promise<{ success: boolean; result?: unknown; error?: string }>;
  allocateFreeIp: () => Promise<{ success: boolean; ip?: string; error?: string }>;
  createSnapshot: (input: { vmNameOrHref: string; name?: string; description?: string; memory?: boolean; quiesce?: boolean }) => Promise<{ success: boolean; result?: unknown; error?: string }>;
  revertSnapshot: (input: { vmNameOrHref: string }) => Promise<{ success: boolean; result?: unknown; error?: string }>;
  createVmCopy: (input: { vmNameOrHref: string; newVmName: string; targetVappHref: string; powerOn?: boolean; description?: string }) => Promise<{ success: boolean; result?: unknown; error?: string }>;
  listSnapshots: () => Promise<{ success: boolean; count?: number; snapshots?: Array<Record<string, unknown>>; error?: string }>;
  proxyRequest: (options: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; headers: Record<string, unknown>; body: string }>;
  vcdSignIn: (input: { host?: string; org: string; username: string; password: string; apiVersion?: string; vdcId?: string; orgUuid?: string; networkName?: string; gateway?: string; dnsServers?: string; storageProfileId?: string; computePolicyId?: string; rejectUnauthorized?: boolean }) => Promise<{ connected: boolean; user?: string; org?: string; host?: string }>;
  vcdStatus: () => Promise<{ connected: boolean; user?: string; org?: string; host?: string }>;
  vcdSignOut: () => Promise<{ connected: boolean }>;
  terminalCreate: (options: { terminalId: string; cols: number; rows: number; command?: string }) => Promise<{ success: boolean; terminalId?: string; error?: string }>;
  terminalInput: (options: { terminalId: string; data: string }) => Promise<{ success: boolean; error?: string }>;
  terminalResize: (options: { terminalId: string; cols: number; rows: number }) => Promise<{ success: boolean; error?: string }>;
  terminalClose: (options: { terminalId: string }) => Promise<{ success: boolean; error?: string }>;
  terminalQueryCwd: (options: { terminalId: string }) => Promise<{ success: boolean; cwd?: string; error?: string }>;
  terminalQuerySshContext: (options: { terminalId: string }) => Promise<{ success: boolean; connected?: boolean; username?: string; host?: string; port?: number; error?: string }>;
  onTerminalData: (callback: (event: Electron.IpcRendererEvent, data: { terminalId: string; data: string }) => void) => () => void;
  listSavedTerminalSessions: () => Promise<{ success: boolean; sessions: Array<{ id: string; label: string; command: string; host?: string; username?: string; port?: number; password?: string; vmName?: string; ip?: string; source?: string; createdAt: number; lastUsedAt?: number }>; error?: string }>;
  saveTerminalSession: (input: { id?: string; label: string; command: string; host?: string; username?: string; port?: number; password?: string; vmName?: string; ip?: string; source?: 'vm' | 'manual' }) => Promise<{ success: boolean; session?: { id: string }; error?: string }>;
  deleteTerminalSession: (input: { id: string }) => Promise<{ success: boolean; error?: string }>;
  fileConnect: (options: { terminalId: string; command: string; password?: string }) => Promise<{ connected: boolean; currentDirectory?: string; error?: string; authRequired?: boolean }>;
  fileDisconnect: (options: { terminalId: string }) => Promise<{ success: boolean; error?: string }>;
  fileGetDirectory: (options: { terminalId: string }) => Promise<{ success: boolean; currentDirectory?: string; error?: string }>;
  fileSetDirectory: (options: { terminalId: string; directory: string }) => Promise<{ success: boolean; currentDirectory?: string; error?: string }>;
  fileList: (options: { terminalId: string; path?: string }) => Promise<{ success: boolean; path?: string; entries?: Array<{ name: string; path: string; isDirectory: boolean; size: number; modifiedAt?: number }>; error?: string }>;
  fileRead: (options: { terminalId: string; path: string }) => Promise<{ success: boolean; path?: string; content?: string; error?: string }>;
  fileWrite: (options: { terminalId: string; path: string; content: string }) => Promise<{ success: boolean; path?: string; error?: string }>;
  fileDelete: (options: { terminalId: string; path: string }) => Promise<{ success: boolean; path?: string; error?: string }>;
  fileRename: (options: { terminalId: string; oldPath: string; newPath: string }) => Promise<{ success: boolean; oldPath?: string; newPath?: string; error?: string }>;
  fileMkdir: (options: { terminalId: string; path: string }) => Promise<{ success: boolean; path?: string; error?: string }>;
  checkForUpdate: () => void;
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
  onVmCopyDraft: (callback: (event: Electron.IpcRendererEvent, form: Record<string, unknown>) => void) => {
    ipcRenderer.on('chat:vm-copy-draft', callback);
    return () => ipcRenderer.removeListener('chat:vm-copy-draft', callback);
  },
  deployVm: (form: Record<string, unknown>) => ipcRenderer.invoke('vcd:deployVm', form),
  listVms: () => ipcRenderer.invoke('vcd:listVms'),
  listVapps: () => ipcRenderer.invoke('vcd:listVapps'),
  powerOnVm: (vmHref: string) => ipcRenderer.invoke('vcd:powerOnVm', vmHref),
  powerOffVm: (vmHref: string) => ipcRenderer.invoke('vcd:powerOffVm', vmHref),
  deleteVm: (input: { href: string; powered_on?: boolean }) => ipcRenderer.invoke('vcd:deleteVm', input),
  allocateFreeIp: () => ipcRenderer.invoke('vcd:allocateFreeIp'),
  createSnapshot: (input: { vmNameOrHref: string; name?: string; description?: string; memory?: boolean; quiesce?: boolean }) => ipcRenderer.invoke('vcd:createSnapshot', input),
  revertSnapshot: (input: { vmNameOrHref: string }) => ipcRenderer.invoke('vcd:revertSnapshot', input),
  createVmCopy: (input: { vmNameOrHref: string; newVmName: string; targetVappHref: string; powerOn?: boolean; description?: string }) => ipcRenderer.invoke('vcd:createVmCopy', input),
  listSnapshots: () => ipcRenderer.invoke('vcd:listSnapshots'),
  vcdSignIn: (input: { host?: string; org: string; username: string; password: string; apiVersion?: string; vdcId?: string; orgUuid?: string; networkName?: string; gateway?: string; dnsServers?: string; storageProfileId?: string; computePolicyId?: string; rejectUnauthorized?: boolean }) =>
    ipcRenderer.invoke('vcd:signIn', input),
  vcdStatus: () => ipcRenderer.invoke('vcd:status'),
  vcdSignOut: () => ipcRenderer.invoke('vcd:signOut'),
  // DISABLED: Terminal methods removed to prevent antivirus quarantine
  // terminalCreate: (options: { terminalId: string; cols: number; rows: number; command?: string }) =>
  //   ipcRenderer.invoke('terminal:create', options),
  // terminalInput: (options: { terminalId: string; data: string }) =>
  //   ipcRenderer.invoke('terminal:input', options),
  // terminalResize: (options: { terminalId: string; cols: number; rows: number }) =>
  //   ipcRenderer.invoke('terminal:resize', options),
  // terminalClose: (options: { terminalId: string }) =>
  //   ipcRenderer.invoke('terminal:close', options),
  // terminalQueryCwd: (options: { terminalId: string }) =>
  //   ipcRenderer.invoke('terminal:queryCwd', options),
  // terminalQuerySshContext: (options: { terminalId: string }) =>
  //   ipcRenderer.invoke('terminal:querySshContext', options),
  // listSavedTerminalSessions: () =>
  //   ipcRenderer.invoke('terminal:sessions:list'),
  // saveTerminalSession: (input: { id?: string; label: string; command: string; host?: string; username?: string; port?: number; password?: string; vmName?: string; ip?: string; source?: 'vm' | 'manual' }) =>
  //   ipcRenderer.invoke('terminal:sessions:save', input),
  // deleteTerminalSession: (input: { id: string }) =>
  //   ipcRenderer.invoke('terminal:sessions:delete', input),
  // onTerminalData: (callback: (event: Electron.IpcRendererEvent, data: { terminalId: string; data: string }) => void) => {
  //   ipcRenderer.on('terminal:data', callback);
  //   return () => ipcRenderer.removeListener('terminal:data', callback);
  // },
  // DISABLED: File/SFTP methods removed to disable SSH2 functionality
  // fileConnect: (options: { terminalId: string; command: string; password?: string }) =>
  //   ipcRenderer.invoke('file:connect', options),
  // fileDisconnect: (options: { terminalId: string }) =>
  //   ipcRenderer.invoke('file:disconnect', options),
  // fileGetDirectory: (options: { terminalId: string }) =>
  //   ipcRenderer.invoke('file:getDirectory', options),
  // fileSetDirectory: (options: { terminalId: string; directory: string }) =>
  //   ipcRenderer.invoke('file:setDirectory', options),
  // fileList: (options: { terminalId: string; path?: string }) =>
  //   ipcRenderer.invoke('file:list', options),
  // fileRead: (options: { terminalId: string; path: string }) =>
  //   ipcRenderer.invoke('file:read', options),
  // fileWrite: (options: { terminalId: string; path: string; content: string }) =>
  //   ipcRenderer.invoke('file:write', options),
  // fileDelete: (options: { terminalId: string; path: string }) =>
  //   ipcRenderer.invoke('file:delete', options),
  // fileRename: (options: { terminalId: string; oldPath: string; newPath: string }) =>
  //   ipcRenderer.invoke('file:rename', options),
  // fileMkdir: (options: { terminalId: string; path: string }) =>
  //   ipcRenderer.invoke('file:mkdir', options),
  checkForUpdate: () => ipcRenderer.send('check-for-update'),
  // Deployment plan methods
  saveDeploymentPlan: (plan: Record<string, unknown>) => ipcRenderer.invoke('deployment:savePlan', plan),
  loadDeploymentPlan: (planId: string) => ipcRenderer.invoke('deployment:loadPlan', planId),
  listDeploymentPlans: () => ipcRenderer.invoke('deployment:listPlans'),
  deleteDeploymentPlan: (planId: string) => ipcRenderer.invoke('deployment:deletePlan', planId),
  updateDeploymentServiceStatus: (input: Record<string, unknown>) => ipcRenderer.invoke('deployment:updateServiceStatus', input),
  fetchFreeIps: (count?: number) => ipcRenderer.invoke('deployment:fetchFreeIps', count),
  emitDeploymentPlan: (plan: Record<string, unknown>) => ipcRenderer.invoke('deployment:emitPlan', plan),
  onDeploymentPlanReady: (callback: (event: Electron.IpcRendererEvent, plan: Record<string, unknown>) => void) => {
    ipcRenderer.on('deployment:planReady', callback);
    return () => ipcRenderer.removeListener('deployment:planReady', callback);
  },
  onDeploymentPlanUpdated: (callback: (event: Electron.IpcRendererEvent, plan: Record<string, unknown>) => void) => {
    ipcRenderer.on('deployment:planUpdated', callback);
    return () => ipcRenderer.removeListener('deployment:planUpdated', callback);
  },
} as unknown as CopilotAPI);
