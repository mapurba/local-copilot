import { Injectable } from '@angular/core';

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

  async getModels(): Promise<Array<{ id: string; label: string }>> {
    const models = await this.api?.getModels?.();
    if (Array.isArray(models) && typeof models[0] === 'string') {
      return models.map((id: string) => ({ id, label: id }));
    }
    return models ?? [];
  }

  checkForUpdate(): void {
    this.api?.checkForUpdate?.();
  }

  isAvailable(): boolean {
    return !!this.api;
  }
}
