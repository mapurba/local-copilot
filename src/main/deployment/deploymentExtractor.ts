/**
 * Deployment Extractor
 *
 * Parses uploaded product documentation and extracts structured
 * DeploymentIntelligence using a single-pass or 3-pass chunked LLM strategy.
 *
 * Reuses:
 *  - docs/pipeline.ts  → callLlm()
 *  - docs/storage.ts   → getChunks(), searchChunksByText()
 */

import { z } from 'zod';
import { callLlm } from '../tools/categories/docs/pipeline';
import { readDocContent } from '../tools/categories/docs/fileStore';
import {
  DeploymentIntelligence,
  ExtractionOptions,
  OSRequirement,
  PortSpec,
  ConfigKey,
  InstallStep,
  HealthCheckSpec,
  ResourceSpec,
  ServiceSpec,
  DeploymentMode,
  ProductSpec,
} from './types';

// ── Zod schemas ───────────────────────────────────────────────────────────────

const OSRequirementSchema: z.ZodType<OSRequirement> = z.object({
  type: z.string(),
  minVersion: z.string().optional(),
  maxVersion: z.string().optional(),
});

const PortSpecSchema: z.ZodType<PortSpec> = z.object({
  port: z.number(),
  protocol: z.enum(['tcp', 'udp']),
  description: z.string(),
  isPublic: z.boolean(),
});

const ConfigKeySchema: z.ZodType<ConfigKey> = z.object({
  key: z.string(),
  description: z.string(),
  valueType: z.enum(['host', 'port', 'credential', 'name', 'path', 'other']).optional(),
});

const InstallStepSchema: z.ZodType<InstallStep> = z.object({
  osType: z.string().optional(),
  stepNumber: z.number(),
  description: z.string(),
  command: z.string().optional(),
  isPrerequisite: z.boolean(),
  expectedExitCode: z.number(),
  timeoutSeconds: z.number().optional(),
});

const HealthCheckSpecSchema: z.ZodType<HealthCheckSpec> = z.object({
  type: z.enum(['port', 'http', 'process', 'systemctl']),
  target: z.string(),
  expectedStatus: z.string().optional(),
  timeoutSeconds: z.number(),
  retryIntervalSeconds: z.number(),
});

const ResourceSpecSchema: z.ZodType<ResourceSpec> = z.object({
  minCpuCores: z.number().optional(),
  minMemoryMb: z.number().optional(),
  minDiskGb: z.number().optional(),
});

const ServiceSpecSchema: z.ZodType<ServiceSpec> = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(['primary', 'dependency', 'optional']),
  deployOn: z.enum(['vm', 'docker', 'k8s']),
  ports: z.array(PortSpecSchema),
  installSteps: z.array(InstallStepSchema),
  healthCheck: HealthCheckSpecSchema,
  configKeys: z.array(ConfigKeySchema),
  requiresConfigFrom: z.array(z.string()),
  resourceRequirements: ResourceSpecSchema.optional(),
});

const DeploymentModeSchema: z.ZodType<DeploymentMode> = z.object({
  name: z.string(),
  vmCount: z.number(),
  description: z.string(),
  serviceAssignments: z.record(z.string(), z.array(z.string())),
});

const ProductSpecSchema: z.ZodType<ProductSpec> = z.object({
  name: z.string(),
  version: z.string().optional(),
  supportedOS: z.array(OSRequirementSchema),
  services: z.array(ServiceSpecSchema),
});

const DeploymentIntelligenceSchema = z.object({
  products: z.array(ProductSpecSchema),
  deploymentModes: z.array(DeploymentModeSchema),
});

// ── Token helpers ───────────────────────────────────────────────────────────

function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n[... truncated ...]';
}

/**
 * Extracts the most relevant sections from a document for a specific service.
 *
 * Strategy:
 *  1. Split the document at every markdown heading.
 *  2. Score each section by how many times the service name keywords appear
 *     in it, with a bonus for install/config/setup sections.
 *  3. Always include the document preamble (~1 000 tokens) for global context.
 *  4. Append highest-scoring sections until `maxTokens` is reached.
 *  5. Fall back to a simple front-truncation if no relevant sections were found.
 *
 * This ensures that even for 100-page product docs a service documented on
 * page 20 gets its own relevant sections rather than being cut off.
 */
