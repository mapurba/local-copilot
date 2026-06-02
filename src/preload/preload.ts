import { contextBridge, ipcRenderer } from 'electron';

export interface CopilotAPI {
  status: () => Promise<{ status: string; user?: string }>;
  signIn: () => Promise<{ userCode: string; verificationUri: string; status: string }>;
  signInConfirm: () => Promise<{ status: string; user?: string }>;
  signOut: () => Promise<{ success: boolean }>;
  getModels: () => Promise<string[]>;
  sendChatMessage: (modelId: string, messages: Array<{ role: string; content: string }>) => Promise<{ started: boolean }>;
  sendChatMessageWithTools: (modelId: string, messages: Array<{ role: string; content: string }>, disabledToolNames?: string[]) => Promise<{ started: boolean }>;
  cancelChat: () => Promise<{ cancelled: boolean }>;
  listTools: () => Promise<Array<{ name: string; category: string; description: string }>>
  onChatStream: (callback: (event: Electron.IpcRendererEvent, text: string, type?: string) => void) => () => void;
  onChatEnd: (callback: (event: Electron.IpcRendererEvent) => void) => () => void;
  onChatError: (callback: (event: Electron.IpcRendererEvent, message: string) => void) => () => void;
  onVmDraft: (callback: (event: Electron.IpcRendererEvent, form: Record<string, unknown>) => void) => () => void;
  onVmCopyDraft: (callback: (event: Electron.IpcRendererEvent, form: Record<string, unknown>) => void) => () => void;
  onWatchNotification: (callback: (event: Electron.IpcRendererEvent, data: { message: string }) => void) => () => void;
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
  listTemplates: (nameFilter?: string) => Promise<{ success: boolean; count?: number; total?: number; templates?: Array<Record<string, unknown>>; error?: string }>;
  getTemplate: (templateId: string) => Promise<{ success: boolean; xml?: string; error?: string }>;
  updateTemplate: (input: { templateId: string; xml: string }) => Promise<{ success: boolean; result?: unknown; error?: string }>;
  getVcdContext: () => Promise<{ success: boolean; context?: Record<string, unknown>; error?: string }>;
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
  onDeploymentPlanReady: (callback: (event: Electron.IpcRendererEvent, plan: Record<string, unknown>) => void) => () => void;
  dryRunRunbookScript: (input: { script: string; serviceName?: string; osHint?: string }) => Promise<{
    success: boolean;
    summary?: string;
    hasCriticalErrors?: boolean;
    issues?: Array<{ severity?: string; title?: string; detail?: string; lineHint?: string }>;
    changed?: boolean;
    healedScript?: string;
    error?: string;
  }>;

  // ── HITL Deployment Graph ──────────────────────────────────────────────────
  startDeploymentGraph: (threadId: string, input: {
    userPrompt: string;
    docId: string;
    rawContent?: string;
    chatContext?: string;
    modeName?: string;
  }) => Promise<{ success: boolean; done?: boolean; phase?: string; error?: string }>;
  resumeDeploymentGraph: (threadId: string, userUpdate: {
    osPreference?: string;
    vmTemplate?: string;
    modeName?: string;
    architectureApproved?: boolean;
    networkDetails?: { usePoolIps: boolean; staticIps?: Record<string, string>; hostname?: string; subnet?: string; gateway?: string };
    credentialVarsAcknowledged?: boolean;
    finalApproved?: boolean;
  }) => Promise<{ success: boolean; done?: boolean; phase?: string; error?: string }>;
  clearDeploymentGraph: (threadId: string) => Promise<{ success: boolean; error?: string }>;
  onDeploymentCheckpoint: (callback: (event: Electron.IpcRendererEvent, payload: {
    threadId: string;
    phase: string;
    question: string;
    data?: Record<string, unknown>;
  }) => void) => () => void;
  onDeploymentGraphComplete: (callback: (event: Electron.IpcRendererEvent, payload: {
    threadId: string;
    designId?: string;
    warnings?: string[];
  }) => void) => () => void;
  saveDeploymentDraft: (plan: Record<string, unknown>) => Promise<{ success: boolean; id?: string; savedAt?: string; error?: string }>;
  loadDeploymentDraft: (id: string) => Promise<{ success: boolean; plan?: Record<string, unknown>; error?: string }>;
  listDeploymentDrafts: () => Promise<{ success: boolean; drafts: Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string }>; error?: string }>;
  deleteDeploymentDraft: (id: string) => Promise<{ success: boolean; error?: string }>;
  openExternal: (url: string) => Promise<void>;
}

