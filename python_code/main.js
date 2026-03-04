const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

// Prevent Chromium GPU shader-cache "Access is denied" errors caused by
// stale/locked cache files left over from abrupt process termination.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-gpu-program-cache');
const { pipeline } = require('stream/promises');
const axios = require('axios');
const unzipper = require('unzipper');

let mainWindow;
let ollamaProcess, pythonProcess;

const OLLAMA_ZIP_URL = 'https://github.com/ollama/ollama/releases/download/v0.17.0/ollama-windows-amd64.zip';

// ── GitHub Copilot constants ───────────────────────────────────────────────
const COPILOT_CLIENT_ID    = process.env.COPILOT_CLIENT_ID    || 'Iv1.b507a08c87ecfe98';
const COPILOT_DEFAULT_MODEL = process.env.COPILOT_DEFAULT_MODEL || 'gpt-4o';
const COPILOT_FALLBACK_MODELS = ['gpt-4o', 'claude-3.5-sonnet', 'o1-preview'];

/**
 * Path to %LOCALAPPDATA%\github-copilot\apps.json
 * This mirrors how the official GitHub Copilot extension stores OAuth tokens.
 */
function getAppsJsonPath() {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'github-copilot', 'apps.json');
}

async function readAppsJson() {
    try {
        const content = await fsp.readFile(getAppsJsonPath(), 'utf8');
        return JSON.parse(content);
    } catch {
        return {};
    }
}

function extractCopilotOAuthToken(apps) {
    if (!apps || typeof apps !== 'object') return null;

    // Prefer the explicit github.com entry when present
    const githubEntry = apps['github.com'];
    if (githubEntry && typeof githubEntry === 'object' && githubEntry.oauth_token) {
        return githubEntry.oauth_token;
    }

    // Fallback: first oauth_token found in any apps.json entry
    for (const entry of Object.values(apps)) {
        if (entry && typeof entry === 'object' && entry.oauth_token) {
            return entry.oauth_token;
        }
    }
    return null;
}

async function getCopilotModelsFromApi(oauthToken) {
    try {
        const response = await axios.get('https://api.githubcopilot.com/models', {
            headers: {
                Authorization: `Bearer ${oauthToken}`,
                'Content-Type': 'application/json',
                'Editor-Version': 'vscode/1.85.0',
                'Editor-Plugin-Version': 'copilot-chat/0.12.0',
                'Copilot-Integration-Id': 'vscode-chat',
                'User-Agent': 'VCD-Agent/1.0.0',
                'X-GitHub-Api-Version': '2023-07-07',
            },
            timeout: 10000,
        });

        const data = response?.data;
        if (data && Array.isArray(data.data)) {
            const ids = data.data
                .map((item) => item && item.id)
                .filter((id) => typeof id === 'string');
            if (ids.length > 0) {
                return ids;
            }
        }
    } catch (err) {
        sendLog('copilot-get-models failed, using fallback: ' + (err && err.message ? err.message : err));
    }
    return COPILOT_FALLBACK_MODELS;
}

