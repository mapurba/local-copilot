/**
 * Execute Tools
 * Run shell commands from the workspace directory.
 */
const { exec }  = require('child_process');
const { promisify } = require('util');
const { workspaceContext } = require('./workspaceContext');

const execAsync = promisify(exec);
const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_OUTPUT_BYTES   = 50_000; // 50 KB

/**
 * Run a shell command and return stdout, stderr, and exit code.
 *
 * @param {string} command    Shell command to run
 * @param {string} [cwd]      Working directory (default: workspace root)
 * @param {number} [timeoutMs] Timeout in ms (default: 30000)
 */
async function runCommand(command, cwd, timeoutMs = DEFAULT_TIMEOUT_MS) {
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
  } catch (err) {
    const e = err;
    const timedOut = e.killed === true || e.code === 'ETIMEDOUT';
    return {
      command,
      cwd: resolvedCwd,
      exitCode: typeof e.code === 'number' ? e.code : 1,
      stdout: (e.stdout ?? '').slice(0, MAX_OUTPUT_BYTES),
      stderr: (e.stderr ?? e.message ?? '').slice(0, MAX_OUTPUT_BYTES),
      durationMs: Date.now() - start,
      timedOut,
    };
  }
}

module.exports = { runCommand };
