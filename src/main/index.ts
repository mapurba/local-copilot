import { app, BrowserWindow, Menu } from 'electron';
import { checkForUpdates } from './autoUpdater';
import path from 'path';
import fs from 'fs';
import { registerIpcHandlers } from './ipcHandlers';
import { lspClient } from './lspClient';
// DISABLED: Terminal functionality disabled to prevent antivirus quarantine
// import { registerTerminalHandlers } from './terminalManager';
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

let mainWindow: BrowserWindow | null = null;

function createMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'Exit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Y', role: 'redo' },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', role: 'paste' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', role: 'forceReload' },
        { label: 'Toggle DevTools', accelerator: 'F12', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', role: 'zoomIn' },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About',
          click: () => {
            console.log('Copilot Chat v1.0.0');
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false, // Don't show until ready-to-show
  });

  const isDevMode = !app.isPackaged;
  const startUrl = process.env.ELECTRON_START_URL;
  const resolveLocalIndexPath = () => {
    const appPath = app.getAppPath();
    const candidates = [
      // Preferred: renderer output colocated under dist-electron.
      path.join(__dirname, '../renderer-angular/browser/index.html'),
      // Compatibility fallback during transition.
      path.join(__dirname, '../../dist/renderer-angular/browser/index.html'),
      // Packaged app fallbacks.
      path.join(appPath, 'dist-electron/renderer-angular/browser/index.html'),
      path.join(appPath, 'dist/renderer-angular/browser/index.html'),
      path.join(appPath, 'dist/renderer-angular/index.html'),
      path.join(appPath, 'dist/index.html'),
    ];

    const existing = candidates.find((candidate) => {
      try {
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    });

    return existing || candidates[0];
  };

  const distIndexPath = resolveLocalIndexPath();

  // Handle SPA routing: redirect non-HTML routes back to index
  if (!isDevMode) {
    mainWindow.webContents.on('will-navigate', (event, url) => {
      try {
        const nextUrl = new URL(url);
        if (nextUrl.protocol !== 'file:') {
          return; // Allow external URLs
        }

        const pathname = nextUrl.pathname;
        const isApiPath = /\/api(?:\/|$)/.test(pathname);
        const isIndexFile = pathname.endsWith('/index.html');
        const isBrowserRoot = pathname.includes('/browser') && (pathname.endsWith('/browser') || pathname.endsWith('/browser/'));

        // Redirect client-side routes back to index.html so Angular router handles them
        if (!isApiPath && !isIndexFile && !isBrowserRoot) {
          event.preventDefault();
          mainWindow?.loadFile(distIndexPath).catch((err) => {
            console.error('[Main] Failed to load fallback index:', err);
          });
        }
      } catch (_error) {
        // Ignore URL parsing errors
      }
    });

    // Recovery: if file:// route fails to load, redirect to index.html
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, _description, validatedURL) => {
      if (validatedURL?.startsWith('file:') && (errorCode === -6 || errorCode === -2)) {
        console.warn(`[Main] Failed to load ${validatedURL}, attempting fallback to index`);
        mainWindow?.loadFile(distIndexPath).catch((err) => {
          console.error('[Main] Fallback load failed:', err);
        });
      }
    });
  }

  // Load the app
  if (isDevMode && startUrl) {
    // Development: load from dev server
    mainWindow.loadURL(startUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else if (isDevMode) {
    // Dev mode without env server: load from dist
    mainWindow.loadFile(distIndexPath).catch((err) => {
      console.error('[Main] Failed to load dist/index:', err);
    });
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // Production: always load local renderer bundle from dist-electron first.
    console.log('[Main] App path:', app.getAppPath());
    console.log('[Main] Loading renderer index:', distIndexPath);
    mainWindow.loadFile(distIndexPath).catch((err) => {
      const errorMsg = `Unable to load app bundle from ${distIndexPath}`;
      console.error('[Main]', errorMsg, err instanceof Error ? err.message : String(err));
      mainWindow?.loadURL(
        'data:text/html,<h1>Error</h1><p>' + errorMsg + '</p><p>Reload (Ctrl+R) to retry</p>'
      );
    });
  }

  // Show window when ready to avoid visual flash
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Handle reload (Ctrl+R works in dev, menu handles it in production too)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && input.key.toLowerCase() === 'r') {
      mainWindow?.reload();
      event.preventDefault();
    }
  });

  // Handle external links - open in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  // Log render process errors
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[Main] Preload error in', preloadPath, ':', error);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Main] Render process gone:', details?.reason);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  createMenu();
  createWindow();
  registerIpcHandlers(mainWindow!);
  // DISABLED: Terminal functionality disabled to prevent antivirus quarantine
  // registerTerminalHandlers(mainWindow!);

  // Check for updates after app settles
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
