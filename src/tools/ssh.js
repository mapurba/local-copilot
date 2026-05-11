/**
 * SSH Tools
 *
 * Provides an AI agent with everything it needs to operate on a remote VM
 * over SSH — without any of the pitfalls of interactive terminal sessions.
 *
 * All tools are prefixed  ssh:  so they never collide with the local
 * filesystem / execute tools (custom:readFile, custom:runCommand, etc.).
 *
 * Connection config is read from environment variables (see sshConfig()),
 * or passed explicitly as a config object to any tool call.
 *
 * ── Tool catalogue ──────────────────────────────────────────────────────────
 *
 * Sessions
 *   ssh:connect             Open a named persistent session (reused across calls)
 *   ssh:disconnect          Close and discard a named session
 *   ssh:listSessions        List all open sessions and their state
 *
 * Command execution
 *   ssh:runCommand          Run a command, wait, return stdout/stderr/exitCode
 *   ssh:runSudoCommand      Like runCommand but prepends sudo via stdin password
 *   ssh:startBackground     Fire-and-forget; returns a taskId
 *   ssh:checkBackground     Poll stdout/stderr/status of a background task
 *   ssh:killProcess         Kill a remote process by PID
 *
 * File operations  (remote only — no clash with local custom:readFile etc.)
 *   ssh:readRemoteFile      Read a remote file (capped at 2000 lines)
 *   ssh:writeRemoteFile     Write/overwrite a remote file
 *   ssh:appendRemoteFile    Append text to a remote file
 *   ssh:searchRemoteFile    grep a remote file for a pattern
 *   ssh:listRemoteDir       List a remote directory as structured JSON
 *   ssh:uploadFile          SCP a local file → remote path
 *   ssh:downloadFile        SCP a remote file → local path
 *
 * System diagnostics
 *   ssh:systemInfo          OS, CPU, memory, disk — returned as JSON
 *   ssh:networkStatus       Ping test + open port check
 */

const { Client } = require('ssh2');
const fs         = require('fs');
const path       = require('path');

// ── Connection config ─────────────────────────────────────────────────────────

/**
 * Build a connection config from environment variables.
 * Any tool that accepts an explicit `config` arg will merge it on top of this.
 *
 * Environment variables:
 *   SSH_HOST            remote hostname or IP  (required)
 *   SSH_PORT            port (default 22)
 *   SSH_USER            username              (required)
 *   SSH_PASSWORD        password auth
 *   SSH_KEY_PATH        path to private key file (preferred over password)
 *   SSH_PASSPHRASE      passphrase for the private key (if encrypted)
 *   SSH_SUDO_PASSWORD   password used by ssh:runSudoCommand
 */
function sshConfig(override = {}) {
  const keyPath = process.env.SSH_KEY_PATH;
  const base = {
    host:       process.env.SSH_HOST,
    port:       Number(process.env.SSH_PORT ?? 22),
    username:   process.env.SSH_USER,
    readyTimeout: 10_000,
    ...(keyPath
      ? { privateKey: fs.readFileSync(keyPath), passphrase: process.env.SSH_PASSPHRASE }
      : { password: process.env.SSH_PASSWORD }),
  };
  return { ...base, ...override };
}

// ── Session store ─────────────────────────────────────────────────────────────
// Named sessions stay alive so the agent can run follow-up commands without
// paying the connection-setup cost each time.
//
// Two indexes:
//   sessions       sessionId  → session object
//   sessionsByHost host       → sessionId   (lets the LLM pass a host IP instead)

const sessions       = new Map();
const sessionsByHost = new Map();

/**
 * Resolve a session by sessionId, host IP, or auto-pick if only one is active.
 *
 * Resolution order:
 *   1. No argument / null  → use the single active session (error if 0 or >1)
 *   2. Exact sessionId match in `sessions`
 *   3. Host/IP match in `sessionsByHost` (LLM may pass the IP it remembers)
 *   4. Not found → helpful error listing active sessions
 *
 * Returns the session object, or { _err: string } on failure.
 */
