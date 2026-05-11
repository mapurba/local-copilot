/**
 * Edit Tools
 * Create, write, and modify files in the workspace.
 */
const fs   = require('fs/promises');
const path = require('path');
const { workspaceContext } = require('./workspaceContext');

/** Create a new file (fails if it already exists). */
async function createFile(filePath, content) {
  try {
    const resolved = workspaceContext.resolvePath(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    try {
      await fs.access(resolved);
      return { success: false, filePath: resolved, message: `File already exists: ${resolved}. Use writeFile to overwrite.` };
    } catch { /* does not exist — proceed */ }
    await fs.writeFile(resolved, content, 'utf8');
    return { success: true, filePath: resolved, message: `Created ${resolved}` };
  } catch (err) {
    return { success: false, filePath, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Write or overwrite a file with new content. */
async function writeFile(filePath, content) {
  try {
    const resolved = workspaceContext.resolvePath(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, 'utf8');
    return { success: true, filePath: resolved, message: `Written ${resolved}` };
  } catch (err) {
    return { success: false, filePath, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Replace exactly one occurrence of oldString with newString in a file.
 * Returns an error if oldString is not found or appears more than once.
 */
async function replaceStringInFile(filePath, oldString, newString) {
  try {
    const resolved = workspaceContext.resolvePath(filePath);
    const content = await fs.readFile(resolved, 'utf8');
    const parts = content.split(oldString);
    const occurrences = parts.length - 1;
    if (occurrences === 0) {
      return { success: false, filePath: resolved, message: `oldString not found in ${resolved}` };
    }
    if (occurrences > 1) {
      return { success: false, filePath: resolved, message: `oldString appears ${occurrences} times — it must appear exactly once` };
    }
    await fs.writeFile(resolved, parts.join(newString), 'utf8');
    return { success: true, filePath: resolved, message: `Replaced 1 occurrence in ${resolved}` };
  } catch (err) {
    return { success: false, filePath, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Apply multiple string replacements across one or more files.
 * @param {{ filePath: string, oldString: string, newString: string }[]} replacements
 */
async function multiReplaceStringInFile(replacements) {
  const results = [];
  const byFile = new Map();
  for (const r of replacements) {
    const resolved = workspaceContext.resolvePath(r.filePath);
    if (!byFile.has(resolved)) byFile.set(resolved, []);
    byFile.get(resolved).push({ ...r, filePath: resolved });
  }
  for (const [resolvedPath, fileReplacements] of byFile) {
    let content;
    try {
      content = await fs.readFile(resolvedPath, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const _ of fileReplacements) results.push({ success: false, filePath: resolvedPath, message: msg });
      continue;
    }
    let current = content;
    const fileResults = [];
    let fileOk = true;
    for (const r of fileReplacements) {
      const parts = current.split(r.oldString);
      const occurrences = parts.length - 1;
      if (occurrences === 0) {
        fileResults.push({ success: false, filePath: resolvedPath, message: `oldString not found in ${resolvedPath}` });
        fileOk = false;
      } else if (occurrences > 1) {
        fileResults.push({ success: false, filePath: resolvedPath, message: `oldString appears ${occurrences} times` });
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
        for (const fr of fileResults) { fr.success = false; fr.message = msg; }
      }
    }
    results.push(...fileResults);
  }
  return results;
}

/** Delete a file permanently. */
async function deleteFile(filePath) {
  try {
    const resolved = workspaceContext.resolvePath(filePath);
    await fs.unlink(resolved);
    return { success: true, filePath: resolved, message: `Deleted ${resolved}` };
  } catch (err) {
    return { success: false, filePath, message: err instanceof Error ? err.message : String(err) };
  }
}

module.exports = { createFile, writeFile, replaceStringInFile, multiReplaceStringInFile, deleteFile };
