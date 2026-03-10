import { Injectable } from '@angular/core';

/**
 * Service wrapper around Electron preload API (window.copilot)
 * Provides access to Copilot chat and workflow generation
 */
@Injectable({
  providedIn: 'root'
})
export class CopilotService {
  private api: any;

  constructor() {
    this.api = (window as any).copilot;
    if (!this.api) {
      console.warn('Copilot API not available - running in development');
    }
  }

  async generateWorkflow(params: { modelId: string; request: string; outputDir?: string }): Promise<any> {
    return this.api?.generateWorkflow(params);
  }

  async askLlm(modelId: string, prompt: string): Promise<string> {
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
        this.api.onChatStream((_event: unknown, chunk: string) => {
          text += chunk || '';
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

  async getWorkflowOutputDir(): Promise<string> {
    return this.api?.getWorkflowOutputDir();
  }

  async chooseWorkflowOutputDir(): Promise<string | null> {
    return this.api?.chooseWorkflowOutputDir();
  }

  async openWorkflowOutputDir(outputDir?: string): Promise<void> {
    return this.api?.openWorkflowOutputDir(outputDir);
  }

  async listWorkflowTree(): Promise<{ success: boolean; root?: string; tree?: any[]; error?: string }> {
    return this.api?.listWorkflowTree?.() ?? { success: false, error: 'Not available' };
  }

  async readWorkflowFile(filePath: string): Promise<{ success: boolean; content?: string; error?: string }> {
    return this.api?.readWorkflowFile?.(filePath) ?? { success: false, error: 'Not available' };
  }

  async saveWorkflowFile(filePath: string, content: string): Promise<{ success: boolean; error?: string }> {
    return this.api?.saveWorkflowFile?.(filePath, content) ?? { success: false, error: 'Not available' };
  }

  async getModels(): Promise<any[]> {
    const models = await this.api?.getModels?.();
    // If it's an array of strings, map to { id, label }
    if (Array.isArray(models) && typeof models[0] === 'string') {
      return models.map((id: string) => ({ id, label: id }));
    }
    return models ?? [];
  }

  isAvailable(): boolean {
    return !!this.api;
  }
}