function requireSession(ref) {
  // 1. Auto-pick the only active session
  if (!ref) {
    const ready = [...sessions.entries()].filter(([, s]) => s.state === 'ready');
    if (ready.length === 1) return ready[0][1];
    if (ready.length === 0) {
      return { _err: 'No active SSH sessions. Call ssh:connect with host, username, and password first.' };
    }
    const ids = ready.map(([id, s]) => `${id} (${s.host})`).join(', ');
    return { _err: `Multiple sessions active: ${ids}. Pass a sessionId to specify which VM to use.` };
  }

  // 2. Direct sessionId lookup
  if (sessions.has(ref)) {
    const s = sessions.get(ref);
    if (s.state !== 'ready') return { _err: `Session '${ref}' is not ready (state: ${s.state}). Call ssh:connect again.` };
    return s;
  }

  // 3. Host/IP lookup (LLM passes '10.x.x.x' instead of the session label)
  if (sessionsByHost.has(ref)) {
    const sid = sessionsByHost.get(ref);
    const s   = sessions.get(sid);
    if (s && s.state === 'ready') return s;
  }

  // 4. Not found
  const active = [...sessions.entries()]
    .filter(([, s]) => s.state === 'ready')
    .map(([id, s]) => `${id} (${s.host})`);
  const hint = active.length
    ? `Active sessions: ${active.join(', ')}. Use one of those sessionIds, or call ssh:listSessions.`
    : 'No active sessions. Call ssh:connect with host, username, and password.';
  return { _err: `Session '${ref}' not found. ${hint}` };
}

// ── Background task store ─────────────────────────────────────────────────────
const backgroundTasks = new Map(); // taskId → { command, stdout, stderr, exitCode, running }
let taskCounter = 0;

// ── Low-level exec helper ─────────────────────────────────────────────────────

/**
 * Execute a command on an existing ssh2 Client.
 * Returns { stdout, stderr, exitCode }.
 */
function execOnClient(client, command, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const MAX = 200_000;
    let stdout = '', stderr = '';
    let timer;

    client.exec(command, { pty: false }, (err, stream) => {
      if (err) return reject(err);

      timer = setTimeout(() => {
        stream.close();
        resolve({ stdout: stdout.slice(0, MAX), stderr: stderr.slice(0, MAX) + '\n[TIMED OUT]', exitCode: -1 });
      }, timeoutMs);

      stream
        .on('data',   (d) => { stdout += d; if (stdout.length > MAX) stdout = stdout.slice(-MAX); })
        .stderr.on('data', (d) => { stderr += d; if (stderr.length > MAX) stderr = stderr.slice(-MAX); });

      stream.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout: stdout.slice(0, MAX), stderr: stderr.slice(0, MAX), exitCode: code ?? 0 });
      });
    });
  });
}

// ── Connect a fresh client ────────────────────────────────────────────────────

function connectClient(config) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client
      .on('ready', () => resolve(client))
      .on('error', reject)
      .connect(config);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Sessions
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Open a named SSH session. Subsequent ssh:runCommand calls can reuse it.
 *
 * Connection details are resolved in this priority order:
 *   1. Explicit values in the config object   (passed by the LLM / user at call time)
 *   2. Environment variables                  (set in .env by the operator)
 *
 * If neither source provides host/username/password, the tool returns an error
 * that tells the LLM exactly what to ask the user for.
 *
 * @param {string} sessionId     Arbitrary label, e.g. 'prod' or 'worker-1'
 * @param {object} [config]      Explicit connection params (override env vars)
 * @param {string} [config.host]         Remote IP or hostname
 * @param {string} [config.username]     SSH username
 * @param {string} [config.password]     SSH password
 * @param {number} [config.port]         SSH port (default 22)
 * @param {string} [config.sudoPassword] sudo password (defaults to SSH password)
 * @param {string} [config.privateKey]   PEM private key content (alternative to password)
 * @param {string} [config.passphrase]   Passphrase for an encrypted private key
 */
