/**
 * Local Execute Tools
 * 
 * Tools for running shell commands in the local environment.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';
import { ToolRegistry } from '../../registry';

const execAsync = promisify(exec);
const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_OUTPUT_BYTES = 50_000; // 50 KB

/**
 * Get workspace root path
 */
function getWorkspacePath(): string {
  return process.env.WORKSPACE_PATH || app.getPath('userData');
}

/**
 * Run a shell command
 */
export async function runCommand(args: {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<{
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}> {
  const workspaceDir = getWorkspacePath();
  const resolvedCwd = args.cwd || workspaceDir;
  const start = Date.now();

  try {
    const { stdout, stderr } = await execAsync(args.command, {
      cwd: resolvedCwd,
      timeout: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });

    return {
      command: args.command,
      cwd: resolvedCwd,
      exitCode: 0,
      stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
      stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
      durationMs: Date.now() - start,
      timedOut: false,
    };
  } catch (err: unknown) {
    const e = err as {
      code?: string | number;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const timedOut = e.killed === true || e.code === 'ETIMEDOUT';

    return {
      command: args.command,
      cwd: resolvedCwd,
      exitCode: typeof e.code === 'number' ? e.code : 1,
      stdout: (e.stdout ?? '').slice(0, MAX_OUTPUT_BYTES),
      stderr: (e.stderr ?? e.message ?? '').slice(0, MAX_OUTPUT_BYTES),
      durationMs: Date.now() - start,
      timedOut,
    };
  }
}

/**
 * Register local execute tools
 */
export function registerLocalExecuteTools(registry: ToolRegistry): void {
  registry.register('local:runCommand', runCommand, {
    category: 'local',
    description: 'Run a shell command and return stdout, stderr, and exit code',
    target: 'local',
    riskLevel: 'review', // Review because it can execute arbitrary commands
  });
}
