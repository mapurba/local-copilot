/**
 * Edit Tools
 *
 * Create, write, and modify files in the workspace.
 * Mirrors the VS Code Copilot "edit" tool category.
 *
 * Tool summary:
 *   createFile            – create a new file (fails if it exists)
 *   writeFile             – write/overwrite a file unconditionally
 *   replaceStringInFile   – replace exactly one occurrence of a string (safe single-replacement)
 *   multiReplaceStringInFile – apply multiple replacements across one or more files atomically
 *   deleteFile            – delete a file
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { workspaceContext } from '../workspaceContext';

export interface EditResult {
  success: boolean;
  filePath: string;
  message: string;
}

// ─── createFile ─────────────────────────────────────────────────────────────

/**
 * Create a new file with the given content.
 * Fails if the file already exists. Creates parent directories as needed.
 *
 * @param filePath Path relative to workspace, or absolute path (must be within workspace)
 * @param content  File content to write
 */
export async function createFile(filePath: string, content: string): Promise<EditResult> {
  try {
    const resolved = workspaceContext.resolvePath(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });

    // Fail if already exists
    try {
      await fs.access(resolved);
      return {
        success: false,
        filePath: resolved,
        message: `File already exists: ${resolved}. Use writeFile to overwrite.`,
      };
    } catch {
      // does not exist – proceed
    }

    await fs.writeFile(resolved, content, 'utf8');
    return { success: true, filePath: resolved, message: `Created ${resolved}` };
  } catch (err) {
    return {
      success: false,
      filePath,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── writeFile ──────────────────────────────────────────────────────────────

/**
 * Write or overwrite a file with new content.
 * Creates parent directories as needed. Use createFile if you want safety-on-exists.
 *
 * @param filePath Path relative to workspace, or absolute path (must be within workspace)
 * @param content  File content to write
 */
export async function writeFile(filePath: string, content: string): Promise<EditResult> {
  try {
    const resolved = workspaceContext.resolvePath(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, 'utf8');
    return { success: true, filePath: resolved, message: `Written ${resolved}` };
  } catch (err) {
    return {
      success: false,
      filePath,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── replaceStringInFile ────────────────────────────────────────────────────

/**
 * Replace exactly one occurrence of oldString with newString in a file.
 * Returns an error if oldString is not found or appears more than once.
 *
 * @param filePath  Path relative to workspace, or absolute path (must be within workspace)
 * @param oldString The exact literal string to replace (must appear exactly once)
 * @param newString The replacement string
 */
export async function replaceStringInFile(
  filePath: string,
  oldString: string,
  newString: string,
): Promise<EditResult> {
  try {
    const resolved = workspaceContext.resolvePath(filePath);
    const content = await fs.readFile(resolved, 'utf8');

    // Use split/join for safe counting & replacing (avoids $& patterns in replace())
    const parts = content.split(oldString);
    const occurrences = parts.length - 1;

    if (occurrences === 0) {
      return {
        success: false,
        filePath: resolved,
        message: `oldString not found in ${resolved}`,
      };
    }
    if (occurrences > 1) {
      return {
        success: false,
        filePath: resolved,
        message: `oldString appears ${occurrences} times in ${resolved} — it must appear exactly once for a safe replacement`,
      };
    }

    const updated = parts.join(newString);
    await fs.writeFile(resolved, updated, 'utf8');
    return { success: true, filePath: resolved, message: `Replaced 1 occurrence in ${resolved}` };
  } catch (err) {
    return {
      success: false,
      filePath,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── multiReplaceStringInFile ───────────────────────────────────────────────

export interface MultiReplacement {
  filePath: string;
  oldString: string;
  newString: string;
}

export interface MultiReplaceResult {
  results: EditResult[];
  successCount: number;
  failureCount: number;
}

/**
 * Apply multiple string replacements across one or more files.
 * Replacements targeting the same file are applied together before writing,
 * so the file is written once per file regardless of how many replacements apply.
 *
 * @param replacements Array of { filePath, oldString, newString } operations (paths relative to workspace)
 */
export async function multiReplaceStringInFile(
  replacements: MultiReplacement[],
): Promise<MultiReplaceResult> {
  const results: EditResult[] = [];

  // Group replacements by resolved file path to batch writes
  const byFile = new Map<string, MultiReplacement[]>();
  for (const r of replacements) {
    const resolved = workspaceContext.resolvePath(r.filePath);
    if (!byFile.has(resolved)) byFile.set(resolved, []);
    byFile.get(resolved)!.push({ ...r, filePath: resolved });
  }

  for (const [resolvedPath, fileReplacements] of byFile) {
    let content: string;
    try {
      content = await fs.readFile(resolvedPath, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const _ of fileReplacements) {
        results.push({ success: false, filePath: resolvedPath, message: msg });
      }
      continue;
    }

    let current = content;
    const fileResults: EditResult[] = [];
    let fileOk = true;

    for (const r of fileReplacements) {
      const parts = current.split(r.oldString);
      const occurrences = parts.length - 1;
      if (occurrences === 0) {
        fileResults.push({
          success: false,
          filePath: resolvedPath,
          message: `oldString not found in ${resolvedPath}`,
        });
        fileOk = false;
      } else if (occurrences > 1) {
        fileResults.push({
          success: false,
          filePath: resolvedPath,
          message: `oldString appears ${occurrences} times — must be unique`,
        });
        fileOk = false;
      } else {
        current = parts.join(r.newString);
        fileResults.push({ success: true, filePath: resolvedPath, message: `Replaced in ${resolvedPath}` });
      }
    }

    if (fileOk) {
      try {
        await fs.writeFile(resolvedPath, current, 'utf8');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        for (const res of fileResults) {
          res.success = false;
          res.message = msg;
        }
      }
    }

    results.push(...fileResults);
  }

  return {
    results,
    successCount: results.filter((r) => r.success).length,
    failureCount: results.filter((r) => !r.success).length,
  };
}

// ─── deleteFile ─────────────────────────────────────────────────────────────

/**
 * Delete a file permanently.
 *
 * @param filePath Path relative to workspace, or absolute path (must be within workspace)
 */
export async function deleteFile(filePath: string): Promise<EditResult> {
  try {
    const resolved = workspaceContext.resolvePath(filePath);
    await fs.unlink(resolved);
    return { success: true, filePath: resolved, message: `Deleted ${resolved}` };
  } catch (err) {
    return {
      success: false,
      filePath,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
