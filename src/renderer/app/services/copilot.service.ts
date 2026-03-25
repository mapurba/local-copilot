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

  onToolCalled(callback: (toolName: string, result: any) => void): () => void {
    if (!this.api?.onToolCalled) {
      console.warn('Tool callbacks not available');
      return () => {};
    }
    return this.api.onToolCalled((_event: unknown, data: { toolName: string; result: any }) => {
      callback(data.toolName, data.result);
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

  async getAvailableTools(): Promise<Array<{ name: string; category: string; description: string }>> {
    if (!this.api?.toolsList) throw new Error('Tools API not available');
    return this.api.toolsList();
  }

  async callTool(toolName: string, ...args: any[]): Promise<any> {
    if (!this.api?.callTool) throw new Error('Tools API not available');
    return this.api.callTool(toolName, ...args);
  }

  checkForUpdate(): void {
    this.api?.checkForUpdate?.();
  }

  // Math tools
  async mathAdd(a: number, b: number): Promise<{ result: number }> {
    if (!this.api?.mathAdd) throw new Error('Math API not available');
    return this.api.mathAdd(a, b);
  }

  async mathSubtract(a: number, b: number): Promise<{ result: number }> {
    if (!this.api?.mathSubtract) throw new Error('Math API not available');
    return this.api.mathSubtract(a, b);
  }

  async mathMultiply(a: number, b: number): Promise<{ result: number }> {
    if (!this.api?.mathMultiply) throw new Error('Math API not available');
    return this.api.mathMultiply(a, b);
  }

  async mathDivide(a: number, b: number): Promise<{ result: number; error?: string }> {
    if (!this.api?.mathDivide) throw new Error('Math API not available');
    return this.api.mathDivide(a, b);
  }

  async mathSolveLinear(a: number, b: number): Promise<{ root: number; error?: string }> {
    if (!this.api?.mathSolveLinear) throw new Error('Math API not available');
    return this.api.mathSolveLinear(a, b);
  }

  async mathSolveLineEquation(a: number, b: number, c: number): Promise<{ x: number; error?: string }> {
    if (!this.api?.mathSolveLineEquation) throw new Error('Math API not available');
    return this.api.mathSolveLineEquation(a, b, c);
  }

  async mathSolveQuadratic(
    a: number,
    b: number,
    c: number
  ): Promise<{
    discriminant: number;
    roots: number[];
    realRoots: number[];
    complexRoots?: Array<{ real: number; imaginary: number }>;
  }> {
    if (!this.api?.mathSolveQuadratic) throw new Error('Math API not available');
    return this.api.mathSolveQuadratic(a, b, c);
  }

  async mathEvaluatePolynomial(coefficients: number[], x: number): Promise<{ value: number; error?: string }> {
    if (!this.api?.mathEvaluatePolynomial) throw new Error('Math API not available');
    return this.api.mathEvaluatePolynomial(coefficients, x);
  }

  async mathFindPolynomialRoots(
    coefficients: number[],
    initialGuess: number = 0,
    iterations: number = 10
  ): Promise<{ roots: number[]; attempts: number; converged: boolean; error?: string }> {
    if (!this.api?.mathFindPolynomialRoots) throw new Error('Math API not available');
    return this.api.mathFindPolynomialRoots(coefficients, initialGuess, iterations);
  }

  isAvailable(): boolean {
    return !!this.api;
  }
}
