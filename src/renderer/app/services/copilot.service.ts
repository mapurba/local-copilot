import { Injectable } from '@angular/core';

interface RegisteredTool {
  name: string;
  category: string;
  description: string;
}

type StreamChunkType = 'content' | 'thinking' | 'tool' | 'usage';

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

  checkForUpdate(): void {
    this.api?.checkForUpdate?.();
  }

  isAvailable(): boolean {
    return !!this.api;
  }
}
