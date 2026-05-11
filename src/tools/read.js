/**
 * Read Tools
 * Read files and list directory contents in the workspace.
 */
const fs   = require('fs/promises');
const path = require('path');
const { workspaceContext } = require('./workspaceContext');

const MAX_LINES_PER_READ = 2000;

/**
 * Read the contents of a file.
 * Line numbers are 1-indexed. Truncates at 2000 lines.
 *
 * @param {string} filePath  Path relative to workspace or absolute
 * @param {number} [offset]  1-based line number to start from (default: 1)
 * @param {number} [limit]   Maximum lines to read (capped at 2000)
 */
async function readFile(filePath, offset, limit) {
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
        error: `Invalid offset ${offset}: file only has ${totalLines} lines. Line numbers are 1-indexed.`,
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
      startLine: 1,
      endLine: 1,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * List directory contents with type and size info.
 *
 * @param {string} dirPath  Path relative to workspace or absolute
 */
async function listDir(dirPath) {
  try {
    const resolved = workspaceContext.resolvePath(dirPath);
    const entries = await fs.readdir(resolved, { withFileTypes: true });

    const items = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(resolved, entry.name);
        let size = 0;
        try {
          if (entry.isFile()) {
            const stat = await fs.stat(fullPath);
            size = stat.size;
          }
        } catch { /* ignore stat errors */ }

        return {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size,
          path: workspaceContext.relativePath(fullPath),
        };
      })
    );

    // Sort: directories first, then files
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return { dirPath: resolved, entries: items, total: items.length };
  } catch (err) {
    return {
      dirPath,
      entries: [],
      total: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

module.exports = { readFile, listDir };
