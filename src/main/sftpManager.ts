// DISABLED: SSH2/SFTP functionality disabled to prevent antivirus quarantine
// This file is kept for reference but all functionality is commented out

/*
import { Client, ConnectConfig, SFTPWrapper } from 'ssh2';
import fs from 'fs';
import os from 'os';
import path from 'path';

interface ParsedSshCommand {
  host: string;
  username?: string;
  port: number;
}

interface FileConnectAuth {
  password?: string;
}

interface SftpSession {
  client: Client;
  sftp: SFTPWrapper;
  terminalId: string;
  host: string;
  username: string;
  port: number;
  currentDirectory: string;
}

export interface RemoteFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt?: number;
}

const sessions = new Map<string, SftpSession>();

function parseSshCommand(command: string): ParsedSshCommand | null {
  const trimmed = command.trim();
  if (!trimmed.startsWith('ssh ')) {
    return null;
  }

  const tokens = trimmed.split(/\s+/).slice(1);
  let host = '';
  let username: string | undefined;
  let port = 22;
  const optionsWithValue = new Set([
    '-b',
    '-c',
    '-D',
    '-E',
    '-e',
    '-F',
    '-I',
    '-i',
    '-J',
    '-L',
    '-l',
    '-m',
    '-O',
    '-o',
    '-p',
    '-Q',
    '-R',
    '-S',
    '-W',
    '-w',
  ]);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token.startsWith('-p') && token.length > 2) {
      port = Number(token.slice(2)) || 22;
      continue;
    }

    if (token === '-p' && tokens[index + 1]) {
      port = Number(tokens[index + 1]) || 22;
      index += 1;
      continue;
    }

    if (token === '-l' && tokens[index + 1]) {
      username = tokens[index + 1];
      index += 1;
      continue;
    }

    if (token.startsWith('-')) {
      if (optionsWithValue.has(token) && tokens[index + 1]) {
        index += 1;
      }
      continue;
    }

    if (token.includes('@')) {
      const [userPart, hostPart] = token.split('@');
      username = userPart;
      host = hostPart;
      continue;
    }

    if (!host) {
      host = token;
    }
  }

  if (!host) {
    return null;
  }

  return {
    host,
    username,
    port,
  };
}

function readFirstExistingPrivateKey(): Buffer | undefined {
  const home = os.homedir();
  const candidates = ['id_ed25519', 'id_rsa'].map((filename) => path.join(home, '.ssh', filename));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        return fs.readFileSync(candidate);
      } catch {
        continue;
      }
    }
  }

  return undefined;
}

function createConnectionConfig(parsed: ParsedSshCommand, auth?: FileConnectAuth): ConnectConfig {
  const config: ConnectConfig = {
    host: parsed.host,
    port: parsed.port,
    username: parsed.username || os.userInfo().username,
    readyTimeout: 15000,
  };

  if (auth?.password) {
    config.password = auth.password;
    return config;
  }

  if (process.env.SSH_AUTH_SOCK) {
    config.agent = process.env.SSH_AUTH_SOCK;
  }

  const privateKey = readFirstExistingPrivateKey();
  if (privateKey) {
    config.privateKey = privateKey;
  }

  return config;
}

function getHomeDirectory(session: SftpSession): Promise<string> {
  return new Promise((resolve) => {
    session.sftp.realpath('.', (err, absolutePath) => {
      if (err || !absolutePath) {
        resolve('/');
        return;
      }
      resolve(absolutePath);
    });
  });
}

function normalizeRemotePath(rawPath: string): string {
  if (!rawPath) {
    return '/';
  }

  const normalized = rawPath.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function resolvePath(currentDirectory: string, rawPath: string): string {
  if (!rawPath || rawPath === '.') {
    return currentDirectory;
  }

  if (rawPath.startsWith('/')) {
    return normalizeRemotePath(rawPath);
  }

  return normalizeRemotePath(path.posix.join(currentDirectory, rawPath));
}

function getSession(terminalId: string): SftpSession {
  const session = sessions.get(terminalId);
  if (!session) {
    throw new Error('No SSH file session found for this terminal. Open an SSH terminal first.');
  }
  return session;
}

function connectSftp(config: ConnectConfig): Promise<{ client: Client; sftp: SFTPWrapper }> {
  return new Promise((resolve, reject) => {
    const client = new Client();

    client
      .on('ready', () => {
        client.sftp((err, sftp) => {
          if (err || !sftp) {
            client.end();
            reject(err || new Error('Failed to initialize SFTP session'));
            return;
          }
          resolve({ client, sftp });
        });
      })
      .on('error', (err) => {
        reject(err);
      })
      .connect(config);
  });
}

export async function connectTerminalFileSession(
  terminalId: string,
  command: string,
  auth?: FileConnectAuth,
): Promise<{ connected: boolean; currentDirectory?: string; error?: string; authRequired?: boolean }> {
  const existing = sessions.get(terminalId);
  if (existing) {
    return { connected: true, currentDirectory: existing.currentDirectory };
  }

  const parsed = parseSshCommand(command);
  if (!parsed) {
    return {
      connected: false,
      error: 'Only SSH terminals are supported for file browsing. Use a command like: ssh user@host',
    };
  }

  try {
    const connectConfig = createConnectionConfig(parsed, auth);
    const { client, sftp } = await connectSftp(connectConfig);
    const username = connectConfig.username || parsed.username || os.userInfo().username;
    const provisionalSession: SftpSession = {
      client,
      sftp,
      terminalId,
      host: parsed.host,
      username,
      port: parsed.port,
      currentDirectory: '/',
    };

    const homeDirectory = await getHomeDirectory(provisionalSession);
    provisionalSession.currentDirectory = homeDirectory;

    client.on('close', () => {
      sessions.delete(terminalId);
    });

    sessions.set(terminalId, provisionalSession);
    return { connected: true, currentDirectory: homeDirectory };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const authRequired = /authentication methods failed|permission denied|all configured authentication/i.test(message);
    return {
      connected: false,
      error: message,
      authRequired,
    };
  }
}

export function disconnectTerminalFileSession(terminalId: string): { success: boolean } {
  const existing = sessions.get(terminalId);
  if (existing) {
    existing.client.end();
    sessions.delete(terminalId);
  }
  return { success: true };
}

export function setTerminalDirectory(terminalId: string, directory: string): { success: boolean; currentDirectory: string } {
  const session = getSession(terminalId);
  const resolved = resolvePath(session.currentDirectory, directory);
  session.currentDirectory = resolved;
  return { success: true, currentDirectory: resolved };
}

export function getTerminalDirectory(terminalId: string): { success: boolean; currentDirectory: string } {
  const session = getSession(terminalId);
  return { success: true, currentDirectory: session.currentDirectory };
}

export async function listDirectory(terminalId: string, rawPath?: string): Promise<{ success: boolean; path: string; entries: RemoteFileEntry[] }> {
  const session = getSession(terminalId);
  const targetPath = resolvePath(session.currentDirectory, rawPath || session.currentDirectory);

  const entries = await new Promise<RemoteFileEntry[]>((resolve, reject) => {
    session.sftp.readdir(targetPath, (err, list) => {
      if (err || !list) {
        reject(err || new Error('Failed to read directory'));
        return;
      }

      const mapped = list
        .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
        .map((entry) => {
          const fullPath = normalizeRemotePath(path.posix.join(targetPath, entry.filename));
          const isDirectory = entry.longname?.startsWith('d') || false;

          return {
            name: entry.filename,
            path: fullPath,
            isDirectory,
            size: entry.attrs?.size || 0,
            modifiedAt: entry.attrs?.mtime,
          };
        })
        .sort((left, right) => {
          if (left.isDirectory !== right.isDirectory) {
            return left.isDirectory ? -1 : 1;
          }
          return left.name.localeCompare(right.name);
        });

      resolve(mapped);
    });
  });

  session.currentDirectory = targetPath;
  return { success: true, path: targetPath, entries };
}

export function readRemoteFile(terminalId: string, rawPath: string): Promise<{ success: boolean; path: string; content: string }> {
  const session = getSession(terminalId);
  const targetPath = resolvePath(session.currentDirectory, rawPath);

  return new Promise((resolve, reject) => {
    session.sftp.readFile(targetPath, { encoding: 'utf8' }, (err, data) => {
      if (err) {
        reject(err);
        return;
      }

      resolve({
        success: true,
        path: targetPath,
        content: typeof data === 'string' ? data : data.toString('utf8'),
      });
    });
  });
}

export function writeRemoteFile(terminalId: string, rawPath: string, content: string): Promise<{ success: boolean; path: string }> {
  const session = getSession(terminalId);
  const targetPath = resolvePath(session.currentDirectory, rawPath);

  return new Promise((resolve, reject) => {
    session.sftp.writeFile(targetPath, content, { encoding: 'utf8' }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ success: true, path: targetPath });
    });
  });
}

export function deleteRemotePath(terminalId: string, rawPath: string): Promise<{ success: boolean; path: string }> {
  const session = getSession(terminalId);
  const targetPath = resolvePath(session.currentDirectory, rawPath);

  return new Promise((resolve, reject) => {
    session.sftp.stat(targetPath, (statErr, stats) => {
      if (statErr || !stats) {
        reject(statErr || new Error('Path not found'));
        return;
      }

      const finalize = (err?: Error | null) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({ success: true, path: targetPath });
      };

      if (stats.isDirectory()) {
        session.sftp.rmdir(targetPath, finalize);
      } else {
        session.sftp.unlink(targetPath, finalize);
      }
    });
  });
}

export function renameRemotePath(terminalId: string, oldRawPath: string, newRawPath: string): Promise<{ success: boolean; oldPath: string; newPath: string }> {
  const session = getSession(terminalId);
  const oldPath = resolvePath(session.currentDirectory, oldRawPath);
  const newPath = resolvePath(session.currentDirectory, newRawPath);

  return new Promise((resolve, reject) => {
    session.sftp.rename(oldPath, newPath, (err: Error | null) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ success: true, oldPath, newPath });
    });
  });
}

export function makeRemoteDirectory(terminalId: string, rawPath: string): Promise<{ success: boolean; path: string }> {
  const session = getSession(terminalId);
  const targetPath = resolvePath(session.currentDirectory, rawPath);

  return new Promise((resolve, reject) => {
    session.sftp.mkdir(targetPath, (err: Error | null) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ success: true, path: targetPath });
    });
  });
}
*/