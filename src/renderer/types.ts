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
  proxyRequest: (options: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; headers: Record<string, unknown>; body: string }>;
  vcdSignIn: (input: { host?: string; org: string; username: string; password: string; apiVersion?: string; vdcId?: string; orgUuid?: string; networkName?: string; gateway?: string; dnsServers?: string; storageProfileId?: string; computePolicyId?: string; rejectUnauthorized?: boolean }) => Promise<{ connected: boolean; user?: string; org?: string; host?: string }>;
  vcdStatus: () => Promise<{ connected: boolean; user?: string; org?: string; host?: string }>;
  vcdSignOut: () => Promise<{ connected: boolean }>;
}
