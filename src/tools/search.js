/**
 * Search Tools
 * Find files by glob pattern and search text/regex inside file contents.
 */
const fs   = require('fs/promises');
const path = require('path');
const { workspaceContext } = require('./workspaceContext');

// Directories to skip during recursive walks
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-electron',
  '.angular', 'release', '.cache', 'coverage', '.nyc_output',
]);

const MAX_FILE_SIZE_BYTES = 1_000_000; // 1 MB
const REGEX_SPECIAL = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);

/** Convert a glob pattern to a RegExp. Supports *, **, ? */
function globToRegex(pattern) {
  const normalized = pattern.replace(/\\/g, '/');
  let re = '';
  let i = 0;
  while (i < normalized.length) {
    const c = normalized[i];
    if (c === '*' && normalized[i + 1] === '*') {
      if (normalized[i + 2] === '/') {
        re += '(?:[^/]+/)*';
        i += 3;
      } else {
        re += '.*';
        i += 2;
      }
    } else if (c === '*') {
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (REGEX_SPECIAL.has(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  const prefix = normalized.startsWith('/') || normalized.startsWith('*') ? '' : '(?:.*/)?';
  return new RegExp('^' + prefix + re + '$', 'i');
}

/** Recursively collect file paths under dir. */
async function walkFiles(dir, baseDir, results, pattern, maxResults, includeIgnored) {
  if (results.length >= maxResults) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= maxResults) break;
    if (!includeIgnored && IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(fullPath, baseDir, results, pattern, maxResults, includeIgnored);
    } else if (entry.isFile()) {
      const relative = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      if (!pattern || pattern.test(relative)) {
        results.push(fullPath);
      }
    }
  }
}

/**
 * Find files matching a glob pattern in the workspace.
 *
 * @param {string} query       Glob pattern (e.g. **\/*.ts, src\/**, *.json)
 * @param {number} [maxResults] Max results (default 20)
 */
async function findFiles(query, maxResults = 20) {
  const pattern = globToRegex(query);
  const all = [];
  const searchDir = workspaceContext.getWorkspacePath();
  await walkFiles(searchDir, searchDir, all, pattern, maxResults + 1, false);
  const truncated = all.length > maxResults;
  return {
    files: all.slice(0, maxResults).map((f) => workspaceContext.relativePath(f)),
    totalFound: all.length,
    truncated,
  };
}

/**
 * Search for a text or regex pattern inside file contents.
 *
 * @param {string}  query             Text or regex to search
 * @param {boolean} [isRegexp]        Treat query as regex (default false)
 * @param {string}  [includePattern]  Glob to filter candidate files
 * @param {number}  [maxResults]      Max matching lines (default 20)
 * @param {boolean} [includeIgnoredFiles] Include node_modules etc (default false)
 */
async function findTextInFiles(query, isRegexp = false, includePattern, maxResults = 20, includeIgnoredFiles = false) {
  let searchRegex;
  try {
    const regexSource = isRegexp
      ? query
      : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    searchRegex = new RegExp(regexSource, 'g');
  } catch {
    return { matches: [], filesSearched: 0, truncated: false, query, isRegexp };
  }

  const filePattern = includePattern ? globToRegex(includePattern) : null;
  const allFiles = [];
  const searchDir = workspaceContext.getWorkspacePath();
  await walkFiles(searchDir, searchDir, allFiles, filePattern, 10000, includeIgnoredFiles);

  const matches = [];
  let filesSearched = 0;

  for (const file of allFiles) {
    if (matches.length >= maxResults) break;
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_FILE_SIZE_BYTES) continue;
      const content = await fs.readFile(file, 'utf8');
      if (content.includes('\0')) continue; // skip binary
      filesSearched++;
      const lines = content.split('\n');
      for (let lineIdx = 0; lineIdx < lines.length && matches.length < maxResults; lineIdx++) {
        searchRegex.lastIndex = 0;
        const m = searchRegex.exec(lines[lineIdx]);
        if (m) {
          matches.push({
            file: workspaceContext.relativePath(file),
            line: lineIdx + 1,
            column: m.index + 1,
            text: lines[lineIdx],
          });
        }
      }
    } catch { /* skip unreadable files */ }
  }

  return { matches, filesSearched, truncated: matches.length >= maxResults, query, isRegexp };
}

module.exports = { findFiles, findTextInFiles };
