import * as vscode from 'vscode';
import { Client as SSH2Client, ClientChannel, SFTPWrapper } from 'ssh2';
import * as fs from 'fs/promises';

// ── Session store ─────────────────────────────────────────────────────────────

interface SshSession {
  client: SSH2Client;
  host: string;
  port: number;
  username: string;
  connectedAt: number;
  lastUsedAt: number;
}

const sessions = new Map<string, SshSession>();

function genId(): string {
  return `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getSession(id: string): SshSession {
  const s = sessions.get(id);
  if (!s) throw new Error(`SSH session not found: ${id}`);
  s.lastUsedAt = Date.now();
  return s;
}

const MAX_OUTPUT = 100 * 1024;

function execOn(
  session: SshSession,
  command: string,
  timeoutMs = 30000
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    session.client.exec(command, (execErr, stream: ClientChannel) => {
      if (execErr) return reject(new Error(`exec failed: ${execErr.message}`));
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; stream.close(); }, timeoutMs);
      stream.on('data', (d: Buffer) => { stdout += d.toString(); if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(-MAX_OUTPUT); });
      (stream as NodeJS.EventEmitter & { stderr: NodeJS.EventEmitter }).stderr.on('data', (d: Buffer) => { stderr += d.toString(); if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(-MAX_OUTPUT); });
      stream.on('close', (code: number) => { clearTimeout(timer); resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 0, timedOut }); });
      stream.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
    });
  });
}

function getSftp(session: SshSession): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    session.client.sftp((e, sftp) => (e ? reject(e) : resolve(sftp)));
  });
}

function ok(data: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(data))]);
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerSshTools(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    // ── connect ──────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ host: string; port?: number; username: string; password?: string; private_key?: string }>('vcd-agent_sshConnect', {
      prepareInvocation(params) {
        return {
          confirmationMessages: {
            title: 'SSH Connect',
            message: new vscode.MarkdownString(`Connect to **${params.input.username}@${params.input.host}**?`),
          },
        };
      },
      async invoke(params) {
        const { host, port = 22, username, password, private_key } = params.input;
        if (!password && !private_key) throw new Error('password or private_key required');
        const sessionId = genId();
        await new Promise<void>((resolve, reject) => {
          let attempts = 0;
          const tryConnect = () => {
            attempts++;
            const c = new SSH2Client();
            const cfg: Parameters<SSH2Client['connect']>[0] = { host, port, username, readyTimeout: 60000, hostVerifier: () => true };
            if (private_key) cfg.privateKey = private_key; else cfg.password = password;
            c.on('ready', () => { sessions.set(sessionId, { client: c, host, port, username, connectedAt: Date.now(), lastUsedAt: Date.now() }); resolve(); });
            c.on('error', (e) => {
              if (/timed out|timeout|handshake/i.test(e.message) && attempts < 3) { setTimeout(tryConnect, 8000); }
              else reject(new Error(`SSH connect failed: ${e.message}`));
            });
            c.connect(cfg);
          };
          tryConnect();
        });
        return ok({ sessionId, host, username, message: `Connected to ${username}@${host}:${port}` });
      },
    }),

    // ── disconnect ───────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string }>('vcd-agent_sshDisconnect', {
      prepareInvocation(params) {
        return { confirmationMessages: { title: 'SSH Disconnect', message: new vscode.MarkdownString(`Disconnect session \`${params.input.session_id}\`?`) } };
      },
      async invoke(params) {
        const s = sessions.get(params.input.session_id);
        if (s) { s.client.end(); sessions.delete(params.input.session_id); }
        return ok({ disconnected: params.input.session_id });
      },
    }),

    // ── listSessions ─────────────────────────────────────────────────────────
    vscode.lm.registerTool('vcd-agent_sshListSessions', {
      async invoke() {
        const list = [...sessions.entries()].map(([id, s]) => ({
          sessionId: id, host: s.host, port: s.port, username: s.username,
          idleSecs: Math.floor((Date.now() - s.lastUsedAt) / 1000),
        }));
        return ok({ sessions: list, count: list.length });
      },
    }),

    // ── runCommand ───────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string; command: string; timeout_secs?: number }>('vcd-agent_sshRunCommand', {
      prepareInvocation(params) {
        return { confirmationMessages: { title: 'Run SSH Command', message: new vscode.MarkdownString(`Run on \`${params.input.session_id}\`:\n\`\`\`\n${params.input.command}\n\`\`\``) } };
      },
      async invoke(params) {
        return ok(await execOn(getSession(params.input.session_id), params.input.command, (params.input.timeout_secs ?? 30) * 1000));
      },
    }),

    // ── runSudo ──────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string; command: string; sudo_password?: string; timeout_secs?: number }>('vcd-agent_sshRunSudo', {
      prepareInvocation(params) {
        return { confirmationMessages: { title: '⚠ Run Sudo Command', message: new vscode.MarkdownString(`Run as **sudo** on \`${params.input.session_id}\`:\n\`\`\`\n${params.input.command}\n\`\`\``) } };
      },
      async invoke(params) {
        const { command, sudo_password, timeout_secs = 30, session_id } = params.input;
        const sudoCmd = sudo_password
          ? `echo '${sudo_password.replace(/'/g, "'\\''")}' | sudo -S ${command}`
          : `sudo ${command}`;
        return ok(await execOn(getSession(session_id), sudoCmd, timeout_secs * 1000));
      },
    }),

    // ── runScript ────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string; script: string; timeout_secs?: number }>('vcd-agent_sshRunScript', {
      prepareInvocation(params) {
        return { confirmationMessages: { title: '⚠ Run Script', message: new vscode.MarkdownString(`Execute multi-line script on \`${params.input.session_id}\`?`) } };
      },
      async invoke(params) {
        const encoded = Buffer.from(params.input.script).toString('base64');
        const command = `echo "${encoded}" | base64 -d | bash`;
        return ok(await execOn(getSession(params.input.session_id), command, (params.input.timeout_secs ?? 60) * 1000));
      },
    }),

    // ── background ───────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string; command: string }>('vcd-agent_sshBackground', {
      prepareInvocation(params) {
        return { confirmationMessages: { title: '⚠ Start Background Process', message: new vscode.MarkdownString(`Start nohup process on \`${params.input.session_id}\`:\n\`${params.input.command}\``) } };
      },
      async invoke(params) {
        const cmd = `nohup ${params.input.command} > /dev/null 2>&1 & echo $!`;
        const result = await execOn(getSession(params.input.session_id), cmd);
        return ok({ ...result, pid: result.stdout.trim() });
      },
    }),

    // ── killProcess ──────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string; pid: number; signal?: number }>('vcd-agent_sshKillProcess', {
      prepareInvocation(params) {
        return { confirmationMessages: { title: '⚠ Kill Process', message: new vscode.MarkdownString(`Kill PID **${params.input.pid}** on \`${params.input.session_id}\`?`) } };
      },
      async invoke(params) {
        const signal = params.input.signal ?? 15;
        return ok(await execOn(getSession(params.input.session_id), `kill -${signal} ${params.input.pid}`));
      },
    }),

    // ── listProcesses ────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string; filter?: string }>('vcd-agent_sshListProcesses', {
      async invoke(params) {
        const cmd = params.input.filter ? `ps aux | grep '${params.input.filter}'` : 'ps aux';
        return ok(await execOn(getSession(params.input.session_id), cmd));
      },
    }),

    // ── readFile ─────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string; path: string }>('vcd-agent_sshReadFile', {
      async invoke(params) {
        const sftp = await getSftp(getSession(params.input.session_id));
        return new Promise((resolve) => {
          const chunks: Buffer[] = [];
          const stream = sftp.createReadStream(params.input.path);
          stream.on('data', (d: Buffer) => chunks.push(d));
          stream.on('end', () => resolve(ok({ content: Buffer.concat(chunks).toString('utf8') })));
          stream.on('error', (e: Error) => resolve(ok({ error: e.message })));
        });
      },
    }),

    // ── writeFile ────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string; path: string; content: string }>('vcd-agent_sshWriteFile', {
      prepareInvocation(params) {
        return { confirmationMessages: { title: 'Write Remote File', message: new vscode.MarkdownString(`Write to \`${params.input.path}\` on \`${params.input.session_id}\`?`) } };
      },
      async invoke(params) {
        const sftp = await getSftp(getSession(params.input.session_id));
        return new Promise((resolve) => {
          const stream = sftp.createWriteStream(params.input.path);
          stream.on('close', () => resolve(ok({ written: params.input.path })));
          stream.on('error', (e: Error) => resolve(ok({ error: e.message })));
          stream.end(Buffer.from(params.input.content, 'utf8'));
        });
      },
    }),

    // ── listDir ──────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string; path: string }>('vcd-agent_sshListDir', {
      async invoke(params) {
        const sftp = await getSftp(getSession(params.input.session_id));
        return new Promise((resolve) => {
          sftp.readdir(params.input.path, (e, list) => {
            if (e) return resolve(ok({ error: e.message }));
            resolve(ok({ path: params.input.path, entries: list.map((f) => ({ name: f.filename, size: f.attrs.size, mtime: f.attrs.mtime, isDir: !!(f.attrs.mode && (f.attrs.mode & 0o040000)) })) }));
          });
        });
      },
    }),

    // ── uploadFile ───────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string; local_path: string; remote_path: string }>('vcd-agent_sshUploadFile', {
      prepareInvocation(params) {
        return { confirmationMessages: { title: 'Upload File', message: new vscode.MarkdownString(`Upload \`${params.input.local_path}\` → \`${params.input.remote_path}\` on \`${params.input.session_id}\`?`) } };
      },
      async invoke(params) {
        const content = await fs.readFile(params.input.local_path);
        const sftp = await getSftp(getSession(params.input.session_id));
        return new Promise((resolve) => {
          const stream = sftp.createWriteStream(params.input.remote_path);
          stream.on('close', () => resolve(ok({ uploaded: params.input.remote_path })));
          stream.on('error', (e: Error) => resolve(ok({ error: e.message })));
          stream.end(content);
        });
      },
    }),

    // ── downloadFile ─────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string; remote_path: string; local_path: string }>('vcd-agent_sshDownloadFile', {
      prepareInvocation(params) {
        return { confirmationMessages: { title: 'Download File', message: new vscode.MarkdownString(`Download \`${params.input.remote_path}\` → \`${params.input.local_path}\`?`) } };
      },
      async invoke(params) {
        const sftp = await getSftp(getSession(params.input.session_id));
        return new Promise((resolve) => {
          const chunks: Buffer[] = [];
          const stream = sftp.createReadStream(params.input.remote_path);
          stream.on('data', (d: Buffer) => chunks.push(d));
          stream.on('end', async () => {
            await fs.writeFile(params.input.local_path, Buffer.concat(chunks));
            resolve(ok({ downloaded: params.input.local_path }));
          });
          stream.on('error', (e: Error) => resolve(ok({ error: e.message })));
        });
      },
    }),

    // ── deleteFile ───────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string; path: string }>('vcd-agent_sshDeleteFile', {
      prepareInvocation(params) {
        return { confirmationMessages: { title: '⚠ Delete Remote File', message: new vscode.MarkdownString(`Delete \`${params.input.path}\` on \`${params.input.session_id}\`?`) } };
      },
      async invoke(params) {
        const sftp = await getSftp(getSession(params.input.session_id));
        return new Promise((resolve) => {
          sftp.unlink(params.input.path, (e) => resolve(ok(e ? { error: e.message } : { deleted: params.input.path })));
        });
      },
    }),

    // ── mkdir ────────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string; path: string }>('vcd-agent_sshMkdir', {
      prepareInvocation(params) {
        return { confirmationMessages: { title: 'Create Remote Directory', message: new vscode.MarkdownString(`Create directory \`${params.input.path}\`?`) } };
      },
      async invoke(params) {
        const sftp = await getSftp(getSession(params.input.session_id));
        return new Promise((resolve) => {
          sftp.mkdir(params.input.path, (e) => resolve(ok(e ? { error: e.message } : { created: params.input.path })));
        });
      },
    }),

    // ── fileInfo ─────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string; path: string }>('vcd-agent_sshFileInfo', {
      async invoke(params) {
        const sftp = await getSftp(getSession(params.input.session_id));
        return new Promise((resolve) => {
          sftp.stat(params.input.path, (e, attrs) => resolve(ok(e ? { error: e.message } : { path: params.input.path, size: attrs.size, mtime: attrs.mtime, mode: attrs.mode })));
        });
      },
    }),

    // ── systemInfo ───────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string }>('vcd-agent_sshSystemInfo', {
      async invoke(params) {
        const s = getSession(params.input.session_id);
        const cmds = ['hostname', 'cat /etc/os-release', 'uname -r', 'uptime -p', 'nproc', 'free -m'];
        const results = await Promise.all(cmds.map((c) => execOn(s, c, 10000).then((r) => r.stdout).catch(() => '')));
        return ok({ hostname: results[0], os: results[1], kernel: results[2], uptime: results[3], cpus: results[4], memory: results[5] });
      },
    }),

    // ── diskUsage ────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string; path?: string }>('vcd-agent_sshDiskUsage', {
      async invoke(params) {
        return ok(await execOn(getSession(params.input.session_id), `df -h ${params.input.path ?? '/'}`));
      },
    }),

    // ── networkStatus ────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string }>('vcd-agent_sshNetworkStatus', {
      async invoke(params) {
        const s = getSession(params.input.session_id);
        const [ifaces, routes, conns] = await Promise.all([
          execOn(s, 'ip addr').then((r) => r.stdout),
          execOn(s, 'ip route').then((r) => r.stdout),
          execOn(s, 'ss -tulnp').then((r) => r.stdout),
        ]);
        return ok({ interfaces: ifaces, routes, connections: conns });
      },
    }),

    // ── checkService ─────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string; service: string }>('vcd-agent_sshCheckService', {
      async invoke(params) {
        const s = getSession(params.input.session_id);
        const [active, enabled] = await Promise.all([
          execOn(s, `systemctl is-active ${params.input.service}`).then((r) => r.stdout),
          execOn(s, `systemctl is-enabled ${params.input.service}`).then((r) => r.stdout),
        ]);
        return ok({ service: params.input.service, active, enabled });
      },
    }),

    // ── manageService ────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string; service: string; action: string }>('vcd-agent_sshManageService', {
      prepareInvocation(params) {
        return { confirmationMessages: { title: '⚠ Manage Service', message: new vscode.MarkdownString(`Run **systemctl ${params.input.action} ${params.input.service}** on \`${params.input.session_id}\`?`) } };
      },
      async invoke(params) {
        return ok(await execOn(getSession(params.input.session_id), `sudo systemctl ${params.input.action} ${params.input.service}`));
      },
    }),

    // ── viewLogs ─────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string; source: string; lines?: number; filter?: string }>('vcd-agent_sshViewLogs', {
      async invoke(params) {
        const { session_id, source, lines = 100, filter } = params.input;
        let cmd: string;
        if (source.startsWith('/')) {
          cmd = filter ? `tail -n ${lines} '${source}' | grep '${filter}'` : `tail -n ${lines} '${source}'`;
        } else {
          cmd = filter ? `journalctl -u ${source} -n ${lines} | grep '${filter}'` : `journalctl -u ${source} -n ${lines}`;
        }
        return ok(await execOn(getSession(session_id), cmd, 15000));
      },
    }),

    // ── getEnvVars ───────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ session_id: string }>('vcd-agent_sshGetEnvVars', {
      async invoke(params) {
        return ok(await execOn(getSession(params.input.session_id), 'env | sort'));
      },
    })
  );
}
