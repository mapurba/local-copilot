/**
 * Read Tools
 *
 * Read files and list directory contents in the workspace.
 * Mirrors the VS Code Copilot "read" tool category.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { workspaceContext } from '../workspaceContext';

const MAX_LINES_PER_READ = 2000;

export interface ReadFileResult {
  filePath: string;
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  error?: string;
}

export interface ListDirEntry {
  name: string; // directories end with /
  type: 'file' | 'directory';
  size?: number; // bytes, files only
}

export interface ListDirResult {
  path: string;
  entries: ListDirEntry[];
  error?: string;
}

/**
 * Read the contents of a file.
 * Line numbers are 1-indexed. Truncates at 2000 lines; use offset + limit to page through large files.
 *
 * @param filePath Path relative to workspace, or absolute path (must be within workspace)
 * @param offset   1-based line number to start reading from (default: 1)
 * @param limit    Maximum number of lines to read (capped at 2000)
 */
export async function readFile(
  filePath: string,
  offset?: number,
  limit?: number,
): Promise<ReadFileResult> {
  try {
    const resolved = workspaceContext.resolvePath(filePath);
    const raw = await fs.readFile(resolved, 'utf8');
    const lines = raw.split('\n');
    const totalLines = lines.length;

    const startIdx = Math.max((offset ?? 1) - 1, 0);
    if (startIdx >= totalLines) {
      return {
        filePath: resolved,
        content: '',
        totalLines,
        startLine: offset ?? 1,
        endLine: offset ?? 1,
        truncated: false,
        error: `Invalid offset ${offset}: file only has ${totalLines} line${totalLines === 1 ? '' : 's'}. Line numbers are 1-indexed.`,
      };
    }

    const maxLines = Math.min(limit ?? MAX_LINES_PER_READ, MAX_LINES_PER_READ);
    const endIdx = Math.min(startIdx + maxLines, totalLines);
    const truncated = endIdx < totalLines;

    return {
      filePath: resolved,
      content: lines.slice(startIdx, endIdx).join('\n'),
      totalLines,
      startLine: startIdx + 1,
      endLine: endIdx,
      truncated,
    };
  } catch (err) {
    return {
      filePath,
      content: '',
      totalLines: 0,
      startLine: offset ?? 1,
      endLine: offset ?? 1,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * List the contents of a directory.
 * Directory names are suffixed with / to distinguish them from files.
 * Results are sorted: directories first, then files alphabetically.
 *
 * @param dirPath Path relative to workspace, or absolute path (must be within workspace)
 */
export async function listDir(dirPath: string): Promise<ListDirResult> {
  try {
    const resolved = workspaceContext.resolvePath(dirPath);
    const rawEntries = await fs.readdir(resolved, { withFileTypes: true });

    const entries: ListDirEntry[] = await Promise.all(
      rawEntries.map(async (e): Promise<ListDirEntry> => {
        const isDir = e.isDirectory();
        const entry: ListDirEntry = {
          name: isDir ? e.name + '/' : e.name,
          type: isDir ? 'directory' : 'file',
        };
        if (!isDir) {
          try {
            const stat = await fs.stat(path.join(resolved, e.name));
            entry.size = stat.size;
          } catch {
            // stat failure is non-fatal
          }
        }
        return entry;
      }),
    );

    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return { path: resolved, entries };
  } catch (err) {
    return {
      path: dirPath,
      entries: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
