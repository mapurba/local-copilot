import { ipcMain } from 'electron';
import * as pty from 'node-pty';
import * as os from 'os';

interface PtySession {
  pty: pty.IPty;
  terminalId: string;
}

const activeSessions = new Map<string, PtySession>();

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

      activeSessions.set(terminalId, { pty: ptyProcess, terminalId });

      ptyProcess.onData((data) => {
        mainWindow.webContents.send('terminal:data', { terminalId, data });
      });

      ptyProcess.onExit(({ exitCode }) => {
        console.log(`[Terminal] PTY ${terminalId} exited with code ${exitCode}`);
        mainWindow.webContents.send('terminal:data', { terminalId, data: `\r\n[Process exited with code ${exitCode}]\r\n` });
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
      session.pty.kill();
      activeSessions.delete(terminalId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
