/**
 * Task Tracker — in-memory store for long-running multi-step agent tasks.
 * Notifies subscribers via a VS Code EventEmitter instead of Electron IPC.
 */
import * as vscode from 'vscode';

const DISPLAY_TRUNCATE = 1200;
const LOG_BUDGET_BYTES = 5 * 1024 * 1024; // 5 MB

export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface TaskStep {
  id: string;
  description: string;
  command?: string;
  status: StepStatus;
  output?: string;
  logId?: string;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number;
}

export interface Task {
  id: string;
  name: string;
  description?: string;
  sshSessionId?: string;
  status: TaskStatus;
  steps: TaskStep[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
}

class TaskTrackerClass {
  private static _instance: TaskTrackerClass;
  private tasks: Map<string, Task> = new Map();
  private logStore: Map<string, string> = new Map();
  private logStoreBytes = 0;

  /** Fires whenever any task or step changes — subscribers are TreeViews, webviews, etc. */
  readonly onTaskChanged = new vscode.EventEmitter<Task>();

  static getInstance(): TaskTrackerClass {
    if (!TaskTrackerClass._instance) {
      TaskTrackerClass._instance = new TaskTrackerClass();
    }
    return TaskTrackerClass._instance;
  }

  private genId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  private notify(task: Task): void {
    task.updatedAt = Date.now();
    this.onTaskChanged.fire(task);
  }

  // ── Log store ──────────────────────────────────────────────────────────────

  storeLog(content: string): string {
    const logId = this.genId('log');
    if (this.logStoreBytes + content.length > LOG_BUDGET_BYTES) {
      for (const [id, val] of this.logStore.entries()) {
        this.logStore.delete(id);
        this.logStoreBytes -= val.length;
        if (this.logStoreBytes + content.length <= LOG_BUDGET_BYTES) break;
      }
    }
    this.logStore.set(logId, content);
    this.logStoreBytes += content.length;
    return logId;
  }

  getLog(logId: string, tailChars = 4000): { found: boolean; total?: number; tail?: string } {
    const log = this.logStore.get(logId);
    if (!log) return { found: false };
    const tail = log.length <= tailChars ? log : '...' + log.slice(-tailChars);
    return { found: true, total: log.length, tail };
  }

  // ── Task lifecycle ─────────────────────────────────────────────────────────

  createTask(name: string, description?: string, sshSessionId?: string): string {
    const id = this.genId('task');
    const task: Task = {
      id,
      name,
      description,
      sshSessionId,
      status: 'running',
      steps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.set(id, task);
    this.notify(task);
    return id;
  }

  beginStep(taskId: string, description: string, command?: string): string {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const stepId = this.genId('step');
    task.steps.push({
      id: stepId,
      description,
      command,
      status: 'running',
      startedAt: Date.now(),
    });
    this.notify(task);
    return stepId;
  }

  completeStep(
    taskId: string,
    stepId: string,
    output: string,
    exitCode: number
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const step = task.steps.find((s) => s.id === stepId);
    if (!step) return;

    step.completedAt = Date.now();
    step.exitCode = exitCode;
    step.status = exitCode === 0 ? 'done' : 'failed';

    if (output.length > DISPLAY_TRUNCATE) {
      const logId = this.storeLog(output);
      step.logId = logId;
      step.output =
        output.slice(0, 600) +
        `\n...<output truncated — use task_get_log with logId="${logId}" to retrieve full output>...\n` +
        output.slice(-300);
    } else {
      step.output = output;
    }

    this.notify(task);
  }

  completeTask(taskId: string, error?: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = error ? 'failed' : 'completed';
    task.error = error;
    task.completedAt = Date.now();
    this.notify(task);
  }

  cancelTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = 'cancelled';
    task.completedAt = Date.now();
    this.notify(task);
  }

  listTasks(limit = 20): Task[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }
}

export const taskTracker = TaskTrackerClass.getInstance();
