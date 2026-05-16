/**
 * SSH Session Tools
 * connect, disconnect, list active sessions
 */

import { Client as SSH2Client } from 'ssh2';
import { toolRegistry } from '../../registry';
import { z } from 'zod';

interface SshSessionInfo {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  connectedAt: number;
  lastUsedAt: number;
}

// In-memory session store
const activeSessions = new Map<string, { client: SSH2Client; info: SshSessionInfo }>();

function generateSessionId(): string {
  return `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getActiveSession(sessionId: string) {
  return activeSessions.get(sessionId);
}

export function registerSshSessionTools() {
  // ── ssh:connect ───────────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:connect',
    async (args: { host: string; port?: number; username: string; password?: string; privateKey?: string }) => {
      const { host, port = 22, username, password, privateKey } = args;
      if (!password && !privateKey) throw new Error('Either password or privateKey must be provided');

      const sessionId = generateSessionId();

      return new Promise<{ sessionId: string; host: string; username: string; message: string }>((resolve, reject) => {
        let attempted = 0;
        const MAX_ATTEMPTS = 3;
        const RETRY_DELAY_MS = 8000;

        const attempt = () => {
          attempted++;
          const c = new SSH2Client();

          const cfg: Parameters<SSH2Client['connect']>[0] = {
            host, port, username,
            // 60 s covers SLES/SUSE reverse-DNS lookup (UseDNS yes default) and
            // post-boot customization script delays.
            readyTimeout: 60000,
            hostVerifier: () => true,
          };
          if (privateKey) cfg.privateKey = privateKey;
          else cfg.password = password;

          c.on('ready', () => {
            activeSessions.set(sessionId, { client: c, info: { sessionId, host, port, username, connectedAt: Date.now(), lastUsedAt: Date.now() } });
            console.log(`[SSH] Connected: ${sessionId} \u2192 ${username}@${host}:${port}`);
            resolve({ sessionId, host, username, message: `Connected to ${username}@${host}:${port}` });
          });

          c.on('error', (err) => {
            const isTimeout = /timed out|timeout|handshake/i.test(err.message);
            if (isTimeout && attempted < MAX_ATTEMPTS) {
              console.warn(`[SSH] Timeout for ${host} (attempt ${attempted}/${MAX_ATTEMPTS}), retrying in ${RETRY_DELAY_MS / 1000}s\u2026`);
              setTimeout(attempt, RETRY_DELAY_MS);
            } else {
              reject(new Error(`SSH connection failed: ${err.message}${attempted > 1 ? ` (after ${attempted} attempts)` : ''}`));
            }
          });

          c.connect(cfg);
        };

        attempt();
      });
    },
    {
      category: 'ssh',
      description: 'Connect to a remote host via SSH and return a session ID for subsequent commands',
      target: 'remote',
      riskLevel: 'review',
      schema: z.object({
        host: z.string().describe('Hostname or IP address'),
        port: z.number().optional().describe('SSH port (default 22)'),
        username: z.string().describe('SSH username'),
        password: z.string().optional().describe('SSH password'),
        privateKey: z.string().optional().describe('SSH private key (PEM format)'),
      }),
    }
  );

  // ── ssh:disconnect ────────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:disconnect',
    async (args: { sessionId: string }) => {
      const session = activeSessions.get(args.sessionId);
      if (!session) {
        return { success: false, error: `No session found: ${args.sessionId}` };
      }
      session.client.end();
      activeSessions.delete(args.sessionId);
      console.log(`[SSH] Disconnected: ${args.sessionId}`);
      return { success: true, message: `Session ${args.sessionId} disconnected` };
    },
    {
      category: 'ssh',
      description: 'Disconnect an active SSH session',
      target: 'remote',
      riskLevel: 'review',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID to disconnect'),
      }),
    }
  );

  // ── ssh:listSessions ──────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:listSessions',
    async () => {
      const sessions = Array.from(activeSessions.values()).map(({ info }) => ({
        sessionId: info.sessionId,
        host: info.host,
        port: info.port,
        username: info.username,
        connectedAt: info.connectedAt,
        lastUsedAt: info.lastUsedAt,
        idleSecs: Math.floor((Date.now() - info.lastUsedAt) / 1000),
      }));
      return { count: sessions.length, sessions };
    },
    {
      category: 'ssh',
      description: 'List all active SSH sessions',
      target: 'local',
      riskLevel: 'safe',
      schema: z.object({}),
    }
  );
}
