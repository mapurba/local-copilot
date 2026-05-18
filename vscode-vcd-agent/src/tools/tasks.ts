import * as vscode from 'vscode';
import { taskTracker } from '../taskTracker';

function ok(data: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(data))]);
}

export function registerTaskTools(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    // ── taskStart ────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ name: string; description?: string; ssh_session_id?: string }>('vcd-agent_taskStart', {
      async invoke(params) {
        const taskId = taskTracker.createTask(params.input.name, params.input.description, params.input.ssh_session_id);
        return ok({ taskId, status: 'running', message: `Task "${params.input.name}" started` });
      },
    }),

    // ── taskLogStep ──────────────────────────────────────────────────────────
    vscode.lm.registerTool<{
      task_id: string;
      description: string;
      command?: string;
      output: string;
      exit_code: number;
    }>('vcd-agent_taskLogStep', {
      async invoke(params) {
        const stepId = taskTracker.beginStep(params.input.task_id, params.input.description, params.input.command);
        taskTracker.completeStep(params.input.task_id, stepId, params.input.output, params.input.exit_code);
        return ok({ taskId: params.input.task_id, stepId, exitCode: params.input.exit_code, logged: true });
      },
    }),

    // ── taskDone ─────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ task_id: string; error?: string }>('vcd-agent_taskDone', {
      async invoke(params) {
        taskTracker.completeTask(params.input.task_id, params.input.error);
        const task = taskTracker.getTask(params.input.task_id);
        return ok({ taskId: params.input.task_id, status: task?.status ?? 'completed' });
      },
    }),

    // ── taskList ─────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ limit?: number }>('vcd-agent_taskList', {
      async invoke(params) {
        const tasks = taskTracker.listTasks(params.input.limit ?? 20);
        return ok({ tasks: tasks.map((t) => ({
          id: t.id, name: t.name, status: t.status,
          steps: t.steps.length, createdAt: t.createdAt,
        })) });
      },
    }),

    // ── taskCancel ───────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ task_id: string }>('vcd-agent_taskCancel', {
      prepareInvocation(params) {
        return { confirmationMessages: { title: 'Cancel Task', message: new vscode.MarkdownString(`Cancel task \`${params.input.task_id}\`?`) } };
      },
      async invoke(params) {
        taskTracker.cancelTask(params.input.task_id);
        return ok({ taskId: params.input.task_id, cancelled: true });
      },
    }),

    // ── taskGetLog ───────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ log_id: string; tail_chars?: number }>('vcd-agent_taskGetLog', {
      async invoke(params) {
        return ok(taskTracker.getLog(params.input.log_id, params.input.tail_chars ?? 4000));
      },
    })
  );
}
