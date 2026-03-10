export interface CopilotAPI {
  status: () => Promise<{ status: string; user?: string }>;
  signIn: () => Promise<{ userCode: string; verificationUri: string; status: string }>;
  signInConfirm: () => Promise<{ status: string; user?: string }>;
  signOut: () => Promise<{ success: boolean }>;
  getModels: () => Promise<string[]>;
  sendChatMessage: (modelId: string, messages: Array<{ role: string; content: string }>) => Promise<{ started: boolean }>;
  onChatStream: (callback: (event: unknown, text: string, type?: string) => void) => () => void;
  onChatEnd: (callback: (event: unknown) => void) => () => void;
  onChatError: (callback: (event: unknown, message: string) => void) => () => void;
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
}
