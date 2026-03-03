export interface CopilotAPI {
  status: () => Promise<{ status: string; user?: string }>;
  signIn: () => Promise<{ userCode: string; verificationUri: string; status: string }>;
  signInConfirm: () => Promise<{ status: string; user?: string }>;
  signOut: () => Promise<{ success: boolean }>;
  getModels: () => Promise<string[]>;
  sendChatMessage: (modelId: string, messages: Array<{ role: string; content: string }>) => Promise<{ started: boolean }>;
  onChatStream: (callback: (event: unknown, text: string) => void) => () => void;
  onChatEnd: (callback: (event: unknown) => void) => () => void;
  onChatError: (callback: (event: unknown, message: string) => void) => () => void;
}
