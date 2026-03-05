import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export interface SavedTerminalSession {
  id: string;
  label: string;
  command: string;
  host?: string;
  username?: string;
  port?: number;
  password?: string;
  vmName?: string;
  ip?: string;
  source?: 'vm' | 'manual';
  createdAt: number;
  lastUsedAt?: number;
}

interface ParsedSshCommand {
  host: string;
  username?: string;
  port: number;
}

const defaultPort = 22;

function getStorePath(): string {
  return path.join(app.getPath('userData'), 'saved-terminals.json');
}

function readStore(): SavedTerminalSession[] {
  const storePath = getStorePath();
  if (!fs.existsSync(storePath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(sessions: SavedTerminalSession[]): void {
  const storePath = getStorePath();
  const payload = JSON.stringify(sessions, null, 2);
  fs.writeFileSync(storePath, payload, 'utf8');
}

function parseSshCommand(command: string): ParsedSshCommand | null {
  const trimmed = command.trim();
  if (!trimmed.startsWith('ssh ')) {
    return null;
  }

  const tokens = trimmed.split(/\s+/).slice(1);
  let host = '';
  let username: string | undefined;
  let port = defaultPort;
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
      port = Number(token.slice(2)) || defaultPort;
      continue;
    }

    if (token === '-p' && tokens[index + 1]) {
      port = Number(tokens[index + 1]) || defaultPort;
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

  return { host, username, port };
}

export function listSavedTerminalSessions(): SavedTerminalSession[] {
  return readStore().sort((a, b) => (b.lastUsedAt || b.createdAt) - (a.lastUsedAt || a.createdAt));
}

export function saveTerminalSession(input: Omit<SavedTerminalSession, 'id' | 'createdAt'> & { id?: string }): SavedTerminalSession {
  const sessions = readStore();
  const now = Date.now();

  const parsed = parseSshCommand(input.command);
  const session: SavedTerminalSession = {
    id: input.id || `sess-${now}-${Math.random().toString(36).slice(2, 8)}`,
    label: input.label,
    command: input.command,
    host: input.host || parsed?.host,
    username: input.username || parsed?.username,
    port: input.port || parsed?.port || defaultPort,
    password: input.password,
    vmName: input.vmName,
    ip: input.ip,
    source: input.source || 'manual',
    createdAt: input.id ? (sessions.find((item) => item.id === input.id)?.createdAt || now) : now,
    lastUsedAt: input.lastUsedAt || now,
  };

  const existingIndex = sessions.findIndex((item) => item.id === session.id);
  if (existingIndex >= 0) {
    sessions[existingIndex] = session;
  } else {
    sessions.push(session);
  }

  writeStore(sessions);
  return session;
}

export function deleteTerminalSession(id: string): { success: boolean } {
  const sessions = readStore().filter((item) => item.id !== id);
  writeStore(sessions);
  return { success: true };
}