async function connect(sessionId, config = {}) {
  // The LLM sometimes passes all connection details as the first argument
  // (a single object) instead of (sessionId, configObject).
  // Detect that and shift the args so things work either way.
  if (sessionId && typeof sessionId === 'object') {
    config    = sessionId;
    sessionId = config.sessionId ?? 'default';
  }
  if (!sessionId) sessionId = 'default';

  if (sessions.has(sessionId)) {
    const s = sessions.get(sessionId);
    if (s.state === 'ready') return { sessionId, status: 'already connected', host: s.host, user: s.username };
    sessions.get(sessionId).client.end();
    sessions.delete(sessionId);
  }

  const cfg = sshConfig(config);

  // Validate — tell the LLM exactly what to collect from the user
  if (!cfg.host) {
    return { error: 'Missing host. Ask the user: "What is the IP address or hostname of the remote VM?" Then call ssh:connect again with config.host set.' };
  }
  if (!cfg.username) {
    return { error: 'Missing username. Ask the user: "What SSH username should I use to connect?" Then call ssh:connect again with config.username set.' };
  }
  if (!cfg.password && !cfg.privateKey) {
    return { error: 'Missing credentials. Ask the user: "What is the SSH password for that VM?" Then call ssh:connect again with config.password set.' };
  }

  const entry = { state: 'connecting', client: null, host: cfg.host, username: cfg.username };
  sessions.set(sessionId, entry);

  try {
    const client = await connectClient(cfg);
    entry.client      = client;
    entry.state       = 'ready';
    entry.sessionId   = sessionId;
    // sudo password: explicit > env var > fall back to the SSH password itself
    entry.sudoPassword = config.sudoPassword ?? process.env.SSH_SUDO_PASSWORD ?? cfg.password ?? null;
    // Register in host index so later calls can find this session by IP
    sessionsByHost.set(cfg.host, sessionId);
    client.on('end',   () => { entry.state = 'closed'; sessionsByHost.delete(cfg.host); });
    client.on('error', () => { entry.state = 'error';  sessionsByHost.delete(cfg.host); });
    return { sessionId, status: 'connected', host: cfg.host, user: cfg.username, port: cfg.port };
  } catch (err) {
    sessions.delete(sessionId);
    return { error: `SSH connection failed: ${err.message}` };
  }
}

/**
 * Close a named session.
 *
 * @param {string} sessionId
 */
async function disconnect(sessionId) {
  // Also accept host IP
  const resolvedId = sessions.has(sessionId)
    ? sessionId
    : (sessionsByHost.has(sessionId) ? sessionsByHost.get(sessionId) : sessionId);

  const s = sessions.get(resolvedId);
  if (!s) return { error: `Session '${sessionId}' not found.` };
  sessionsByHost.delete(s.host);
  try { s.client?.end(); } catch (_) {}
  sessions.delete(resolvedId);
  return { sessionId: resolvedId, status: 'disconnected' };
}

/**
 * List all open SSH sessions.
 * The LLM should call this to find sessionIds for subsequent tool calls.
 */
