/**
 * Git & GitHub Tools
 *
 * Two namespaces:
 *
 *   git:*    — Git CLI operations on a local or remote repository.
 *              Every tool accepts an  executionTarget  parameter:
 *                'local'        → run on this machine (default)
 *                <sessionId>    → run on a remote VM via an open ssh: session
 *                                 (call ssh:connect first to get the sessionId)
 *
 *   github:* — GitHub REST API operations. No file-system access required.
 *              Auth token is read from GITHUB_TOKEN env var; never pass it
 *              as a tool argument.
 *
 * ── Git CLI tools ────────────────────────────────────────────────────────────
 *
 *   git:cloneRepository   Clone a repo to a local or remote path
 *   git:getStatus         git status --porcelain → structured JSON
 *   git:fetchAndPull      Fetch + pull; detects merge conflicts
 *   git:getDiff           git diff (unstaged / staged / between branches)
 *   git:createBranch      Create and checkout a new branch
 *   git:stageFiles        git add (explicit file list or '.' for all)
 *   git:commit            git commit -m (fails cleanly if nothing staged)
 *   git:mergeBranch       git merge; detects and surfaces conflicts
 *   git:push              git push --set-upstream (handles new branches)
 *
 * ── GitHub API tools ─────────────────────────────────────────────────────────
 *
 *   github:createPullRequest   Open a PR
 *   github:listIssues          List open issues (filterable)
 *   github:updateIssueOrPR     Close/reopen + add a comment
 *   github:searchCode          Search code across a repo without cloning
 */

'use strict';

const { exec }      = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT = 60_000;   // 60 s — git network ops can be slow
const CLONE_TIMEOUT   = 180_000;  // 3 min for large clones
const MAX_OUTPUT      = 200_000;  // 200 KB cap per stream

const GITHUB_API = 'https://api.github.com';

// ── Execution abstraction ─────────────────────────────────────────────────────
//
//   execGit(command, workspacePath, executionTarget, timeoutMs)
//
//   Dispatches a Git CLI command to either:
//     • The local machine (child_process.exec, cwd = workspacePath)
//     • A remote VM      (ssh:runCommand with "cd <path> && <command>" prefix)
//
//   GIT_TERMINAL_PROMPT=0 prevents git from blocking on credential prompts.
//   --no-pager / GIT_PAGER=cat ensure output is not piped through `less`.

async function execGit(command, workspacePath, executionTarget = 'local', timeoutMs = DEFAULT_TIMEOUT) {
  if (!executionTarget || executionTarget === 'local') {
    // ── Local ────────────────────────────────────────────────────────────────
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' };
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd:       workspacePath || process.cwd(),
        timeout:   timeoutMs,
        maxBuffer: MAX_OUTPUT,
        env,
      });
      return {
        stdout:   stdout.slice(0, MAX_OUTPUT),
        stderr:   stderr.slice(0, MAX_OUTPUT),
        exitCode: 0,
      };
    } catch (err) {
      return {
        stdout:   (err.stdout  ?? '').slice(0, MAX_OUTPUT),
        stderr:   (err.stderr  ?? err.message ?? '').slice(0, MAX_OUTPUT),
        exitCode: typeof err.code === 'number' ? err.code : 1,
      };
    }
  } else {
    // ── Remote via SSH session ────────────────────────────────────────────────
    // The sessionId is the executionTarget value.
    // We wrap the command in: export GIT_TERMINAL_PROMPT=0; cd <path> && <command>
    const { runCommand } = require('./ssh');
    const cdPrefix = workspacePath
      ? `cd ${JSON.stringify(workspacePath)} && `
      : '';
    const remoteCmd = `export GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat; ${cdPrefix}${command}`;
    return runCommand(remoteCmd, executionTarget, timeoutMs);
  }
}

// ── GitHub API helper ─────────────────────────────────────────────────────────

function resolveGitHubToken() {
  const tok = process.env.GITHUB_TOKEN;
  if (!tok) throw new Error('GITHUB_TOKEN env var is not set. Add it to your .env file.');
  return tok;
}

async function ghFetch(path, options = {}) {
  const token = resolveGitHubToken();
  const url   = path.startsWith('http') ? path : `${GITHUB_API}${path}`;

  const res  = await fetch(url, {
    ...options,
    headers: {
      Authorization:          `Bearer ${token}`,
      Accept:                 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type':         'application/json',
      ...(options.headers ?? {}),
    },
  });

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }

  return { status: res.status, ok: res.ok, body };
}

