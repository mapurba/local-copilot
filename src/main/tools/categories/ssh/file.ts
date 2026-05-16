/**
 * SSH File Operation Tools
 * readRemoteFile, writeRemoteFile, listDirectory, uploadFile, downloadFile,
 * deleteRemoteFile, makeDirectory, getFileInfo
 */

import { Client as SSH2Client, SFTPWrapper } from 'ssh2';
import { toolRegistry } from '../../registry';
import { getActiveSession } from './session';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB read limit

function getSftp(sessionId: string): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    const session = getActiveSession(sessionId);
    if (!session) {
      reject(new Error(`SSH session not found: ${sessionId}`));
      return;
    }
    session.client.sftp((err, sftp) => {
      if (err) reject(new Error(`SFTP open failed: ${err.message}`));
      else resolve(sftp);
    });
  });
}

export function registerSshFileTools() {
  // ── ssh:readFile ──────────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:readFile',
    async (args: { sessionId: string; path: string }) => {
      const sftp = await getSftp(args.sessionId);
      return new Promise<{ path: string; content: string; size: number }>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let totalSize = 0;

        const stream = sftp.createReadStream(args.path);
        stream.on('data', (chunk: Buffer) => {
          totalSize += chunk.length;
          if (totalSize > MAX_FILE_SIZE) {
            stream.destroy();
            reject(new Error(`File exceeds 2 MB read limit (${totalSize} bytes)`));
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', () => {
          const content = Buffer.concat(chunks).toString('utf8');
          resolve({ path: args.path, content, size: totalSize });
        });
        stream.on('error', (e: Error) => reject(e));
      });
    },
    {
      category: 'ssh',
      description: 'Read a file from a remote SSH host (max 2 MB)',
      target: 'remote',
      riskLevel: 'safe',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
        path: z.string().describe('Absolute path to file on remote host'),
      }),
    }
  );

  // ── ssh:writeFile ─────────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:writeFile',
    async (args: { sessionId: string; path: string; content: string }) => {
      const sftp = await getSftp(args.sessionId);
      return new Promise<{ path: string; bytesWritten: number }>((resolve, reject) => {
        const buffer = Buffer.from(args.content, 'utf8');
        const stream = sftp.createWriteStream(args.path);
        stream.on('close', () => resolve({ path: args.path, bytesWritten: buffer.length }));
        stream.on('error', (e: Error) => reject(e));
        stream.end(buffer);
      });
    },
    {
      category: 'ssh',
      description: 'Write or overwrite a file on a remote SSH host',
      target: 'remote',
      riskLevel: 'review',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
        path: z.string().describe('Absolute path to file on remote host'),
        content: z.string().describe('Text content to write'),
      }),
    }
  );

  // ── ssh:listDirectory ─────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:listDirectory',
    async (args: { sessionId: string; path: string }) => {
      const sftp = await getSftp(args.sessionId);
      return new Promise<{ path: string; entries: Array<{ name: string; type: 'file' | 'dir' | 'other'; size: number; modified: number; permissions: string }> }>((resolve, reject) => {
        sftp.readdir(args.path, (err, list) => {
          if (err) {
            reject(new Error(`listdir failed: ${err.message}`));
            return;
          }
          const entries = list.map(item => ({
            name: item.filename,
            type: item.attrs.isDirectory() ? 'dir' as const : item.attrs.isFile() ? 'file' as const : 'other' as const,
            size: item.attrs.size,
            modified: (item.attrs.mtime ?? 0) * 1000,
            permissions: item.longname.slice(0, 10),
          }));
          resolve({ path: args.path, entries });
        });
      });
    },
    {
      category: 'ssh',
      description: 'List directory contents on a remote SSH host',
      target: 'remote',
      riskLevel: 'safe',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
        path: z.string().describe('Absolute directory path on remote host'),
      }),
    }
  );

  // ── ssh:deleteFile ────────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:deleteFile',
    async (args: { sessionId: string; path: string }) => {
      const sftp = await getSftp(args.sessionId);
      return new Promise<{ success: boolean; path: string }>((resolve, reject) => {
        sftp.unlink(args.path, (err) => {
          if (err) reject(new Error(`delete failed: ${err.message}`));
          else resolve({ success: true, path: args.path });
        });
      });
    },
    {
      category: 'ssh',
      description: 'Delete a file on a remote SSH host',
      target: 'remote',
      riskLevel: 'dangerous',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
        path: z.string().describe('Absolute path to file to delete'),
      }),
    }
  );

  // ── ssh:makeDirectory ─────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:makeDirectory',
    async (args: { sessionId: string; path: string }) => {
      const sftp = await getSftp(args.sessionId);
      return new Promise<{ success: boolean; path: string }>((resolve, reject) => {
        sftp.mkdir(args.path, (err) => {
          if (err) reject(new Error(`mkdir failed: ${err.message}`));
          else resolve({ success: true, path: args.path });
        });
      });
    },
    {
      category: 'ssh',
      description: 'Create a directory on a remote SSH host',
      target: 'remote',
      riskLevel: 'review',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
        path: z.string().describe('Absolute path of directory to create'),
      }),
    }
  );

  // ── ssh:uploadFile ────────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:uploadFile',
    async (args: { sessionId: string; localPath: string; remotePath: string }) => {
      const sftp = await getSftp(args.sessionId);
      const localContent = await fs.readFile(args.localPath);
      
      return new Promise<{ success: boolean; remotePath: string; bytesUploaded: number }>((resolve, reject) => {
        const stream = sftp.createWriteStream(args.remotePath);
        stream.on('close', () => resolve({ success: true, remotePath: args.remotePath, bytesUploaded: localContent.length }));
        stream.on('error', (e: Error) => reject(e));
        stream.end(localContent);
      });
    },
    {
      category: 'ssh',
      description: 'Upload a local file to a remote SSH host',
      target: 'remote',
      riskLevel: 'review',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
        localPath: z.string().describe('Absolute local path of file to upload'),
        remotePath: z.string().describe('Absolute remote path destination'),
      }),
    }
  );

  // ── ssh:downloadFile ──────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:downloadFile',
    async (args: { sessionId: string; remotePath: string; localPath: string }) => {
      const sftp = await getSftp(args.sessionId);
      const chunks: Buffer[] = [];

      return new Promise<{ success: boolean; localPath: string; bytesDownloaded: number }>((resolve, reject) => {
        const stream = sftp.createReadStream(args.remotePath);
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', async () => {
          const content = Buffer.concat(chunks);
          await fs.mkdir(path.dirname(args.localPath), { recursive: true });
          await fs.writeFile(args.localPath, content);
          resolve({ success: true, localPath: args.localPath, bytesDownloaded: content.length });
        });
        stream.on('error', (e: Error) => reject(e));
      });
    },
    {
      category: 'ssh',
      description: 'Download a file from a remote SSH host to local disk',
      target: 'remote',
      riskLevel: 'review',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
        remotePath: z.string().describe('Absolute remote file path'),
        localPath: z.string().describe('Absolute local destination path'),
      }),
    }
  );

  // ── ssh:getFileInfo ───────────────────────────────────────────────────────
  toolRegistry.register(
    'ssh:getFileInfo',
    async (args: { sessionId: string; path: string }) => {
      const sftp = await getSftp(args.sessionId);
      return new Promise<{ path: string; size: number; modified: number; isFile: boolean; isDirectory: boolean; permissions: string } | { error: string }>((resolve) => {
        sftp.stat(args.path, (err, stats) => {
          if (err) {
            resolve({ error: err.message });
            return;
          }
          resolve({
            path: args.path,
            size: stats.size,
            modified: (stats.mtime ?? 0) * 1000,
            isFile: stats.isFile(),
            isDirectory: stats.isDirectory(),
            permissions: ((stats as unknown as { permissions?: number }).permissions ?? 0).toString(8) ?? 'unknown',
          });
        });
      });
    },
    {
      category: 'ssh',
      description: 'Get file or directory metadata on a remote SSH host',
      target: 'remote',
      riskLevel: 'safe',
      schema: z.object({
        sessionId: z.string().describe('SSH session ID'),
        path: z.string().describe('Absolute path on remote host'),
      }),
    }
  );
}