async function writeAppsJson(data) {
    const appsPath = getAppsJsonPath();
    await fsp.mkdir(path.dirname(appsPath), { recursive: true });
    await fsp.writeFile(appsPath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Path to llm_config.json – must match the path used by the Python backend:
 *   %APPDATA%\VCD-Agent\llm_config.json  (packaged)
 *   <repo>/gpu-ai-app/llm_config_dev/llm_config.json  (dev)
 */
function getLlmConfigPath() {
    if (app.isPackaged) {
        return path.join(app.getPath('appData'), 'VCD-Agent', 'llm_config.json');
    }
    return path.join(__dirname, 'llm_config_dev', 'llm_config.json');
}

async function writeLlmConfig(cfg) {
    const cfgPath = getLlmConfigPath();
    await fsp.mkdir(path.dirname(cfgPath), { recursive: true });
    await fsp.writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
}

// ── IPC: GitHub Copilot device-flow ───────────────────────────────────────
// NOTE: Device-flow tokens don't grant access to Copilot APIs.
// Users must install the official GitHub Copilot extension in VS Code and sign in there.

ipcMain.handle('copilot-auth-start', async () => {
    // Device-flow auth removed - it doesn't grant Copilot API access.
    // Return error directing user to install official Copilot extension.
    return {
        error: 'device_flow_unsupported',
        message: 'To use GitHub Copilot:\n\n' +
                 '1. Install the official GitHub Copilot extension in VS Code\n' +
                 '2. Sign in with your GitHub account (must have active Copilot subscription)\n' +
                 '3. Restart this application\n\n' +
                 'This app will automatically use the Copilot token from VS Code.'
    };
});

ipcMain.handle('copilot-auth-poll', async (_event, deviceCode) => {
    // Removed - see copilot-auth-start
    return { authenticated: false, error: 'device_flow_unsupported' };
});

ipcMain.handle('copilot-status', async () => {
    const apps = await readAppsJson();
    const oauthToken = extractCopilotOAuthToken(apps);
    if (!oauthToken) {
        return {
            connected: false,
            message: 'No Copilot token found. Please install GitHub Copilot extension in VS Code and sign in.'
        };
    }

    // Validate the stored token is still active
    try {
        const resp = await axios.get('https://api.github.com/user', {
            headers: {
                Authorization: `Bearer ${oauthToken}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            timeout: 8000,
        });
        if (resp.status === 200) {
            sendLog('Official Copilot token found and validated.');
            return { connected: true, official: true };
        }
    } catch (err) {
        if (err.response && err.response.status === 401) {
            sendLog('Copilot token expired or revoked.');
            return {
                connected: false,
                reason: 'token_expired',
                message: 'Copilot token has expired. Please re-authenticate in VS Code.'
            };
        }
        sendLog('Copilot token validation failed (network): ' + err.message);
    }
    return { connected: false };
});

ipcMain.handle('copilot-get-models', async () => {
    const apps = await readAppsJson();
    const oauthToken = extractCopilotOAuthToken(apps);
    if (!oauthToken) {
        return COPILOT_FALLBACK_MODELS;
    }
    return getCopilotModelsFromApi(oauthToken);
});

// Paths for bundled binaries
const getResourcePath = (subPath) => {
    return app.isPackaged 
        ? path.join(process.resourcesPath, 'bin', subPath)
        : path.join(__dirname, 'bin', subPath);
};
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

async function killExistingProcesses() {
    const processesToKill = ['ollama.exe', 'app.exe']; // Add your Flask exe name here
    for (const proc of processesToKill) {
        try {
            // /F = Force, /T = Tree (kills child processes), /IM = Image Name
            await execPromise(`taskkill /F /T /IM ${proc}`);
            sendLog(`Cleaned up existing instances of ${proc}`);
        } catch (e) {
            // taskkill throws an error if the process isn't running; we can ignore this.
            console.log(`${proc} was not running.`);
        }
    }
}
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900, height: 700,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false,
            corsEnabled:false
            
        }
    });
    mainWindow.loadFile('index.html');
}

async function ensureOllamaInstalled() {
    if (!app.isPackaged) return;

    const ollamaDir = getResourcePath('ollama-win');
    const exePath = path.join(ollamaDir, 'ollama.exe');

    try {
        await fsp.access(exePath);
        sendLog('Ollama already installed.');
        return;
    } catch {
        // Missing; continue with download.
    }

    try {
        sendStatus('Downloading Ollama...');
        sendLog('Starting Ollama download from: ' + OLLAMA_ZIP_URL);
        await fsp.mkdir(ollamaDir, { recursive: true });

        const tempDir = path.join(app.getPath('userData'), 'downloads');
        await fsp.mkdir(tempDir, { recursive: true });
        const zipPath = path.join(tempDir, 'ollama-windows-amd64.zip');

        const response = await axios({
            method: 'get',
            url: OLLAMA_ZIP_URL,
            responseType: 'stream',
            timeout: 60000
        });

        let received = 0;
        let total = parseInt(response.headers['content-length'] || '0', 10);
        sendLog(`Ollama zip size: ${total} bytes`);
        response.data.on('data', (chunk) => {
            received += chunk.length;
            if (total > 0) {
                const percent = Math.round((received / total) * 100);
                sendProgress(percent);
            }
        });
        await pipeline(response.data, fs.createWriteStream(zipPath));

        sendStatus('Extracting Ollama...');
        sendLog('Extracting Ollama zip to: ' + ollamaDir);
        await fs.createReadStream(zipPath)
            .pipe(unzipper.Extract({ path: ollamaDir }))
            .promise();

        sendStatus('Ollama ready.');
        sendLog('Ollama extraction complete.');
    } catch (err) {
        sendLog('Ollama install error: ' + (err && err.message ? err.message : err));
        sendStatus('Failed to install Ollama.');
        throw err;
    }
}
// Helper functions to send logs and status to renderer and file
const logDir = path.join(app.getPath('userData'), 'logs');
const logFile = path.join(logDir, 'app.log');
async function appendLogFile(msg) {
    try {
        await fsp.mkdir(logDir, { recursive: true });
        const line = `[${new Date().toISOString()}] ${msg}\n`;
        await fsp.appendFile(logFile, line, 'utf8');
    } catch (e) {
        // Ignore file logging errors
    }
}
function sendLog(msg) {
    console.log(msg);
    if (mainWindow) mainWindow.webContents.send('log', msg);
    appendLogFile(msg);
}
function sendStatus(msg) {
    if (mainWindow) mainWindow.webContents.send('status', msg);
    appendLogFile('[STATUS] ' + msg);
}
function sendProgress(percent) {
    if (mainWindow) mainWindow.webContents.send('progress', percent);
    appendLogFile(`[PROGRESS] ${percent}%`);
}

async function startServices() {
    const ollamaDir = getResourcePath('ollama-win');
    const appPath = getResourcePath(path.join('api-win', 'app.exe'));
    const modelsPath = path.join(app.getPath('userData'), 'ollama_models');
    // --- NEW: CLEAN UP FIRST ---
    sendStatus('Cleaning up background processes...');
    await killExistingProcesses();
    await ensureOllamaInstalled();

    // 1. Start Ollama
    ollamaProcess = spawn(path.join(ollamaDir, 'ollama.exe'), ['serve'], {
        env: {
            ...process.env, OLLAMA_MODELS: modelsPath,
            OLLAMA_MAX_LOADED_MODELS: "1", // Force only one model in VRAM
            OLLAMA_KEEP_ALIVE: "0",
            CUDA_VISIBLE_DEVICES: "0"   // Pin to GPU 0; avoids multi-device discovery timeout on laptop GPUs
        }
    });
    ollamaProcess.on('error', (err) => sendLog('Ollama spawn error: ' + err.message));
    ollamaProcess.stderr.on('data', (d) => sendLog('ollama: ' + d.toString()));

    // 2. Start Python Flask App
    sendLog('Starting Flask app from: ' + appPath);
    // pythonProcess = spawn(appPath, [], { 
    //     stdio: ['ignore', 'pipe', 'pipe'],
    //     windowsHide: true 
    // });
    // pythonProcess.on('error', (err) => {
    //     sendLog('Flask app spawn error: ' + err.message);
    //     sendStatus('Failed to start Flask app.');
    // });
    // pythonProcess.stdout.on('data', (d) => sendLog('app: ' + d.toString()));
    // pythonProcess.stderr.on('data', (d) => sendLog('app: ' + d.toString()));

    // Give Ollama 3 seconds to start up, then check/pull the model
    setTimeout(ensureModelExists, 3000);
}

async function waitForFlaskApp() {
    const maxRetries = 15;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await axios.get('http://127.0.0.1:5002/', { timeout: 2000 });
            if (response.status === 200) {
                console.log('Flask app is ready.');
                return true;
            }
        } catch (e) {
            console.log(`Waiting for Flask app... (${i + 1}/${maxRetries})`);
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    throw new Error('Flask app did not start in time.');
}

async function ensureModelExists() {
    const modelName = 'llama3.2:3b'; // Change to qwen3 or qwen2.5 based on what you need
    try {
        sendStatus('Checking for AI models...');
        const tags = await axios.get('http://127.0.0.1:11434/api/tags');
        const hasModel = tags.data.models.some(m => m.name.includes(modelName));

        if (!hasModel) {
            sendStatus(`Downloading ${modelName}... This uses GPU & Network.`);
            sendLog(`Pulling model: ${modelName}`);
            // Pull model via API to get clean progress stats
            const response = await axios({
                method: 'post',
                url: 'http://127.0.0.1:11434/api/pull',
                data: { name: modelName },
                responseType: 'stream'
            });

            response.data.on('data', (chunk) => {
                const lines = chunk.toString().split('\n').filter(Boolean);
                for (const line of lines) {
                    try {
                        const data = JSON.parse(line);
                        if (data.total) {
                            const percent = Math.round((data.completed / data.total) * 100);
                            sendProgress(percent);
                        }
                    } catch (parseErr) {
                        sendLog('Progress parse error: ' + parseErr.message);
                    }
                }
            });

            response.data.on('end', async () => {
                sendLog('Model download complete.');
                await loadFlaskApp();
            });
        } else {
            sendLog('Model already present.');
            await loadFlaskApp();
        }
    } catch (error) {
        sendLog('Ollama connection error: ' + error.message);
        sendStatus('Failed to connect to Local AI engine.');
    }
}

async function loadFlaskApp() {
    try {
        sendStatus('Loading application...');
        await waitForFlaskApp();
        mainWindow.loadURL('http://127.0.0.1:5002/');
    } catch (error) {
        sendLog('Error loading Flask app: ' + error.message);
        sendStatus('Failed to load application.');
    }
}


// LLM selection state
let selectedLLM = null;

app.whenReady().then(async () => {
    createWindow();
    try {     
          await startPythonOnly();

    } catch (err) {
        sendLog('Startup error: ' + err.message);
    }
    // Wait for renderer to send LLM selection
    ipcMain.on('llm-selected', async (event, llm) => {
        selectedLLM = llm;
        sendLog('LLM selected: ' + JSON.stringify(llm));
        try {
            // For Copilot: read the saved token from apps.json and write llm_config.json
            // so the Python backend can use it. The renderer never holds the raw token.
            if (llm.provider === 'copilot') {
                const apps = await readAppsJson();
                const oauthToken = extractCopilotOAuthToken(apps);
                if (!oauthToken) {
                    sendStatus('GitHub Copilot is not authenticated. Please connect first.');
                    return;
                }
                await writeLlmConfig({
                    provider: 'copilot',
                    model: llm.model || COPILOT_DEFAULT_MODEL,
                    credentials: { github_token: oauthToken },
                });
                sendLog('Wrote Copilot config to llm_config.json');
            }
            if (llm.provider === 'ollama') {
                await startServices(); // includes Ollama download/start
            } else {
                await loadFlaskApp();
            }
        } catch (err) {
            sendLog('Service startup error: ' + err.message);
        }
    });
});

// Start only the Python backend (no Ollama)
async function startPythonOnly() {
    const appPath = getResourcePath(path.join('api-win', 'app.exe'));
    sendLog('Starting Flask app from: ' + appPath);
    // pythonProcess = spawn(appPath, [], {
    //     stdio: ['ignore', 'pipe', 'pipe'],
    //     windowsHide: true
    // });
    // pythonProcess.on('error', (err) => {
    //     sendLog('Flask app spawn error: ' + err.message);
    //     sendStatus('Failed to start Flask app.');
    // });
    // pythonProcess.stdout.on('data', (d) => sendLog('app: ' + d.toString()));
    // pythonProcess.stderr.on('data', (d) => sendLog('app: ' + d.toString()));
    // await loadFlaskApp();
}

// ── Process cleanup ────────────────────────────────────────────────────
// Use synchronous taskkill so it works even during abrupt/crash exits.
// /F = force, /T = kill entire child-process tree, /PID = target by PID.
function cleanupProcessesSync() {
    const targets = [
        { proc: ollamaProcess, name: 'ollama.exe' },
        { proc: pythonProcess, name: 'app.exe' },
    ];
    for (const { proc, name } of targets) {
        // Kill by PID first (most precise); fall back to image name
        if (proc && proc.pid) {
            try {
                require('child_process').execFileSync(
                    'taskkill', ['/F', '/T', '/PID', String(proc.pid)],
                    { timeout: 4000 }
                );
            } catch (_) {}
        } else {
            try {
                require('child_process').execFileSync(
                    'taskkill', ['/F', '/T', '/IM', name],
                    { timeout: 4000 }
                );
            } catch (_) {}
        }
    }
}

// Graceful window close / app.quit()
app.on('before-quit', cleanupProcessesSync);
app.on('will-quit',   cleanupProcessesSync);

// Node.js-level exit (covers uncaught exceptions, process.exit(), etc.)
process.on('exit',     cleanupProcessesSync);
process.on('SIGTERM',  () => { cleanupProcessesSync(); process.exit(0); });
process.on('SIGINT',   () => { cleanupProcessesSync(); process.exit(0); });
process.on('SIGBREAK', () => { cleanupProcessesSync(); process.exit(0); }); // Ctrl+Break on Windows
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    cleanupProcessesSync();
    process.exit(1);
});