// ── Conflict detection helper ─────────────────────────────────────────────────

function detectConflict(stdout, stderr) {
  return (
    stdout.includes('CONFLICT') ||
    stderr.includes('CONFLICT') ||
    stdout.includes('Automatic merge failed') ||
    stderr.includes('Automatic merge failed')
  );
}

// =============================================================================
// Git CLI Tools
// =============================================================================

// ── 1. Clone ─────────────────────────────────────────────────────────────────

/**
 * Clone a remote repository to a path on the local machine or on a remote VM.
 *
 * For private GitHub repos the GITHUB_TOKEN is automatically injected into the
 * HTTPS clone URL so the user does not need to handle credential setup.
 *
 * @param {string} repoUrl         Full HTTPS or SSH clone URL
 * @param {string} targetPath      Absolute path where the repo should land
 * @param {string} [executionTarget='local']  'local' or an ssh: sessionId
 */
async function cloneRepository(repoUrl, targetPath, executionTarget = 'local') {
  if (!repoUrl)    return { error: 'repoUrl is required (e.g. https://github.com/owner/repo.git).' };
  if (!targetPath) return { error: 'targetPath is required (absolute path on the target machine).' };

  // Inject GITHUB_TOKEN into HTTPS github.com URLs automatically
  let url = repoUrl;
  if (url.startsWith('https://github.com/') && !url.includes('@')) {
    try {
      const tok = resolveGitHubToken();
      url = url.replace('https://', `https://x-access-token:${tok}@`);
    } catch {
      // No token — proceed without injection (works for public repos)
    }
  }

  // For clone, the cwd only matters for the OS; git writes to targetPath itself
  const cwd = (!executionTarget || executionTarget === 'local') ? require('os').tmpdir() : '/tmp';
  const cmd = `git clone --no-pager ${JSON.stringify(url)} ${JSON.stringify(targetPath)}`;

  const result = await execGit(cmd, cwd, executionTarget, CLONE_TIMEOUT);
  return {
    repoUrl,
    targetPath,
    cloned:   result.exitCode === 0,
    stdout:   result.stdout,
    stderr:   result.stderr,
    error:    result.exitCode !== 0 ? result.stderr : undefined,
  };
}

// ── 2. Status ─────────────────────────────────────────────────────────────────

/**
 * Get the working-tree status as structured JSON.
 * Runs `git status --porcelain=v1 -b` and parses the output.
 *
 * @param {string} workspacePath   Absolute path to the repository root
 * @param {string} [executionTarget='local']
 */
