export interface CopilotAPI {
  status: () => Promise<{ status: string; user?: string }>;
  signIn: () => Promise<{ userCode: string; verificationUri: string; status: string }>;
  signInConfirm: () => Promise<{ status: string; user?: string }>;
  signOut: () => Promise<{ success: boolean }>;
  getModels: () => Promise<string[]>;
  sendChatMessage: (modelId: string, messages: Array<{ role: string; content: string }>) => Promise<{ started: boolean }>;
  sendChatMessageWithTools: (modelId: string, messages: Array<{ role: string; content: string }>) => Promise<{ started: boolean }>;
  onChatStream: (callback: (event: unknown, text: string, type?: string) => void) => () => void;
  onChatEnd: (callback: (event: unknown) => void) => () => void;
  onChatError: (callback: (event: unknown, message: string) => void) => () => void;
  onVmDraft: (callback: (event: unknown, form: Record<string, unknown>) => void) => () => void;
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
  onTerminalData: (callback: (event: unknown, data: { terminalId: string; data: string }) => void) => () => void;
}
