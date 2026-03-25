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
  onToolCalled: (callback: (event: Electron.IpcRendererEvent, data: { toolName: string; result: any }) => void) => () => void;
  onToolError: (callback: (event: Electron.IpcRendererEvent, data: { toolName: string; error: string }) => void) => () => void;

  // Tools
  toolsList: () => Promise<Array<{ name: string; category: string; description: string }>>;
  callTool: (toolName: string, ...args: any[]) => Promise<any>;

  // Utility methods
  proxyRequest: (options: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; headers: Record<string, unknown>; body: string }>;
  checkForUpdate: () => void;

  // Math tools
  mathAdd: (a: number, b: number) => Promise<{ result: number }>;
  mathSubtract: (a: number, b: number) => Promise<{ result: number }>;
  mathMultiply: (a: number, b: number) => Promise<{ result: number }>;
  mathDivide: (a: number, b: number) => Promise<{ result: number; error?: string }>;
  mathSolveLinear: (a: number, b: number) => Promise<{ root: number; error?: string }>;
  mathSolveLineEquation: (a: number, b: number, c: number) => Promise<{ x: number; error?: string }>;
  mathSolveQuadratic: (
    a: number,
    b: number,
    c: number
  ) => Promise<{
    discriminant: number;
    roots: number[];
    realRoots: number[];
    complexRoots?: Array<{ real: number; imaginary: number }>;
  }>;
  mathEvaluatePolynomial: (coefficients: number[], x: number) => Promise<{ value: number; error?: string }>;
  mathFindPolynomialRoots: (
    coefficients: number[],
    initialGuess?: number,
    iterations?: number
  ) => Promise<{ roots: number[]; attempts: number; converged: boolean; error?: string }>;
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

  onToolCalled: (callback: (event: Electron.IpcRendererEvent, data: { toolName: string; result: any }) => void) => {
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

  // Utilities
  proxyRequest: (options: { url: string; method?: string; headers?: Record<string, string>; body?: string }) =>
    ipcRenderer.invoke('proxy:http', options),
  checkForUpdate: () => ipcRenderer.send('check-for-update'),

  // Math tools
  mathAdd: (a: number, b: number) => ipcRenderer.invoke('custom:mathAdd', a, b),
  mathSubtract: (a: number, b: number) => ipcRenderer.invoke('custom:mathSubtract', a, b),
  mathMultiply: (a: number, b: number) => ipcRenderer.invoke('custom:mathMultiply', a, b),
  mathDivide: (a: number, b: number) => ipcRenderer.invoke('custom:mathDivide', a, b),
  mathSolveLinear: (a: number, b: number) => ipcRenderer.invoke('custom:mathSolveLinear', a, b),
  mathSolveLineEquation: (a: number, b: number, c: number) => ipcRenderer.invoke('custom:mathSolveLineEquation', a, b, c),
  mathSolveQuadratic: (a: number, b: number, c: number) =>
    ipcRenderer.invoke('custom:mathSolveQuadratic', a, b, c),
  mathEvaluatePolynomial: (coefficients: number[], x: number) =>
    ipcRenderer.invoke('custom:mathEvaluatePolynomial', coefficients, x),
  mathFindPolynomialRoots: (coefficients: number[], initialGuess: number = 0, iterations: number = 10) =>
    ipcRenderer.invoke('custom:mathFindPolynomialRoots', coefficients, initialGuess, iterations),
} as unknown as CopilotAPI);