async function getStatus(workspacePath, executionTarget = 'local') {
  if (!workspacePath) return { error: 'workspacePath is required.' };

  const result = await execGit('git --no-pager status --porcelain=v1 -b', workspacePath, executionTarget);
  if (result.exitCode !== 0) {
    return { workspacePath, error: result.stderr || 'git status failed.', exitCode: result.exitCode };
  }

  const lines = result.stdout.split('\n').filter(Boolean);

  // First line is the branch header (## main...origin/main)
  const branchLine = lines.find((l) => l.startsWith('##'));
  const branch     = branchLine ? branchLine.replace(/^## /, '').split('...')[0] : null;

  const files = lines
    .filter((l) => !l.startsWith('##'))
    .map((l) => {
      const xy       = l.slice(0, 2);
      const filePath = l.slice(3).trim();
      return {
        file:      filePath,
        staged:    xy[0] !== ' ' && xy[0] !== '?',
        unstaged:  xy[1] !== ' ',
        untracked: xy === '??',
        statusCode: xy.trim(),
      };
    });

  return {
    workspacePath,
    branch,
    clean: files.length === 0,
    files,
  };
}

// ── 3. Fetch & Pull ──────────────────────────────────────────────────────────

/**
 * Fetch all remotes, then pull the specified (or current) branch.
 * Returns a structured result including conflict detection.
 *
 * @param {string} workspacePath
 * @param {string} [branch]           Branch to pull (default: current branch)
 * @param {string} [executionTarget='local']
 */
async function fetchAndPull(workspacePath, branch, executionTarget = 'local') {
  if (!workspacePath) return { error: 'workspacePath is required.' };

  const fetchResult = await execGit('git --no-pager fetch --all', workspacePath, executionTarget);
  if (fetchResult.exitCode !== 0) {
    return {
      workspacePath,
      phase:    'fetch',
      error:    fetchResult.stderr || 'git fetch failed.',
      exitCode: fetchResult.exitCode,
    };
  }

  const pullCmd = branch
    ? `git --no-pager pull --no-rebase origin ${JSON.stringify(branch)}`
    : 'git --no-pager pull --no-rebase';

  const pullResult = await execGit(pullCmd, workspacePath, executionTarget);
  const hasConflict = pullResult.exitCode !== 0 && detectConflict(pullResult.stdout, pullResult.stderr);

  return {
    workspacePath,
    branch:      branch ?? '(current)',
    fetchOk:     true,
    pullOk:      pullResult.exitCode === 0,
    hasConflict,
    stdout:      pullResult.stdout,
    stderr:      pullResult.stderr,
    exitCode:    pullResult.exitCode,
    ...(hasConflict ? {
      hint: 'Merge conflicts detected. Call git:getStatus to list conflicted files, resolve them manually, then git:stageFiles and git:commit.',
    } : {}),
  };
}

// ── 4. Diff ───────────────────────────────────────────────────────────────────

/**
 * Show what has changed in the working tree or between refs.
 *
 * `target` examples:
 *   ''                  — unstaged changes (default)
 *   '--staged'          — staged-but-not-committed changes
 *   'main..feature'     — diff between two branches
 *   'HEAD~1'            — changes since the last commit
 *   '-- path/to/file'   — diff of a specific file only
 *
 * Output is capped at 200 KB. Pass a specific file path to reduce size.
 *
 * @param {string} workspacePath
 * @param {string} [target='']
 * @param {string} [executionTarget='local']
 */
async function getDiff(workspacePath, target = '', executionTarget = 'local') {
  if (!workspacePath) return { error: 'workspacePath is required.' };

  const result = await execGit(`git --no-pager diff ${target}`, workspacePath, executionTarget);
  return {
    workspacePath,
    target:    target || '(unstaged)',
    diff:      result.stdout.slice(0, MAX_OUTPUT),
    truncated: result.stdout.length > MAX_OUTPUT,
    error:     result.exitCode !== 0 ? result.stderr : undefined,
  };
}

// ── 5. Create Branch ─────────────────────────────────────────────────────────

/**
 * Create a new branch and check it out.
 * Equivalent to `git checkout -b <branchName>`.
 *
 * @param {string} workspacePath
 * @param {string} branchName
 * @param {string} [executionTarget='local']
 */
async function createBranch(workspacePath, branchName, executionTarget = 'local') {
  if (!workspacePath) return { error: 'workspacePath is required.' };
  if (!branchName)    return { error: 'branchName is required.' };

  const result = await execGit(
    `git --no-pager checkout -b ${JSON.stringify(branchName)}`,
    workspacePath,
    executionTarget,
  );

  return {
    workspacePath,
    branchName,
    created:  result.exitCode === 0,
    stdout:   result.stdout,
    error:    result.exitCode !== 0 ? result.stderr : undefined,
  };
}

// ── 6. Stage Files ───────────────────────────────────────────────────────────

/**
 * Stage files for commit.
 *
 * Pass an array of file paths for surgical staging, or `'.'` to stage
 * everything in the working tree. Explicit paths are strongly preferred
 * to avoid accidentally committing unrelated agent artifacts.
 *
 * @param {string}          workspacePath
 * @param {string|string[]} filePaths     Single path, array of paths, or '.'
 * @param {string}          [executionTarget='local']
 */
async function stageFiles(workspacePath, filePaths, executionTarget = 'local') {
  if (!workspacePath) return { error: 'workspacePath is required.' };
  if (!filePaths)     return { error: 'filePaths is required. Pass an array of paths or "." to stage all.' };

  const paths  = Array.isArray(filePaths) ? filePaths : [filePaths];
  const quoted = paths.map((p) => JSON.stringify(p)).join(' ');

  const result = await execGit(`git --no-pager add -- ${quoted}`, workspacePath, executionTarget);
  return {
    workspacePath,
    staged:   paths,
    ok:       result.exitCode === 0,
    stdout:   result.stdout,
    error:    result.exitCode !== 0 ? result.stderr : undefined,
  };
}

// ── 7. Commit ────────────────────────────────────────────────────────────────

/**
 * Commit staged changes with the given message.
 * Fails cleanly (returns an error object) if there is nothing staged.
 *
 * @param {string} workspacePath
 * @param {string} message         Commit message
 * @param {string} [executionTarget='local']
 */
async function commit(workspacePath, message, executionTarget = 'local') {
  if (!workspacePath) return { error: 'workspacePath is required.' };
  if (!message)       return { error: 'message is required.' };

  // Guard: abort early if nothing is staged (avoids a confusing git error)
  const check = await execGit('git --no-pager diff --cached --name-only', workspacePath, executionTarget);
  if (!check.stdout.trim()) {
    return {
      workspacePath,
      committed: false,
      error: 'Nothing is staged. Call git:stageFiles first, then retry git:commit.',
    };
  }

  const result = await execGit(
    `git --no-pager commit -m ${JSON.stringify(message)}`,
    workspacePath,
    executionTarget,
  );

  return {
    workspacePath,
    message,
    committed: result.exitCode === 0,
    stdout:    result.stdout,
    error:     result.exitCode !== 0 ? result.stderr : undefined,
  };
}

// ── 8. Merge Branch ──────────────────────────────────────────────────────────

/**
 * Merge a source branch into the currently checked-out branch.
 * Conflicts are detected and surfaced as structured data rather than
 * leaving the shell in a blocked state.
 *
 * @param {string} workspacePath
 * @param {string} sourceBranch    Branch to merge in
 * @param {string} [executionTarget='local']
 */
async function mergeBranch(workspacePath, sourceBranch, executionTarget = 'local') {
  if (!workspacePath) return { error: 'workspacePath is required.' };
  if (!sourceBranch)  return { error: 'sourceBranch is required.' };

  const result = await execGit(
    `git --no-pager merge --no-edit ${JSON.stringify(sourceBranch)}`,
    workspacePath,
    executionTarget,
  );

  const hasConflict = result.exitCode !== 0 && detectConflict(result.stdout, result.stderr);

  return {
    workspacePath,
    sourceBranch,
    merged:      result.exitCode === 0,
    hasConflict,
    stdout:      result.stdout,
    error:       result.exitCode !== 0 ? result.stderr : undefined,
    ...(hasConflict ? {
      hint: 'Resolve conflicts, then call git:stageFiles on the resolved files and git:commit.',
    } : {}),
  };
}

// ── 9. Push ───────────────────────────────────────────────────────────────────

/**
 * Push committed changes to the remote.
 * Uses `--set-upstream` so new branches are tracked automatically.
 *
 * @param {string} workspacePath
 * @param {string} branchName     Branch to push
 * @param {string} [executionTarget='local']
 */
async function push(workspacePath, branchName, executionTarget = 'local') {
  if (!workspacePath) return { error: 'workspacePath is required.' };
  if (!branchName)    return { error: 'branchName is required.' };

  const result = await execGit(
    `git --no-pager push --set-upstream origin ${JSON.stringify(branchName)}`,
    workspacePath,
    executionTarget,
    CLONE_TIMEOUT,
  );

  return {
    workspacePath,
    branchName,
    pushed:   result.exitCode === 0,
    stdout:   result.stdout,
    stderr:   result.stderr,
    error:    result.exitCode !== 0 ? result.stderr : undefined,
  };
}

// =============================================================================
// GitHub API Tools
// =============================================================================

// ── 10. Create Pull Request ───────────────────────────────────────────────────

/**
 * Open a pull request on GitHub.
 * Typically called after git:push succeeds.
 *
 * @param {string} repoFullName   'owner/repo'
 * @param {string} title
 * @param {string} body           PR description (markdown)
 * @param {string} headBranch     Source branch (the one you pushed)
 * @param {string} [baseBranch='main']  Target branch
 */
async function createPullRequest(repoFullName, title, body, headBranch, baseBranch = 'main') {
  if (!repoFullName) return { error: 'repoFullName is required (format: owner/repo).' };
  if (!title)        return { error: 'title is required.' };
  if (!headBranch)   return { error: 'headBranch is required.' };

  try {
    const res = await ghFetch(`/repos/${repoFullName}/pulls`, {
      method: 'POST',
      body:   JSON.stringify({ title, body: body ?? '', head: headBranch, base: baseBranch }),
    });

    if (!res.ok) {
      return { error: `GitHub API ${res.status}: ${JSON.stringify(res.body)}` };
    }

    const pr = res.body;
    return {
      number:     pr.number,
      url:        pr.html_url,
      title:      pr.title,
      state:      pr.state,
      headBranch,
      baseBranch: pr.base?.ref,
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ── 11. List Issues ───────────────────────────────────────────────────────────

/**
 * List open issues (and PRs) for a repository.
 * Returns a structured JSON list suitable for agent triage.
 *
 * @param {string}          repoFullName  'owner/repo'
 * @param {string|string[]} [labels]      Filter by label(s)
 * @param {string}          [assignee]    Filter by GitHub username
 * @param {number}          [perPage=30]  Max results (1-100)
 */
async function listIssues(repoFullName, labels, assignee, perPage = 30) {
  if (!repoFullName) return { error: 'repoFullName is required (format: owner/repo).' };

  const params = new URLSearchParams({ state: 'open', per_page: String(Math.min(perPage, 100)) });
  if (labels)   params.set('labels',   Array.isArray(labels) ? labels.join(',') : labels);
  if (assignee) params.set('assignee', assignee);

  try {
    const res = await ghFetch(`/repos/${repoFullName}/issues?${params}`);
    if (!res.ok) return { error: `GitHub API ${res.status}: ${JSON.stringify(res.body)}` };

    return {
      repoFullName,
      count:  res.body.length,
      issues: res.body.map((i) => ({
        number:    i.number,
        title:     i.title,
        state:     i.state,
        isPR:      !!i.pull_request,
        labels:    i.labels.map((l) => l.name),
        assignees: i.assignees.map((a) => a.login),
        url:       i.html_url,
        createdAt: i.created_at,
        updatedAt: i.updated_at,
      })),
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ── 12. Update Issue or PR ────────────────────────────────────────────────────

/**
 * Close/reopen an issue or PR, and/or post a comment on it.
 * Either `status` or `commentBody` (or both) must be supplied.
 *
 * @param {string} repoFullName  'owner/repo'
 * @param {number} number        Issue or PR number
 * @param {string} [status]      'open' or 'closed'
 * @param {string} [commentBody] Markdown body of the comment to post
 */
async function updateIssueOrPR(repoFullName, number, status, commentBody) {
  if (!repoFullName)            return { error: 'repoFullName is required.' };
  if (!number)                  return { error: 'number (issue/PR number) is required.' };
  if (!status && !commentBody)  return { error: 'Provide at least one of: status ("open"/"closed") or commentBody.' };

  const results = { repoFullName, number: Number(number) };

  try {
    if (status === 'closed' || status === 'open') {
      const res = await ghFetch(`/repos/${repoFullName}/issues/${number}`, {
        method: 'PATCH',
        body:   JSON.stringify({ state: status }),
      });
      results.statusUpdate = res.ok
        ? { newState: res.body.state }
        : { error: `${res.status}: ${JSON.stringify(res.body)}` };
    }

    if (commentBody) {
      const res = await ghFetch(`/repos/${repoFullName}/issues/${number}/comments`, {
        method: 'POST',
        body:   JSON.stringify({ body: commentBody }),
      });
      results.comment = res.ok
        ? { id: res.body.id, url: res.body.html_url }
        : { error: `${res.status}: ${JSON.stringify(res.body)}` };
    }
  } catch (err) {
    return { error: err.message };
  }

  return results;
}

// ── 13. Search Code ───────────────────────────────────────────────────────────

/**
 * Search code across a GitHub repository using the GitHub code search API.
 * Useful for finding function definitions, references, or config values
 * without needing to clone the repo locally.
 *
 * GitHub code search syntax:
 *   'functionName extension:ts'
 *   'TODO filename:server.js'
 *   'import axios'
 *
 * @param {string} repoFullName  'owner/repo'
 * @param {string} query         GitHub code search query string
 * @param {number} [perPage=20]  Max results (1-100)
 */
async function searchCode(repoFullName, query, perPage = 20) {
  if (!repoFullName) return { error: 'repoFullName is required (format: owner/repo).' };
  if (!query)        return { error: 'query is required.' };

  const q = `${query} repo:${repoFullName}`;
  try {
    const res = await ghFetch(`/search/code?q=${encodeURIComponent(q)}&per_page=${Math.min(perPage, 100)}`);
    if (!res.ok) return { error: `GitHub API ${res.status}: ${JSON.stringify(res.body)}` };

    return {
      repoFullName,
      query,
      totalCount: res.body.total_count,
      results:    res.body.items.map((i) => ({
        name:       i.name,
        path:       i.path,
        url:        i.html_url,
        repository: i.repository?.full_name,
      })),
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // git CLI
  cloneRepository,
  getStatus,
  fetchAndPull,
  getDiff,
  createBranch,
  stageFiles,
  commit,
  mergeBranch,
  push,
  // GitHub API
  createPullRequest,
  listIssues,
  updateIssueOrPR,
  searchCode,
};
