/**
 * Task Tracker
 *
 * Tracks long-running multi-step agent tasks (e.g., software installs).
 * - Persists step status & output in memory
 * - Stores full command logs separately (evicted LRU when budget exceeded)
 * - Notifies the renderer via IPC on every state change
 */

import { BrowserWindow } from 'electron';

// ── Constants ─────────────────────────────────────────────────────────────────
const DISPLAY_TRUNCATE = 1200; // chars kept inline in step.output for the UI
const LOG_BUDGET_BYTES = 5 * 1024 * 1024; // 5 MB total for stored logs

// ── Types ─────────────────────────────────────────────────────────────────────
export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface TaskStep {
  id: string;
  description: string;
  command?: string;
  status: StepStatus;
  /** Truncated output shown in UI / fed back to LLM */
  output?: string;
  /** Key into the log store for the full raw output */
  logId?: string;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number;
}

export interface Task {
  id: string;
  name: string;
  description?: string;
  /** SSH session ID this task is running inside */
  sshSessionId?: string;
  status: TaskStatus;
  steps: TaskStep[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
}

// ── TaskTracker singleton ─────────────────────────────────────────────────────
class TaskTrackerClass {
  private static _instance: TaskTrackerClass;
  private tasks: Map<string, Task> = new Map();
  /** Full raw logs indexed by logId */
  private logStore: Map<string, string> = new Map();
  private logStoreBytes = 0;

  static getInstance(): TaskTrackerClass {
    if (!TaskTrackerClass._instance) {
      TaskTrackerClass._instance = new TaskTrackerClass();
    }
    return TaskTrackerClass._instance;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private id(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  private notify(): void {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('task:updated');
    }
  }

  // ── Log store ────────────────────────────────────────────────────────────

  /**
   * Store a full log string, evicting oldest entries when over budget.
   * Returns the logId.
   */
  storeLog(content: string): string {
    const logId = this.id('log');
    // Evict oldest entries if we'd exceed the budget
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

  /** Retrieve a stored log.  Returns the tail (last 4 KB) to avoid huge LLM payloads. */
  getLog(logId: string, tailChars = 4000): { found: boolean; total?: number; tail?: string } {
    const log = this.logStore.get(logId);
    if (!log) return { found: false };
    const tail = log.length > tailChars
      ? `...[${log.length - tailChars} chars omitted]...\n` + log.slice(-tailChars)
      : log;
    return { found: true, total: log.length, tail };
  }

  // ── Tasks ────────────────────────────────────────────────────────────────

  createTask(name: string, description?: string, sshSessionId?: string): Task {
    const task: Task = {
      id: this.id('task'),
      name,
      description,
      sshSessionId,
      status: 'running',
      steps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.set(task.id, task);
    console.log(`[TaskTracker] ▶ Created task ${task.id}: "${name}"`);
    this.notify();
    return task;
  }

  /**
   * Begin a new step inside a task.
   * Returns the step so the caller can pass the stepId to completeStep.
   */
  beginStep(taskId: string, description: string, command?: string): TaskStep | null {
    const task = this.tasks.get(taskId);
    if (!task) {
      console.warn(`[TaskTracker] beginStep: task ${taskId} not found`);
      return null;
    }
    const step: TaskStep = {
      id: this.id('step'),
      description,
      command,
      status: 'running',
      startedAt: Date.now(),
    };
    task.steps.push(step);
    task.updatedAt = Date.now();
    this.notify();
    return step;
  }

  /**
   * Mark a step as done/failed and store its output.
   * Large outputs are moved to the log store; a truncated preview stays inline.
   */
  completeStep(
    taskId: string,
    stepId: string,
    output: string,
    exitCode = 0,
    forceFailed = false
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const step = task.steps.find((s) => s.id === stepId);
    if (!step) return;

    step.status = forceFailed || exitCode !== 0 ? 'failed' : 'done';
    step.completedAt = Date.now();
    step.exitCode = exitCode;

    if (output.length > DISPLAY_TRUNCATE) {
      const logId = this.storeLog(output);
      step.logId = logId;
      step.output =
        output.slice(0, 600) +
        `\n...[truncated — ${output.length} bytes total, logId: "${logId}" — use task_get_log to read full output]...\n` +
        output.slice(-300);
    } else {
      step.output = output;
    }

    task.updatedAt = Date.now();
    this.notify();
  }

  completeTask(taskId: string, error?: string): Task | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.status = error ? 'failed' : 'completed';
    task.completedAt = Date.now();
    task.updatedAt = Date.now();
    if (error) task.error = error;
    console.log(`[TaskTracker] ${task.status === 'completed' ? '✓' : '✗'} Task ${taskId}: "${task.name}" ${task.status}`);
    this.notify();
    return task;
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return false;
    task.status = 'cancelled';
    task.updatedAt = Date.now();
    this.notify();
    return true;
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(limit = 20): Task[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }
}

export const taskTracker = TaskTrackerClass.getInstance();
