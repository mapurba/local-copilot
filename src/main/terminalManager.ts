// DISABLED: Terminal functionality disabled to prevent antivirus quarantine
// This file is kept for reference but all functionality is commented out

/*
import { ipcMain } from 'electron';
import * as pty from 'node-pty';
import * as os from 'os';

interface PtySession {
  pty: pty.IPty;
  terminalId: string;
  queryBuffer: string;
  pendingProbe?: {
    token: string;
    resolve: (payload: string) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  };
}

const activeSessions = new Map<string, PtySession>();

function stripAnsi(raw: string): string {
  return raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

function handleProbeOutput(session: PtySession, rawChunk: string): { visibleChunk: string; extractedPayload?: string } {
  const originalChunk = rawChunk;
  
  if (!session.pendingProbe) {
    return { visibleChunk: rawChunk };
  }

  session.queryBuffer += stripAnsi(rawChunk);

  const { token } = session.pendingProbe;
  const beginMarker = `__COPILOT_PROBE_BEGIN_${token}__`;
  const endMarker = `__COPILOT_PROBE_END_${token}__`;

  const beginIndex = session.queryBuffer.indexOf(beginMarker);
  const endIndex = session.queryBuffer.indexOf(endMarker);

  let extractedPayload: string | undefined;
  let visibleChunk = originalChunk;
  
  if (beginIndex >= 0 && endIndex > beginIndex) {
    // We have a complete probe response
    extractedPayload = session.queryBuffer.slice(beginIndex + beginMarker.length, endIndex);
    // Remove the entire probe section from buffer
    const beforeProbe = session.queryBuffer.slice(0, beginIndex);
    const afterProbe = session.queryBuffer.slice(endIndex + endMarker.length);
    session.queryBuffer = (beforeProbe + afterProbe).trim();
    
    // Suppress the probe from visible output
    visibleChunk = originalChunk
      .split('\n')
      .filter(line => !line.includes(beginMarker) && !line.includes(endMarker))
      .join('\n')
      .replace(/^\s*\n|\n\s*$/g, '');
  } else if (session.queryBuffer.includes(beginMarker) || session.queryBuffer.includes(endMarker)) {
    // We have partial probe markers, suppress them from view
    visibleChunk = originalChunk
      .split('\n')
      .filter(line => !line.includes(beginMarker) && !line.includes(endMarker))
      .join('\n')
      .replace(/^\s*\n|\n\s*$/g, '');
  }

  return { visibleChunk, extractedPayload };
}

export function registerTerminalHandlers(mainWindow: { webContents: { send: (channel: string, ...args: unknown[]) => void } }) {
  // Create a new PTY session
  ipcMain.handle('terminal:create', (_event, options: { terminalId: string; cols: number; rows: number; command?: string }) => {
    try {
      const { terminalId, cols, rows, command } = options;

      let finalShell: string;
      let finalArgs: string[];
      const isWindows = os.platform() === 'win32';

      if (command) {
        // Route command through shell to ensure executables are found in PATH
        if (isWindows) {
          finalShell = 'cmd.exe';
          finalArgs = ['/c', command];
        } else {
          finalShell = 'bash';
          finalArgs = ['-c', command];
        }
      } else {
        // Default interactive shell
        finalShell = isWindows ? 'cmd.exe' : 'bash';
        finalArgs = [];
      }

      console.log('[Terminal] Creating PTY:', finalShell, finalArgs, `${cols}x${rows}`);

      const ptyProcess = pty.spawn(finalShell, finalArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: os.homedir(),
        env: process.env as { [key: string]: string },
      });

      activeSessions.set(terminalId, { pty: ptyProcess, terminalId, queryBuffer: '' });

      ptyProcess.onData((data) => {
        const session = activeSessions.get(terminalId);
        if (!session) {
          return;
        }

        const { visibleChunk, extractedPayload } = handleProbeOutput(session, data);
        if (visibleChunk) {
          mainWindow.webContents.send('terminal:data', { terminalId, data: visibleChunk });
        }

        if (typeof extractedPayload === 'string' && session.pendingProbe) {
          clearTimeout(session.pendingProbe.timeout);
          session.pendingProbe.resolve(extractedPayload);
          session.pendingProbe = undefined;
        }
      });

      ptyProcess.onExit(({ exitCode }) => {
        console.log(`[Terminal] PTY ${terminalId} exited with code ${exitCode}`);
        mainWindow.webContents.send('terminal:data', { terminalId, data: `\r\n[Process exited with code ${exitCode}]\r\n` });
        const session = activeSessions.get(terminalId);
        if (session?.pendingProbe) {
          clearTimeout(session.pendingProbe.timeout);
          session.pendingProbe.reject(new Error('Terminal closed before probe completed'));
        }
        activeSessions.delete(terminalId);
      });

      return { success: true, terminalId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Terminal] Failed to create PTY:', message);
      return { success: false, error: message };
    }
  });

  // Send input to PTY
  ipcMain.handle('terminal:input', (_event, options: { terminalId: string; data: string }) => {
    const { terminalId, data } = options;
    const session = activeSessions.get(terminalId);
    if (!session) {
      return { success: false, error: 'Terminal not found' };
    }

    try {
      session.pty.write(data);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Resize PTY
  ipcMain.handle('terminal:resize', (_event, options: { terminalId: string; cols: number; rows: number }) => {
    const { terminalId, cols, rows } = options;
    const session = activeSessions.get(terminalId);
    if (!session) {
      return { success: false, error: 'Terminal not found' };
    }

    try {
      session.pty.resize(cols, rows);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Close PTY
  ipcMain.handle('terminal:close', (_event, options: { terminalId: string }) => {
    const { terminalId } = options;
    const session = activeSessions.get(terminalId);
    if (!session) {
      return { success: false, error: 'Terminal not found' };
    }

    try {
      if (session.pendingProbe) {
        clearTimeout(session.pendingProbe.timeout);
        session.pendingProbe.reject(new Error('Terminal closed'));
      }
      session.pty.kill();
      activeSessions.delete(terminalId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('terminal:queryCwd', async (_event, options: { terminalId: string }) => {
    const { terminalId } = options;
    const session = activeSessions.get(terminalId);
    if (!session) {
      return { success: false, error: 'Terminal not found' };
    }

    if (session.pendingProbe) {
      return { success: false, error: 'A terminal probe is already in progress' };
    }

    const token = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // Use silent execution: { ... } 2>&1 sends all output (including errors) to stdout without showing the subshell
    const script = `{ echo __COPILOT_PROBE_BEGIN_${token}__; pwd; echo __COPILOT_PROBE_END_${token}__; } 2>&1\r`;

    try {
      const payload = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          session.pendingProbe = undefined;
          reject(new Error('Directory query timed out'));
        }, 5000);

        session.pendingProbe = {
          token,
          resolve,
          reject,
          timeout,
        };

        session.pty.write(script);
      });

      const lines = payload
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const pathLines = lines.filter((line) => line.startsWith('/'));
      const cwd = pathLines.length > 0 ? pathLines[pathLines.length - 1] : '';

      if (!cwd) {
        return { success: false, error: 'Unable to read current directory from terminal' };
      }

      return { success: true, cwd };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('terminal:querySshContext', async (_event, options: { terminalId: string }) => {
    const { terminalId } = options;
    const session = activeSessions.get(terminalId);
    if (!session) {
      return { success: false, error: 'Terminal not found' };
    }

    if (session.pendingProbe) {
      return { success: false, error: 'A terminal probe is already in progress' };
    }

    const token = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // Use subshell to keep probe invisible and clean: { ... } 2>&1
    const script = `{ echo __COPILOT_PROBE_BEGIN_${token}__; whoami; echo "$SSH_CONNECTION"; echo __COPILOT_PROBE_END_${token}__; } 2>&1\r`;

    try {
      const payload = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          session.pendingProbe = undefined;
          reject(new Error('SSH context query timed out'));
        }, 5000);

        session.pendingProbe = {
          token,
          resolve,
          reject,
          timeout,
        };

        session.pty.write(script);
      });

      const lines = payload
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      if (lines.length < 2) {
        return { success: true, connected: false };
      }

      const username = lines[0];
      const connectionLine = lines.find((line) => line.includes(' ')) || lines[lines.length - 1];
      const parts = connectionLine.split(/\s+/);

      if (parts.length < 4) {
        return { success: true, connected: false, username };
      }

      const host = parts[2];
      const port = Number(parts[3]) || 22;

      return { success: true, connected: true, username, host, port };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
*/