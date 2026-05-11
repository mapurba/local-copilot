/**
 * Java Tools
 *
 * Language-aware toolset for Java/Maven/Gradle projects.
 * All tools are environment-agnostic:
 *
 *   executionTarget = 'local'     → run on this machine (default)
 *   executionTarget = <sessionId> → run on a remote VM via an open ssh: session
 *                                   (call ssh:connect first to get the sessionId)
 *
 * ── Static Analysis ──────────────────────────────────────────────────────────
 *
 *   java:inspectProject        Detect build system, Java version, main class
 *   java:getPackageHierarchy   List all .java source files under src/main/java
 *   java:findComponent         Locate classes by annotation (e.g. @RestController)
 *   java:analyzeDependencies   Parse pom.xml or build.gradle for declared deps
 *
 * ── Dockerized Build & Run ───────────────────────────────────────────────────
 *
 *   java:generateDockerfile    Write a multi-stage Dockerfile to the workspace
 *   java:dockerBuild           docker build — streams stderr so LLM can self-correct
 *   java:runContainerizedApp   docker run with port mapping, env vars, health check
 *
 * ── Verification & Testing ───────────────────────────────────────────────────
 *
 *   java:runTests              Run Maven/Gradle tests inside a Docker container
 *   java:curlEndpoint          Hit a deployed endpoint to verify a fix or feature
 */

'use strict';

const { exec }      = require('child_process');
const { promisify } = require('util');
const fs            = require('fs');
const path          = require('path');

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT = 5  * 60_000;  // 5 min — builds can be slow
const BUILD_TIMEOUT   = 10 * 60_000;  // 10 min — Docker image builds
const MAX_OUTPUT      = 200_000;       // 200 KB cap per stream

// ── Execution abstraction ─────────────────────────────────────────────────────
//
//   execJava(command, workspacePath, executionTarget, timeoutMs)
//
//   Dispatches a shell command to either:
//     • The local machine  (child_process.exec, cwd = workspacePath)
//     • A remote VM        (ssh:runCommand with "cd <path> && <command>" prefix)

