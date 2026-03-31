import { Injectable } from '@angular/core';

interface RegisteredTool {
  name: string;
  category: string;
  description: string;
}

type StreamChunkType = 'content' | 'thinking' | 'tool' | 'usage';

export interface ConvertPrdProgressEvent {
  requestId: string;
  stage: string;
  message: string;
  percent?: number;
  details?: Record<string, unknown>;
  timestamp?: string;
}

@Injectable({
  providedIn: 'root'
})
export class CopilotService {
  private api: any;
  private toolCache: RegisteredTool[] = [];
  private toolCacheAt = 0;
  private readonly toolCacheTtlMs = 10000;

  constructor() {
    this.api = (window as any).copilot;
    if (!this.api) {
      console.warn('Copilot API not available - running in development');
    }
  }

  async getStatus(): Promise<{ status: string; user?: string }> {
    return this.api?.status?.() ?? { status: 'Unavailable' };
  }

  async convertPrd(input: { content?: string; filePath?: string; modelId?: string; fileName?: string; requestId?: string }): Promise<any> {
    if (this.api && this.api.convertPrd) return this.api.convertPrd(input);
    // Fallback to local converter for development (no preload API)
    try {
      // dynamic import to avoid bundling server-only code into production builds
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      const local = await import('./local-prd-converter');
      return await local.convertPrdLocal(input.content || input.filePath || '');
    } catch (e) {
      return { success: false, error: 'convertPrd not available' };
    }
  }

  onConvertPrdProgress(callback: (event: ConvertPrdProgressEvent) => void): () => void {
    if (!this.api?.onConvertPrdProgress) {
      return () => {};
    }
    return this.api.onConvertPrdProgress((_event: unknown, data: ConvertPrdProgressEvent) => {
      callback(data);
    });
  }

  async signIn(): Promise<{ userCode: string; verificationUri: string; status: string }> {
    if (!this.api?.signIn) {
      throw new Error('Sign-in API is not available');
    }
    return this.api.signIn();
  }

  async confirmSignIn(): Promise<{ status: string; user?: string }> {
    if (!this.api?.signInConfirm) {
      throw new Error('Sign-in confirmation API is not available');
    }
    return this.api.signInConfirm();
  }

  async signOut(): Promise<{ success: boolean }> {
    return this.api?.signOut?.() ?? { success: false };
  }

  async askLlm(
    modelId: string,
    prompt: string,
    onStream?: (chunk: string, type: StreamChunkType) => void
  ): Promise<string> {
    if (!this.api?.sendChatMessage || !this.api?.onChatStream || !this.api?.onChatEnd || !this.api?.onChatError) {
      throw new Error('Chat API is not available');
    }

    return new Promise<string>(async (resolve, reject) => {
      let text = '';
      let done = false;

      const cleanup = (unsubs: Array<() => void>) => {
        for (const unsub of unsubs) {
          try {
            unsub();
          } catch {
            // Ignore cleanup failures.
          }
        }
      };

      const unsubs: Array<() => void> = [];
      unsubs.push(
        this.api.onChatStream((_event: unknown, chunk: string, type?: StreamChunkType) => {
          const chunkType: StreamChunkType = type ?? 'content';
          if (chunkType === 'content') {
            text += chunk || '';
          }
          if (onStream) {
            onStream(chunk || '', chunkType);
          }
        })
      );
      unsubs.push(
        this.api.onChatEnd(() => {
          if (done) return;
          done = true;
          cleanup(unsubs);
          resolve(text.trim());
        })
      );
      unsubs.push(
        this.api.onChatError((_event: unknown, message: string) => {
          if (done) return;
          done = true;
          cleanup(unsubs);
          reject(new Error(message || 'LLM request failed'));
        })
      );

      try {
        await this.api.sendChatMessage(modelId, [{ role: 'user', content: prompt }]);
      } catch (error) {
        if (!done) {
          done = true;
          cleanup(unsubs);
          reject(error);
        }
      }
    });
  }

  onToolCalled(callback: (toolName: string, result: any, args?: any[]) => void): () => void {
    if (!this.api?.onToolCalled) {
      console.warn('Tool callbacks not available');
      return () => {};
    }
    return this.api.onToolCalled((_event: unknown, data: { toolName: string; args?: any[]; result: any }) => {
      callback(data.toolName, data.result, data.args);
    });
  }

  onToolError(callback: (toolName: string, error: string) => void): () => void {
    if (!this.api?.onToolError) {
      console.warn('Tool error callbacks not available');
      return () => {};
    }
    return this.api.onToolError((_event: unknown, data: { toolName: string; error: string }) => {
      callback(data.toolName, data.error);
    });
  }