async function listSessions() {
  if (sessions.size === 0) {
    return { sessions: [], hint: 'No active sessions. Call ssh:connect with host, username, and password to connect to a VM.' };
  }
  return {
    sessions: [...sessions.entries()].map(([id, s]) => ({
      sessionId: id,
      host:      s.host,
      username:  s.username,
      state:     s.state,
    })),
    hint: 'Pass sessionId (or the host IP) to any ssh: tool to target a specific VM.',
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Command Execution
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Run a command on the remote host (blocking, up to timeoutMs).
 * Uses a named session if sessionId is given; otherwise opens a one-shot connection.
 *
 * @param {string} command
 * @param {string} [sessionId]   Use an open session (preferred)
 * @param {number} [timeoutMs]   Default 30 s
 * @param {object} [config]      One-shot connection config (if no session)
 */
async function runCommand(command, sessionId, timeoutMs = 30_000) {
  if (!command) return { error: 'command is required.' };
  const s = requireSession(sessionId);
  if (s._err) return { error: s._err };

  try {
    const result = await execOnClient(s.client, command, timeoutMs);
    return { command, sessionId: s.sessionId, host: s.host, ...result };
  } catch (err) {
    return { command, error: err.message, exitCode: -1 };
  }
}

/**
 * Run a command with sudo, passing the password via stdin.
 * Requires SSH_SUDO_PASSWORD env var or the session was opened with sudoPassword.
 *
 * @param {string} command       The command to run (without "sudo")
 * @param {string} [sessionId]
 * @param {number} [timeoutMs]
 * @param {object} [config]
 */
async function runSudoCommand(command, sessionId, timeoutMs = 30_000) {
  if (!command) return { error: 'command is required.' };
  const s = requireSession(sessionId);
  if (s._err) return { error: s._err };

  if (!s.sudoPassword) {
    return { error: 'No sudo password stored for this session. Reconnect via ssh:connect and pass sudoPassword (or it defaults to the SSH password).' };
  }

  const wrapped = `echo ${JSON.stringify(s.sudoPassword)} | sudo -S -p '' ${command}`;
  return runCommand(wrapped, s.sessionId, timeoutMs);
}

/**
 * Start a long-running command in the background. Returns a taskId immediately.
 *
 * @param {string} command
 * @param {string} [sessionId]
 * @param {object} [config]
 */
async function startBackground(command, sessionId, config = {}) {
  const s = requireSession(sessionId);
  if (s._err) return { error: s._err };

  const taskId = `task-${++taskCounter}`;
  const task   = { command, stdout: '', stderr: '', exitCode: null, running: true, startedAt: new Date().toISOString() };
  backgroundTasks.set(taskId, task);

  (async () => {
    try {
      await new Promise((resolve) => {
        s.client.exec(command, { pty: false }, (err, stream) => {
          if (err) { task.stderr += err.message; task.running = false; task.exitCode = -1; return resolve(); }
          stream.on('data',        (d) => { task.stdout += d; });
          stream.stderr.on('data', (d) => { task.stderr += d; });
          stream.on('close', (code) => { task.exitCode = code ?? 0; task.running = false; resolve(); });
        });
      });
    } catch (err) {
      task.stderr  += err.message;
      task.exitCode = -1;
      task.running  = false;
    }
  })();

  return { taskId, command, status: 'started', hint: 'Poll with ssh:checkBackground using this taskId.' };
}

/**
 * Poll the status / output of a background task.
 *
 * @param {string} taskId
 * @param {number} [tailLines]  Return only the last N lines of stdout/stderr (default: all)
 */
async function checkBackground(taskId, tailLines) {
  const task = backgroundTasks.get(taskId);
  if (!task) return { error: `Task '${taskId}' not found.` };

  const tail = (str) => {
    if (!tailLines) return str;
    return str.split('\n').slice(-tailLines).join('\n');
  };

  return {
    taskId,
    command:   task.command,
    running:   task.running,
    exitCode:  task.exitCode,
    stdout:    tail(task.stdout),
    stderr:    tail(task.stderr),
    startedAt: task.startedAt,
  };
}

/**
 * Kill a remote process by PID.
 *
 * @param {number} pid
 * @param {string} [sessionId]
 * @param {string} [signal]    Default SIGTERM
 * @param {object} [config]
 */
async function killProcess(pid, sessionId, signal = 'SIGTERM', config = {}) {
  return runCommand(`kill -${signal} ${pid}`, sessionId, 5_000, config);
}

// ═════════════════════════════════════════════════════════════════════════════
// Remote File Operations
// (Prefixed ssh: in the registry — never clashes with custom:readFile etc.)
// ═════════════════════════════════════════════════════════════════════════════

const MAX_REMOTE_LINES = 2_000;
const MAX_REMOTE_BYTES = 200_000;

/**
 * Read a remote file (capped at 2000 lines to protect the LLM context window).
 *
 * @param {string} filePath
 * @param {string} [sessionId]
 * @param {number} [offset]    1-based start line (default 1)
 * @param {number} [limit]     Max lines (capped at 2000)
 * @param {object} [config]
 */
async function readRemoteFile(filePath, sessionId, offset = 1, limit) {
  if (!filePath) return { error: 'filePath is required.' };
  const s = requireSession(sessionId);
  if (s._err) return { error: s._err };

  const maxLines = Math.min(limit ?? MAX_REMOTE_LINES, MAX_REMOTE_LINES);
  const start    = Math.max(offset, 1);
  const end      = start + maxLines - 1;

  const [totalResult, contentResult] = await Promise.all([
    execOnClient(s.client, `wc -l < ${JSON.stringify(filePath)}`, 10_000),
    execOnClient(s.client, `sed -n '${start},${end}p' ${JSON.stringify(filePath)}`, 10_000),
  ]);

  if (contentResult.exitCode !== 0) {
    return { filePath, error: contentResult.stderr || 'Could not read file.' };
  }

  const totalLines = parseInt(totalResult.stdout.trim(), 10) || null;
  return {
    filePath,
    content:    contentResult.stdout,
    startLine:  start,
    endLine:    end,
    totalLines,
    truncated:  (totalLines ?? 0) > end,
  };
}

/**
 * Write/overwrite a remote file with the given content.
 *
 * @param {string} filePath
 * @param {string} content
 * @param {string} [sessionId]
 * @param {object} [config]
 */
async function writeRemoteFile(filePath, content, sessionId) {
  if (!filePath)     return { error: 'filePath is required.' };
  if (content == null) return { error: 'content is required.' };
  const s = requireSession(sessionId);
  if (s._err) return { error: s._err };

  const escaped = content.replace(/\\/g, '\\\\').replace(/'/g, "'\\''" );
  const dir = path.posix.dirname(filePath);
  const cmd = `mkdir -p ${JSON.stringify(dir)} && printf '%s' '${escaped}' > ${JSON.stringify(filePath)}`;
  const result = await execOnClient(s.client, cmd, 15_000);
  return {
    filePath,
    written:  result.exitCode === 0,
    exitCode: result.exitCode,
    error:    result.exitCode !== 0 ? result.stderr : undefined,
  };
}

/**
 * Append text to a remote file.
 *
 * @param {string} filePath
 * @param {string} content
 * @param {string} [sessionId]
 * @param {object} [config]
 */
async function appendRemoteFile(filePath, content, sessionId) {
  if (!filePath)     return { error: 'filePath is required.' };
  if (content == null) return { error: 'content is required.' };
  const s = requireSession(sessionId);
  if (s._err) return { error: s._err };

  const escaped = content.replace(/\\/g, '\\\\').replace(/'/g, "'\\''" );
  const result  = await execOnClient(s.client, `printf '%s' '${escaped}' >> ${JSON.stringify(filePath)}`, 10_000);
  return {
    filePath,
    appended: result.exitCode === 0,
    exitCode: result.exitCode,
    error:    result.exitCode !== 0 ? result.stderr : undefined,
  };
}

/**
 * Search a remote file with grep.
 *
 * @param {string} filePath
 * @param {string} pattern      Regex pattern
 * @param {string} [sessionId]
 * @param {number} [context]    Lines of context before/after each match (default 2)
 * @param {object} [config]
 */
async function searchRemoteFile(filePath, pattern, sessionId, context = 2) {
  if (!filePath) return { error: 'filePath is required.' };
  if (!pattern)  return { error: 'pattern is required.' };
  const s = requireSession(sessionId);
  if (s._err) return { error: s._err };

  const cmd    = `grep -n -E -C ${context} ${JSON.stringify(pattern)} ${JSON.stringify(filePath)} | head -c ${MAX_REMOTE_BYTES}`;
  const result = await execOnClient(s.client, cmd, 15_000);
  return {
    filePath,
    pattern,
    matches:   result.stdout,
    noMatches: result.exitCode === 1 && !result.stderr,
    error:     result.exitCode > 1 ? result.stderr : undefined,
  };
}

/**
 * List a remote directory as structured JSON.
 *
 * @param {string} dirPath
 * @param {string} [sessionId]
 * @param {object} [config]
 */
async function listRemoteDir(dirPath, sessionId) {
  if (!dirPath) return { error: 'dirPath is required.' };
  const s = requireSession(sessionId);
  if (s._err) return { error: s._err };

  const cmd    = `ls -la --time-style=iso ${JSON.stringify(dirPath)} 2>/dev/null || ls -la ${JSON.stringify(dirPath)}`;
  const result = await execOnClient(s.client, cmd, 10_000);
  if (result.exitCode !== 0) return { dirPath, error: result.stderr };

  const entries = result.stdout
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('total'))
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 9) return null;
      const perms = parts[0];
      const size  = parts[4];
      const name  = parts.slice(8).join(' ');
      return {
        name,
        type:        perms.startsWith('d') ? 'directory' : perms.startsWith('l') ? 'symlink' : 'file',
        permissions: perms,
        size:        parseInt(size, 10) || 0,
      };
    })
    .filter(Boolean);

  return { dirPath, entries, count: entries.length };
}