function extractServiceRelevantContent(
  text: string,
  serviceName: string,
  maxTokens: number
): string {
  const maxChars = maxTokens * 4;

  // Build keyword set from service name
  const keywords = serviceName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);

  // Split into sections at markdown headings (keep the heading as part of section)
  const rawSections = text.split(/(?=\n#{1,4}\s)/);

  const scored = rawSections.map((section, idx) => {
    const lower = section.toLowerCase();
    // Keyword frequency score
    let score = keywords.reduce((acc, kw) => {
      return acc + (lower.match(new RegExp(kw, 'g'))?.length ?? 0);
    }, 0);
    // Boost sections that look like installation/configuration procedures
    if (/install|setup|config|deploy|start|enable|procedure|step|command|package/i.test(section)) {
      score += 3;
    }
    // Strong boost for sections that contain actual shell commands or code blocks —
    // these are the highest-value sections for runbook generation
    if (/```|~~~/.test(section)) score += 6;
    if (/^\s*[$#>]\s+\S/m.test(section)) score += 4;
    // Boost sections referencing installer scripts or config files
    if (/\.bin\b|\.sh\b|silent\.properties|response\.varfile|\.rpm\b|\.deb\b/i.test(section)) score += 5;
    return { section, score, idx };
  });

  // Always include preamble for global context
  const preamble = truncateToTokens(text, 1000);
  const included = new Set<number>();
  let result = preamble;
  // Mark preamble sections as included
  for (const s of scored) {
    if (preamble.includes(s.section)) included.add(s.idx);
  }

  // Append most-relevant sections, highest-score first
  for (const { section, idx } of [...scored].sort((a, b) => b.score - a.score)) {
    if (included.has(idx)) continue;
    if (result.length + section.length > maxChars) continue;
    result += '\n' + section;
    included.add(idx);
  }

  // Fallback: nothing useful found — just truncate from the start
  if (result.trim().length < 200) return truncateToTokens(text, maxTokens);

  return result.slice(0, maxChars);
}

// ── Install-step command sanitizer ───────────────────────────────────────────

/**
 * Cleans up a single shell command emitted by the LLM so it can run
 * non-interactively as root inside a VCD guest-customization script.
 *
 * Rules applied:
 *  - Strip leading `sudo ` (script runs as root)
 *  - Add -y / --noconfirm to package-manager install calls that lack it
 *  - Prepend DEBIAN_FRONTEND=noninteractive for apt/apt-get installs
 *  - Flag interactive editor calls with # MANUAL_EDIT_REQUIRED (cannot automate)
 */
function sanitizeInstallStepCommand(cmd: string): string {
  if (!cmd) return cmd;
  let c = cmd.trim();

  // Multi-line commands (heredocs, multi-step scripts) must pass through unchanged
  // — they were deliberately written as multi-line and splitting them would break them.
  if (c.includes('\n')) return c;

  // Flag interactive editors — they cannot run unattended
  if (/^(sudo\s+)?(vi|vim|nano|emacs|pico)\s/.test(c)) {
    return `# MANUAL_EDIT_REQUIRED: ${c}`;
  }

  // Strip sudo prefix
  c = c.replace(/^sudo\s+/, '');

  // apt / apt-get install: add -y and DEBIAN_FRONTEND=noninteractive
  if (/^apt(-get)?\s+install\b/.test(c)) {
    if (!/-y\b/.test(c)) c = c.replace(/^(apt(-get)?)\s+install\b/, '$1 install -y');
    if (!/DEBIAN_FRONTEND/.test(c)) c = `DEBIAN_FRONTEND=noninteractive ${c}`;
  }

  // yum / dnf install: add -y
  if (/^(yum|dnf)\s+install\b/.test(c) && !/-y\b/.test(c)) {
    c = c.replace(/^(yum|dnf)\s+install\b/, '$1 install -y');
  }

  // zypper install: add --non-interactive
  if (/^zypper\s+install\b/.test(c) && !/--non-interactive/.test(c)) {
    c = c.replace(/^zypper\s+install\b/, 'zypper --non-interactive install');
  }

  // rpm -i / -ih → rpm -Uvh (upgrade-safe, verbose, hash)
  if (/^rpm\s+-i\b/.test(c)) {
    c = c.replace(/^rpm\s+-i\b/, 'rpm -Uvh');
  }

  // pip install: add --quiet if missing
  if (/^pip[23]?\s+install\b/.test(c) && !/-q\b|--quiet/.test(c)) {
    c = c.replace(/^(pip[23]?)\s+install\b/, '$1 install -q');
  }

  // Legacy SysV: service <name> start/stop/restart/enable → systemctl
  const svcMatch = c.match(/^service\s+(\S+)\s+(start|stop|restart|enable|disable)$/);
  if (svcMatch) {
    const [, svcName, action] = svcMatch;
    c = action === 'enable'
      ? `systemctl enable --now ${svcName}`
      : `systemctl ${action} ${svcName}`;
  }

  // chkconfig <name> on → systemctl enable --now <name>
  const chkMatch = c.match(/^chkconfig\s+(\S+)\s+on$/);
  if (chkMatch) {
    c = `systemctl enable --now ${chkMatch[1]}`;
  }

  return c;
}

// ── JSON extraction helper ────────────────────────────────────────────────────

function extractJson(raw: string): string {
  // Strip markdown code fences
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenceMatch) return fenceMatch[1].trim();
  // Find first { to last }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1) return raw.slice(start, end + 1);
  return raw.trim();
}

// ── LLM call with retry ───────────────────────────────────────────────────────

async function callLlmWithRetry(
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
  maxRetries = 2
): Promise<string> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const sp =
      attempt > 0
        ? systemPrompt + '\n\nCRITICAL: Respond ONLY with valid JSON. No prose, no markdown, no explanations. Start with { and end with }.'
        : systemPrompt;
    const raw = await callLlm(sp, userContent, maxTokens);
    try {
      const json = extractJson(raw);
      JSON.parse(json); // validate parseable
      return json;
    } catch {
      if (attempt === maxRetries) return raw; // return raw, caller handles failure
    }
  }
  return '{}';
}

// ── Single-pass extraction ────────────────────────────────────────────────────

