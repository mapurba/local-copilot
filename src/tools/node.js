/**
 * Node.js Tools
 *
 * Language-aware toolset for Node.js applications — both frontend and backend.
 *
 * Frameworks detected automatically:
 *   Full-stack : Next.js, Nuxt, Remix, SvelteKit
 *   Backend    : NestJS, Fastify, Express, Koa, Hapi, Hono
 *   Frontend   : React (CRA + Vite), Vue, Angular, Svelte, Vite
 *
 * All tools are environment-agnostic:
 *   executionTarget = 'local'     → run on this machine (default)
 *   executionTarget = <sessionId> → run on a remote VM via an open ssh: session
 *
 * ── Static Analysis ──────────────────────────────────────────────────────────
 *
 *   node:inspectProject    Detect framework, type, package manager, Node version
 *   node:listDependencies  Return deps + devDeps from package.json as structured JSON
 *   node:findComponent     Find files by role shorthand or grep pattern
 *   node:analyzeScripts    List all npm scripts with their commands
 *
 * ── Dockerized Build & Run ───────────────────────────────────────────────────
 *
 *   node:generateDockerfile  Framework-aware multi-stage Dockerfile
 *                            • Frontend SPAs  → nginx:alpine + nginx.conf for SPA routing
 *                            • Backend/SSR    → node:alpine with dumb-init + non-root user
 *   node:dockerBuild         docker build — captures stderr for self-correction
 *   node:runContainerizedApp docker run with port mapping, env vars, health check
 *
 * ── Verification & Testing ───────────────────────────────────────────────────
 *
 *   node:runTests       Run Jest / Vitest / Mocha tests inside a Docker container
 *   node:curlEndpoint   Hit a deployed endpoint to verify a fix or feature
 */

'use strict';

const { exec }      = require('child_process');
const { promisify } = require('util');
const fs            = require('fs');
const path          = require('path');

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT = 5  * 60_000;  // 5 min
const BUILD_TIMEOUT   = 10 * 60_000;  // 10 min — npm install + build can be slow
const MAX_OUTPUT      = 200_000;       // 200 KB cap per stream

// ── Execution abstraction ─────────────────────────────────────────────────────
//
//   execNode(command, workspacePath, executionTarget, timeoutMs)
//
//   Dispatches a shell command to either:
//     • The local machine  (child_process.exec, cwd = workspacePath)
//     • A remote VM        (ssh:runCommand with "cd <path> && <command>" prefix)

