import { Injectable } from '@angular/core';
import { Subject, Observable } from 'rxjs';

export interface ThinkingStep {
  id: string;
  stepNumber: number;
  timestamp: Date;
  content: string;
  category?: 'analysis' | 'planning' | 'decision' | 'reasoning' | 'synthesis';
  tokens?: number;
  metadata?: Record<string, any>;
  parentId?: string; // For nested thoughts
  children?: ThinkingStep[];
}

export interface DebugLog {
  id: string;
  timestamp: Date;
  type: 'info' | 'debug' | 'error' | 'tool' | 'api' | 'thinking';
  message: string;
  details?: any;
  duration?: number;
  thinkingChain?: ThinkingStep[]; // For structured thinking logs
}

@Injectable({
  providedIn: 'root'
})
export class DebugLoggerService {
  private logs: DebugLog[] = [];
  private logsSubject = new Subject<DebugLog>();
  private maxLogs = 500;
  private startTimes: Map<string, number> = new Map();
  private currentThinkingChain: ThinkingStep[] = [];
  private thinkingStepCounter = 0;
  private thinkingTokenCounter = 0;
  private lastLogMessages: Map<string, number> = new Map(); // For deduplication
  private deduplicateWindowMs = 500; // Consider logs within 500ms as duplicates

  logs$: Observable<DebugLog> = this.logsSubject.asObservable();

  constructor() {
    this.interceptConsole();
  }

  private interceptConsole() {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalDebug = console.debug;

    // Skip console interception for structured messages
    const isStructuredMsg = (msg: string) => msg.startsWith('[') || msg.startsWith('{');

    console.log = (...args: any[]) => {
      originalLog(...args);
      // Only capture actually structured messages to avoid duplicates
      const msg = String(args[0] || '');
      if (isStructuredMsg(msg) && !msg.includes('[Chat]') && !msg.includes('[API]')) {
        // Avoid duplicate capture of already-logged messages
        // (chat component logs directly via debugLogger, not console)
      }
    };

    console.error = (...args: any[]) => {
      originalError(...args);
      this.addLog('error', args.map(a => JSON.stringify(a)).join(' '));
    };

    console.warn = (...args: any[]) => {
      originalWarn(...args);
      // Only log genuine warnings, not debug info
      const msg = String(args[0] || '');
      if (!msg.includes('[Chat]') && !msg.includes('warn')) {
        this.addLog('debug', msg);
      }
    };

    console.debug = (...args: any[]) => {
      originalDebug(...args);
      // Skip debug spam
      const msg = String(args[0] || '');
      if (msg.length > 20) { // Only capture substantial debug messages
        this.addLog('debug', msg);
      }
    };
  }

  addLog(type: DebugLog['type'], message: string, details?: any): void {
    // Deduplication check - skip if same message logged within last 500ms
    const msgKey = `${type}:${message}`;
    const lastTime = this.lastLogMessages.get(msgKey);
    const now = Date.now();

    if (lastTime && now - lastTime < this.deduplicateWindowMs) {
      // Skip duplicate
      return;
    }

    this.lastLogMessages.set(msgKey, now);

    const log: DebugLog = {
      id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
      type,
      message,
      details,
      thinkingChain: type === 'thinking' ? [...this.currentThinkingChain] : undefined
    };

    this.logs.push(log);

    // Keep only the latest N logs to prevent memory issues
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    this.logsSubject.next(log);
  }

  startTimer(key: string): void {
    this.startTimes.set(key, performance.now());
  }

  endTimer(key: string, type: DebugLog['type'], message: string, details?: any): void {
    const startTime = this.startTimes.get(key);
    if (startTime) {
      const duration = performance.now() - startTime;
      this.addLog(type, message, { ...details, duration: `${duration.toFixed(2)}ms` });
      this.startTimes.delete(key);
    } else {
      this.addLog(type, message, details);
    }
  }

  logApiCall(method: string, endpoint: string, details?: any): void {
    this.startTimer(`api-${endpoint}`);
    this.addLog('api', `${method} ${endpoint}`, details);
  }

  logApiResponse(endpoint: string, status: number, details?: any): void {
    this.endTimer(`api-${endpoint}`, 'api', `Response: ${status}`, details);
  }

  logTool(toolName: string, args: any[], result: any): void {
    this.addLog('tool', `Tool: ${toolName}`, {
      arguments: args,
      result: result
    });
  }

  logThinking(thinking: string, metadata?: any): void {
    this.addLog('thinking', thinking, metadata);
  }

  /**
   * Start a new thinking chain (e.g., for a new LLM request)
   */
  startThinkingChain(): void {
    this.currentThinkingChain = [];
    this.thinkingStepCounter = 0;
    this.thinkingTokenCounter = 0;
  }

