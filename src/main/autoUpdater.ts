import { app, dialog } from 'electron';
import https from 'https';
import fs from 'fs';
import path from 'path';

const UPDATE_URL = process.env.COPILOT_CHAT_UPDATE_URL || '';

export async function checkForUpdates(mainWindow: Electron.BrowserWindow) {
  try {
    if (!UPDATE_URL) {
      return;
    }

    // 1. Fetch latest.json
    const latest = await fetchJson(UPDATE_URL);
    if (!latest?.version || !latest?.url) return;

    // 2. Compare with current version
    const currentVersion = app.getVersion();
    if (compareVersions(latest.version, currentVersion) <= 0) return;

    // 3. Prompt user for update (one-click)
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Update Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update Available',
      message: `A new version (${latest.version}) is available.\n\n${latest.notes || ''}`,
      detail: 'Click "Update Now" to download and install the update automatically.',
    });
    if (result.response !== 0) {
      // User clicked 'Later', notify renderer to hide update toast
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('update-cancelled');
      }
      return;
    }

    // 4. Download new installer
    const tmpPath = path.join(app.getPath('temp'), path.basename(latest.url));
    await downloadFile(latest.url, tmpPath, (progress) => {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('update-download-progress', progress);
      }
    });

    // 5. Launch installer and quit app
    require('child_process').spawn(tmpPath, [], {
      detached: true,
      stdio: 'ignore',
    });
    app.quit();
  } catch (err) {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('update-download-progress', 0);
    }
    dialog.showErrorBox('Update Error', String(err));
  }
}

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function downloadFile(url: string, dest: string, onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    
    const request = https.get(url, (response) => {
      // Handle HTTP redirects (301, 302, 307, 308)
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlink(dest, () => {
          downloadFile(response.headers.location!, dest, onProgress).then(resolve).catch(reject);
        });
        return;
      }
      
      const total = parseInt(response.headers['content-length'] || '0', 10);
      let downloaded = 0;
      response.pipe(file);
      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (onProgress && total) onProgress(Math.round((downloaded / total) * 100));
      });
      file.on('finish', () => file.close(() => resolve()));
    });
    
    request.on('error', (err) => {
      file.close();
      fs.unlink(dest, () => reject(err));
    });
  });
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}