/**
 * Upload a local file to the remote host via SFTP.
 *
 * @param {string} localPath    Absolute or workspace-relative local path
 * @param {string} remotePath   Absolute remote path
 * @param {string} [sessionId]  Use an open session's connection config
 * @param {object} [config]
 */
async function uploadFile(localPath, remotePath, sessionId) {
  if (!localPath)  return { error: 'localPath is required.' };
  if (!remotePath) return { error: 'remotePath is required.' };
  const s = requireSession(sessionId);
  if (s._err) return { error: s._err };

  return new Promise((resolve) => {
    s.client.sftp((err, sftp) => {
      if (err) return resolve({ error: `SFTP init failed: ${err.message}` });
      sftp.fastPut(localPath, remotePath, (err2) => {
        if (err2) return resolve({ error: err2.message });
        resolve({ localPath, remotePath, uploaded: true });
      });
    });
  });
}

/**
 * Download a remote file to a local path via SFTP.
 *
 * @param {string} remotePath
 * @param {string} localPath
 * @param {string} [sessionId]
 * @param {object} [config]
 */
async function downloadFile(remotePath, localPath, sessionId) {
  if (!remotePath) return { error: 'remotePath is required.' };
  if (!localPath)  return { error: 'localPath is required.' };
  const s = requireSession(sessionId);
  if (s._err) return { error: s._err };

  return new Promise((resolve) => {
    s.client.sftp((err, sftp) => {
      if (err) return resolve({ error: `SFTP init failed: ${err.message}` });
      sftp.fastGet(remotePath, localPath, (err2) => {
        if (err2) return resolve({ error: err2.message });
        resolve({ remotePath, localPath, downloaded: true });
      });
    });
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// System Diagnostics
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Return OS, CPU, memory, and disk info as structured JSON.
 *
 * @param {string} [sessionId]
 * @param {object} [config]
 */
async function systemInfo(sessionId) {
  const s = requireSession(sessionId);
  if (s._err) return { error: s._err };

  const cmd = [
    "echo '---OS---'",
    'cat /etc/os-release 2>/dev/null | grep -E "^(NAME|VERSION)=" | head -4',
    'uname -sr',
    "echo '---CPU---'",
    "grep -m1 'model name' /proc/cpuinfo 2>/dev/null || sysctl -n machdep.cpu.brand_string 2>/dev/null || echo 'N/A'",
    "nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo '?'",
    "echo '---MEM---'",
    'free -h 2>/dev/null || vm_stat 2>/dev/null | head -5',
    "echo '---DISK---'",
    'df -h --output=source,size,used,avail,pcent,target 2>/dev/null || df -h',
    "echo '---LOAD---'",
    'uptime',
  ].join(' && ');

  const result = await execOnClient(s.client, cmd, 15_000);

  const parse = (section) => {
    const re = new RegExp(`---${section}---\\n([\\s\\S]*?)(?=---[A-Z]|$)`);
    return result.stdout.match(re)?.[1]?.trim() ?? '';
  };

  return {
    os:     parse('OS'),
    cpu:    parse('CPU'),
    memory: parse('MEM'),
    disk:   parse('DISK'),
    load:   parse('LOAD'),
    error:  result.exitCode !== 0 ? result.stderr : undefined,
  };
}

/**
 * Check network connectivity and optionally test if a remote port is open.
 *
 * @param {string} [sessionId]
 * @param {string} [targetHost]   Host to ping (default: 8.8.8.8)
 * @param {number} [targetPort]   If provided, also test TCP connectivity
 * @param {object} [config]
 */
async function networkStatus(sessionId, targetHost = '8.8.8.8', targetPort) {
  const s = requireSession(sessionId);
  if (s._err) return { error: s._err };

  const pingResult = await execOnClient(s.client, `ping -c 3 -W 2 ${targetHost} 2>&1 | tail -4`, 15_000);

  const out = {
    targetHost,
    pingOutput:   pingResult.stdout,
    pingExitCode: pingResult.exitCode,
    reachable:    pingResult.exitCode === 0,
  };

  if (targetPort) {
    const tcpCmd = `timeout 3 bash -c "echo >/dev/tcp/${targetHost}/${targetPort}" 2>&1 && echo OPEN || echo CLOSED`;
    const tcp    = await execOnClient(s.client, tcpCmd, 8_000);
    out.targetPort = targetPort;
    out.portStatus = tcp.stdout.trim();
  }

  return out;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // sessions
  connect, disconnect, listSessions,
  // execution
  runCommand, runSudoCommand, startBackground, checkBackground, killProcess,
  // remote files
  readRemoteFile, writeRemoteFile, appendRemoteFile, searchRemoteFile, listRemoteDir,
  uploadFile, downloadFile,
  // diagnostics
  systemInfo, networkStatus,
};