async function execNode(command, workspacePath, executionTarget = 'local', timeoutMs = DEFAULT_TIMEOUT) {
  if (!executionTarget || executionTarget === 'local') {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd:       workspacePath || process.cwd(),
        timeout:   timeoutMs,
        maxBuffer: MAX_OUTPUT,
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
    // Normalize the response: ssh.js may return { error, exitCode } with no stdout
    // when the session doesn't exist or the command fails to start.
    const { runCommand } = require('./ssh');
    const cdPrefix = workspacePath
      ? `cd ${JSON.stringify(workspacePath)} && `
      : '';
    const res = await runCommand(`${cdPrefix}${command}`, executionTarget, timeoutMs);
    return {
      stdout:   res.stdout   != null ? String(res.stdout)  : '',
      stderr:   res.stderr   != null ? String(res.stderr)  : (res.error ?? ''),
      exitCode: res.exitCode != null ? res.exitCode        : 1,
      ...(res.error ? { error: res.error } : {}),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeSlice(str, max = MAX_OUTPUT) {
  return typeof str === 'string' ? str.slice(0, max) : String(str ?? '').slice(0, max);
}

function sanitizeImageName(name) {
  return (name ?? 'node-app').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Detect Node.js version from .nvmrc content, .node-version, or
 * package.json engines.node. Falls back to '20'.
 */
function detectNodeVersion(packageJsonText, versionFileText = '') {
  // .nvmrc / .node-version: "20", "v20.11.0", "lts/iron", etc.
  const nvmMatch = (versionFileText || '').match(/v?(\d+)/);
  if (nvmMatch) return nvmMatch[1];

  // package.json engines.node: ">= 18", "^20", "20.x"
  try {
    const pkg = JSON.parse(packageJsonText);
    const eng = pkg?.engines?.node;
    if (eng) {
      const m = eng.match(/(\d+)/);
      if (m) return m[1];
    }
  } catch {}

  return '20';
}

/**
 * Return the production install command for a given package manager.
 * Used in Stage 2 of multi-stage Dockerfiles (devDeps excluded).
 */
function prodInstallCmd(packageManager, baseInstallCmd) {
  switch (packageManager) {
    case 'yarn': return baseInstallCmd.replace('--frozen-lockfile', '--production');
    case 'pnpm': return baseInstallCmd + ' --prod';
    case 'bun':  return baseInstallCmd + ' --production';
    default:     return 'npm ci --omit=dev';
  }
}

/**
 * Analyse package.json to determine the Node.js framework and project type.
 *
 * Detection order: full-stack (most specific) → backend → frontend → plain.
 *
 * Returns:
 *   framework      — framework name string
 *   type           — 'frontend' | 'backend' | 'fullstack'
 *   port           — default app port
 *   healthPath     — best-guess health endpoint
 *   distDir        — build output directory (null for plain JS backends)
 *   runtimeType    — 'node' | 'nginx'
 *   startCommand   — command to run the app in the runtime container
 *   needsBuild     — true if a build step is required
 *   hasTypescript  — true if TypeScript is used
 *   packageManager — 'npm' | 'yarn' | 'pnpm' | 'bun'
 *   installCmd     — full install command for the detected package manager
 *   lockFileCopy   — COPY line for the Dockerfile (includes the lock file)
 *   copyArtefacts  — array of COPY --from=builder lines for Stage 2
 *   extraPackages  — Alpine apk packages to install in the runtime image
 */
function detectNodeFramework(packageJsonText, lockFilesList = '') {
  let pkg = {};
  try { pkg = JSON.parse(packageJsonText); } catch {}

  const deps    = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const scripts = pkg.scripts ?? {};

  // ── Package manager ────────────────────────────────────────────────────────
  let packageManager = 'npm';
  let lockFileCopy   = 'COPY package*.json ./';
  let installCmdStr  = 'npm ci';

  if (lockFilesList.includes('yarn.lock')) {
    packageManager = 'yarn';
    lockFileCopy   = 'COPY package.json yarn.lock ./';
    installCmdStr  = 'yarn install --frozen-lockfile';
  } else if (lockFilesList.includes('pnpm-lock.yaml')) {
    packageManager = 'pnpm';
    lockFileCopy   = 'COPY package.json pnpm-lock.yaml ./';
    installCmdStr  = 'pnpm install --frozen-lockfile';
  } else if (lockFilesList.includes('bun.lockb')) {
    packageManager = 'bun';
    lockFileCopy   = 'COPY package.json bun.lockb ./';
    installCmdStr  = 'bun install';
  }

  const hasTypescript = !!(deps['typescript'] || deps['ts-node'] || deps['@types/node']);
  const startScript   = scripts['start'] ?? null;

  // Convenience builder for return objects
  const make = (overrides) => ({
    packageManager, lockFileCopy, installCmd: installCmdStr,
    hasTypescript, copyArtefacts: [],
    extraPackages: ['curl', 'tzdata', 'dumb-init'],
    ...overrides,
  });

  // ── Full-stack (check before their underlying frontend libs) ──────────────

  if (deps['next']) {
    return make({
      framework: 'nextjs', type: 'fullstack', port: 3000, healthPath: '/',
      distDir: '.next', runtimeType: 'node',
      startCommand: 'npm start', needsBuild: true,
      copyArtefacts: [
        'COPY --from=builder /app/.next ./.next',
        'COPY --from=builder /app/public ./public',
      ],
    });
  }

  if (deps['nuxt'] || deps['nuxt3'] || deps['@nuxt/core']) {
    return make({
      framework: 'nuxt', type: 'fullstack', port: 3000, healthPath: '/',
      distDir: '.output', runtimeType: 'node',
      startCommand: 'node .output/server/index.mjs', needsBuild: true,
      copyArtefacts: ['COPY --from=builder /app/.output ./.output'],
    });
  }

  if (deps['@remix-run/node'] || deps['@remix-run/react'] || deps['@remix-run/serve']) {
    return make({
      framework: 'remix', type: 'fullstack', port: 3000, healthPath: '/',
      distDir: 'build', runtimeType: 'node',
      startCommand: 'npm start', needsBuild: true,
      copyArtefacts: [
        'COPY --from=builder /app/build ./build',
        'COPY --from=builder /app/public ./public',
      ],
    });
  }

  if (deps['@sveltejs/kit']) {
    return make({
      framework: 'sveltekit', type: 'fullstack', port: 3000, healthPath: '/',
      distDir: 'build', runtimeType: 'node',
      startCommand: 'node build/index.js', needsBuild: true,
      copyArtefacts: ['COPY --from=builder /app/build ./build'],
    });
  }

  // ── Backend ────────────────────────────────────────────────────────────────

  if (deps['@nestjs/core'] || deps['@nestjs/common']) {
    return make({
      framework: 'nestjs', type: 'backend', port: 3000, healthPath: '/health',
      distDir: 'dist', runtimeType: 'node',
      startCommand: 'node dist/main', needsBuild: true, hasTypescript: true,
      copyArtefacts: ['COPY --from=builder /app/dist ./dist'],
    });
  }

  if (deps['fastify']) {
    return make({
      framework: 'fastify', type: 'backend', port: 3000, healthPath: '/health',
      distDir:      hasTypescript ? 'dist' : null,
      runtimeType:  'node',
      startCommand: startScript ?? 'node src/index.js',
      needsBuild:   hasTypescript,
      copyArtefacts: hasTypescript ? ['COPY --from=builder /app/dist ./dist'] : [],
    });
  }

  if (deps['koa']) {
    return make({
      framework: 'koa', type: 'backend', port: 3000, healthPath: '/health',
      distDir:      hasTypescript ? 'dist' : null,
      runtimeType:  'node',
      startCommand: startScript ?? 'node src/index.js',
      needsBuild:   hasTypescript,
      copyArtefacts: hasTypescript ? ['COPY --from=builder /app/dist ./dist'] : [],
    });
  }

  if (deps['@hapi/hapi']) {
    return make({
      framework: 'hapi', type: 'backend', port: 3000, healthPath: '/health',
      distDir: null, runtimeType: 'node',
      startCommand: startScript ?? 'node src/index.js',
      needsBuild: false,
    });
  }

  if (deps['hono']) {
    return make({
      framework: 'hono', type: 'backend', port: 3000, healthPath: '/health',
      distDir:      hasTypescript ? 'dist' : null,
      runtimeType:  'node',
      startCommand: startScript ?? 'node src/index.js',
      needsBuild:   hasTypescript,
      copyArtefacts: hasTypescript ? ['COPY --from=builder /app/dist ./dist'] : [],
    });
  }

  if (deps['express']) {
    return make({
      framework: 'express', type: 'backend', port: 3000, healthPath: '/health',
      distDir:      hasTypescript ? 'dist' : null,
      runtimeType:  'node',
      startCommand: startScript ?? 'node src/index.js',
      needsBuild:   hasTypescript,
      copyArtefacts: hasTypescript ? ['COPY --from=builder /app/dist ./dist'] : [],
    });
  }

  // ── Frontend ───────────────────────────────────────────────────────────────

  if (deps['@angular/core'] || deps['@angular/cli']) {
    const projectName = sanitizeImageName(pkg.name ?? 'app');
    return make({
      framework: 'angular', type: 'frontend', port: 80, healthPath: '/',
      // Angular 17+ outputs to dist/<name>/browser; older to dist/<name>
      distDir: `dist/${projectName}/browser`,
      runtimeType: 'nginx', startCommand: null, needsBuild: true,
      hasTypescript: true, extraPackages: ['curl'],
    });
  }

  if (deps['vue'] || deps['@vue/core']) {
    return make({
      framework: 'vue', type: 'frontend', port: 80, healthPath: '/',
      distDir: 'dist', runtimeType: 'nginx', startCommand: null, needsBuild: true,
      extraPackages: ['curl'],
    });
  }

  if (deps['react'] || deps['react-dom']) {
    // Create React App (react-scripts) outputs to build/, Vite outputs to dist/
    const isCRA  = !!deps['react-scripts'];
    return make({
      framework: 'react', type: 'frontend', port: 80, healthPath: '/',
      distDir: isCRA ? 'build' : 'dist',
      runtimeType: 'nginx', startCommand: null, needsBuild: true,
      extraPackages: ['curl'],
    });
  }

  if (deps['svelte']) {
    return make({
      framework: 'svelte', type: 'frontend', port: 80, healthPath: '/',
      distDir: 'dist', runtimeType: 'nginx', startCommand: null, needsBuild: true,
      extraPackages: ['curl'],
    });
  }

  if (deps['vite']) {
    return make({
      framework: 'vite', type: 'frontend', port: 80, healthPath: '/',
      distDir: 'dist', runtimeType: 'nginx', startCommand: null, needsBuild: true,
      extraPackages: ['curl'],
    });
  }

  // ── Plain Node.js ──────────────────────────────────────────────────────────
  return make({
    framework: 'plain-node', type: 'backend', port: 3000, healthPath: '/',
    distDir: null, runtimeType: 'node',
    startCommand: startScript ?? 'node index.js',
    needsBuild: false,
  });
}

// ── Dockerfile template builders ──────────────────────────────────────────────

/**
 * nginx SPA config: serves index.html for all routes (client-side routing),
 * caches hashed static assets forever, exposes a /health endpoint.
 */
const NGINX_SPA_CONFIG = `server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # Health check — used by node:runContainerizedApp
    location /health {
        return 200 'ok';
        add_header Content-Type text/plain;
    }

    # SPA routing: unknown paths serve index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Aggressively cache content-hashed static assets
    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|map)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
`;

function buildFrontendDockerfile(fw, nodeVersion) {
  const apkPkgs = fw.extraPackages.join(' ');
  return [
    `# Generated by node:generateDockerfile`,
    `# Framework : ${fw.framework}`,
    `# Type      : frontend (SPA → nginx)`,
    `# Node      : ${nodeVersion}`,
    ``,
    `# ── Stage 1: Build ────────────────────────────────────────────────────────────`,
    `FROM node:${nodeVersion}-alpine AS builder`,
    `WORKDIR /app`,
    ``,
    `# Layer-cache: reinstall only when lock file changes`,
    fw.lockFileCopy,
    `RUN ${fw.installCmd}`,
    ``,
    `COPY . .`,
    `RUN npm run build`,
    ``,
    `# ── Stage 2: Runtime (nginx:alpine) ───────────────────────────────────────────`,
    `FROM nginx:alpine`,
    `RUN apk add --no-cache ${apkPkgs}`,
    ``,
    `# Copy compiled assets to nginx web root`,
    `# NOTE: if your framework outputs to a different directory, adjust this path`,
    `COPY --from=builder /app/${fw.distDir} /usr/share/nginx/html`,
    ``,
    `# SPA routing config (serves index.html for all client-side routes)`,
    `COPY nginx.conf /etc/nginx/conf.d/default.conf`,
    ``,
    `EXPOSE 80`,
    `CMD ["nginx", "-g", "daemon off;"]`,
    ``,
  ].join('\n');
}

function buildNodeMultiStageDockerfile(fw, nodeVersion) {
  const apkPkgs     = fw.extraPackages.join(' ');
  const prodInstall = prodInstallCmd(fw.packageManager, fw.installCmd);
  const copyLines   = fw.copyArtefacts.length > 0
    ? fw.copyArtefacts.join('\n')
    : `COPY --from=builder /app/${fw.distDir ?? 'dist'} ./${fw.distDir ?? 'dist'}`;

  return [
    `# Generated by node:generateDockerfile`,
    `# Framework : ${fw.framework}`,
    `# Type      : ${fw.type}`,
    `# Node      : ${nodeVersion}`,
    ``,
    `# ── Stage 1: Build ────────────────────────────────────────────────────────────`,
    `FROM node:${nodeVersion}-alpine AS builder`,
    `WORKDIR /app`,
    ``,
    `# Layer-cache: reinstall only when lock file changes`,
    fw.lockFileCopy,
    `RUN ${fw.installCmd}`,
    ``,
    `COPY . .`,
    `RUN npm run build`,
    ``,
    `# ── Stage 2: Runtime (node:${nodeVersion}-alpine) ──────────────────────────────`,
    `FROM node:${nodeVersion}-alpine`,
    `WORKDIR /app`,
    ``,
    `# Install OS prerequisites: ${apkPkgs}`,
    `RUN apk add --no-cache ${apkPkgs}`,
    ``,
    `# Install production dependencies only`,
    fw.lockFileCopy,
    `RUN ${prodInstall}`,
    ``,
    `# Copy compiled artefacts from builder`,
    copyLines,
    ``,
    `# Run as non-root for security`,
    `RUN addgroup -S appgroup && adduser -S appuser -G appgroup`,
    `RUN chown -R appuser:appgroup /app`,
    `USER appuser`,
    ``,
    `EXPOSE ${fw.port}`,
    `ENTRYPOINT ["dumb-init", "--"]`,
    `CMD ["sh", "-c", "${fw.startCommand ?? 'node index.js'}"]`,
    ``,
  ].join('\n');
}

function buildNodeSimpleDockerfile(fw, nodeVersion) {
  const apkPkgs     = fw.extraPackages.join(' ');
  const prodInstall = prodInstallCmd(fw.packageManager, fw.installCmd);

  return [
    `# Generated by node:generateDockerfile`,
    `# Framework : ${fw.framework}`,
    `# Type      : ${fw.type} (no build step)`,
    `# Node      : ${nodeVersion}`,
    ``,
    `# ── Single stage ──────────────────────────────────────────────────────────────`,
    `# NOTE: create a .dockerignore to exclude node_modules, .git, .env, dist, etc.`,
    `FROM node:${nodeVersion}-alpine`,
    `WORKDIR /app`,
    ``,
    `# Install OS prerequisites: ${apkPkgs}`,
    `RUN apk add --no-cache ${apkPkgs}`,
    ``,
    `# Install production dependencies only`,
    fw.lockFileCopy,
    `RUN ${prodInstall}`,
    ``,
    `# Copy application source`,
    `COPY . .`,
    ``,
    `# Run as non-root for security`,
    `RUN addgroup -S appgroup && adduser -S appuser -G appgroup`,
    `RUN chown -R appuser:appgroup /app`,
    `USER appuser`,
    ``,
    `EXPOSE ${fw.port}`,
    `ENTRYPOINT ["dumb-init", "--"]`,
    `CMD ["sh", "-c", "${fw.startCommand ?? 'node index.js'}"]`,
    ``,
  ].join('\n');
}

// ── Static Analysis ───────────────────────────────────────────────────────────

/**
 * Detect the Node.js framework, project type (frontend/backend/fullstack),
 * package manager, Node version, npm scripts, port, and whether a Dockerfile
 * already exists.
 *
 * Call this first after cloning any Node.js repository.
 *
 * @param {string} workspacePath
 * @param {string} executionTarget  'local' or an ssh: sessionId
 */
async function inspectProject(workspacePath, executionTarget = 'local') {
  const pkgResult = await execNode(
    'cat package.json 2>/dev/null || echo "{}"',
    workspacePath, executionTarget,
  );
  const lockResult = await execNode(
    'ls package-lock.json yarn.lock pnpm-lock.yaml bun.lockb .nvmrc .node-version Dockerfile 2>/dev/null || true',
    workspacePath, executionTarget,
  );
  const versionResult = await execNode(
    'cat .nvmrc 2>/dev/null || cat .node-version 2>/dev/null || true',
    workspacePath, executionTarget,
  );

  const packageJsonText = pkgResult.stdout || '{}';
  const lockFilesList   = lockResult.stdout;
  const hasDockerfile   = lockFilesList.includes('Dockerfile');

  const nodeVersion = detectNodeVersion(packageJsonText, versionResult.stdout);
  const fw          = detectNodeFramework(packageJsonText, lockFilesList);

  let pkg = {};
  try { pkg = JSON.parse(packageJsonText); } catch {}

  const isRemote = executionTarget && executionTarget !== 'local';

  return {
    projectName:    pkg.name      ?? null,
    projectVersion: pkg.version   ?? null,
    nodeVersion,
    framework:      fw.framework,
    type:           fw.type,
    packageManager: fw.packageManager,
    installCmd:     fw.installCmd,
    port:           fw.port,
    healthPath:     fw.healthPath,
    runtimeType:    fw.runtimeType,
    needsBuild:     fw.needsBuild,
    hasTypescript:  fw.hasTypescript,
    hasDockerfile,
    scripts:        pkg.scripts   ?? {},
    workspacePath,
    executionTarget,
    // Guidance for the LLM when operating on a remote host
    _remoteHint: isRemote
      ? `IMPORTANT: executionTarget is "${executionTarget}" (remote SSH session). `
        + `Pass executionTarget: "${executionTarget}" to ALL subsequent node: tool calls. `
        + `Do NOT use custom:listDir, custom:readFile, or custom:runCommand for paths on this host — `
        + `those run locally. Use ssh:listRemoteDir, ssh:readRemoteFile, and node: tools with executionTarget.`
      : undefined,
  };
}

/**
 * Parse package.json and return all dependencies, devDependencies, and
 * peerDependencies as structured JSON.
 *
 * Useful for checking whether a library is already installed before adding it.
 *
 * @param {string} workspacePath
 * @param {string} executionTarget
 */
async function listDependencies(workspacePath, executionTarget = 'local') {
  const result = await execNode(
    'cat package.json 2>/dev/null || echo "{}"',
    workspacePath, executionTarget,
  );

  let pkg = {};
  try { pkg = JSON.parse(result.stdout); } catch {}

  return {
    name:             pkg.name             ?? null,
    version:          pkg.version          ?? null,
    dependencies:     pkg.dependencies     ?? {},
    devDependencies:  pkg.devDependencies  ?? {},
    peerDependencies: pkg.peerDependencies ?? {},
    engines:          pkg.engines          ?? {},
    totalDeps:        Object.keys(pkg.dependencies     ?? {}).length,
    totalDevDeps:     Object.keys(pkg.devDependencies  ?? {}).length,
    workspacePath,
    executionTarget,
  };
}

/**
 * Search for source files by role shorthand or raw grep pattern.
 *
 * role shortcuts:
 *   'routes'      → files with router.get / @Get / createRouter
 *   'controllers' → files with @Controller / Controller class
 *   'services'    → files with @Injectable / @Service / class *Service
 *   'components'  → files with React.FC / export default function / <template> / @Component
 *   'models'      → files with @Entity / mongoose.model / Schema(
 *   'middleware'  → files with app.use / middleware / next(
 *
 * Or pass a plain string for pattern to grep directly.
 *
 * @param {string} workspacePath
 * @param {string} pattern   Grep pattern string (takes precedence over role)
 * @param {string} role      Shorthand role name
 * @param {string} executionTarget
 */
async function findComponent(workspacePath, pattern, role = null, executionTarget = 'local') {
  const rolePatterns = {
    routes:      '(router\\.|app\\.get|app\\.post|createRouter|@Get|@Post|@Put|@Delete)',
    controllers: '(@Controller|Controller\\b)',
    services:    '(@Injectable|@Service|class\\s+\\w+Service)',
    components:  '(React\\.FC|export default function|<template>|@Component)',
    models:      '(@Entity|mongoose\\.model|new Schema)',
    middleware:  '(app\\.use|middleware|next\\()',
  };

  const grepPattern = pattern ?? rolePatterns[role];
  if (!grepPattern) {
    return {
      error: `Provide a pattern string or a role. Valid roles: ${Object.keys(rolePatterns).join(', ')}`,
    };
  }

  // Search common source directories across frameworks
  // Use single quotes around pattern to prevent shell interpretation on remote hosts
  const safePattern = grepPattern.replace(/'/g, "'\\''")
  const dirs = 'src app pages components controllers routes services middleware';
  const cmd  = `grep -rl '${safePattern}' ${dirs} 2>/dev/null `
    + `--include='*.js' --include='*.ts' --include='*.jsx' --include='*.tsx' --include='*.vue' `
    + `|| true`;

  const result = await execNode(cmd, workspacePath, executionTarget);
  const files  = result.stdout
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  return {
    pattern:    grepPattern,
    role:       role ?? null,
    files,
    count:      files.length,
    workspacePath,
    executionTarget,
  };
}

/**
 * List all npm scripts from package.json with their commands.
 * Reveals how to build, test, start, dev-serve, and lint the project.
 *
 * @param {string} workspacePath
 * @param {string} executionTarget
 */
async function analyzeScripts(workspacePath, executionTarget = 'local') {
  const result = await execNode(
    'cat package.json 2>/dev/null || echo "{}"',
    workspacePath, executionTarget,
  );

  let pkg = {};
  try { pkg = JSON.parse(result.stdout); } catch {}

  const scripts = pkg.scripts ?? {};
  const entries = Object.entries(scripts).map(([name, command]) => ({ name, command }));

  return {
    scripts:   entries,
    count:     entries.length,
    hasStart:  'start'  in scripts,
    hasBuild:  'build'  in scripts,
    hasTest:   'test'   in scripts,
    hasDev:    'dev'    in scripts || 'serve' in scripts,
    hasLint:   'lint'   in scripts,
    workspacePath,
    executionTarget,
  };
}

// ── Dockerized Build & Run ────────────────────────────────────────────────────

/**
 * Write a production-ready, framework-aware Dockerfile (and nginx.conf for
 * frontend SPAs) to the workspace.
 *
 * Three Dockerfile patterns are chosen automatically:
 *
 *   Frontend (nginx) : node:alpine build stage → nginx:alpine runtime.
 *                      SPA routing nginx.conf written alongside Dockerfile.
 *
 *   Backend/SSR with build step : node:alpine build stage → node:alpine
 *                      runtime. dumb-init, non-root user, prod deps only.
 *
 *   Plain JS backend : single-stage node:alpine. No build step.
 *
 * @param {string} workspacePath
 * @param {string} executionTarget
 */
async function generateDockerfile(workspacePath, executionTarget = 'local') {
  const pkgResult = await execNode(
    'cat package.json 2>/dev/null || echo "{}"',
    workspacePath, executionTarget,
  );
  const lockResult = await execNode(
    'ls package-lock.json yarn.lock pnpm-lock.yaml bun.lockb 2>/dev/null || true',
    workspacePath, executionTarget,
  );
  const versionResult = await execNode(
    'cat .nvmrc 2>/dev/null || cat .node-version 2>/dev/null || true',
    workspacePath, executionTarget,
  );

  const packageJsonText = pkgResult.stdout || '{}';
  const nodeVersion     = detectNodeVersion(packageJsonText, versionResult.stdout);
  const fw              = detectNodeFramework(packageJsonText, lockResult.stdout);

  // ── Choose template ────────────────────────────────────────────────────────
  let content;
  let nginxContent = null;

  if (fw.runtimeType === 'nginx') {
    content      = buildFrontendDockerfile(fw, nodeVersion);
    nginxContent = NGINX_SPA_CONFIG;
  } else if (fw.needsBuild) {
    content      = buildNodeMultiStageDockerfile(fw, nodeVersion);
  } else {
    content      = buildNodeSimpleDockerfile(fw, nodeVersion);
  }

  // ── Write file(s) ──────────────────────────────────────────────────────────
  const dockerfilePath = path.posix.join(workspacePath ?? '.', 'Dockerfile');
  const nginxPath      = path.posix.join(workspacePath ?? '.', 'nginx.conf');

  if (!executionTarget || executionTarget === 'local') {
    fs.writeFileSync(path.join(workspacePath ?? '.', 'Dockerfile'), content, 'utf8');
    if (nginxContent) {
      fs.writeFileSync(path.join(workspacePath ?? '.', 'nginx.conf'), nginxContent, 'utf8');
    }
  } else {
    const { writeRemoteFile } = require('./ssh');
    const res = await writeRemoteFile(dockerfilePath, content, executionTarget);
    if (res.error) {
      return { written: false, dockerfilePath, content, error: res.error };
    }
    if (nginxContent) {
      await writeRemoteFile(nginxPath, nginxContent, executionTarget);
    }
  }

  return {
    written:            true,
    framework:          fw.framework,
    type:               fw.type,
    nodeVersion,
    packageManager:     fw.packageManager,
    runtimeType:        fw.runtimeType,
    dockerfilePath,
    nginxConfWritten:   !!nginxContent,
    nginxConfPath:      nginxContent ? nginxPath : null,
    healthPath:         fw.healthPath,
    content,
  };
}

/**
 * Build a Docker image from the workspace Dockerfile.
 * Captures stderr so the LLM can self-correct on build failures (e.g. missing
 * deps, TypeScript errors).
 *
 * @param {string} workspacePath
 * @param {string} imageName  Docker image tag (e.g. 'my-app:latest')
 * @param {string} executionTarget
 */
async function dockerBuild(workspacePath, imageName, executionTarget = 'local') {
  const tag    = sanitizeImageName(imageName ?? 'agent-node-app');
  const result = await execNode(
    `docker build -t ${tag} . 2>&1`,
    workspacePath, executionTarget, BUILD_TIMEOUT,
  );

  return {
    imageName:      tag,
    exitCode:       result.exitCode,
    success:        result.exitCode === 0,
    stdout:         safeSlice(result.stdout),
    stderr:         safeSlice(result.stderr),
    workspacePath,
    executionTarget,
  };
}

/**
 * Start the containerized application.
 *
 * Auto-detects the internal container port from the project (80 for nginx/
 * frontend, app port for node/backend). Runs docker run -d with:
 *   • Port mapping: hostPort → containerPort
 *   • Memory limit: 1 GB
 *   • Env injection: passed as -e KEY=VALUE pairs
 *   • Health check: polls healthPath until 200 OK or timeout
 *
 * @param {string} workspacePath
 * @param {string} imageName
 * @param {number} hostPort        Port exposed on the host (default: auto)
 * @param {Object} envVars         Key/value env vars to inject
 * @param {string} healthPath      HTTP path to check (default: auto-detected)
 * @param {string} executionTarget
 */
async function runContainerizedApp(
  workspacePath,
  imageName,
  hostPort        = null,
  envVars         = {},
  healthPath      = null,
  executionTarget = 'local',
) {
  // Detect internal port and health path from the project
  const info          = await inspectProject(workspacePath, executionTarget);
  const containerPort = info.runtimeType === 'nginx' ? 80 : (info.port ?? 3000);
  const resolvedHost  = hostPort    ?? containerPort;
  const resolvedPath  = healthPath  ?? info.healthPath ?? '/health';

  const tag  = sanitizeImageName(imageName ?? 'agent-node-app');
  const name = `agent-app-${tag}`;

  // Stop+remove any existing container (idempotent)
  await execNode(`docker rm -f ${name} 2>/dev/null || true`, workspacePath, executionTarget);

  const envFlags = Object.entries(envVars ?? {})
    .map(([k, v]) => `-e ${k}=${JSON.stringify(String(v))}`)
    .join(' ');

  const runCmd = [
    'docker run -d',
    `--name ${name}`,
    `-p ${resolvedHost}:${containerPort}`,
    '--memory="1g"',
    envFlags,
    tag,
  ].filter(Boolean).join(' ');

  const run = await execNode(runCmd, workspacePath, executionTarget);

  if (run.exitCode !== 0) {
    return {
      containerId: null,
      url:         null,
      healthy:     false,
      exitCode:    run.exitCode,
      stdout:      safeSlice(run.stdout),
      stderr:      safeSlice(run.stderr),
    };
  }

  const containerId = run.stdout.trim().slice(0, 12);

  // For remote targets the health check must run ON the VM (curl there, not here).
  // For local targets, curl runs on this machine against localhost.
  const healthHost = (executionTarget && executionTarget !== 'local')
    ? '127.0.0.1'
    : 'localhost';
  const url = `http://${healthHost}:${resolvedHost}${resolvedPath}`;

  const health = await execNode(
    `curl -s -o /dev/null -w "%{http_code}" --max-time 5 --retry 10 --retry-delay 3 ${url}`,
    workspacePath, executionTarget, 60_000,
  );
  const healthy = health.stdout.trim() === '200';

  return {
    containerId,
    url,
    healthy,
    healthStatusCode: health.stdout.trim(),
    imageName:        tag,
    containerName:    name,
    hostPort:         resolvedHost,
    containerPort,
    exitCode:         run.exitCode,
    stdout:           safeSlice(run.stdout),
    stderr:           safeSlice(run.stderr),
    executionTarget,
  };
}

// ── Verification & Testing ────────────────────────────────────────────────────

/**
 * Run the project's test suite (Jest, Vitest, or Mocha) inside a Docker
 * container. Returns structured pass/fail counts.
 *
 * @param {string} workspacePath
 * @param {string} executionTarget
 */
async function runTests(workspacePath, executionTarget = 'local') {
  const pkgResult  = await execNode('cat package.json 2>/dev/null || echo "{}"', workspacePath, executionTarget);
  const lockResult = await execNode('ls package-lock.json yarn.lock pnpm-lock.yaml bun.lockb 2>/dev/null || true', workspacePath, executionTarget);
  const verResult  = await execNode('cat .nvmrc 2>/dev/null || true', workspacePath, executionTarget);

  const nv = detectNodeVersion(pkgResult.stdout, verResult.stdout);
  const fw = detectNodeFramework(pkgResult.stdout, lockResult.stdout);

  let pkg = {};
  try { pkg = JSON.parse(pkgResult.stdout); } catch {}

  const scripts    = pkg.scripts ?? {};
  const testScript = scripts['test'] ?? scripts['test:ci'];
  if (!testScript) {
    return {
      error:   'No "test" or "test:ci" script in package.json. Add one to run tests.',
      exitCode: 1,
    };
  }

  // Detect test runner to pass correct no-watch / CI flags
  const deps        = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const isVitest    = !!(deps['vitest'] || testScript.includes('vitest'));
  const isMocha     = !!(deps['mocha']  || testScript.includes('mocha'));
  const isJest      = !!(deps['jest']   || deps['@jest/globals'] || testScript.includes('jest'));

  let testCmd = 'npm test';
  if (isVitest) testCmd = 'npx vitest run';
  else if (isJest) testCmd = 'npm test -- --watchAll=false --ci --passWithNoTests';
  else if (isMocha) testCmd = 'npm test';

  // For remote execution: docker run on the remote host using the remote workspace path.
  // The volume mount path is the remote workspacePath — docker is running on that VM.
  // For local: same docker run but with local path.
  const dockerCmd = `docker run --rm \
    -v ${JSON.stringify(workspacePath)}:/app \
    -w /app node:${nv}-alpine \
    sh -c "${fw.installCmd} && ${testCmd} 2>&1"`;

  const result = await execNode(dockerCmd, null, executionTarget, BUILD_TIMEOUT);
  const out    = result.stdout + result.stderr;

  // Parse Jest / Vitest: "Tests: 12 passed, 1 failed, 13 total"
  let passed = null, failed = null, total = null;
  const jestMatch = out.match(/Tests:\s+(\d+) passed(?:,\s*(\d+) failed)?(?:,\s*(\d+) total)?/);
  if (jestMatch) {
    passed = parseInt(jestMatch[1], 10);
    failed = jestMatch[2] ? parseInt(jestMatch[2], 10) : 0;
    total  = jestMatch[3] ? parseInt(jestMatch[3], 10) : passed + failed;
  }

  // Parse Mocha: "12 passing\n1 failing"
  if (!jestMatch) {
    const passMatch = out.match(/(\d+) passing/);
    const failMatch = out.match(/(\d+) failing/);
    if (passMatch) {
      passed = parseInt(passMatch[1], 10);
      failed = failMatch ? parseInt(failMatch[1], 10) : 0;
      total  = passed + failed;
    }
  }

  return {
    testRunner:  isVitest ? 'vitest' : isJest ? 'jest' : isMocha ? 'mocha' : 'npm-test',
    passed,
    failed,
    total,
    success:     result.exitCode === 0,
    exitCode:    result.exitCode,
    stdout:      safeSlice(out),
    workspacePath,
    executionTarget,
  };
}

/**
 * Send an HTTP request to a deployed endpoint and return status code,
 * response body, and latency in milliseconds.
 *
 * Use this to verify a fix or new feature actually works after deployment.
 *
 * @param {string} url
 * @param {string} method     HTTP method: GET | POST | PUT | DELETE | PATCH
 * @param {string|Object|null} body  Request body (for POST/PUT)
 * @param {Object} headers    Additional headers as key/value map
 * @param {string} executionTarget
 */
async function curlEndpoint(url, method = 'GET', body = null, headers = {}, executionTarget = 'local') {
  if (!url || !url.startsWith('http')) {
    return { error: `Invalid URL: "${url}". Must start with http:// or https://` };
  }

  const headerFlags = Object.entries(headers ?? {})
    .map(([k, v]) => `-H ${JSON.stringify(`${k}: ${v}`)}`)
    .join(' ');

  const bodyFlag = body
    ? `-d ${JSON.stringify(typeof body === 'string' ? body : JSON.stringify(body))}`
    : '';

  const contentTypeFlag = (body && !headers?.['Content-Type'])
    ? `-H "Content-Type: application/json"`
    : '';

  const cmd = [
    'curl -s -w "\\n---STATUS:%{http_code}---LATENCY:%{time_total}---"',
    `-X ${method.toUpperCase()}`,
    headerFlags,
    contentTypeFlag,
    bodyFlag,
    JSON.stringify(url),
  ].filter(Boolean).join(' ');

  const result = await execNode(cmd, null, executionTarget, 30_000);
  const output = result.stdout;

  const statusMatch  = output.match(/---STATUS:(\d+)---/);
  const latencyMatch = output.match(/---LATENCY:([\d.]+)---/);
  const responseBody = output.replace(/\n?---STATUS:\d+---LATENCY:[\d.]+---$/, '').trim();

  return {
    url,
    method:     method.toUpperCase(),
    statusCode: statusMatch  ? parseInt(statusMatch[1],  10)                   : null,
    latencyMs:  latencyMatch ? Math.round(parseFloat(latencyMatch[1]) * 1000)  : null,
    body:       safeSlice(responseBody, 10_000),
    success:    statusMatch ? statusMatch[1].startsWith('2') : false,
    exitCode:   result.exitCode,
    executionTarget,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Static analysis
  inspectProject,
  listDependencies,
  findComponent,
  analyzeScripts,
  // Dockerized build & run
  generateDockerfile,
  dockerBuild,
  runContainerizedApp,
  // Verification
  runTests,
  curlEndpoint,
};