const SINGLE_PASS_SYSTEM = `You are a software deployment analyst. Analyze the product documentation and extract structured deployment information.

⚠ ABSOLUTE RULE — REAL CONTENT ONLY:
  NEVER produce placeholder, example, template, or dummy content.
  Every field you emit MUST come directly from the provided document.
  If the document is a SHELL SCRIPT, understand it as the installation guide for the
  product it installs — extract the actual product name, service names, ports, and
  installation steps from the script logic, NOT from your own knowledge.
  Examples of FORBIDDEN placeholder output (never emit these):
    productName "Example Product", "Sample Product", "My Product"
    serviceId "example-service", "sample-service", "my-service"
    serviceName "Example Service", "Sample Service"
    commands referencing $EXAMPLE_REPO_URL, $SERVICE_BINARY_URL, http://localhost:8080/health
    ports 8080 unless the document explicitly specifies port 8080
  If you cannot extract a real value, OMIT the field rather than invent a placeholder.
  Returning placeholder JSON is WORSE than returning an empty products array.

installSteps command rules — every generated command MUST follow these:
  - NEVER use interactive editors: vi, vim, nano, emacs, less, pause, dialog
  - NEVER require user interaction at runtime: no read -p, select, whiptail/dialog, passwd prompts,
    yes/no confirmations, or commands waiting for stdin.
  - If a value is required, set it non-interactively in-script via env defaults (example:
    : "\${COMMON_PASSWORD:=novell}") and then reference that variable.
  - Do NOT leave unresolved placeholders that require user action (like CHANGE_ME, TODO, <FILL_ME>)
    unless the source document explicitly requires manual action and no automation path exists.
  - NEVER prefix commands with sudo (the script runs as root)
  - Package installs: always include -y / --yes / --noconfirm; prefix apt/apt-get with DEBIAN_FRONTEND=noninteractive
  - OS matters: SLES/RHEL/CentOS → zypper --non-interactive / yum -y / dnf -y; Ubuntu/Debian → apt-get -y
    Only generate package-manager or system commands that exist on the documented target OS.
    On SLES/SUSE: use zypper; AppArmor is the security module (NOT SELinux/semanage).
    On RHEL/CentOS: use yum/dnf; SELinux tools (semanage, setsebool) are appropriate.
  - Config file writes: use tee, sed -i, or cat with a heredoc — never an editor
  - Downloads: curl -fsSL -o <dest> or wget -q -O <dest>
  - Service management: systemctl enable --now <unit>
  - Each command field is normally a single executable shell line (use ; for sequencing if needed)
  - EXCEPTION — multi-line heredoc: for silent.properties / response.varfile creation, the command
    field MUST be a multi-line string encoded with \\n in JSON. Example:
      "command": "tee /tmp/node_specific_silent.properties << 'EOF'\\nINSTALL_ENGINE=\\"true\\"\\nID_VAULT_HOST=\\"\${ID_VAULT_HOST}\\"\\nCOMMON_PASSWORD=\\"\${COMMON_PASSWORD}\\"\\nEOF"
    Rules for this heredoc step:
      • Copy the COMPLETE properties file content from the document — do NOT abbreviate.
      • Replace EVERY hardcoded IP address or hostname with \${<VAR>} env var references.
        Use the same variable names as the properties file keys where sensible:
        <IP_OF_NODE_1> → \${ID_VAULT_HOST}; <IP_OF_NODE_2> → \${OSP_HOST}; etc.
      • Replace hardcoded passwords (e.g. "novell") with \${COMMON_PASSWORD} or \${<KEY>_PWD}.
      • Keep all other KEY="value" lines exactly as they appear in the document.
  - isPrerequisite: true for package/repo setup; false for service-specific configuration
  - IDEMPOTENCY — every command must be safe to re-run without failing:
      • User creation:    getent passwd <user> >/dev/null || useradd ...
      • Group creation:   getent group <grp> >/dev/null || groupadd ...
      • File append:      grep -qF '<line>' <file> || echo '<line>' >> <file>
      • Service enable:   systemctl is-active --quiet <svc> || systemctl enable --now <svc>
      • File download:    [ -f <dest> ] || wget/curl ...
      • ISO mount:        mountpoint -q <dir> 2>/dev/null || mount -o loop <iso> <dir>
      • One-shot install: use a marker file → [ -f /var/opt/.<product>_installed ] || (./install.sh ... && touch /var/opt/.<product>_installed)
  - NEVER hardcode IP addresses or hostnames in commands. Reference env vars like $SERVICE_HOST,
    $NODE_IP, $ID_VAULT_HOST that will be injected at runtime.

Per-node / per-role structure — CRITICAL for distributed deployments:
  If the document describes separate "Node 1:", "Node 2:", "Node 3:" (or similarly labeled)
  installation sections, you MUST create ONE service per node, not one service per component.
  Each node-service encapsulates ALL steps for that node including:
    1. ISO download / mount step
    2. tee heredoc step that creates the node-specific silent.properties file
    3. ./install.sh -s -f <properties-file> (wrapped in one-shot marker)
    4. ./configure.sh -s -f <properties-file> (wrapped in one-shot marker)
  Create a "distributed" deploymentMode with one VM role per node in serviceAssignments.
  Also create a "single-node" deploymentMode if a single-node properties block is present.

configKeys vs requiresConfigFrom — CRITICAL distinction:
  configKeys    = env vars that OTHER services need to connect TO THIS service.
                  e.g. A backend service exposes SERVICE_HOST and SERVICE_PORT so consumers know
                  how to reach it. Do NOT put connection vars here for services this component
                  consumes — those belong in the dependency service's own configKeys.
  requiresConfigFrom = IDs of services this service DEPENDS ON (needs at startup).
                  e.g. If service A depends on service B, A has requiresConfigFrom=["service-b-id"].
                  The connection vars (SERVICE_B_HOST, SERVICE_B_PORT) live in service B's configKeys.

configKeys valueType classification:
  "host"       → IP address, hostname, URL, connection string (e.g. <SVC>_HOST, <SVC>_URL, <SVC>_ENDPOINT)
  "port"       → port number (e.g. <SVC>_PORT, HTTP_PORT, LISTEN_PORT)
  "credential" → password, secret, API key, token, certificate (e.g. <SVC>_PASSWORD, API_SECRET, AUTH_TOKEN)
  "name"       → database name, schema, username, tenant name (e.g. <SVC>_DB_NAME, APP_USER, TENANT_ID)
  "path"       → file system path or directory (e.g. LOG_DIR, DATA_DIR, CONFIG_FILE)
  "other"      → anything else

Return ONLY valid JSON with this exact structure:
{
  "products": [{
    "name": "string",
    "version": "string (optional)",
    "supportedOS": [{"type": "string", "minVersion": "string (optional)"}],
    "services": [{
      "id": "kebab-case-slug",
      "name": "string",
      "role": "primary|dependency|optional",
      "deployOn": "vm|docker|k8s",
      "ports": [{"port": 0, "protocol": "tcp|udp", "description": "string", "isPublic": true}],
      "installSteps": [{"stepNumber": 1, "description": "string", "command": "string (optional)", "isPrerequisite": false, "expectedExitCode": 0, "timeoutSeconds": 60}],
      "healthCheck": {"type": "port|http|process|systemctl", "target": "string", "expectedStatus": "string (optional)", "timeoutSeconds": 30, "retryIntervalSeconds": 10},
      "configKeys": [{"key": "ENV_VAR_NAME", "description": "env var OTHER services need to connect TO this service", "valueType": "host|port|credential|name|path|other"}],
      "requiresConfigFrom": ["other-service-id"],
      "resourceRequirements": {"minCpuCores": 2, "minMemoryMb": 4096, "minDiskGb": 40}
    }]
  }],
  "deploymentModes": [{
    "name": "single-node|distributed|ha",
    "vmCount": 1,
    "description": "string",
    "serviceAssignments": {"vm-role-name": ["service-id-1", "service-id-2"]}
  }]
}`;

/**
 * Returns true if the extraction output looks like placeholder/hallucinated content
 * rather than real product information extracted from the document.
 */
function hasPlaceholderContent(products: ProductSpec[]): boolean {
  const PLACEHOLDER_PATTERNS = [
    /^example\b/i, /\bexample\s+product$/i, /^sample\b/i, /^my\s+product$/i,
    /^placeholder/i, /^dummy\b/i,
  ];
  const PLACEHOLDER_SERVICE_PATTERNS = [
    /^example[-\s]service$/i, /^sample[-\s]service$/i, /^my[-\s]service$/i,
    /^placeholder[-\s]service$/i,
  ];
  for (const product of products) {
    if (PLACEHOLDER_PATTERNS.some((re) => re.test(product.name))) return true;
    for (const svc of product.services) {
      if (PLACEHOLDER_SERVICE_PATTERNS.some((re) => re.test(svc.name))) return true;
      if (PLACEHOLDER_SERVICE_PATTERNS.some((re) => re.test(svc.id))) return true;
      // Commands referencing obvious placeholder env vars
      for (const step of svc.installSteps ?? []) {
        if (step.command && /\$EXAMPLE_REPO_URL|\$SERVICE_BINARY_URL|\$EXAMPLE_SERVICE_PORT/i.test(step.command)) {
          return true;
        }
      }
    }
  }
  return false;
}

async function singlePassExtract(documentId: string, warnings: string[]): Promise<DeploymentIntelligence> {
  const allText = readDocContent(documentId) ?? '';
  return singlePassExtractFromText(documentId, allText, warnings);
}