contextBridge.exposeInMainWorld('copilot', {
  status: () => ipcRenderer.invoke('copilot:status'),
  signIn: () => ipcRenderer.invoke('copilot:signIn'),
  signInConfirm: () => ipcRenderer.invoke('copilot:signInConfirm'),
  signOut: () => ipcRenderer.invoke('copilot:signOut'),
  getModels: () => ipcRenderer.invoke('copilot:getModels'),
  sendChatMessage: (modelId: string, messages: Array<{ role: string; content: string }>) =>
    ipcRenderer.invoke('copilot:sendChatMessage', modelId, messages),
  sendChatMessageWithTools: (modelId: string, messages: Array<{ role: string; content: string }>, disabledToolNames?: string[]) =>
    ipcRenderer.invoke('copilot:sendChatMessageWithTools', modelId, messages, disabledToolNames),
  cancelChat: () => ipcRenderer.invoke('copilot:cancelChat'),
  listTools: () => ipcRenderer.invoke('tools:list'),
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
  onWatchNotification: (callback: (event: Electron.IpcRendererEvent, data: { message: string }) => void) => {
    ipcRenderer.on('chat:watch-notification', callback);
    return () => ipcRenderer.removeListener('chat:watch-notification', callback);
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
  listTemplates: (nameFilter?: string) => ipcRenderer.invoke('vcd:listTemplates', nameFilter),
  getTemplate: (templateId: string) => ipcRenderer.invoke('vcd:getTemplate', templateId),
  updateTemplate: (input: { templateId: string; xml: string }) => ipcRenderer.invoke('vcd:updateTemplate', input),
  getVcdContext: () => ipcRenderer.invoke('vcd:getContext'),
  vcdSignIn: (input: { host?: string; org: string; username: string; password: string; apiVersion?: string; vdcId?: string; orgUuid?: string; networkName?: string; gateway?: string; dnsServers?: string; storageProfileId?: string; computePolicyId?: string; rejectUnauthorized?: boolean }) =>
    ipcRenderer.invoke('vcd:signIn', input),
  vcdStatus: () => ipcRenderer.invoke('vcd:status'),
  vcdSignOut: () => ipcRenderer.invoke('vcd:signOut'),
  onVcdSessionExpired: (callback: () => void) => {
    ipcRenderer.on('vcd:session-expired', callback);
    return () => ipcRenderer.removeListener('vcd:session-expired', callback);
  },

  // ── Tool Approval ────────────────────────────────────────────────────────
  sendToolApprovalResponse: (response: {
    requestId: string;
    approved: boolean;
    approvalType?: 'once' | 'session' | 'always';
    denialReason?: string;
  }) => ipcRenderer.invoke('tool:approval-response', response),
  
  getToolApprovalStatus: () => ipcRenderer.invoke('tool:approval-status'),
  
  onToolApprovalRequest: (callback: (event: Electron.IpcRendererEvent, request: {
    requestId: string;
    toolName: string;
    category: string;
    riskLevel: string;
    description: string;
    args: unknown;
    target: string;
    impactAssessment?: string;
    timestamp: number;
  }) => void) => {
    ipcRenderer.on('tool:approval-request', callback);
    return () => ipcRenderer.removeListener('tool:approval-request', callback);
  },

  // ── Document Management ───────────────────────────────────────────────────
  docsOpenAndUpload: () => ipcRenderer.invoke('docs:openAndUpload'),
  docsList: () => ipcRenderer.invoke('docs:list'),
  docsGet: (docId: string) => ipcRenderer.invoke('docs:get', docId),
  docsGetContent: (docId: string) => ipcRenderer.invoke('docs:getContent', docId),
  docsDelete: (docId: string) => ipcRenderer.invoke('docs:delete', docId),
  docsImportFromUrl: (url: string) => ipcRenderer.invoke('docs:importFromUrl', url),
  docsMergeDocs: (docIds: string[]) => ipcRenderer.invoke('docs:mergeDocs', docIds),
  docsFetchUrlMarkdown: (url: string) => ipcRenderer.invoke('docs:fetchUrlMarkdown', url),
  docsSaveMarkdown: (title: string, markdown: string) => ipcRenderer.invoke('docs:saveMarkdown', title, markdown),
  docsAnalyze: (docId: string) => ipcRenderer.invoke('docs:analyze', docId),
  onDocsAnalyzeLog: (callback: (event: Electron.IpcRendererEvent, payload: {
    docId: string;
    message: string;
    level: 'info' | 'warn' | 'error';
    done: boolean;
  }) => void) => {
    ipcRenderer.on('docs:analyze-log', callback);
    return () => ipcRenderer.removeListener('docs:analyze-log', callback);
  },

  // Chat history (conversations)
  chatHistoryNew: (name?: string) => ipcRenderer.invoke('chat:createConversation', name),
  chatHistoryList: () => ipcRenderer.invoke('chat:listConversations'),
  chatHistoryGet: (id: string) => ipcRenderer.invoke('chat:getConversation', id),
  chatHistoryAppend: (id: string, message: { role: string; content: string; ts: string; type?: string }) => ipcRenderer.invoke('chat:appendMessage', id, message),
  chatHistoryClear: (id: string) => ipcRenderer.invoke('chat:clearConversation', id),
  chatHistoryDelete: (id: string) => ipcRenderer.invoke('chat:deleteConversation', id),

  // ── Task Tracker ──────────────────────────────────────────────────────────
  taskList: () => ipcRenderer.invoke('task:list'),
  taskGet: (taskId: string) => ipcRenderer.invoke('task:get', taskId),
  taskCancel: (taskId: string) => ipcRenderer.invoke('task:cancel', taskId),
  onTaskUpdated: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('task:updated', handler);
    return () => ipcRenderer.removeListener('task:updated', handler);
  },

  onDeploymentPlanReady: (callback: (event: Electron.IpcRendererEvent, plan: Record<string, unknown>) => void) => {
    ipcRenderer.on('deployment:planReady', callback);
    return () => ipcRenderer.removeListener('deployment:planReady', callback);
  },

  dryRunRunbookScript: (input: { script: string; serviceName?: string; osHint?: string }) =>
    ipcRenderer.invoke('deployment:dryRunRunbookScript', input),

  saveDeploymentDraft: (plan: Record<string, unknown>) => ipcRenderer.invoke('deploymentDraft:save', plan),
  loadDeploymentDraft: (id: string) => ipcRenderer.invoke('deploymentDraft:load', id),
  listDeploymentDrafts: () => ipcRenderer.invoke('deploymentDraft:list'),
  deleteDeploymentDraft: (id: string) => ipcRenderer.invoke('deploymentDraft:delete', id),

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
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // ── HITL Deployment Graph ──────────────────────────────────────────────────
  startDeploymentGraph: (threadId: string, input: Record<string, unknown>) =>
    ipcRenderer.invoke('deployment:graph:start', threadId, input),
  resumeDeploymentGraph: (threadId: string, userUpdate: Record<string, unknown>) =>
    ipcRenderer.invoke('deployment:graph:resume', threadId, userUpdate),
  clearDeploymentGraph: (threadId: string) =>
    ipcRenderer.invoke('deployment:graph:clear', threadId),
  onDeploymentCheckpoint: (callback: (event: Electron.IpcRendererEvent, payload: Record<string, unknown>) => void) => {
    ipcRenderer.on('deployment:checkpoint', callback);
    return () => ipcRenderer.removeListener('deployment:checkpoint', callback);
  },
  onDeploymentGraphComplete: (callback: (event: Electron.IpcRendererEvent, payload: Record<string, unknown>) => void) => {
    ipcRenderer.on('deployment:graph:complete', callback);
    return () => ipcRenderer.removeListener('deployment:graph:complete', callback);
  },
} as unknown as CopilotAPI);
