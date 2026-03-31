/**
 * Execute Tools
 *
 * Run shell commands and applications on the local machine.
 * Mirrors the VS Code Copilot "execute" tool category.
 *
 * Security note: This tool executes arbitrary shell commands in the Node.js
 * main process. It is intended for local development use only.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { workspaceContext } from '../workspaceContext';

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_OUTPUT_BYTES = 50_000;   // 50 KB output cap

export interface RunCommandResult {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
}

/**
 * Run a shell command and return stdout, stderr, and exit code.
 *
 * Uses cmd.exe on Windows and /bin/sh on POSIX systems.
 * Output is capped at 50 KB to avoid flooding the LLM context.
 * Commands run in the workspace directory by default.
 *
 * @param command    The command string to execute
 * @param cwd        Working directory (default: workspace root)
 * @param timeoutMs  Timeout in milliseconds before the process is killed (default: 30000)
 */
export async function runCommand(
  command: string,
  cwd?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RunCommandResult> {
  const workspaceDir = workspaceContext.getWorkspacePath();
  const resolvedCwd = cwd ? workspaceContext.resolvePath(cwd) : workspaceDir;
  const start = Date.now();

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: resolvedCwd,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return {
      command,
      cwd: resolvedCwd,
      exitCode: 0,
      stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
      stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
      durationMs: Date.now() - start,
      timedOut: false,
    };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    const timedOut = e.killed === true || e.code === 'ETIMEDOUT';
    return {
      command,
      cwd: resolvedCwd,
      exitCode: typeof e.code === 'number' ? e.code : 1,
      stdout: (e.stdout ?? '').slice(0, MAX_OUTPUT_BYTES),
      stderr: (e.stderr ?? e.message ?? '').slice(0, MAX_OUTPUT_BYTES),
      durationMs: Date.now() - start,
      timedOut,
      error: e.message,
    };
  }
}