async function execJava(command, workspacePath, executionTarget = 'local', timeoutMs = DEFAULT_TIMEOUT) {
  if (!executionTarget || executionTarget === 'local') {
    // ── Local ────────────────────────────────────────────────────────────────
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
    // ── Remote via SSH session ────────────────────────────────────────────────
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

// Sanitize an image/container name: keep only lowercase alphanum + dash
function sanitizeImageName(name) {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Analyse build file text to determine which framework the project uses.
 *
 * Returns an object used internally by inspectProject and generateDockerfile:
 *
 *   framework      — 'spring-boot' | 'quarkus' | 'micronaut' | 'helidon' | 'plain'
 *   packaging      — 'fat-jar' | 'quarkus-app' | 'native' | 'plain-jar'
 *   healthPath     — best-guess HTTP health endpoint for this framework
 *   extraPackages  — Alpine apk packages that should be installed in the runtime image
 *   jvmFlags       — extra JVM flags appropriate for the framework inside Docker
 *   buildGoal      — Maven goal or Gradle task to use for packaging
 */
function detectFramework(buildFileContent, buildSystem) {
  const text = buildFileContent ?? '';

  // ── Spring Boot ───────────────────────────────────────────────────────────
  if (
    text.includes('spring-boot') ||
    text.includes('org.springframework.boot') ||
    text.includes('SpringApplication')
  ) {
    const hasNative = text.includes('spring-boot:build-image') || text.includes('native');
    return {
      framework:     'spring-boot',
      packaging:     hasNative ? 'native' : 'fat-jar',
      healthPath:    '/actuator/health',
      extraPackages: ['curl', 'tzdata', 'fontconfig'],
      jvmFlags:      '-XX:+UseContainerSupport -XX:MaxRAMPercentage=75.0',
      buildGoal:     buildSystem === 'gradle' ? 'bootJar' : 'package',
    };
  }

  // ── Quarkus ───────────────────────────────────────────────────────────────
  if (
    text.includes('quarkus') ||
    text.includes('io.quarkus')
  ) {
    const isNative = text.includes('native') || text.includes('-Pnative');
    return {
      framework:     'quarkus',
      packaging:     isNative ? 'native' : 'quarkus-app',
      healthPath:    '/q/health',
      extraPackages: ['curl', 'tzdata', 'gcompat'],  // gcompat for glibc compat on Alpine
      jvmFlags:      '-XX:+UseContainerSupport',
      buildGoal:     buildSystem === 'gradle' ? 'quarkusBuild' : 'package -Dquarkus.package.type=uber-jar',
    };
  }

  // ── Micronaut ─────────────────────────────────────────────────────────────
  if (
    text.includes('micronaut') ||
    text.includes('io.micronaut')
  ) {
    return {
      framework:     'micronaut',
      packaging:     'fat-jar',
      healthPath:    '/health',
      extraPackages: ['curl', 'tzdata'],
      jvmFlags:      '-XX:+UseContainerSupport -Dmicronaut.environments=docker',
      buildGoal:     buildSystem === 'gradle' ? 'shadowJar' : 'package',
    };
  }

  // ── Helidon ───────────────────────────────────────────────────────────────
  if (text.includes('helidon') || text.includes('io.helidon')) {
    return {
      framework:     'helidon',
      packaging:     'fat-jar',
      healthPath:    '/health',
      extraPackages: ['curl', 'tzdata'],
      jvmFlags:      '-XX:+UseContainerSupport',
      buildGoal:     buildSystem === 'gradle' ? 'jar' : 'package',
    };
  }

  // ── Plain Java ────────────────────────────────────────────────────────────
  return {
    framework:     'plain',
    packaging:     'plain-jar',
    healthPath:    '/',
    extraPackages: ['curl', 'tzdata'],
    jvmFlags:      '-XX:+UseContainerSupport',
    buildGoal:     buildSystem === 'gradle' ? 'jar' : 'package',
  };
}

// ── Static Analysis ───────────────────────────────────────────────────────────

/**
 * Detect build system (Maven/Gradle), Java framework, version, entry-point
 * class, and whether the project already has a Dockerfile.
 *
 * @param {string} workspacePath  Absolute path to the cloned repository root
 * @param {string} executionTarget  'local' or an ssh: sessionId
 * @returns {{ buildSystem, framework, packaging, javaVersion, mainClass,
 *             hasDockerfile, projectName, healthPath, extraPackages, jvmFlags, buildGoal }}
 */
async function inspectProject(workspacePath, executionTarget = 'local') {
  const probe = await execJava(
    'ls pom.xml build.gradle build.gradle.kts Dockerfile 2>/dev/null || true',
    workspacePath,
    executionTarget,
  );
  const files = probe.stdout;

  let buildSystem = 'unknown';
  if (files.includes('pom.xml'))           buildSystem = 'maven';
  else if (files.includes('build.gradle')) buildSystem = 'gradle';

  const hasDockerfile = files.includes('Dockerfile');

  // Read the build file to extract metadata
  let buildFileContent = '';
  let javaVersion      = null;
  let mainClass        = null;
  let projectName      = null;

  if (buildSystem === 'maven') {
    const readPom = await execJava('cat pom.xml', workspacePath, executionTarget);
    buildFileContent = readPom.stdout;

    const javaMatch  = buildFileContent.match(/<java\.version>([^<]+)<\/java\.version>/);
    const srcMatch   = buildFileContent.match(/<source>(\d+)<\/source>/);
    const relMatch   = buildFileContent.match(/<release>(\d+)<\/release>/);
    javaVersion = (javaMatch?.[1] ?? srcMatch?.[1] ?? relMatch?.[1] ?? '17').trim();

    const mainMatch = buildFileContent.match(/<mainClass>([^<]+)<\/mainClass>/);
    mainClass = mainMatch?.[1]?.trim() ?? null;

    const nameMatch = buildFileContent.match(/<artifactId>([^<]+)<\/artifactId>/);
    projectName = nameMatch?.[1]?.trim() ?? null;

  } else if (buildSystem === 'gradle') {
    const readGradle = await execJava(
      'cat build.gradle 2>/dev/null || cat build.gradle.kts 2>/dev/null',
      workspacePath, executionTarget,
    );
    buildFileContent = readGradle.stdout;

    const javaMatch = buildFileContent.match(
      /sourceCompatibility\s*[=:]\s*['"]?(?:JavaVersion\.VERSION_)?(\d+)['"]?/,
    );
    javaVersion = javaMatch?.[1]?.trim() ?? '17';

    const mainMatch = buildFileContent.match(/mainClass(?:Name)?\s*[=:]\s*['"]([^'"]+)['"]/);
    mainClass = mainMatch?.[1]?.trim() ?? null;

    const nameMatch = buildFileContent.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
    projectName = nameMatch?.[1]?.trim() ?? null;
  }

  // Detect framework from build file content
  const fw = detectFramework(buildFileContent, buildSystem);

  const isRemote = executionTarget && executionTarget !== 'local';

  return {
    buildSystem,
    framework:     fw.framework,
    packaging:     fw.packaging,
    javaVersion:   javaVersion ?? '17',
    mainClass,
    projectName,
    hasDockerfile,
    healthPath:    fw.healthPath,
    extraPackages: fw.extraPackages,
    jvmFlags:      fw.jvmFlags,
    buildGoal:     fw.buildGoal,
    workspacePath,
    executionTarget,
    // Guidance for the LLM when operating on a remote host
    _remoteHint: isRemote
      ? `IMPORTANT: executionTarget is "${executionTarget}" (remote SSH session). `
        + `Pass executionTarget: "${executionTarget}" to ALL subsequent java: tool calls. `
        + `Do NOT use custom:listDir, custom:readFile, or custom:runCommand for paths on this host — `
        + `those run locally. Use ssh:listRemoteDir, ssh:readRemoteFile, and java: tools with executionTarget.`
      : undefined,
  };
}

/**
 * Return a structured list of all Java source files under src/main/java.
 * Filters out test files. Useful for the LLM to map the project before editing.
 *
 * @param {string} workspacePath
 * @param {string} executionTarget
 * @returns {{ files: string[], count: number, stdout: string }}
 */
async function getPackageHierarchy(workspacePath, executionTarget = 'local') {
  const result = await execJava(
    'find src/main/java -type f -name "*.java" | sort',
    workspacePath,
    executionTarget,
  );

  const files = result.stdout
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  return {
    files,
    count:          files.length,
    workspacePath,
    executionTarget,
    stdout:         safeSlice(result.stdout),
    stderr:         safeSlice(result.stderr),
    exitCode:       result.exitCode,
  };
}

/**
 * Locate Java source files that carry a specific annotation.
 * Helpful for finding @RestController, @Service, @Entity, @Repository, etc.
 *
 * @param {string} workspacePath
 * @param {string} annotationName  e.g. 'RestController' or '@Service'
 * @param {string} executionTarget
 * @returns {{ matches: string[], count: number }}
 */
async function findComponent(workspacePath, annotationName, executionTarget = 'local') {
  // Strip leading @ if the caller included it
  const ann = annotationName.replace(/^@/, '');

  const result = await execJava(
    `grep -r "@${ann}" src/main/java --include="*.java" -l 2>/dev/null || true`,
    workspacePath,
    executionTarget,
  );

  const matches = result.stdout
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  return {
    annotation:     `@${ann}`,
    matches,
    count:          matches.length,
    workspacePath,
    executionTarget,
  };
}

/**
 * Parse build file for declared dependencies.
 * For Maven: extracts <dependency> blocks.
 * For Gradle: extracts implementation/compile/api directives.
 *
 * @param {string} workspacePath
 * @param {string} executionTarget
 * @returns {{ buildSystem, dependencies: Array<{group, artifact, version, scope}> }}
 */
async function analyzeDependencies(workspacePath, executionTarget = 'local') {
  // First detect build system
  const inspect = await inspectProject(workspacePath, executionTarget);

  if (inspect.buildSystem === 'maven') {
    const read = await execJava('cat pom.xml', workspacePath, executionTarget);
    const pom  = read.stdout;

    // Extract all <dependency>...</dependency> blocks
    const depRegex = /<dependency>([\s\S]*?)<\/dependency>/g;
    const deps = [];
    let match;
    while ((match = depRegex.exec(pom)) !== null) {
      const block   = match[1];
      const group   = block.match(/<groupId>([^<]+)<\/groupId>/)?.[1]?.trim() ?? '';
      const artifact= block.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim() ?? '';
      const version = block.match(/<version>([^<]+)<\/version>/)?.[1]?.trim() ?? 'managed';
      const scope   = block.match(/<scope>([^<]+)<\/scope>/)?.[1]?.trim() ?? 'compile';
      if (group && artifact) deps.push({ group, artifact, version, scope });
    }

    return { buildSystem: 'maven', dependencies: deps, workspacePath };

  } else if (inspect.buildSystem === 'gradle') {
    const read   = await execJava(
      'cat build.gradle 2>/dev/null || cat build.gradle.kts 2>/dev/null',
      workspacePath, executionTarget,
    );
    const gradle = read.stdout;

    // Match lines like: implementation 'group:artifact:version' or implementation("...")
    const depRegex = /\b(implementation|api|compile|runtimeOnly|testImplementation)\s+["'(]([^"')]+)["')]/g;
    const deps = [];
    let match;
    while ((match = depRegex.exec(gradle)) !== null) {
      const scope = match[1];
      const coord = match[2];
      const parts = coord.split(':');
      deps.push({
        group:    parts[0] ?? '',
        artifact: parts[1] ?? coord,
        version:  parts[2] ?? 'managed',
        scope,
      });
    }

    return { buildSystem: 'gradle', dependencies: deps, workspacePath };
  }

  return { buildSystem: inspect.buildSystem, dependencies: [], workspacePath, error: 'No pom.xml or build.gradle found' };
}

// ── Dockerized Build & Run ────────────────────────────────────────────────────

/**
 * Write a production-ready, framework-aware multi-stage Dockerfile.
 *
 * Auto-detects build system (Maven/Gradle) and framework (Spring Boot, Quarkus,
 * Micronaut, Helidon, or plain Java). Generates:
 *
 *   Stage 1 — build image  : correct builder base, dependency-cache layer,
 *                             framework-specific package goal
 *   Stage 2 — runtime image: slim JRE with only the OS packages the framework
 *                             actually needs (curl, tzdata, fontconfig, gcompat…)
 *
 * @param {string} workspacePath
 * @param {string} buildSystem   'maven' | 'gradle' | 'auto'  (default 'auto')
 * @param {string} javaVersion   e.g. '17', '21'              (default 'auto')
 * @param {string} executionTarget
 * @returns {{ written, buildSystem, framework, javaVersion, dockerfilePath, content }}
 */
async function generateDockerfile(workspacePath, buildSystem = 'auto', javaVersion = 'auto', executionTarget = 'local') {
  // ── 1. Inspect project to get all context ──────────────────────────────────
  const info = await inspectProject(workspacePath, executionTarget);

  // Allow caller to override auto-detected values
  const bs  = (!buildSystem || buildSystem === 'auto')
    ? (info.buildSystem !== 'unknown' ? info.buildSystem : 'maven')
    : buildSystem;
  const jv  = (!javaVersion || javaVersion === 'auto')
    ? (info.javaVersion ?? '17')
    : javaVersion;

  const fw        = info.framework   ?? 'plain';
  const packaging = info.packaging   ?? 'fat-jar';
  const goal      = info.buildGoal   ?? (bs === 'gradle' ? 'jar' : 'package');
  const jvmFlags  = info.jvmFlags    ?? '-XX:+UseContainerSupport';
  const apkPkgs   = (info.extraPackages ?? ['curl', 'tzdata']).join(' ');

  // ── 2. Build-stage snippet ─────────────────────────────────────────────────
  let buildStage;
  if (bs === 'maven') {
    buildStage = `# ── Stage 1: Build (${fw}) ────────────────────────────────────────────────
FROM maven:3.9-eclipse-temurin-${jv} AS builder
WORKDIR /build

# Layer-cache: download deps only when pom.xml changes
COPY pom.xml .
RUN mvn dependency:go-offline --batch-mode -q

# Copy source and build
COPY src ./src
RUN mvn ${goal} --batch-mode -DskipTests -q`;
  } else {
    buildStage = `# ── Stage 1: Build (${fw}) ────────────────────────────────────────────────
FROM gradle:jdk${jv} AS builder
WORKDIR /build

# Layer-cache: download deps only when build file changes
COPY build.gradle* settings.gradle* gradle* ./
RUN gradle dependencies --no-daemon -q 2>/dev/null || true

# Copy source and build
COPY src ./src
RUN gradle ${goal} --no-daemon -q`;
  }

  // ── 3. Copy artefact snippet (varies by packaging type) ───────────────────
  let copyArtefact;
  if (packaging === 'quarkus-app') {
    // Quarkus fast-jar layout: quarkus-app/ directory + quarkus-run.jar
    copyArtefact = `COPY --from=builder /build/target/quarkus-app/ quarkus-app/`;
  } else if (bs === 'gradle') {
    copyArtefact = `COPY --from=builder /build/build/libs/*.jar app.jar`;
  } else {
    // Maven fat-jar / uber-jar
    copyArtefact = `COPY --from=builder /build/target/*.jar app.jar`;
  }

  // ── 4. Entrypoint snippet ──────────────────────────────────────────────────
  let entrypoint;
  if (packaging === 'quarkus-app') {
    entrypoint = `ENTRYPOINT ["java", ${jvmFlags ? `"${jvmFlags.split(' ').join('", "')}", ` : ''}"${'-jar'}", "quarkus-app/quarkus-run.jar"]`;
  } else if (packaging === 'native') {
    entrypoint = `ENTRYPOINT ["./application"]`;
  } else {
    entrypoint = `ENTRYPOINT ["java", "${jvmFlags.split(' ').join('", "')}", "-jar", "app.jar"]`;
  }

  // ── 5. Assemble runtime stage ──────────────────────────────────────────────
  //  • Alpine keeps the image small
  //  • apk packages are installed in a single layer with --no-cache
  //  • Non-root user for security
  const runtimeBase = packaging === 'native'
    ? 'alpine:3.19'               // native binary: no JRE needed
    : `eclipse-temurin:${jv}-jre-alpine`;

  const runtimeStage = `# ── Stage 2: Runtime (${runtimeBase}) ─────────────────────────────────────
FROM ${runtimeBase}
WORKDIR /app

# Install OS prerequisites: ${apkPkgs}
RUN apk add --no-cache ${apkPkgs}

# Run as non-root for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

${copyArtefact}

RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 8080
${entrypoint}`;

  // ── 6. Compose final Dockerfile ────────────────────────────────────────────
  const content = [
    `# Generated by java:generateDockerfile`,
    `# Framework : ${fw}`,
    `# Build     : ${bs} / Java ${jv}`,
    `# Packaging : ${packaging}`,
    '',
    buildStage,
    '',
    runtimeStage,
    '',
  ].join('\n');

  // ── 7. Write the file (local or remote) ────────────────────────────────────
  const dockerfilePath = path.posix.join(workspacePath ?? '.', 'Dockerfile');

  if (!executionTarget || executionTarget === 'local') {
    const localPath = path.join(workspacePath ?? '.', 'Dockerfile');
    fs.writeFileSync(localPath, content, 'utf8');
  } else {
    const { writeRemoteFile } = require('./ssh');
    const res = await writeRemoteFile(dockerfilePath, content, executionTarget);
    if (res.error) {
      return { written: false, dockerfilePath, content, error: res.error };
    }
  }

  return {
    written: true,
    buildSystem: bs,
    framework:   fw,
    packaging,
    javaVersion: jv,
    healthPath:  info.healthPath,
    dockerfilePath,
    content,
  };
}

/**
 * Build a Docker image from the workspace Dockerfile.
 * Captures stderr so the LLM can self-correct on compilation failures.
 *
 * @param {string} workspacePath
 * @param {string} imageName  Docker image tag (e.g. 'my-app:latest')
 * @param {string} executionTarget
 * @returns {{ imageName, exitCode, stdout, stderr, success }}
 */
async function dockerBuild(workspacePath, imageName, executionTarget = 'local') {
  const tag  = sanitizeImageName(imageName ?? 'agent-java-app');
  const cmd  = `docker build -t ${tag} . 2>&1`;

  const result = await execJava(cmd, workspacePath, executionTarget, BUILD_TIMEOUT);

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
 * Runs docker run -d with:
 *   • Port mapping: hostPort → 8080
 *   • Memory limit: 2 GB (prevents runaway Java processes crashing the VM)
 *   • Env injection: passed as -e KEY=VALUE pairs
 *   • Health check: polls /actuator/health (or /) until 200 OK or timeout
 *
 * @param {string} workspacePath
 * @param {string} imageName
 * @param {number} hostPort         Port on the host to expose (default 8080)
 * @param {Object} envVars          Key/value map of env vars to inject
 * @param {string} healthPath       HTTP path to health-check (default '/actuator/health')
 * @param {string} executionTarget
 * @returns {{ containerId, url, healthy, exitCode, stdout, stderr }}
 */
async function runContainerizedApp(
  workspacePath,
  imageName,
  hostPort     = 8080,
  envVars      = {},
  healthPath   = '/actuator/health',
  executionTarget = 'local',
) {
  const tag  = sanitizeImageName(imageName ?? 'agent-java-app');
  const name = `agent-app-${tag}`;

  // Stop+remove any existing container with the same name (idempotent)
  await execJava(
    `docker rm -f ${name} 2>/dev/null || true`,
    workspacePath, executionTarget,
  );

  // Build -e flags
  const envFlags = Object.entries(envVars ?? {})
    .map(([k, v]) => `-e ${k}=${JSON.stringify(String(v))}`)
    .join(' ');

  const runCmd = [
    'docker run -d',
    `--name ${name}`,
    `-p ${hostPort}:8080`,
    '--memory="2g"',
    envFlags,
    tag,
  ].filter(Boolean).join(' ');

  const run = await execJava(runCmd, workspacePath, executionTarget);

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

  // Health check — curl with retries
  const url = `http://localhost:${hostPort}${healthPath}`;
  const healthCmd = `curl -s -o /dev/null -w "%{http_code}" --max-time 5 --retry 10 --retry-delay 3 ${url}`;
  const health = await execJava(healthCmd, workspacePath, executionTarget, 60_000);
  const healthy = health.stdout.trim() === '200';

  return {
    containerId,
    url,
    healthy,
    healthStatusCode: health.stdout.trim(),
    imageName:        tag,
    containerName:    name,
    hostPort,
    exitCode:         run.exitCode,
    stdout:           safeSlice(run.stdout),
    stderr:           safeSlice(run.stderr),
    executionTarget,
  };
}

// ── Verification & Testing ────────────────────────────────────────────────────

/**
 * Run the project's test suite inside a Docker container (no local JDK needed).
 * Returns a structured report with pass/fail counts.
 *
 * @param {string} workspacePath
 * @param {'maven'|'gradle'|'auto'} buildSystem
 * @param {string} executionTarget
 * @returns {{ buildSystem, passed, failed, errors, skipped, exitCode, stdout, stderr }}
 */
async function runTests(workspacePath, buildSystem = 'auto', executionTarget = 'local') {
  // Auto-detect build system
  if (!buildSystem || buildSystem === 'auto') {
    const info = await inspectProject(workspacePath, executionTarget);
    buildSystem = info.buildSystem !== 'unknown' ? info.buildSystem : 'maven';
  }

  let testCmd;
  if (buildSystem === 'maven') {
    testCmd = `docker run --rm -v ${JSON.stringify(workspacePath)}:/app -w /app maven:3.9-eclipse-temurin-17 mvn test --batch-mode 2>&1`;
  } else {
    testCmd = `docker run --rm -v ${JSON.stringify(workspacePath)}:/app -w /app gradle:jdk17 gradle test --no-daemon 2>&1`;
  }

  const result = await execJava(testCmd, null, executionTarget, BUILD_TIMEOUT);
  const out    = result.stdout + result.stderr;

  // Parse Maven Surefire summary: "Tests run: X, Failures: Y, Errors: Z, Skipped: W"
  let passed = null, failed = null, errors = null, skipped = null;
  const mavenMatch = out.match(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/);
  if (mavenMatch) {
    const total = parseInt(mavenMatch[1], 10);
    failed  = parseInt(mavenMatch[2], 10);
    errors  = parseInt(mavenMatch[3], 10);
    skipped = parseInt(mavenMatch[4], 10);
    passed  = total - failed - errors - skipped;
  }

  // Parse Gradle summary: "X tests completed, Y failed"
  const gradleMatch = out.match(/(\d+) tests? completed(?:,\s*(\d+) failed)?/);
  if (gradleMatch) {
    const total = parseInt(gradleMatch[1], 10);
    failed  = parseInt(gradleMatch[2] ?? '0', 10);
    passed  = total - failed;
    errors  = 0;
    skipped = 0;
  }

  return {
    buildSystem,
    passed,
    failed,
    errors,
    skipped,
    success:        result.exitCode === 0,
    exitCode:       result.exitCode,
    stdout:         safeSlice(out),
    workspacePath,
    executionTarget,
  };
}

/**
 * Hit an HTTP endpoint to verify a deployed application.
 * Returns status code, response body, and latency.
 *
 * @param {string} url                  Full URL including scheme
 * @param {'GET'|'POST'|'PUT'|'DELETE'|'PATCH'} method  HTTP method (default GET)
 * @param {string|null} body            Request body (for POST/PUT)
 * @param {Object} headers              Additional headers as key/value map
 * @param {string} executionTarget
 * @returns {{ url, method, statusCode, body, latencyMs, success }}
 */
async function curlEndpoint(url, method = 'GET', body = null, headers = {}, executionTarget = 'local') {
  if (!url || !url.startsWith('http')) {
    return { error: `Invalid URL: ${url}. Must start with http:// or https://` };
  }

  const headerFlags = Object.entries(headers ?? {})
    .map(([k, v]) => `-H ${JSON.stringify(`${k}: ${v}`)}`)
    .join(' ');

  const bodyFlag = body
    ? `-d ${JSON.stringify(typeof body === 'string' ? body : JSON.stringify(body))}`
    : '';

  const contentTypeFlag = body && !headers?.['Content-Type']
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

  const result = await execJava(cmd, null, executionTarget, 30_000);
  const output = result.stdout;

  // Parse sentinel markers appended by -w
  const statusMatch  = output.match(/---STATUS:(\d+)---/);
  const latencyMatch = output.match(/---LATENCY:([\d.]+)---/);
  const responseBody = output.replace(/---STATUS:\d+---LATENCY:[\d.]+---$/, '').trim();

  return {
    url,
    method:     method.toUpperCase(),
    statusCode: statusMatch  ? parseInt(statusMatch[1],  10)    : null,
    latencyMs:  latencyMatch ? Math.round(parseFloat(latencyMatch[1]) * 1000) : null,
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
  getPackageHierarchy,
  findComponent,
  analyzeDependencies,
  // Dockerized build & run
  generateDockerfile,
  dockerBuild,
  runContainerizedApp,
  // Verification
  runTests,
  curlEndpoint,
};
