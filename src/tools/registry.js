/**
 * Tool Registry
 *
 * Simple Map-based tool registration system.
 * Register tools by name, then call them by name.
 *
 * Usage:
 *   toolRegistry.register('custom:myTool', handler, 'category', 'description');
 *   toolRegistry.call('custom:myTool', arg1, arg2);
 */

const mathTools   = require('./math');
const readTools   = require('./read');
const searchTools = require('./search');
const editTools   = require('./edit');
const executeTools = require('./execute');
const todoTools   = require('./todo');
const browserTools = require('./browser');
const agentTools  = require('./agent');
const sshTools    = require('./ssh');
const gitTools    = require('./git');
const javaTools   = require('./java');
const nodeTools   = require('./node');

class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  get size() {
    return this.tools.size;
  }

  register(name, handler, category, description) {
    this.tools.set(name, { handler, category, description });
    console.log(`[Tools] ✓ ${name} (${category})`);
  }

  async call(name, ...args) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool '${name}' not found. Available: ${[...this.tools.keys()].join(', ')}`);
    }
    try {
      return await Promise.resolve(tool.handler(...args));
    } catch (err) {
      console.error(`[Tools] Error calling '${name}':`, err);
      throw err;
    }
  }

  list() {
    return Array.from(this.tools.entries()).map(([name, tool]) => ({
      name,
      category: tool.category,
      description: tool.description,
    }));
  }

  listByCategory(category) {
    return this.list().filter((t) => t.category === category);
  }
}

const toolRegistry = new ToolRegistry();

function initializeDefaultTools() {
  if (toolRegistry.size > 0) return;

  console.log('\n[Tools] Initializing...');

  // ── read ──────────────────────────────────────────────────────────────────
  toolRegistry.register('custom:readFile',  readTools.readFile,  'read', 'Read file contents with optional offset/limit (max 2000 lines)');
  toolRegistry.register('custom:listDir',   readTools.listDir,   'read', 'List directory contents with type and size info');

  // ── search ────────────────────────────────────────────────────────────────
  toolRegistry.register('custom:findFiles',       searchTools.findFiles,       'search', 'Find files matching a glob pattern (e.g. **/*.ts, src/**)');
  toolRegistry.register('custom:findTextInFiles', searchTools.findTextInFiles, 'search', 'Search for text or regex pattern inside file contents');

  // ── edit ──────────────────────────────────────────────────────────────────
  toolRegistry.register('custom:createFile',              editTools.createFile,              'edit', 'Create a new file (fails if it already exists)');
  toolRegistry.register('custom:writeFile',               editTools.writeFile,               'edit', 'Write or overwrite a file with new content');
  toolRegistry.register('custom:replaceStringInFile',     editTools.replaceStringInFile,     'edit', 'Replace exactly one occurrence of a string in a file');
  toolRegistry.register('custom:multiReplaceStringInFile', editTools.multiReplaceStringInFile, 'edit', 'Apply multiple string replacements across one or more files');
  toolRegistry.register('custom:deleteFile',              editTools.deleteFile,              'edit', 'Delete a file permanently');

  // ── execute ───────────────────────────────────────────────────────────────
  toolRegistry.register('custom:runCommand', executeTools.runCommand, 'execute', 'Run a shell command and return stdout, stderr, and exit code');

  // ── todo ──────────────────────────────────────────────────────────────────
  toolRegistry.register('custom:manageTodoList', todoTools.manageTodoList, 'todo', 'Replace the entire todo list (at most 1 item in-progress at a time)');
  toolRegistry.register('custom:getTodoList',    todoTools.getTodoList,    'todo', 'Return the current todo list without modifying it');
  toolRegistry.register('custom:clearTodoList',  todoTools.clearTodoList,  'todo', 'Clear the entire todo list');

  // ── browser ───────────────────────────────────────────────────────────────
  toolRegistry.register('custom:fetchUrl', browserTools.fetchUrl, 'browser', 'Fetch a URL and return status, headers, and body (http/https)');

  // ── agent ─────────────────────────────────────────────────────────────────
  toolRegistry.register('custom:delegateTask',    agentTools.delegateTask,    'agent', 'Delegate a task to a named agent for tracking');
  toolRegistry.register('custom:updateAgentTask', agentTools.updateAgentTask, 'agent', 'Update the status and result of a delegated agent task');
  toolRegistry.register('custom:listAgentTasks',  agentTools.listAgentTasks,  'agent', 'List delegated agent tasks filtered by agent or status');
  toolRegistry.register('custom:clearAgentTasks', agentTools.clearAgentTasks, 'agent', 'Clear all agent tasks for this session');

  // ── math ──────────────────────────────────────────────────────────────────
  toolRegistry.register('custom:mathAdd',                 mathTools.mathAdd,                 'math', 'Add: a + b');
  toolRegistry.register('custom:mathSubtract',            mathTools.mathSubtract,            'math', 'Subtract: a - b');
  toolRegistry.register('custom:mathMultiply',            mathTools.mathMultiply,            'math', 'Multiply: a * b');
  toolRegistry.register('custom:mathDivide',              mathTools.mathDivide,              'math', 'Divide: a / b (safe, handles divide-by-zero)');
  toolRegistry.register('custom:mathSolveLinear',         mathTools.mathSolveLinear,         'math', 'Solve linear equation: ax + b = 0');
  toolRegistry.register('custom:mathSolveLineEquation',   mathTools.mathSolveLineEquation,   'math', 'Solve line equation: ax + b = c');
  toolRegistry.register('custom:mathSolveQuadratic',      mathTools.mathSolveQuadratic,      'math', 'Solve quadratic: ax² + bx + c = 0 (real & complex roots)');
  toolRegistry.register('custom:mathEvaluatePolynomial',  mathTools.mathEvaluatePolynomial,  'math', 'Evaluate a polynomial at x');
  toolRegistry.register('custom:mathFindPolynomialRoots', mathTools.mathFindPolynomialRoots, 'math', 'Find polynomial roots (Newton-Raphson method)');

  // ── ssh ─────────────────────────────────────────────────────────────────────────
  // All ssh: tools operate on remote hosts only — no clash with custom: local tools.
  // Sessions
  toolRegistry.register('ssh:connect',       sshTools.connect,       'ssh', 'Open a named SSH session reused by all other ssh: tools. Pass connection details as a config object: { host, username, password, port?, sudoPassword?, privateKey? } OR set SSH_HOST/SSH_USER/SSH_PASSWORD env vars. The sessionId is optional — defaults to "default". After connecting, all other ssh: tools can omit sessionId if only one VM is connected.');
  toolRegistry.register('ssh:disconnect',    sshTools.disconnect,    'ssh', 'Close and discard a named SSH session by sessionId or host IP.');
  toolRegistry.register('ssh:listSessions',  sshTools.listSessions,  'ssh', 'List all open SSH sessions (sessionId, host, username, state). Call this to discover which VMs are already connected before making other ssh: calls.');
  // Execution
  toolRegistry.register('ssh:runCommand',      sshTools.runCommand,      'ssh', 'Run a command on a remote VM and return stdout, stderr, exitCode. sessionId is optional — omit it if only one VM is connected, or pass the host IP/sessionId to target a specific VM.');
  toolRegistry.register('ssh:runSudoCommand',  sshTools.runSudoCommand,  'ssh', 'Run a command with sudo on a remote VM. sudo password is captured at ssh:connect time (defaults to the SSH password). sessionId optional when only one VM is connected.');
  toolRegistry.register('ssh:startBackground', sshTools.startBackground, 'ssh', 'Start a long-running background command on a remote VM. Returns a taskId immediately. sessionId optional when only one VM is connected.');
  toolRegistry.register('ssh:checkBackground', sshTools.checkBackground, 'ssh', 'Poll stdout, stderr, and running status of a background task by taskId.');
  toolRegistry.register('ssh:killProcess',     sshTools.killProcess,     'ssh', 'Kill a remote process by PID (default signal: SIGTERM). sessionId optional when only one VM is connected.');
  // Remote file operations (ssh: prefix = remote only, never clashes with local custom:readFile)
  toolRegistry.register('ssh:readRemoteFile',    sshTools.readRemoteFile,    'ssh', 'Read a remote file over SSH (capped at 2000 lines). Supports line offset and limit.');
  toolRegistry.register('ssh:writeRemoteFile',   sshTools.writeRemoteFile,   'ssh', 'Write or overwrite a remote file with the provided string content.');
  toolRegistry.register('ssh:appendRemoteFile',  sshTools.appendRemoteFile,  'ssh', 'Append text to a remote file.');
  toolRegistry.register('ssh:searchRemoteFile',  sshTools.searchRemoteFile,  'ssh', 'grep a remote file for a regex pattern. Returns matching lines with surrounding context.');
  toolRegistry.register('ssh:listRemoteDir',     sshTools.listRemoteDir,     'ssh', 'List a remote directory as structured JSON (name, type, size, permissions).');
  toolRegistry.register('ssh:uploadFile',        sshTools.uploadFile,        'ssh', 'Upload a local file to the remote host via SFTP.');
  toolRegistry.register('ssh:downloadFile',      sshTools.downloadFile,      'ssh', 'Download a remote file to a local path via SFTP.');
  // Diagnostics
  toolRegistry.register('ssh:systemInfo',     sshTools.systemInfo,     'ssh', 'Get structured JSON of remote OS, CPU, memory, disk space, and load average.');
  toolRegistry.register('ssh:networkStatus',  sshTools.networkStatus,  'ssh', 'Test remote outbound connectivity (ping) and optionally check a TCP port.');

  // ── git / github ──────────────────────────────────────────────────────────────
  // git:*    — Git CLI ops. All accept executionTarget: 'local' (default) or an
  //            ssh: sessionId to run on a remote VM.
  // github:* — GitHub REST API ops. No filesystem access. Reads GITHUB_TOKEN from env.

  // Repository & Workspace
  toolRegistry.register('git:cloneRepository', gitTools.cloneRepository, 'git', 'Clone a repository to a local or remote path. GITHUB_TOKEN is auto-injected for private repos. Args: repoUrl, targetPath, executionTarget ("local" or ssh sessionId).');
  toolRegistry.register('git:getStatus',       gitTools.getStatus,       'git', 'Run git status --porcelain and return a structured JSON list of staged, unstaged, and untracked files. Args: workspacePath, executionTarget.');
  toolRegistry.register('git:fetchAndPull',    gitTools.fetchAndPull,    'git', 'Fetch all remotes then pull the current (or specified) branch. Detects and surfaces merge conflicts as structured data. Args: workspacePath, branch (optional), executionTarget.');
  toolRegistry.register('git:getDiff',         gitTools.getDiff,         'git', 'Show what changed. target examples: "" = unstaged, "--staged" = staged, "main..feature" = between branches, "HEAD~1" = since last commit, "-- file.js" = specific file. Args: workspacePath, target, executionTarget.');

  // Branching, Staging, Commits
  toolRegistry.register('git:createBranch', gitTools.createBranch, 'git', 'Create and check out a new branch (git checkout -b). Args: workspacePath, branchName, executionTarget.');
  toolRegistry.register('git:stageFiles',   gitTools.stageFiles,   'git', 'Stage files for commit (git add). Pass an array of file paths for surgical staging, or "." to stage everything. Args: workspacePath, filePaths (string or array), executionTarget.');
  toolRegistry.register('git:commit',       gitTools.commit,       'git', 'Commit staged changes. Returns a clear error if nothing is staged — call git:stageFiles first. Args: workspacePath, message, executionTarget.');
  toolRegistry.register('git:mergeBranch',  gitTools.mergeBranch,  'git', 'Merge a source branch into the current branch. Conflicts are detected and returned as structured data rather than blocking. Args: workspacePath, sourceBranch, executionTarget.');
  toolRegistry.register('git:push',         gitTools.push,         'git', 'Push committed changes to the remote. Uses --set-upstream automatically for new branches. Args: workspacePath, branchName, executionTarget.');

  // GitHub REST API (requires GITHUB_TOKEN env var)
  toolRegistry.register('github:createPullRequest', gitTools.createPullRequest, 'github', 'Open a pull request on GitHub. Call after git:push. Args: repoFullName (owner/repo), title, body, headBranch, baseBranch (default "main").');
  toolRegistry.register('github:listIssues',        gitTools.listIssues,        'github', 'List open issues for a repo as structured JSON. Args: repoFullName, labels (optional array), assignee (optional), perPage (default 30).');
  toolRegistry.register('github:updateIssueOrPR',   gitTools.updateIssueOrPR,   'github', 'Close/reopen an issue or PR and/or post a comment. Args: repoFullName, number, status ("open"/"closed", optional), commentBody (optional).');
  toolRegistry.register('github:searchCode',        gitTools.searchCode,        'github', 'Search code across a GitHub repo without cloning. Supports GitHub search syntax (e.g. "functionName extension:ts"). Args: repoFullName, query, perPage (default 20).');

  // ── java ─────────────────────────────────────────────────────────────────────
  // All java: tools accept executionTarget: 'local' (default) or an ssh: sessionId.
  // Use these tools after git:cloneRepository has cloned a Java/Maven/Gradle project.

  // Static analysis
  toolRegistry.register('java:inspectProject',      javaTools.inspectProject,      'java', 'Detect build system (Maven/Gradle), Java version, main class, and whether a Dockerfile exists. Run this first on any newly cloned Java repo. Args: workspacePath, executionTarget.');
  toolRegistry.register('java:getPackageHierarchy', javaTools.getPackageHierarchy, 'java', 'List all .java source files under src/main/java sorted by path. Use this to map the project structure before reading or editing code. Args: workspacePath, executionTarget.');
  toolRegistry.register('java:findComponent',       javaTools.findComponent,       'java', 'Find Java source files carrying a specific annotation (e.g. @RestController, @Service, @Entity). Args: workspacePath, annotationName, executionTarget.');
  toolRegistry.register('java:analyzeDependencies', javaTools.analyzeDependencies, 'java', 'Parse pom.xml or build.gradle and return a structured list of declared dependencies with groupId, artifactId, version, and scope. Args: workspacePath, executionTarget.');

  // Dockerized build & run
  toolRegistry.register('java:generateDockerfile',    javaTools.generateDockerfile,    'java', 'Write a production-ready multi-stage Dockerfile to the workspace. Stage 1 builds the jar (Maven or Gradle with dependency caching). Stage 2 runs on a slim JRE. Call before java:dockerBuild if no Dockerfile exists. Args: workspacePath, buildSystem ("maven"/"gradle"/"auto"), javaVersion (e.g. "17"), executionTarget.');
  toolRegistry.register('java:dockerBuild',           javaTools.dockerBuild,           'java', 'Build a Docker image from the workspace Dockerfile. Captures stderr so the LLM can self-correct on compilation errors. Args: workspacePath, imageName (e.g. "my-app:latest"), executionTarget.');
  toolRegistry.register('java:runContainerizedApp',   javaTools.runContainerizedApp,   'java', 'Start the compiled application in a Docker container with port mapping, environment variable injection, a 2 GB memory limit, and an automatic health check. Args: workspacePath, imageName, hostPort (default 8080), envVars (object), healthPath (default "/actuator/health"), executionTarget.');

  // Verification
  toolRegistry.register('java:runTests',     javaTools.runTests,     'java', 'Run the Maven or Gradle test suite inside a Docker container (no local JDK required). Returns pass/fail counts parsed from Surefire or Gradle output. Args: workspacePath, buildSystem ("maven"/"gradle"/"auto"), executionTarget.');
  toolRegistry.register('java:curlEndpoint', javaTools.curlEndpoint, 'java', 'Send an HTTP request to a deployed endpoint and return status code, response body, and latency. Use this to verify that a fix or feature works after deploying. Args: url, method (GET/POST/PUT/DELETE), body (optional), headers (optional object), executionTarget.');

  // ── node ────────────────────────────────────────────────────────────────────
  // All node: tools accept executionTarget: 'local' (default) or an ssh: sessionId.
  // Use these tools after git:cloneRepository has cloned a Node.js project.
  // Frameworks auto-detected: Next.js, Nuxt, Remix, SvelteKit, NestJS, Fastify,
  // Express, Koa, Hapi, Hono, React (CRA+Vite), Vue, Angular, Svelte, Vite.

  // Static analysis
  toolRegistry.register('node:inspectProject',    nodeTools.inspectProject,    'node', 'Detect Node.js framework (Express, NestJS, React, Next.js, Vue, Angular, etc.), project type (frontend/backend/fullstack), package manager (npm/yarn/pnpm/bun), Node version, and whether a Dockerfile exists. Call this first after cloning any Node.js repo. Args: workspacePath, executionTarget.');
  toolRegistry.register('node:listDependencies',  nodeTools.listDependencies,  'node', 'Parse package.json and return all dependencies, devDependencies, and peerDependencies as structured JSON. Useful for checking if a library is already installed before adding it. Args: workspacePath, executionTarget.');
  toolRegistry.register('node:findComponent',     nodeTools.findComponent,     'node', 'Find source files by role shorthand or grep pattern. Role shortcuts: routes, controllers, services, components, models, middleware. Or pass a plain grep pattern string. Args: workspacePath, pattern, role, executionTarget.');
  toolRegistry.register('node:analyzeScripts',    nodeTools.analyzeScripts,    'node', 'List all npm scripts from package.json with their commands. Reveals how to build, test, start, dev-serve, and lint the project. Args: workspacePath, executionTarget.');

  // Dockerized build & run
  toolRegistry.register('node:generateDockerfile',   nodeTools.generateDockerfile,   'node', 'Generate a production-ready, framework-aware Dockerfile. Frontend SPAs (React/Vue/Angular/Svelte) get a multi-stage build with nginx:alpine runtime and an nginx.conf for SPA client-side routing. Backends and SSR apps (Express/NestJS/Next.js/Nuxt) get node:alpine with dumb-init and a non-root user. Also auto-detects Node version, package manager, and dist directory. Args: workspacePath, executionTarget.');
  toolRegistry.register('node:dockerBuild',          nodeTools.dockerBuild,          'node', 'Build a Docker image from the workspace Dockerfile. Captures stderr so the LLM can self-correct on build or TypeScript compilation failures. Args: workspacePath, imageName (e.g. "my-app:latest"), executionTarget.');
  toolRegistry.register('node:runContainerizedApp',  nodeTools.runContainerizedApp,  'node', 'Start the Node.js application in a Docker container. Auto-detects the correct internal port (80 for nginx/frontend, app port for backend). Supports port mapping, env variable injection, 1 GB memory limit, and health check polling. Args: workspacePath, imageName, hostPort (default auto), envVars (object), healthPath (optional), executionTarget.');

  // Verification
  toolRegistry.register('node:runTests',     nodeTools.runTests,     'node', 'Run the project test suite (Jest, Vitest, or Mocha) inside a Docker container. Auto-detects the test runner and passes appropriate no-watch/CI flags. Returns parsed pass/fail/total counts. Args: workspacePath, executionTarget.');
  toolRegistry.register('node:curlEndpoint', nodeTools.curlEndpoint, 'node', 'Send an HTTP request to a deployed endpoint and return status code, response body, and latency in milliseconds. Use this to verify a fix or new feature works after deployment. Args: url, method (GET/POST/PUT/DELETE/PATCH), body (optional), headers (optional object), executionTarget.');

  console.log(`[Tools] Ready: ${toolRegistry.list().length} tools loaded\n`);
}

module.exports = { toolRegistry, initializeDefaultTools };
