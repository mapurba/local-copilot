/**
 * VM Watcher — Actions (logic layer)
 *
 * Pure functions that perform the actual work during a watch cycle.
 * No Electron, no taskTracker, no setInterval — just VCD and SSH.
 *
 * Consumed by vmWatcher.ts (the scheduling engine).
 */

import { Client as SSH2Client } from 'ssh2';
import { checkVmStatus } from './vcdApi';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SshTarget {
  ip: string;
  username: string;
  password: string;
}

export interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ── VCD ───────────────────────────────────────────────────────────────────────

/**
 * Ask VCD whether a VM is powered on.
 * Returns true/false, throws on API error.
 */
export async function isVmPoweredOn(vmName: string): Promise<boolean> {
  const status = await checkVmStatus(vmName);
  const vm = (status as { vm?: { powered_on?: boolean } }).vm;
  return vm?.powered_on === true;
}

// ── SSH ───────────────────────────────────────────────────────────────────────

/**
 * Connect to a host via SSH, run all commands sequentially, return results.
 * Throws if the connection fails or any exec fails fatally.
 */
export function runSshCommands(
  target: SshTarget,
  commands: string[]
): Promise<CommandResult[]> {
  return new Promise((resolve, reject) => {
    const client = new SSH2Client();
    const results: CommandResult[] = [];

    client.on('ready', async () => {
      console.log(`[vmWatcherActions] SSH connected to ${target.username}@${target.ip}`);
      try {
        for (const cmd of commands) {
          const r = await execOnClient(client, cmd);
          results.push({ command: cmd, ...r });
        }
        client.end();
        resolve(results);
      } catch (err) {
        client.end();
        reject(err);
      }
    });

    client.on('error', (err) => {
      reject(new Error(`SSH connection to ${target.ip} failed: ${err.message}`));
    });

    client.connect({
      host: target.ip,
      port: 22,
      username: target.username,
      password: target.password,
      readyTimeout: 60_000,
      hostVerifier: () => true,
    });
  });
}

/**
 * Run a single command on an already-connected SSH2 client.
 */
function execOnClient(
  client: SSH2Client,
  command: string,
  timeoutMs = 30_000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(new Error(`exec failed: ${err.message}`));

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { stream.close(); }, timeoutMs);

      stream.on('data', (data: Buffer) => { stdout += data.toString(); });
      stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      stream.on('close', (code: number) => {
        clearTimeout(timer);
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 0 });
      });
      stream.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
    });
  });
}

/**
 * Returns true if the error looks like a transient network/boot issue
 * (SSH daemon not ready yet) rather than an auth failure.
 */
export function isTransientSshError(message: string): boolean {
  return /ETIMEDOUT|ECONNREFUSED|ECONNRESET|handshake|timed out/i.test(message);
}
