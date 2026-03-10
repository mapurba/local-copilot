import { contextBridge, ipcRenderer } from 'electron';

export interface CopilotAPI {
  status: () => Promise<{ status: string; user?: string }>;
  signIn: () => Promise<{ userCode: string; verificationUri: string; status: string }>;
  signInConfirm: () => Promise<{ status: string; user?: string }>;
  signOut: () => Promise<{ success: boolean }>;
  getModels: () => Promise<string[]>;
  sendChatMessage: (modelId: string, messages: Array<{ role: string; content: string }>) => Promise<{ started: boolean }>;
  onChatStream: (callback: (event: Electron.IpcRendererEvent, text: string, type?: string) => void) => () => void;
  onChatEnd: (callback: (event: Electron.IpcRendererEvent) => void) => () => void;
  onChatError: (callback: (event: Electron.IpcRendererEvent, message: string) => void) => () => void;
  proxyRequest: (options: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; headers: Record<string, unknown>; body: string }>;
  chooseWorkflowOutputDir: () => Promise<{ cancelled: boolean; path?: string }>;
  getWorkflowOutputDir: () => Promise<{ path?: string }>;
  openWorkflowOutputDir: (outputDir: string) => Promise<{ success: boolean; error?: string }>;
  listWorkflowTree: () => Promise<{ success: boolean; root?: string; tree?: any[]; error?: string }>;
  readWorkflowFile: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
  saveWorkflowFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>;
  generateWorkflow: (input: { modelId: string; request: string; outputDir?: string }) => Promise<{
    success: boolean;
    outputDir?: string;
    critique?: string;
    workflowXml?: string;
    formsJson?: string;
    plan?: {
      forms: Array<{ id: string; components: any[] }>;
      activities: Array<{ id: string; type: string; attributes: Record<string, unknown> }>;
      flows: Array<{ source: string; target: string }>;
    };
    files?: { workflowPath: string; formsPath: string };
    error?: string;
  }>;
  // Terminal/session/file APIs removed from the public preload surface.
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
  chooseWorkflowOutputDir: () => ipcRenderer.invoke('workflow:chooseOutputDir'),
  getWorkflowOutputDir: () => ipcRenderer.invoke('workflow:getOutputDir'),
  openWorkflowOutputDir: (outputDir: string) => ipcRenderer.invoke('workflow:openOutputDir', outputDir),
  listWorkflowTree: () => ipcRenderer.invoke('workflow:listTree'),
  readWorkflowFile: (filePath: string) => ipcRenderer.invoke('workflow:readFile', filePath),
  saveWorkflowFile: (filePath: string, content: string) => ipcRenderer.invoke('workflow:saveFile', filePath, content),
  generateWorkflow: (input: { modelId: string; request: string; outputDir?: string }) =>
    ipcRenderer.invoke('workflow:generate', input),
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
} as unknown as CopilotAPI);
