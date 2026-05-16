/**
 * SSH System Information Tools
 * systemInfo, diskUsage, networkStatus, checkService, viewLogs, getEnvVars
 */

import { toolRegistry } from '../../registry';
import { getActiveSession } from './session';
import { z } from 'zod';

function exec(sessionId: string, command: string, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    const session = getActiveSession(sessionId);
    if (!session) {
      reject(new Error(`SSH session not found: ${sessionId}`));
      return;
    }
    session.info.lastUsedAt = Date.now();
    session.client.exec(command, (err, stream) => {
      if (err) { reject(err); return; }
      let out = '';
      const timer = setTimeout(() => { stream.close(); resolve(out.trim()); }, timeoutMs);
      stream.on('data', (d: Buffer) => { out += d.toString(); });
      stream.stderr.on('data', (d: Buffer) => { out += d.toString(); });
      stream.on('close', () => { clearTimeout(timer); resolve(out.trim()); });
    });
  });
}

export function registerSshSystemTools() {
  // ── ssh:systemInfo ────────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:systemInfo',
    async (args: { sessionId: string }) => {
      const [hostname, os, kernel, uptime, cpu, mem] = await Promise.all([
        exec(args.sessionId, 'hostname'),
        exec(args.sessionId, 'cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d \'"\''),
        exec(args.sessionId, 'uname -r'),
        exec(args.sessionId, 'uptime -p 2>/dev/null || uptime'),
        exec(args.sessionId, 'nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo'),
        exec(args.sessionId, 'free -m 2>/dev/null | awk \'NR==2{printf "total:%s used:%s free:%s", $2, $3, $4}\''),
      ]);
      return { hostname, os, kernel, uptime, cpuCount: parseInt(cpu) || 0, memory: mem };
    },
    {
      category: 'ssh',
      description: 'Get system information from a remote SSH host (OS, CPU, memory, uptime)',
      target: 'remote',
      riskLevel: 'safe',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
      }),
    }
  );

  // ── ssh:diskUsage ─────────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:diskUsage',
    async (args: { sessionId: string; path?: string }) => {
      const target = args.path ?? '/';
      const output = await exec(args.sessionId, `df -h ${target} 2>/dev/null`);
      const lines = output.split('\n').filter(Boolean);
      const entries = lines.slice(1).map(line => {
        const [filesystem, size, used, avail, usePercent, mountpoint] = line.trim().split(/\s+/);
        return { filesystem, size, used, avail, usePercent, mountpoint };
      });
      return { path: target, entries, raw: output };
    },
    {
      category: 'ssh',
      description: 'Get disk usage on a remote SSH host',
      target: 'remote',
      riskLevel: 'safe',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
        path: z.string().optional().describe('Path to check (default: /)'),
      }),
    }
  );

  // ── ssh:networkStatus ─────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:networkStatus',
    async (args: { sessionId: string }) => {
      const [interfaces, routes, connections] = await Promise.all([
        exec(args.sessionId, 'ip addr show 2>/dev/null || ifconfig 2>/dev/null | head -60'),
        exec(args.sessionId, 'ip route 2>/dev/null || netstat -rn 2>/dev/null | head -20'),
        exec(args.sessionId, 'ss -tnp 2>/dev/null || netstat -tnp 2>/dev/null | head -20'),
      ]);
      return { interfaces, routes, connections };
    },
    {
      category: 'ssh',
      description: 'Get network interface status, routes, and active connections on a remote host',
      target: 'remote',
      riskLevel: 'safe',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
      }),
    }
  );

  // ── ssh:checkService ──────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:checkService',
    async (args: { sessionId: string; serviceName: string }) => {
      const output = await exec(
        args.sessionId,
        `systemctl status ${args.serviceName} 2>/dev/null || service ${args.serviceName} status 2>/dev/null`,
        8000
      );
      const isActive = /active \(running\)|is running/i.test(output);
      const isEnabled = /enabled/i.test(output);
      return { serviceName: args.serviceName, isActive, isEnabled, output };
    },
    {
      category: 'ssh',
      description: 'Check the status of a system service on a remote SSH host',
      target: 'remote',
      riskLevel: 'safe',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
        serviceName: z.string().describe('Name of the service to check'),
      }),
    }
  );

  // ── ssh:manageService ─────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:manageService',
    async (args: { sessionId: string; serviceName: string; action: 'start' | 'stop' | 'restart' | 'reload' }) => {
      const output = await exec(
        args.sessionId,
        `sudo systemctl ${args.action} ${args.serviceName} 2>&1`,
        15000
      );
      const result = await exec(args.sessionId, `systemctl is-active ${args.serviceName} 2>/dev/null`);
      return { serviceName: args.serviceName, action: args.action, status: result.trim(), output };
    },
    {
      category: 'ssh',
      description: 'Start, stop, restart, or reload a system service on a remote SSH host',
      target: 'remote',
      riskLevel: 'dangerous',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
        serviceName: z.string().describe('Name of the service'),
        action: z.enum(['start', 'stop', 'restart', 'reload']).describe('Action to perform'),
      }),
    }
  );

  // ── ssh:viewLogs ──────────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:viewLogs',
    async (args: { sessionId: string; source: string; lines?: number; filter?: string }) => {
      const { sessionId, source, lines = 50, filter } = args;
      let cmd: string;
      if (source.startsWith('/')) {
        // File path
        cmd = filter
          ? `tail -n ${lines} ${source} | grep -i '${filter}'`
          : `tail -n ${lines} ${source}`;
      } else {
        // journald unit
        cmd = filter
          ? `journalctl -u ${source} -n ${lines} --no-pager 2>/dev/null | grep -i '${filter}'`
          : `journalctl -u ${source} -n ${lines} --no-pager 2>/dev/null`;
      }
      const output = await exec(sessionId, cmd, 15000);
      return { source, lines, filter, output };
    },
    {
      category: 'ssh',
      description: 'View log file or journald logs on a remote SSH host',
      target: 'remote',
      riskLevel: 'safe',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
        source: z.string().describe('Log file path (e.g. /var/log/syslog) or service name for journald'),
        lines: z.number().optional().describe('Number of lines to return (default 50)'),
        filter: z.string().optional().describe('Grep filter string'),
      }),
    }
  );

  // ── ssh:getEnvVars ────────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:getEnvVars',
    async (args: { sessionId: string; names?: string[] }) => {
      const { sessionId, names } = args;
      const cmd = names?.length
        ? names.map(n => `echo "${n}=$\{${n}}"` ).join('; ')
        : 'env | sort';
      const output = await exec(sessionId, cmd, 5000);
      const vars: Record<string, string> = {};
      output.split('\n').filter(Boolean).forEach(line => {
        const idx = line.indexOf('=');
        if (idx > 0) {
          vars[line.slice(0, idx)] = line.slice(idx + 1);
        }
      });
      return { vars, count: Object.keys(vars).length };
    },
    {
      category: 'ssh',
      description: 'Get environment variables from a remote SSH session',
      target: 'remote',
      riskLevel: 'safe',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
        names: z.array(z.string()).optional().describe('Specific variable names (empty = all)'),
      }),
    }
  );
}