async function singlePassExtractFromText(documentId: string, allText: string, warnings: string[]): Promise<DeploymentIntelligence> {
  // ── Pass 0: intent clarification ────────────────────────────────────────────
  // Establish topology intent before extraction so the main pass is informed.
  let osHint = 'Linux';
  try {
    const intentRaw = await callLlmWithRetry(PASS0_SYSTEM, truncateToTokens(allText, 4000), 1000);
    const intent = JSON.parse(extractJson(intentRaw));
    const osList: Array<{ type: string; minVersion?: string }> = intent.supportedOS ?? [];
    if (osList.length > 0) {
      osHint = osList.map((o) => `${o.type}${o.minVersion ? ' ' + o.minVersion : ''}`).join('/');
    }
  } catch {
    // non-fatal — continue with default osHint
  }

  // Prepend the detected OS so the main extraction uses OS-appropriate commands.
  const truncated = `[Target OS: ${osHint}]\n\n` + truncateToTokens(allText, 14000);

  // Inline helper to attempt one parse+validate cycle and return the validated result,
  // throwing if the JSON is invalid, schema fails, or looks like placeholder content.
  const attemptParse = async (llmOutput: string): Promise<ReturnType<typeof DeploymentIntelligenceSchema.parse>> => {
    const json = extractJson(llmOutput);
    const parsed = JSON.parse(json);
    const validated = DeploymentIntelligenceSchema.parse(parsed);
    if (hasPlaceholderContent(validated.products)) {
      throw new Error('Placeholder/hallucinated content detected in extraction output');
    }
    return validated;
  };

  let raw = await callLlmWithRetry(SINGLE_PASS_SYSTEM, truncated, 14000);
  let validated: ReturnType<typeof DeploymentIntelligenceSchema.parse> | null = null;
  let parseErr: unknown = null;

  try {
    validated = await attemptParse(raw);
  } catch (firstErr) {
    parseErr = firstErr;
    const isPlaceholder = firstErr instanceof Error &&
      firstErr.message.includes('Placeholder');
    if (isPlaceholder) {
      warnings.push('First extraction produced placeholder content — retrying with stricter prompt.');
      console.warn('[DeploymentExtractor] Placeholder content detected, retrying extraction');
      // Retry with an explicitly reinforced instruction prepended to the user content
      const retryContent =
        `⚠ CRITICAL: Your previous response contained placeholder/example content.\n` +
        `The document below is about a REAL product. Extract ONLY real names, real ports,\n` +
        `real commands, and real services from the document. Do NOT output "Example Product",\n` +
        `"example-service", port 8080 (unless the doc says 8080), or any invented placeholder.\n\n` +
        truncated;
      try {
        raw = await callLlmWithRetry(SINGLE_PASS_SYSTEM, retryContent, 14000);
        validated = await attemptParse(raw);
        parseErr = null;
      } catch (retryErr) {
        parseErr = retryErr;
      }
    }
  }

  if (validated) {
    // Sanitize all install-step commands so they run non-interactively as root
    for (const product of validated.products) {
      for (const service of product.services) {
        for (const step of service.installSteps) {
          if (step.command) step.command = sanitizeInstallStepCommand(step.command);
        }
      }
    }

    // ── Pass A: architect review — fill in missing obvious steps ──────────
    const allServices = validated.products.flatMap((p) => p.services);
    await enrichServicesWithArchitectReview(allServices, osHint, warnings, allText);

    return {
      documentId,
      ...validated,
      extractedAt: Date.now(),
      extractionStrategy: 'single-pass',
      extractionWarnings: warnings,
    };
  }

  // Both attempts failed — use partial parse as last resort, but refuse placeholder partial results
  warnings.push(`Single-pass extraction failed: ${parseErr}. Using partial data.`);
  const fallback = tryPartialParse(raw);
  const fallbackProducts = (fallback.products ?? []).filter(
    (p) => !hasPlaceholderContent([p])
  );
  return {
    documentId,
    products: fallbackProducts,
    deploymentModes: fallback.deploymentModes ?? [],
    extractedAt: Date.now(),
    extractionStrategy: 'single-pass',
    extractionWarnings: warnings,
  };
}

