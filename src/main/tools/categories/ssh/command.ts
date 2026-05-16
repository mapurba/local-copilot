/**
 * SSH Command Execution Tools
 * runCommand, runSudoCommand, runScript, startBackground, killProcess, listProcesses
 */

import { toolRegistry } from '../../registry';
import { getActiveSession } from './session';
import { z } from 'zod';

const MAX_OUTPUT = 100 * 1024; // 100 KB

function execOnSession(
  sessionId: string,
  command: string,
  timeoutMs = 30000
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const session = getActiveSession(sessionId);
    if (!session) {
      reject(new Error(`SSH session not found: ${sessionId}`));
      return;
    }

    // Update last used
    session.info.lastUsedAt = Date.now();

    session.client.exec(command, (err: Error | undefined, stream: import('ssh2').ClientChannel) => {
      if (err) {
        reject(new Error(`exec failed: ${err.message}`));
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        stream.close();
      }, timeoutMs);

      stream.on('data', (data: Buffer) => {
        stdout += data.toString();
        if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(-MAX_OUTPUT);
      });

      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
        if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(-MAX_OUTPUT);
      });

      stream.on('close', (code: number) => {
        clearTimeout(timer);
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 0, timedOut });
      });

      stream.on('error', (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  });
}

export function registerSshCommandTools() {
  // ── ssh:runCommand ────────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:runCommand',
    async (args: { sessionId: string; command: string; timeoutSecs?: number }) => {
      const { sessionId, command, timeoutSecs = 30 } = args;
      const result = await execOnSession(sessionId, command, timeoutSecs * 1000);
      return result;
    },
    {
      category: 'ssh',
      description: 'Run a shell command on a remote SSH session',
      target: 'remote',
      riskLevel: 'review',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
        command: z.string().describe('Shell command to execute'),
        timeoutSecs: z.number().optional().describe('Timeout in seconds (default 30)'),
      }),
    }
  );

  // ── ssh:runSudoCommand ────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:runSudoCommand',
    async (args: { sessionId: string; command: string; sudoPassword?: string; timeoutSecs?: number }) => {
      const { sessionId, command, sudoPassword, timeoutSecs = 30 } = args;
      const sudoCmd = sudoPassword
        ? `echo '${sudoPassword.replace(/'/g, "'\\''")}' | sudo -S ${command}`
        : `sudo ${command}`;
      const result = await execOnSession(sessionId, sudoCmd, timeoutSecs * 1000);
      return result;
    },
    {
      category: 'ssh',
      description: 'Run a command with sudo on a remote SSH session',
      target: 'remote',
      riskLevel: 'dangerous',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
        command: z.string().describe('Command to run with sudo'),
        sudoPassword: z.string().optional().describe('Sudo password if required'),
        timeoutSecs: z.number().optional().describe('Timeout in seconds (default 30)'),
      }),
    }
  );

  // ── ssh:runScript ─────────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:runScript',
    async (args: { sessionId: string; script: string; shell?: string; timeoutSecs?: number }) => {
      const { sessionId, script, shell = '/bin/bash', timeoutSecs = 60 } = args;
      // Encode script as base64 to avoid quoting issues
      const encoded = Buffer.from(script).toString('base64');
      const command = `echo '${encoded}' | base64 -d | ${shell}`;
      const result = await execOnSession(sessionId, command, timeoutSecs * 1000);
      return result;
    },
    {
      category: 'ssh',
      description: 'Execute a multi-line shell script on a remote SSH session',
      target: 'remote',
      riskLevel: 'dangerous',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
        script: z.string().describe('Shell script content (multi-line)'),
        shell: z.string().optional().describe('Shell interpreter (default: /bin/bash)'),
        timeoutSecs: z.number().optional().describe('Timeout in seconds (default 60)'),
      }),
    }
  );

  // ── ssh:listProcesses ─────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:listProcesses',
    async (args: { sessionId: string; filter?: string }) => {
      const { sessionId, filter } = args;
      const cmd = filter
        ? `ps aux | grep -i '${filter}' | grep -v grep`
        : 'ps aux --no-header | head -40';
      const result = await execOnSession(sessionId, cmd, 10000);
      const processes = result.stdout
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const parts = line.trim().split(/\s+/);
          return {
            user: parts[0],
            pid: parts[1],
            cpu: parts[2],
            mem: parts[3],
            command: parts.slice(10).join(' '),
          };
        });
      return { count: processes.length, processes, raw: result.stdout };
    },
    {
      category: 'ssh',
      description: 'List running processes on a remote SSH host',
      target: 'remote',
      riskLevel: 'safe',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
        filter: z.string().optional().describe('Filter processes by name'),
      }),
    }
  );

  // ── ssh:killProcess ───────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:killProcess',
    async (args: { sessionId: string; pid: string; signal?: string }) => {
      const { sessionId, pid, signal = '15' } = args;
      const result = await execOnSession(sessionId, `kill -${signal} ${pid}`, 5000);
      return { success: result.exitCode === 0, ...result };
    },
    {
      category: 'ssh',
      description: 'Kill a process on a remote SSH host by PID',
      target: 'remote',
      riskLevel: 'dangerous',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
        pid: z.string().describe('Process ID to kill'),
        signal: z.string().optional().describe('Signal number (default 15/SIGTERM, use 9 for SIGKILL)'),
      }),
    }
  );

  // ── ssh:startBackground ───────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:startBackground',
    async (args: { sessionId: string; command: string; logFile?: string }) => {
      const { sessionId, command, logFile = '/tmp/bg-process.log' } = args;
      const bgCmd = `nohup ${command} > ${logFile} 2>&1 & echo $!`;
      const result = await execOnSession(sessionId, bgCmd, 10000);
      const pid = result.stdout.trim();
      return { success: result.exitCode === 0, pid, logFile, ...result };
    },
    {
      category: 'ssh',
      description: 'Start a background process (nohup) on a remote SSH host',
      target: 'remote',
      riskLevel: 'dangerous',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
        command: z.string().describe('Command to run in background'),
        logFile: z.string().optional().describe('Log file path (default: /tmp/bg-process.log)'),
      }),
    }
  );
}