  async getModels(): Promise<Array<{ id: string; label: string }>> {
    const models = await this.api?.getModels?.();
    if (Array.isArray(models) && typeof models[0] === 'string') {
      return models.map((id: string) => ({ id, label: id }));
    }
    return models ?? [];
  }

  async chooseWorkflowOutputDir(): Promise<{ cancelled: boolean; path?: string }> {
    if (!this.api?.chooseWorkflowOutputDir) {
      throw new Error('Workflow API not available');
    }
    return this.api.chooseWorkflowOutputDir();
  }

  async getWorkflowOutputDir(): Promise<{ path?: string }> {
    if (!this.api?.getWorkflowOutputDir) {
      throw new Error('Workflow API not available');
    }
    return this.api.getWorkflowOutputDir();
  }

  async openWorkflowOutputDir(outputDir: string): Promise<{ success: boolean; error?: string }> {
    if (!this.api?.openWorkflowOutputDir) {
      throw new Error('Workflow API not available');
    }
    return this.api.openWorkflowOutputDir(outputDir);
  }

  async listWorkflowTree(): Promise<{ success: boolean; root?: string; tree?: unknown[]; error?: string }> {
    if (!this.api?.listWorkflowTree) {
      throw new Error('Workflow API not available');
    }
    return this.api.listWorkflowTree();
  }

  async readWorkflowFile(filePath: string): Promise<{ success: boolean; content?: string; error?: string }> {
    if (!this.api?.readWorkflowFile) {
      throw new Error('Workflow API not available');
    }
    return this.api.readWorkflowFile(filePath);
  }

  async saveWorkflowFile(filePath: string, content: string): Promise<{ success: boolean; error?: string }> {
    if (!this.api?.saveWorkflowFile) {
      throw new Error('Workflow API not available');
    }
    return this.api.saveWorkflowFile(filePath, content);
  }

  async generateWorkflow(input: { modelId: string; request: string; outputDir?: string }): Promise<{
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
  }> {
    if (!this.api?.generateWorkflow) {
      throw new Error('Workflow API not available');
    }
    return this.api.generateWorkflow(input);
  }

  async getAvailableTools(): Promise<RegisteredTool[]> {
    if (!this.api?.toolsList) throw new Error('Tools API not available');
    const tools = (await this.api.toolsList()) as RegisteredTool[];
    this.toolCache = tools;
    this.toolCacheAt = Date.now();
    return tools;
  }

  async callTool(toolName: string, ...args: any[]): Promise<any> {
    if (!this.api?.callTool) throw new Error('Tools API not available');
    await this.assertToolRegistered(toolName);
    return this.api.callTool(toolName, ...args);
  }

  async invokeTool(toolName: string, args?: unknown[] | Record<string, unknown>): Promise<any> {
    const normalizedArgs = this.normalizeArgs(args);
    return this.callTool(toolName, ...normalizedArgs);
  }

  async hasTool(toolName: string): Promise<boolean> {
    const tools = await this.getToolsCached();
    return tools.some((tool) => tool.name === toolName);
  }

  private async assertToolRegistered(toolName: string): Promise<void> {
    const exists = await this.hasTool(toolName);
    if (!exists) {
      throw new Error(`Tool '${toolName}' is not registered in tools registry`);
    }
  }

  private async getToolsCached(): Promise<RegisteredTool[]> {
    const isFresh = this.toolCache.length > 0 && Date.now() - this.toolCacheAt < this.toolCacheTtlMs;
    if (isFresh) {
      return this.toolCache;
    }
    return this.getAvailableTools();
  }

  private normalizeArgs(args?: unknown[] | Record<string, unknown>): unknown[] {
    if (!args) {
      return [];
    }
    if (Array.isArray(args)) {
      return args;
    }
    return Object.values(args);
  }

  // ── Workspace Methods ────────────────────────────────────────────────────

  async getWorkspacePath(): Promise<string> {
    if (!this.api?.workspaceGetPath) throw new Error('Workspace API not available');
    return this.api.workspaceGetPath();
  }

  async setWorkspacePath(path: string): Promise<{ success: boolean; path?: string; error?: string }> {
    if (!this.api?.workspaceSetPath) throw new Error('Workspace API not available');
    return this.api.workspaceSetPath(path);
  }

  checkForUpdate(): void {
    this.api?.checkForUpdate?.();
  }

  isAvailable(): boolean {
    return !!this.api;
  }
}
