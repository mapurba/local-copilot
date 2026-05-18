import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const MAX_LINES = 2000;
const MAX_OUTPUT = 50 * 1024;

let workspacePath: string | null = null;

export function setLocalWorkspacePath(p: string): void {
  workspacePath = p;
}

function resolveWorkspacePath(relativePath: string): string {
  const base = workspacePath ?? (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd());
  const resolved = path.resolve(base, relativePath);
  // Security: ensure resolved path stays within base (path traversal prevention)
  if (!resolved.startsWith(path.resolve(base))) {
    throw new Error(`Path traversal detected: "${relativePath}" resolves outside workspace.`);
  }
  return resolved;
}

function ok(data: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(data))]);
}

export function registerLocalTools(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    // ── readFile ─────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ path: string; start_line?: number; max_lines?: number }>('vcd-agent_localReadFile', {
      async invoke(params) {
        const fullPath = resolveWorkspacePath(params.input.path);
        const content = await fs.readFile(fullPath, 'utf8');
        const lines = content.split('\n');
        const start = Math.max(0, (params.input.start_line ?? 1) - 1);
        const maxLines = Math.min(params.input.max_lines ?? MAX_LINES, MAX_LINES);
        const slice = lines.slice(start, start + maxLines).join('\n');
        return ok({ path: fullPath, content: slice, totalLines: lines.length, truncated: lines.length > start + maxLines });
      },
    }),

    // ── listDir ──────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ path: string }>('vcd-agent_localListDir', {
      async invoke(params) {
        const fullPath = resolveWorkspacePath(params.input.path);
        const entries = await fs.readdir(fullPath, { withFileTypes: true });
        const items = await Promise.all(entries.map(async (e) => {
          const stat = await fs.stat(path.join(fullPath, e.name)).catch(() => null);
          return { name: e.name, isDir: e.isDirectory(), size: stat?.size ?? 0 };
        }));
        return ok({ path: fullPath, entries: items });
      },
    }),

    // ── createFile ───────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ path: string; content: string }>('vcd-agent_localCreateFile', {
      prepareInvocation(params) {
        return { confirmationMessages: { title: 'Create File', message: new vscode.MarkdownString(`Create \`${params.input.path}\`?`) } };
      },
      async invoke(params) {
        const fullPath = resolveWorkspacePath(params.input.path);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        // Fail if already exists
        try { await fs.access(fullPath); return ok({ error: `File already exists: ${fullPath}` }); } catch { /* expected */ }
        await fs.writeFile(fullPath, params.input.content, 'utf8');
        return ok({ created: fullPath });
      },
    }),

    // ── writeFile ────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ path: string; content: string }>('vcd-agent_localWriteFile', {
      prepareInvocation(params) {
        return { confirmationMessages: { title: 'Write File', message: new vscode.MarkdownString(`Overwrite \`${params.input.path}\`?`) } };
      },
      async invoke(params) {
        const fullPath = resolveWorkspacePath(params.input.path);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, params.input.content, 'utf8');
        return ok({ written: fullPath });
      },
    }),

    // ── deleteFile ───────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ path: string }>('vcd-agent_localDeleteFile', {
      prepareInvocation(params) {
        return { confirmationMessages: { title: '⚠ Delete File', message: new vscode.MarkdownString(`Permanently delete \`${params.input.path}\`?`) } };
      },
      async invoke(params) {
        const fullPath = resolveWorkspacePath(params.input.path);
        await fs.unlink(fullPath);
        return ok({ deleted: fullPath });
      },
    }),

    // ── runCommand ───────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ command: string; cwd?: string; timeout_secs?: number }>('vcd-agent_localRunCommand', {
      prepareInvocation(params) {
        return { confirmationMessages: { title: 'Run Local Command', message: new vscode.MarkdownString(`Run locally:\n\`\`\`\n${params.input.command}\n\`\`\``) } };
      },
      async invoke(params) {
        const cwd = params.input.cwd
          ? resolveWorkspacePath(params.input.cwd)
          : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd());
        const timeoutMs = (params.input.timeout_secs ?? 30) * 1000;
        try {
          const { stdout, stderr } = await execAsync(params.input.command, { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT });
          return ok({ stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT), exitCode: 0 });
        } catch (e: unknown) {
          const err = e as { stdout?: string; stderr?: string; code?: number };
          return ok({ stdout: (err.stdout ?? '').slice(0, MAX_OUTPUT), stderr: (err.stderr ?? '').slice(0, MAX_OUTPUT), exitCode: err.code ?? 1 });
        }
      },
    })
  );
}
