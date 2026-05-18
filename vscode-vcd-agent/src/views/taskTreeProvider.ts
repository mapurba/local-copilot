import * as vscode from 'vscode';
import { Task, TaskStep, taskTracker } from '../taskTracker';

type AnyNode = TaskNode | StepNode;

export class TaskTreeProvider implements vscode.TreeDataProvider<AnyNode>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<AnyNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private listener: vscode.Disposable;

  constructor() {
    this.listener = taskTracker.onTaskChanged.event(() => this._onDidChangeTreeData.fire());
  }

  dispose(): void {
    this.listener.dispose();
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(element: AnyNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AnyNode): AnyNode[] {
    if (!element) {
      return taskTracker.listTasks(50).map((t) => new TaskNode(t));
    }
    if (element instanceof TaskNode && element.task) {
      return element.task.steps.map((s) => new StepNode(s));
    }
    return [];
  }
}

class TaskNode extends vscode.TreeItem {
  constructor(readonly task: Task) {
    super(task.name, task.steps.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);

    const statusIcon: Record<string, string> = {
      running: '$(loading~spin)',
      completed: '$(check)',
      failed: '$(error)',
      cancelled: '$(circle-slash)',
    };

    this.iconPath = new vscode.ThemeIcon(statusIcon[task.status]?.replace('$(', '').replace(')', '') ?? 'circle-outline');
    this.description = `${task.steps.filter((s) => s.status === 'done').length}/${task.steps.length} steps`;
    this.tooltip = task.error ?? `Status: ${task.status}`;
    this.contextValue = task.status === 'running' ? 'runningTask' : 'doneTask';
  }
}

class StepNode extends vscode.TreeItem {
  constructor(step: TaskStep) {
    super(step.description, vscode.TreeItemCollapsibleState.None);
    const icon: Record<string, string> = {
      running: 'loading~spin',
      done: 'check',
      failed: 'error',
      pending: 'clock',
      skipped: 'debug-step-over',
    };
    this.iconPath = new vscode.ThemeIcon(icon[step.status] ?? 'circle-outline');
    this.description = step.command ? `$ ${step.command.slice(0, 60)}` : undefined;
    this.tooltip = step.output?.slice(0, 300) ?? step.status;
  }
}