function tryPartialParse(raw: string): Partial<{ products: ProductSpec[]; deploymentModes: DeploymentMode[] }> {
  try {
    const json = extractJson(raw);
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// ── Chunked 3-pass extraction ─────────────────────────────────────────────────

const PASS1_SYSTEM = `You are a software deployment analyst. Your task is Pass 1 of 3: topology discovery only.
Extract ONLY top-level structure from the documentation.

Return ONLY valid JSON:
{
  "products": [{
    "name": "string",
    "version": "string (optional)",
    "supportedOS": [{"type": "string", "minVersion": "string (optional)"}],
    "services": [{"id": "kebab-case-slug", "name": "string", "role": "primary|dependency|optional", "deployOn": "vm|docker|k8s"}]
  }],
  "deploymentModes": [{
    "name": "string",
    "vmCount": 1,
    "description": "string",
    "serviceAssignments": {"vm-role": ["service-id"]}
  }]
}`;

const PASS2_SYSTEM_TEMPLATE = (serviceName: string) =>
  `You are a software deployment analyst. This is Pass 2 of 3: per-service detail extraction for "${serviceName}".

Extract details for this specific service from the documentation excerpts provided.

installSteps command rules — every generated command MUST follow these:
  - NEVER use interactive editors: vi, vim, nano, emacs, less, pause, dialog
  - NEVER require user interaction at runtime: no read -p, select, whiptail/dialog, passwd prompts,
    yes/no confirmations, or commands waiting for stdin.
  - If a value is required, set it non-interactively in-script via env defaults (example:
    : "\${COMMON_PASSWORD:=novell}") and then reference that variable.
  - Do NOT emit unresolved placeholders that require user action.
  - NEVER prefix commands with sudo (the script runs as root)
  - Package installs: always include -y / --yes / --noconfirm; prefix apt/apt-get with DEBIAN_FRONTEND=noninteractive
  - OS matters: SLES/RHEL/CentOS → zypper --non-interactive / yum -y / dnf -y; Ubuntu/Debian → apt-get -y
    Only generate package-manager or system commands that exist on the documented target OS.
    On SLES/SUSE: use zypper; AppArmor is the security module (NOT SELinux/semanage).
    On RHEL/CentOS: use yum/dnf; SELinux tools (semanage, setsebool) are appropriate.
  - Config file writes: use tee, sed -i, or cat with a heredoc — never an editor
  - Downloads: curl -fsSL -o <dest> or wget -q -O <dest>
  - Service management: systemctl enable --now <unit>
  - Each command field is a single executable shell line (use ; for sequencing if needed)
  - isPrerequisite: true for package/repo setup; false for service-specific configuration
  - Set osType on each step when the document specifies an OS (e.g. "sles", "rhel", "ubuntu")
  - IDEMPOTENCY — every command must be safe to re-run without failing:
      • User creation:    getent passwd <user> >/dev/null || useradd ...
      • Group creation:   getent group <grp> >/dev/null || groupadd ...
      • File append:      grep -qF '<line>' <file> || echo '<line>' >> <file>
      • Service enable:   systemctl is-active --quiet <svc> || systemctl enable --now <svc>
      • File download:    [ -f <dest> ] || wget/curl ...
      • ISO mount:        mountpoint -q <dir> 2>/dev/null || mount -o loop <iso> <dir>
      • One-shot install: use a marker file → [ -f /var/opt/.<product>_installed ] || (./install.sh ... && touch /var/opt/.<product>_installed)
  - NEVER hardcode IP addresses or hostnames in commands. Reference env vars like $SERVICE_HOST,
    $NODE_IP, $ID_VAULT_HOST that will be injected at runtime. If a file (like a silent properties
    file) needs an IP, write the command so it reads from an env var: echo "KEY=\${SERVICE_HOST}"

Installer binary / response file rules — CRITICAL:
  - If the document references a binary installer (.bin, .jar, .sh script, .rpm, .deb), generate the
    EXACT invocation command from the document — e.g. ./IDM_Install.bin -i silent -f /opt/silent.properties
    Wrap with the one-shot marker: [ -f /var/opt/.<product>_installed ] || (./installer ... && touch ...)
  - If the document shows a silent.properties / response.varfile / install.properties file, generate
    a tee heredoc step that CREATES that file before the installer runs. The command field must be
    a multi-line string encoded with \\n in JSON:
      "command": "tee /opt/silent.properties << 'EOF'\\nKEY=value\\nHOST=\${SERVICE_HOST}\\nEOF"
    Copy the COMPLETE key-value block from the document. Replace every IP/hostname with
    \${<VAR>} references; replace every hardcoded password with \${<KEY>_PWD} or \${COMMON_PASSWORD}.
  - Mount an ISO before running its installer:
      mountpoint -q /mnt/iso 2>/dev/null || mount -o loop /path/to/product.iso /mnt/iso

configKeys vs requiresConfigFrom — CRITICAL distinction:
  configKeys    = env vars that OTHER services need to connect TO THIS service.
                  e.g. A backend service exposes its own <SVC>_HOST and <SVC>_PORT here so
                  consumers know how to reach it. Do NOT place connection vars for services
                  this component depends on — those belong in the dependency's configKeys.
  requiresConfigFrom = IDs of services this service DEPENDS ON (needs at startup).

configKeys valueType classification:
  "host"       → IP address, hostname, URL, connection string (e.g. <SVC>_HOST, <SVC>_URL, <SVC>_ENDPOINT)
  "port"       → port number (e.g. <SVC>_PORT, HTTP_PORT, LISTEN_PORT)
  "credential" → password, secret, API key, token, certificate (e.g. <SVC>_PASSWORD, API_SECRET, AUTH_TOKEN)
  "name"       → database name, schema, username, tenant name (e.g. <SVC>_DB_NAME, APP_USER, TENANT_ID)
  "path"       → file system path or directory (e.g. LOG_DIR, DATA_DIR, CONFIG_FILE)
  "other"      → anything else

Return ONLY valid JSON:
{
  "id": "same-id-from-pass1",
  "ports": [{"port": 0, "protocol": "tcp|udp", "description": "string", "isPublic": true}],
  "installSteps": [{"stepNumber": 1, "description": "string", "command": "shell command", "isPrerequisite": false, "expectedExitCode": 0, "timeoutSeconds": 60, "osType": "string (optional — only when OS-specific)"}],
  "healthCheck": {"type": "port|http|process|systemctl", "target": "string", "expectedStatus": "string (optional)", "timeoutSeconds": 30, "retryIntervalSeconds": 10},
  "configKeys": [{"key": "ENV_VAR_NAME", "description": "env var OTHER services use to connect TO this service", "valueType": "host|port|credential|name|path|other"}],
  "requiresConfigFrom": ["service-ids-this-service-needs-at-startup"],
  "resourceRequirements": {"minCpuCores": 2, "minMemoryMb": 4096, "minDiskGb": 40}
}`;

const PASS3_SYSTEM = `You are a software deployment analyst. This is Pass 3 of 3: dependency cross-check.

Review the service list below. Verify that requiresConfigFrom relationships are complete and symmetric.
If service A lists service B in requiresConfigFrom, then service B must have a relevant configKey.
Return the COMPLETE corrected services array — include EVERY service even if unchanged.
Add missing requiresConfigFrom entries. Ensure every configKey has the correct valueType.

configKeys vs requiresConfigFrom — CRITICAL distinction:
  configKeys    = env vars OTHER services need to connect TO THIS service
                  (e.g. a backend service exposes <SVC>_HOST and <SVC>_PORT for its consumers).
                  Do NOT put dependency connection vars in the consuming service's configKeys.
  requiresConfigFrom = IDs of services this service connects TO at startup.

configKeys valueType classification:
  "host"       → IP address, hostname, URL, connection string (e.g. DB_HOST, REDIS_URL, API_ENDPOINT)
  "port"       → port number (e.g. DB_PORT, HTTP_PORT)
  "credential" → password, secret, API key, token, certificate (e.g. DB_PASSWORD, API_SECRET)
  "name"       → database name, schema, username, tenant name (e.g. DB_NAME, DB_USER, TENANT_ID)
  "path"       → file system path or directory (e.g. LOG_DIR, CONFIG_FILE)
  "other"      → anything else

Return ONLY valid JSON — include ALL services (unchanged ones too):
{"services": [{"id": "string", "requiresConfigFrom": ["..."], "configKeys": [{"key":"string","description":"string","valueType":"host|port|credential|name|path|other"}]}]}`;
/**
 * Pass 4 — targeted gap-fill for services with missing or sparse install steps.
 * Sends the most relevant document sections to the LLM with a prompt focused
 * exclusively on extracting shell installation commands for that service.
 */
const PASS4_SYSTEM_TEMPLATE = (serviceName: string) =>
  `You are a DevOps engineer performing a focused gap-fill pass. Extract EVERY installation and configuration step for "${serviceName}" that appears in the documentation.

This service had too few install steps in previous passes — your job is to find ALL commands and config file writes the document describes, especially:
  • ISO mount commands before running an installer
  • Binary installer invocations (.bin, .sh, .jar) with silent/response file flags
  • silent.properties / response.varfile / install.properties file creation
  • Package/repo setup steps that are prerequisites
  • Systemd service enablement
  • Configuration file writes (tee, heredoc, sed -i)

installSteps command rules — every generated command MUST follow these:
  - NEVER use interactive editors: vi, vim, nano, emacs, less, pause, dialog
  - NEVER require user interaction at runtime: no read -p, select, whiptail/dialog, passwd prompts,
    yes/no confirmations, or commands waiting for stdin.
  - If a value is required, set it non-interactively in-script via env defaults (example:
    : "\${COMMON_PASSWORD:=novell}") and then reference that variable.
  - Do NOT emit unresolved placeholders that require user action.
  - NEVER prefix commands with sudo (the script runs as root)
  - Package installs: always include -y / --yes / --noconfirm; prefix apt/apt-get with DEBIAN_FRONTEND=noninteractive
  - OS matters: SLES/RHEL/CentOS → zypper --non-interactive / yum -y / dnf -y; Ubuntu/Debian → apt-get -y
    On SLES/SUSE: use zypper; AppArmor is the security module (NOT SELinux/semanage).
  - Config file writes: use tee, sed -i, or cat with a heredoc — never an editor
  - Downloads: curl -fsSL -o <dest> or wget -q -O <dest>
  - Service management: systemctl enable --now <unit>
  - Each command field is a single executable shell line (use ; for sequencing if needed)
  - Set osType on each step when the document specifies an OS (e.g. "sles", "rhel", "ubuntu")
  - isPrerequisite: true for package/repo setup; false for service-specific configuration
  - IDEMPOTENCY — every command must be safe to re-run:
      • User creation:    getent passwd <user> >/dev/null || useradd ...
      • Group creation:   getent group <grp> >/dev/null || groupadd ...
      • File append:      grep -qF '<line>' <file> || echo '<line>' >> <file>
      • Service enable:   systemctl is-active --quiet <svc> || systemctl enable --now <svc>
      • File download:    [ -f <dest> ] || wget/curl ...
      • ISO mount:        mountpoint -q <dir> 2>/dev/null || mount -o loop <iso> <dir>
      • One-shot install: [ -f /var/opt/.<product>_installed ] || (./installer ... && touch /var/opt/.<product>_installed)
  - NEVER hardcode IP addresses, hostnames, or passwords. Use env vars: $SERVICE_HOST, $NODE_IP,
    $SERVICE_PASSWORD. For config file writes, interpolate env vars in the heredoc body.

Installer binary / response file rules — CRITICAL:
  - Binary installers: generate the EXACT invocation shown in the document, e.g.
      ./IDM_Install.bin -i silent -f /opt/silent.properties
    Always wrap with the one-shot marker pattern.
  - If a silent.properties or response.varfile is needed, generate its creation BEFORE the installer
    step. The command field is a multi-line string encoded with \\n in JSON:
      "command": "tee /opt/silent.properties << 'EOF'\\nINSTALL_DIR=/opt/myproduct\\nDB_HOST=\${DB_HOST}\\nEOF"
    Copy the COMPLETE key-value block from the document. Replace EVERY IP/hostname with
    \${<VAR>} references; replace every hardcoded password with \${<KEY>_PWD} or \${COMMON_PASSWORD}.

Include ALL steps: prerequisite packages → config file writes → installer invocation → service start.
Return ONLY a valid JSON array (NOT a wrapper object):
[
  {"stepNumber": 1, "description": "string", "command": "shell command", "isPrerequisite": true, "expectedExitCode": 0, "timeoutSeconds": 120, "osType": "optional"},
  {"stepNumber": 2, "description": "string", "command": "shell command", "isPrerequisite": false, "expectedExitCode": 0, "timeoutSeconds": 60}
]`;

// ── Pass 0 — Intent / topology clarification ──────────────────────────────────
// Runs before topology discovery. Establishes whether the install is truly
// single-node, how many VMs are involved, and the primary service.
const PASS0_SYSTEM = `You are a software deployment analyst. Perform intent and topology clarification for a product deployment.

Read the documentation and determine:
1. What is the simplest working single-node deployment — how many VMs/hosts are needed?
2. What deployment topology options are documented (single-node, distributed, HA)?
3. What is the primary service (the one end-users interact with)?
4. What OS is required or recommended?

Return ONLY valid JSON:
{
  "primaryServiceName": "string",
  "supportedOS": [{"type": "string", "minVersion": "string (optional)"}],
  "recommendedTopology": "single-node|distributed|ha",
  "topologyOptions": [
    {
      "name": "single-node",
      "vmCount": 1,
      "description": "All components on one VM — suitable for dev/test",
      "isSingleVm": true
    }
  ],
  "installationNotes": "Brief key installation requirements"
}`;

// ── Pass A — Architect review: identify missing obvious steps ──────────────────
// Inspired by the Python pipeline's architect_node. After per-service detail
// extraction, each service's steps are reviewed to catch prerequisites the
// documentation assumes the reader already knows.

const PASS_ARCHITECT_SYSTEM = `You are an Expert System Architect reviewing a deployment runbook for completeness.
Your sole job is to find steps that appear in the SOURCE DOCUMENT but were MISSED by the extraction pass.

⚠ STRICT RULES — read carefully before generating anything:
  1. ONLY add steps that are EXPLICITLY described or clearly implied by a command in the source document.
     Do NOT add steps from your general knowledge of how deployments typically work.
  2. Do NOT add generic OS-hardening, package installs, user/group creation, firewall rules, sysctl
     settings, time-sync, AppArmor, or any other step unless the SOURCE DOCUMENT TEXT BELOW contains
     a clear instruction or command for it.
  3. If the document does not mention a step, do NOT add it — even if it is commonly needed.
     A missing step is ONLY a problem when the document describes it and the extracted list omits it.
  4. If all document-described steps are already in the extracted list, return an EMPTY additionalSteps array.

Priority patterns to check for in the document (commonly missed by extraction):
  A. ISO MOUNT: Does the document ask the user to mount a disc or ISO image before running the installer?
     If so and the step is missing, add: mountpoint -q <dir> 2>/dev/null || mount -o loop <iso> <dir>
  B. BINARY INSTALLER: Does the document reference a .bin, .sh, or .jar installer?
     If so and the invocation is missing, add the exact command from the document:
       [ -f /var/opt/.<product>_installed ] || (./<installer>.bin -i silent -f /path/silent.properties && touch /var/opt/.<product>_installed)
  C. SILENT/RESPONSE FILE: Does the document show a silent.properties, response.varfile, or install config file?
     If so and the file-creation step is missing, add a tee/heredoc command that creates it with env vars.
  D. POST-INSTALL CONFIG: Does the document describe running a post-install configuration script or wizard?
     If so, add its invocation using the exact path/name from the document.

installSteps command rules (apply to any step you do add):
  - NEVER use interactive editors (vi, vim, nano, emacs)
  - NEVER require user interaction at runtime: no read -p, select, whiptail/dialog, passwd prompts,
    yes/no confirmations, or commands waiting for stdin.
  - Prefer non-interactive defaults for required vars instead of prompting users.
  - NEVER prefix with sudo (script runs as root)
  - Package installs: always -y / --noconfirm; prefix apt/apt-get with DEBIAN_FRONTEND=noninteractive
  - Only generate commands valid for the detected OS (SLES: zypper+AppArmor; RHEL: yum/dnf+SELinux)
  - isPrerequisite: true for OS/package/repo setup; false for service-specific steps
  - IDEMPOTENCY — every command must be safe to re-run:
      • User creation:    getent passwd <user> >/dev/null || useradd ...
      • Group creation:   getent group <grp> >/dev/null || groupadd ...
      • File append:      grep -qF '<line>' <file> || echo '<line>' >> <file>
      • Service enable:   systemctl is-active --quiet <svc> || systemctl enable --now <svc>
      • File download:    [ -f <dest> ] || wget/curl ...
      • ISO mount:        mountpoint -q <dir> 2>/dev/null || mount -o loop <iso> <dir>
      • One-shot install: [ -f /var/opt/.<product>_installed ] || (./installer ... && touch ...)
  - NEVER hardcode IP addresses. Reference env vars like $SERVICE_HOST, $NODE_IP.

Return ONLY valid JSON (empty additionalSteps array if nothing is missing from the document):
{
  "additionalSteps": [
    {"stepNumber": 1, "description": "string", "command": "shell command", "isPrerequisite": true, "expectedExitCode": 0, "timeoutSeconds": 120}
  ]
}`;

function buildArchitectPrompt(serviceName: string, osHint: string, stepsJson: string, docExcerpt: string): string {
  return `Review the extracted installation steps for "${serviceName}" on ${osHint || 'Linux'}.

SOURCE DOCUMENT (relevant sections):
---
${docExcerpt}
---

ALREADY EXTRACTED STEPS:
${stepsJson}

Using ONLY the source document above, identify steps that are explicitly described in the document but were NOT captured in the extracted list. Do NOT add anything that is not clearly stated in the document.`;
}

/**
 * Architect review pass — runs after per-service detail extraction.
 * For each service, asks the LLM what obvious steps are missing and prepends
 * any new prerequisites / appends new main steps.
 *
 * Modifies services in-place.
 */
async function enrichServicesWithArchitectReview(
  services: ServiceSpec[],
  osHint: string,
  warnings: string[],
  sourceText?: string
): Promise<void> {
  await Promise.all(
    services.map(async (svc) => {
      if (svc.installSteps.length === 0) return; // nothing to review yet

      const stepsJson = JSON.stringify(svc.installSteps.slice(0, 20), null, 2);
      // Ground the review in the actual document — use the most relevant excerpt for this service.
      const docExcerpt = sourceText
        ? extractServiceRelevantContent(sourceText, svc.name, 3000)
        : '(source document not available)';
      const userContent = buildArchitectPrompt(svc.name, osHint, stepsJson, docExcerpt);

      try {
        const raw = await callLlmWithRetry(PASS_ARCHITECT_SYSTEM, userContent, 2000);
        const parsed = JSON.parse(extractJson(raw));
        const additionalSteps: any[] = parsed.additionalSteps ?? [];

        if (additionalSteps.length === 0) return;

        const newPrereqs = additionalSteps
          .filter((s: any) => s.isPrerequisite)
          .map((s: any) => ({
            ...s,
            command: s.command ? sanitizeInstallStepCommand(s.command) : undefined,
          }));

        const newMainSteps = additionalSteps
          .filter((s: any) => !s.isPrerequisite)
          .map((s: any) => ({
            ...s,
            command: s.command ? sanitizeInstallStepCommand(s.command) : undefined,
          }));

        // New prerequisites go before existing steps; new main steps go after.
        const combined = [...newPrereqs, ...svc.installSteps, ...newMainSteps];
        svc.installSteps = combined.map((step, i) => ({ ...step, stepNumber: i + 1 }));

        warnings.push(`Architect review: enriched '${svc.id}' with ${additionalSteps.length} additional step(s).`);
      } catch (err) {
        warnings.push(`Architect review failed for '${svc.id}': ${err}`);
      }
    })
  );
}
async function chunkedExtract(documentId: string, warnings: string[]): Promise<DeploymentIntelligence> {
  const allText = readDocContent(documentId) ?? '';

  // ── Pass 0: intent clarification ────────────────────────────────────────────
  let osHint = 'Linux';
  try {
    const intentRaw = await callLlmWithRetry(PASS0_SYSTEM, truncateToTokens(allText, 4000), 1000);
    const intent = JSON.parse(extractJson(intentRaw));
    const osList: Array<{ type: string; minVersion?: string }> = intent.supportedOS ?? [];
    if (osList.length > 0) {
      osHint = osList.map((o) => `${o.type}${o.minVersion ? ' ' + o.minVersion : ''}`).join('/');
    }
  } catch {
    // non-fatal — continue with default osHint
  }

  // ── Pass 1: topology ──────────────────────────────────────────────────────
  const truncated = truncateToTokens(allText, 12000);

  let pass1Products: Array<{ name: string; version?: string; supportedOS: OSRequirement[]; services: Array<{ id: string; name: string; role: string; deployOn: string }> }> = [];
  let deploymentModes: DeploymentMode[] = [];

  try {
    const raw1 = await callLlmWithRetry(PASS1_SYSTEM, truncated, 4000);
    const p1 = JSON.parse(extractJson(raw1));
    pass1Products = p1.products ?? [];
    deploymentModes = p1.deploymentModes ?? [];
  } catch (err) {
    warnings.push(`Pass 1 failed: ${err}. Falling back to single-pass.`);
    return singlePassExtract(documentId, warnings);
  }

  // ── Pass 2: per-service detail (parallel) ─────────────────────────────────
  const allServiceStubs = pass1Products.flatMap((p) => p.services);

  const serviceDetails = await Promise.all(
    allServiceStubs.map(async (stub) => {
      // Build a focused context window for this specific service:
      // relevant sections scored by keyword match + preamble for global context.
      // This ensures services documented later in large docs still get their
      // install steps extracted, instead of being silently cut off by a
      // uniform front-truncation.
      const context = extractServiceRelevantContent(allText, stub.name, 10000);

      try {
        // Prepend the OS hint so Pass 2 generates OS-appropriate commands.
        const contextWithOs = `[Target OS: ${osHint}]\n\n` + context;
        const raw2 = await callLlmWithRetry(PASS2_SYSTEM_TEMPLATE(stub.name), contextWithOs, 4500);
        const detail = JSON.parse(extractJson(raw2));
        return { id: stub.id, ...detail };
      } catch (err) {
        warnings.push(`Pass 2 failed for service '${stub.id}': ${err}`);
        return {
          id: stub.id,
          ports: [],
          installSteps: [],
          healthCheck: { type: 'port', target: '80', timeoutSeconds: 30, retryIntervalSeconds: 10 },
          configKeys: [],
          requiresConfigFrom: [],
        };
      }
    })
  );

  // Merge stub + detail
  const detailMap = new Map(serviceDetails.map((d) => [d.id, d]));

  // ── Pass A: architect review — fill in missing obvious steps ──────────────
  // For each service, review the extracted steps and add any missing
  // prerequisites or setup commands the documentation assumed were known.
  {
    const builtServices: ServiceSpec[] = allServiceStubs.map((stub) => {
      const detail = detailMap.get(stub.id) ?? {};
      return {
        id: stub.id,
        name: stub.name,
        role: (stub.role as ServiceSpec['role']) || 'primary',
        deployOn: (stub.deployOn as ServiceSpec['deployOn']) || 'vm',
        ports: detail.ports ?? [],
        installSteps: (detail.installSteps ?? []).map((step: any) => ({
          ...step,
          command: step.command ? sanitizeInstallStepCommand(step.command) : step.command,
        })),
        healthCheck: detail.healthCheck ?? { type: 'port', target: '80', timeoutSeconds: 30, retryIntervalSeconds: 10 },
        configKeys: detail.configKeys ?? [],
        requiresConfigFrom: detail.requiresConfigFrom ?? [],
        resourceRequirements: detail.resourceRequirements,
      } as ServiceSpec;
    });

    await enrichServicesWithArchitectReview(builtServices, osHint, warnings, allText);

    // Write enriched steps back into detailMap
    for (const svc of builtServices) {
      const existing = detailMap.get(svc.id);
      if (existing) {
        existing.installSteps = svc.installSteps;
        detailMap.set(svc.id, existing);
      }
    }
  }

  // ── Pass 3: cross-check dependencies ─────────────────────────────────────
  const servicesCompact = JSON.stringify(
    serviceDetails.map((d) => ({
      id: d.id,
      requiresConfigFrom: d.requiresConfigFrom ?? [],
      configKeys: d.configKeys ?? [],
    }))
  );
  const pass3Input = truncateToTokens(servicesCompact, 3000);

  try {
    const raw3 = await callLlmWithRetry(PASS3_SYSTEM, pass3Input, 2000);
    const p3 = JSON.parse(extractJson(raw3));
    const correctedServices: Array<{ id: string; requiresConfigFrom?: string[]; configKeys?: ConfigKey[] }> = p3.services ?? [];
    for (const correction of correctedServices) {
      const existing = detailMap.get(correction.id);
      if (existing) {
        if (correction.requiresConfigFrom) existing.requiresConfigFrom = correction.requiresConfigFrom;
        if (correction.configKeys) existing.configKeys = correction.configKeys;
        detailMap.set(correction.id, existing);
      }
    }
  } catch (err) {
    warnings.push(`Pass 3 cross-check failed: ${err}. Proceeding with Pass 2 results.`);
  }

  // ── Pass 4: gap-fill for services with missing / sparse install steps ────────
  // Any service with fewer than 4 install steps after the architect review gets
  // a dedicated focused extraction — the threshold is intentionally conservative
  // because 2-3 steps almost always means the extractor missed the bulk of the
  // installer invocation or config-file-write section.
  const incompleteServices = serviceDetails.filter(
    (d) => ((d as any).installSteps ?? []).length < 4
  );
  if (incompleteServices.length > 0) {
    await Promise.all(
      incompleteServices.map(async (svc) => {
        const stub = allServiceStubs.find((s) => s.id === (svc as any).id);
        if (!stub) return;
        const context = extractServiceRelevantContent(allText, stub.name, 12000);
        try {
          const raw4 = await callLlmWithRetry(PASS4_SYSTEM_TEMPLATE(stub.name), context, 4000);
          const parsed = JSON.parse(extractJson(raw4));
          // Prompt asks for a raw array; handle both array and {steps:[]} shapes gracefully
          const steps: any[] = Array.isArray(parsed) ? parsed : (parsed.steps ?? []);
          if (steps.length > ((svc as any).installSteps ?? []).length) {
            (svc as any).installSteps = steps.map((step: any) => ({
              ...step,
              command: step.command ? sanitizeInstallStepCommand(step.command) : step.command,
            }));
            detailMap.set((svc as any).id, svc);
            warnings.push(`Pass 4 gap-fill: enriched '${(svc as any).id}' with ${steps.length} install steps.`);
          }
        } catch (err) {
          warnings.push(`Pass 4 gap-fill failed for '${(svc as any).id}': ${err}`);
        }
      })
    );
  }

  // ── Assemble final structure ───────────────────────────────────────────────
  const products: ProductSpec[] = pass1Products.map((p) => {
    const services: ServiceSpec[] = p.services.map((stub) => {
      const detail = detailMap.get(stub.id) ?? {};
      const svc: ServiceSpec = {
        id: stub.id,
        name: stub.name,
        role: (stub.role as ServiceSpec['role']) || 'primary',
        deployOn: (stub.deployOn as ServiceSpec['deployOn']) || 'vm',
        ports: detail.ports ?? [],
        installSteps: (detail.installSteps ?? []).map((step: any) => ({
          ...step,
          command: step.command ? sanitizeInstallStepCommand(step.command) : step.command,
        })),
        healthCheck: detail.healthCheck ?? { type: 'port', target: '80', timeoutSeconds: 30, retryIntervalSeconds: 10 },
        configKeys: detail.configKeys ?? [],
        requiresConfigFrom: detail.requiresConfigFrom ?? [],
        resourceRequirements: detail.resourceRequirements,
      };
      return svc;
    });
    return {
      name: p.name,
      version: p.version,
      supportedOS: p.supportedOS ?? [],
      services,
    };
  });

  return {
    documentId,
    products,
    deploymentModes,
    extractedAt: Date.now(),
    extractionStrategy: 'chunked',
    extractionWarnings: warnings,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract deployment intelligence from a stored document.
 *
 * @param documentId  ID of a document already in the docs store
 * @param options     Strategy override ('auto' | 'single-pass' | 'chunked'). Default: 'auto'
 * @param rawContent  Optional: the full document text already in memory (e.g. from chat attachment).
 *                    When provided, DB chunk reads are skipped entirely — this improves accuracy
 *                    since the whole document is used instead of a subset of chunks.
 * @param chatContext Optional: relevant information the user provided in the current conversation
 *                    (e.g. component lists, silent.properties variables, configuration preferences).
 *                    Prepended to the document text so the extractor honours chat-supplied specs.
 */
export async function extractFromDocument(
  documentId: string,
  options?: ExtractionOptions,
  rawContent?: string,
  chatContext?: string
): Promise<DeploymentIntelligence> {
  const warnings: string[] = [];

  // Build a chat-context preamble if the caller supplied conversation details.
  // This ensures user-provided specs (e.g. silent.properties, component list) take
  // priority over whatever the raw document alone would produce.
  const contextPreamble = chatContext && chatContext.trim().length > 0
    ? `=== USER-PROVIDED CONTEXT FROM CONVERSATION ===\n${chatContext.trim()}\n\n` +
      `⚠ The above context was provided by the user in the current conversation.\n` +
      `It MUST be honoured over conflicting defaults in the document below.\n` +
      `=== END USER-PROVIDED CONTEXT ===\n\n`
    : '';

  // If caller already has the full content (e.g. attached doc), use it directly.
  if (rawContent && rawContent.trim().length > 0) {
    const combined = contextPreamble + rawContent;
    console.log(`[DeploymentExtractor] documentId=${documentId} using provided rawContent (${rawContent.length} chars)${chatContext ? ' + chatContext' : ''} — skipping DB reads`);
    return singlePassExtractFromText(documentId, combined, warnings);
  }

  const fileContent = readDocContent(documentId);

  if (!fileContent) {
    throw new Error(`No processed file found for document '${documentId}'. Has it been processed?`);
  }

  const strategy = options?.strategy ?? 'single-pass';
  const resolved = strategy === 'auto' ? 'single-pass' : strategy;

  console.log(`[DeploymentExtractor] documentId=${documentId} content=${fileContent.length} chars strategy=${resolved}${chatContext ? ' + chatContext' : ''}`);
  if (resolved === 'single-pass') {
    // If we have a chat context preamble, prepend it directly to the file content
    if (contextPreamble) {
      return singlePassExtractFromText(documentId, contextPreamble + fileContent, warnings);
    }
    return singlePassExtract(documentId, warnings);
  } else {
    if (contextPreamble) {
      return singlePassExtractFromText(documentId, contextPreamble + fileContent, warnings);
    }
    return chunkedExtract(documentId, warnings);
  }
}
