/**
 * Search Tools
 *
 * Find files by glob pattern and search text/regex inside file contents.
 * Mirrors the VS Code Copilot "search" tool category.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { workspaceContext } from '../workspaceContext';

// Directories to skip during recursive walks
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-electron',
  '.angular', 'release', '.cache', 'coverage', '.nyc_output',
]);

const MAX_FILE_SIZE_BYTES = 1_000_000; // 1 MB – skip larger files in text search

// Regex special characters that need escaping (not counting glob chars * ? [])
const REGEX_SPECIAL = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);

/**
 * Convert a glob pattern to a RegExp.
 * Supports: * (any chars except /), ** (any path segments), ? (single char)
 *
 * Examples:
 *   **\/*.ts  -> match any .ts file at any depth
 *   src\/**   -> match anything under src/
 *   *.json    -> match .json files in root only
 */
function globToRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  let re = '';
  let i = 0;

  while (i < normalized.length) {
    const c = normalized[i];

    if (c === '*' && normalized[i + 1] === '*') {
      if (normalized[i + 2] === '/') {
        // **/ matches zero or more path segments
        re += '(?:[^/]+/)*';
        i += 3;
      } else {
        // ** at end matches everything including slashes
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

  // Patterns without a leading / or * can match anywhere in the relative path
  const prefix =
    normalized.startsWith('/') || normalized.startsWith('*') ? '' : '(?:.*/)?';

  return new RegExp('^' + prefix + re + '$', 'i');
}

/** Recursively collect file paths under dir, optionally filtering by a regex pattern. */
async function walkFiles(
  dir: string,
  baseDir: string,
  results: string[],
  pattern: RegExp | null,
  maxResults: number,
  includeIgnored: boolean,
): Promise<void> {
  if (results.length >= maxResults) return;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // skip unreadable directories
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

export interface FindFilesResult {
  files: string[];
  totalFound: number;
  truncated: boolean;
}

/**
 * Find files matching a glob pattern in the workspace.
 *
 * @param query      Glob pattern (e.g. **\/*.ts, src\/**, *.json)
 * @param maxResults Maximum number of results to return (default 20)
 */
export async function findFiles(
  query: string,
  maxResults = 20,
): Promise<FindFilesResult> {
  const pattern = globToRegex(query);
  const all: string[] = [];
  const searchDir = workspaceContext.getWorkspacePath();
  await walkFiles(searchDir, searchDir, all, pattern, maxResults + 1, false);
  const truncated = all.length > maxResults;
  return {
    files: all.slice(0, maxResults).map((f) => workspaceContext.relativePath(f)),
    totalFound: all.length,
    truncated,
  };
}

export interface TextMatch {
  file: string;
  line: number;
  lineContent: string;
  matchStart: number;
  matchEnd: number;
}

export interface FindTextInFilesResult {
  matches: TextMatch[];
  filesSearched: number;
  truncated: boolean;
  query: string;
  isRegexp: boolean;
}

/**
 * Search for a text or regex pattern inside file contents.
 *
 * @param query             Text or regex pattern to search for
 * @param isRegexp          Whether query is treated as a regex (default false)
 * @param includePattern    Glob pattern to filter which files to search (e.g. **\/*.ts)
 * @param maxResults        Maximum number of matching lines to return (default 20)
 * @param includeIgnoredFiles  Include files in node_modules, .git, dist, etc. (default false)
 */
export async function findTextInFiles(
  query: string,
  isRegexp = false,
  includePattern?: string,
  maxResults = 20,
  includeIgnoredFiles = false,
): Promise<FindTextInFilesResult> {
  // Build the search regex - use literal match if not regexp
  let searchRegex: RegExp;
  try {
    const regexSource = isRegexp
      ? query
      : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    searchRegex = new RegExp(regexSource, 'g');
  } catch {
    return {
      matches: [],
      filesSearched: 0,
      truncated: false,
      query,
      isRegexp,
    };
  }

  // Collect candidate files from workspace
  const filePattern = includePattern ? globToRegex(includePattern) : null;
  const allFiles: string[] = [];
  const searchDir = workspaceContext.getWorkspacePath();
  await walkFiles(searchDir, searchDir, allFiles, filePattern, 10_000, includeIgnoredFiles);

  const matches: TextMatch[] = [];
  let filesSearched = 0;

  for (const file of allFiles) {
    if (matches.length >= maxResults) break;
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_FILE_SIZE_BYTES) continue;

      const content = await fs.readFile(file, 'utf8');
      if (content.includes('\0')) continue; // skip binary files

      filesSearched++;
      const lines = content.split('\n');
      for (let lineIdx = 0; lineIdx < lines.length && matches.length < maxResults; lineIdx++) {
        searchRegex.lastIndex = 0;
        const m = searchRegex.exec(lines[lineIdx]);
        if (m) {
          matches.push({
            file: workspaceContext.relativePath(file),
            line: lineIdx + 1,
            lineContent: lines[lineIdx].trim(),
            matchStart: m.index,
            matchEnd: m.index + m[0].length,
          });
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  return {
    matches,
    filesSearched,
    truncated: matches.length >= maxResults,
    query,
    isRegexp,
  };
}
