import { app, BrowserWindow } from 'electron';
import { checkForUpdates } from './autoUpdater';
import path from 'path';
import { registerIpcHandlers } from './ipcHandlers';
import { lspClient } from './lspClient';
// DISABLED: Terminal functionality disabled to prevent antivirus quarantine
// import { registerTerminalHandlers } from './terminalManager';
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Use app.isPackaged to reliably detect production builds
  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:4200');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // In production, load the built files
    mainWindow.loadFile(path.join(__dirname, '../../dist/renderer-angular/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}


app.whenReady().then(async () => {
  createWindow();
  registerIpcHandlers(mainWindow!);
  // DISABLED: Terminal functionality disabled to prevent antivirus quarantine
  // registerTerminalHandlers(mainWindow!);

  // Check for updates on startup (one-click)
  setTimeout(() => {
    if (mainWindow) checkForUpdates(mainWindow);
  }, 3000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    lspClient.stop();
    app.quit();
  }
});
