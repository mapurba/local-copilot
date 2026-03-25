import { Injectable } from '@angular/core';
import { Subject, Observable } from 'rxjs';

export interface DebugLog {
  id: string;
  timestamp: Date;
  type: 'info' | 'debug' | 'error' | 'tool' | 'api' | 'thinking';
  message: string;
  details?: any;
  duration?: number;
}

@Injectable({
  providedIn: 'root'
})
export class DebugLoggerService {
  private logs: DebugLog[] = [];
  private logsSubject = new Subject<DebugLog>();
  private maxLogs = 500;
  private startTimes: Map<string, number> = new Map();

  logs$: Observable<DebugLog> = this.logsSubject.asObservable();

  constructor() {
    this.interceptConsole();
  }

  private interceptConsole() {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalDebug = console.debug;

    console.log = (...args: any[]) => {
      originalLog(...args);
      if (args[0]?.toString().includes('[') || args[0]?.toString().includes('{')) {
        this.addLog('debug', args.map(a => JSON.stringify(a)).join(' '));
      }
    };

    console.error = (...args: any[]) => {
      originalError(...args);
      this.addLog('error', args.map(a => JSON.stringify(a)).join(' '));
    };

    console.warn = (...args: any[]) => {
      originalWarn(...args);
      this.addLog('debug', args.map(a => JSON.stringify(a)).join(' '));
    };

    console.debug = (...args: any[]) => {
      originalDebug(...args);
      this.addLog('debug', args.map(a => JSON.stringify(a)).join(' '));
    };
  }

  addLog(type: DebugLog['type'], message: string, details?: any): void {
    const log: DebugLog = {
      id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
      type,
      message,
      details
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
  }

  exportLogs(): string {
    return this.logs
      .map(
        log =>
          `[${log.timestamp.toISOString()}] [${log.type.toUpperCase()}] ${log.message}${
            log.details ? '\n  ' + JSON.stringify(log.details, null, 2) : ''
          }`
      )
      .join('\n');
  }
}
