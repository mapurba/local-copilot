/**
 * Local File Tools
 * 
 * Tools for reading, writing, and managing files in the local workspace.
 * Ported from brown-bag session and enhanced with TypeScript.
 */

import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';
import { ToolRegistry } from '../../registry';

const MAX_LINES_PER_READ = 2000;

/**
 * Get workspace root path
 */
function getWorkspacePath(): string {
  // Default to user data directory if no workspace is open
  return process.env.WORKSPACE_PATH || app.getPath('userData');
}

/**
 * Resolve path relative to workspace
 */
function resolvePath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.resolve(getWorkspacePath(), filePath);
}

/**
 * Read file contents with optional line range
 */
export async function readFile(args: {
  filePath: string;
  offset?: number;
  limit?: number;
}): Promise<{
  filePath: string;
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  error?: string;
}> {
  try {
    const resolved = resolvePath(args.filePath);
    const raw = await fs.readFile(resolved, 'utf8');
    const lines = raw.split('\n');
    const totalLines = lines.length;
    const startIdx = Math.max((args.offset ?? 1) - 1, 0);

    if (startIdx >= totalLines) {
      return {
        filePath: resolved,
        content: '',
        totalLines,
        startLine: args.offset ?? 1,
        endLine: args.offset ?? 1,
        truncated: false,
        error: `Invalid offset ${args.offset}: file only has ${totalLines} lines. Line numbers are 1-indexed.`,
      };
    }

    const maxLines = Math.min(args.limit ?? MAX_LINES_PER_READ, MAX_LINES_PER_READ);
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
  } catch (error) {
    return {
      filePath: args.filePath,
      content: '',
      totalLines: 0,
      startLine: 1,
      endLine: 1,
      truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * List directory contents
 */
export async function listDir(args: {
  dirPath: string;
}): Promise<{
  dirPath: string;
  entries: Array<{
    name: string;
    type: 'file' | 'directory';
    size?: number;
  }>;
  error?: string;
}> {
  try {
    const resolved = resolvePath(args.dirPath);
    const entries = await fs.readdir(resolved, { withFileTypes: true });

    const result = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(resolved, entry.name);
        let size: number | undefined;
        
        if (entry.isFile()) {
          try {
            const stats = await fs.stat(fullPath);
            size = stats.size;
          } catch {
            // Ignore stat errors
          }
        }

        return {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' as const : 'file' as const,
          size,
        };
      })
    );

    return {
      dirPath: resolved,
      entries: result,
    };
  } catch (error) {
    return {
      dirPath: args.dirPath,
      entries: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Create a new file
 */
export async function createFile(args: {
  filePath: string;
  content: string;
}): Promise<{
  success: boolean;
  filePath: string;
  message: string;
}> {
  try {
    const resolved = resolvePath(args.filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    
    try {
      await fs.access(resolved);
      return {
        success: false,
        filePath: resolved,
        message: `File already exists: ${resolved}. Use writeFile to overwrite.`,
      };
    } catch {
      // File doesn't exist, proceed
    }

    await fs.writeFile(resolved, args.content, 'utf8');
    return {
      success: true,
      filePath: resolved,
      message: `Created ${resolved}`,
    };
  } catch (error) {
    return {
      success: false,
      filePath: args.filePath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Write or overwrite a file
 */
export async function writeFile(args: {
  filePath: string;
  content: string;
}): Promise<{
  success: boolean;
  filePath: string;
  message: string;
}> {
  try {
    const resolved = resolvePath(args.filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, args.content, 'utf8');
    return {
      success: true,
      filePath: resolved,
      message: `Written ${resolved}`,
    };
  } catch (error) {
    return {
      success: false,
      filePath: args.filePath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Delete a file
 */
export async function deleteFile(args: {
  filePath: string;
}): Promise<{
  success: boolean;
  filePath: string;
  message: string;
}> {
  try {
    const resolved = resolvePath(args.filePath);
    await fs.unlink(resolved);
    return {
      success: true,
      filePath: resolved,
      message: `Deleted ${resolved}`,
    };
  } catch (error) {
    return {
      success: false,
      filePath: args.filePath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Register all local file tools
 */
export function registerLocalFileTools(registry: ToolRegistry): void {
  registry.register('local:readFile', readFile, {
    category: 'local',
    description: 'Read file contents with optional offset/limit (max 2000 lines)',
    target: 'local',
    riskLevel: 'safe',
  });

  registry.register('local:listDir', listDir, {
    category: 'local',
    description: 'List directory contents with type and size info',
    target: 'local',
    riskLevel: 'safe',
  });

  registry.register('local:createFile', createFile, {
    category: 'local',
    description: 'Create a new file (fails if it already exists)',
    target: 'local',
    riskLevel: 'review',
  });

  registry.register('local:writeFile', writeFile, {
    category: 'local',
    description: 'Write or overwrite a file with new content',
    target: 'local',
    riskLevel: 'review',
  });

  registry.register('local:deleteFile', deleteFile, {
    category: 'local',
    description: 'Delete a file permanently',
    target: 'local',
    riskLevel: 'dangerous',
  });
}