  /**
   * Add a structured thinking step with category and metadata
   */
  addThinkingStep(
    content: string,
    category: ThinkingStep['category'] = 'reasoning',
    metadata?: Record<string, any>,
    tokenCount?: number
  ): ThinkingStep {
    this.thinkingStepCounter++;
    const step: ThinkingStep = {
      id: `step-${Date.now()}-${this.thinkingStepCounter}`,
      stepNumber: this.thinkingStepCounter,
      timestamp: new Date(),
      content,
      category,
      tokens: tokenCount,
      metadata
    };

    this.currentThinkingChain.push(step);

    if (tokenCount) {
      this.thinkingTokenCounter += tokenCount;
    }

    // Log immediately for real-time visibility
    this.addLog('thinking', `[${category.toUpperCase()}] ${content.substring(0, 100)}...`, {
      fullContent: content,
      stepNumber: this.thinkingStepCounter,
      category,
      tokens: tokenCount,
      ...metadata
    });

    return step;
  }

  /**
   * Create a nested thinking step (sub-reasoning)
   */
  addNestedThinkingStep(
    content: string,
    parentStepNumber: number,
    category: ThinkingStep['category'] = 'reasoning',
    metadata?: Record<string, any>,
    tokenCount?: number
  ): ThinkingStep {
    this.thinkingStepCounter++;
    const parentStep = this.currentThinkingChain[parentStepNumber - 1];

    const step: ThinkingStep = {
      id: `step-${Date.now()}-${this.thinkingStepCounter}`,
      stepNumber: this.thinkingStepCounter,
      timestamp: new Date(),
      content,
      category,
      tokens: tokenCount,
      parentId: parentStep?.id,
      metadata
    };

    if (!parentStep?.children) {
      parentStep.children = [];
    }
    parentStep.children.push(step);

    if (tokenCount) {
      this.thinkingTokenCounter += tokenCount;
    }

    // Log as sub-thought
    this.addLog('thinking', `  └─ [${category.toUpperCase()}] ${content.substring(0, 90)}...`, {
      fullContent: content,
      stepNumber: this.thinkingStepCounter,
      parentId: parentStep?.id,
      category,
      tokens: tokenCount,
      ...metadata
    });

    return step;
  }

  /**
   * Get current thinking chain for analysis
   */
  getCurrentThinkingChain(): ThinkingStep[] {
    return [...this.currentThinkingChain];
  }

  /**
   * Get thinking statistics for current chain
   */
  getThinkingStats(): {
    stepCount: number;
    totalTokens: number;
    byCategory: Record<string, number>;
  } {
    const byCategory: Record<string, number> = {};
    this.currentThinkingChain.forEach(step => {
      const cat = step.category || 'reasoning';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    });

    return {
      stepCount: this.currentThinkingChain.length,
      totalTokens: this.thinkingTokenCounter,
      byCategory
    };
  }

  /**
   * Format thinking chain as readable text
   */
  formatThinkingChain(indent = 0): string {
    const lines: string[] = [];
    const indentStr = ' '.repeat(indent);

    for (const step of this.currentThinkingChain) {
      lines.push(`${indentStr}[${step.stepNumber}] ${step.category?.toUpperCase() || 'REASONING'} (${step.tokens || 0} tokens)`);
      lines.push(`${indentStr}    ${step.content.substring(0, 120)}${step.content.length > 120 ? '...' : ''}`);

      if (step.children && step.children.length > 0) {
        for (const child of step.children) {
          lines.push(`${indentStr}  └─ [${child.stepNumber}] ${child.category?.toUpperCase()} (${child.tokens || 0} tokens)`);
          lines.push(`${indentStr}     ${child.content.substring(0, 110)}${child.content.length > 110 ? '...' : ''}`);
        }
      }
    }

    return lines.join('\n');
  }

  logError(message: string, error: any): void {
    this.addLog('error', message, {
      error: error?.message || error,
      stack: error?.stack
    });
  }

  getLogs(): DebugLog[] {
    return [...this.logs];
  }

  clearLogs(): void {
    this.logs = [];
    this.lastLogMessages.clear(); // Also clear dedup cache
  }

  /**
   * Clear local dedup cache to save memory periodically
   */
  clearDedupCache(): void {
    this.lastLogMessages.clear();
  }

  exportLogs(): string {
    return this.logs
      .map(
        log => {
          let output = `[${log.timestamp.toISOString()}] [${log.type.toUpperCase()}] ${log.message}`;
          
          if (log.details) {
            output += '\n  ' + JSON.stringify(log.details, null, 2);
          }

          // Include thinking chain if present
          if (log.thinkingChain && log.thinkingChain.length > 0) {
            output += '\n  --- Thinking Chain ---';
            for (const step of log.thinkingChain) {
              output += `\n  [${step.stepNumber}] ${step.category?.toUpperCase()} (${step.tokens || 0} tokens): ${step.content.substring(0, 80)}...`;
            }
          }

          return output;
        }
      )
      .join('\n');
  }
}
