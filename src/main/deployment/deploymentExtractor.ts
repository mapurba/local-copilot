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

// ── Token helpers ─────────────────────────────────────────────────────────────

/**
 * Rough token estimate — ~4 chars per token.
 */
function roughTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n[... truncated ...]';
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
      "configKeys": [{"key": "ENV_VAR_NAME", "description": "string"}],
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

async function singlePassExtract(documentId: string, warnings: string[]): Promise<DeploymentIntelligence> {
  const allText = readDocContent(documentId) ?? '';
  return singlePassExtractFromText(documentId, allText, warnings);
}

async function singlePassExtractFromText(documentId: string, allText: string, warnings: string[]): Promise<DeploymentIntelligence> {
  const truncated = truncateToTokens(allText, 14000);

  const raw = await callLlmWithRetry(SINGLE_PASS_SYSTEM, truncated, 6000);
  try {
    const json = extractJson(raw);
    const parsed = JSON.parse(json);
    const validated = DeploymentIntelligenceSchema.parse(parsed);
    return {
      documentId,
      ...validated,
      extractedAt: Date.now(),
      extractionStrategy: 'single-pass',
      extractionWarnings: warnings,
    };
  } catch (err) {
    warnings.push(`Single-pass extraction Zod validation failed: ${err}. Using partial data.`);
    const fallback = tryPartialParse(raw);
    return {
      documentId,
      products: fallback.products ?? [],
      deploymentModes: fallback.deploymentModes ?? [],
      extractedAt: Date.now(),
      extractionStrategy: 'single-pass',
      extractionWarnings: warnings,
    };
  }
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

Return ONLY valid JSON:
{
  "id": "same-id-from-pass1",
  "ports": [{"port": 0, "protocol": "tcp|udp", "description": "string", "isPublic": true}],
  "installSteps": [{"stepNumber": 1, "description": "string", "command": "shell command", "isPrerequisite": false, "expectedExitCode": 0, "timeoutSeconds": 60}],
  "healthCheck": {"type": "port|http|process|systemctl", "target": "string", "expectedStatus": "string (optional)", "timeoutSeconds": 30, "retryIntervalSeconds": 10},
  "configKeys": [{"key": "ENV_VAR_NAME", "description": "what this exports to dependents"}],
  "requiresConfigFrom": ["service-ids-this-service-needs-at-startup"],
  "resourceRequirements": {"minCpuCores": 2, "minMemoryMb": 4096, "minDiskGb": 40}
}`;

const PASS3_SYSTEM = `You are a software deployment analyst. This is Pass 3 of 3: dependency cross-check.

Review the service list below. Verify that requiresConfigFrom relationships are complete and symmetric.
If service A lists service B in requiresConfigFrom, then service B must have a relevant configKey.
Return the corrected services array. Add missing requiresConfigFrom entries.

Return ONLY valid JSON array of service objects with ONLY these fields changed if needed:
{"services": [{"id": "string", "requiresConfigFrom": ["..."], "configKeys": [{"key":"string","description":"string"}]}]}`;

async function chunkedExtract(documentId: string, warnings: string[]): Promise<DeploymentIntelligence> {
  const allText = readDocContent(documentId) ?? '';

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
      // Use the full document text (already truncated) — no semantic search.
      // Semantic search was dropping relevant sections; the full text gives better results.
      const contextTruncated = truncateToTokens(allText, 8000);

      try {
        const raw2 = await callLlmWithRetry(PASS2_SYSTEM_TEMPLATE(stub.name), contextTruncated, 3000);
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
        installSteps: detail.installSteps ?? [],
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
 */
export async function extractFromDocument(
  documentId: string,
  options?: ExtractionOptions,
  rawContent?: string
): Promise<DeploymentIntelligence> {
  const warnings: string[] = [];

  // If caller already has the full content (e.g. attached doc), use it directly.
  if (rawContent && rawContent.trim().length > 0) {
    console.log(`[DeploymentExtractor] documentId=${documentId} using provided rawContent (${rawContent.length} chars) — skipping DB reads`);
    return singlePassExtractFromText(documentId, rawContent, warnings);
  }

  const fileContent = readDocContent(documentId);

  if (!fileContent) {
    throw new Error(`No processed file found for document '${documentId}'. Has it been processed?`);
  }

  const strategy = options?.strategy ?? 'single-pass';
  const resolved = strategy === 'auto' ? 'single-pass' : strategy;

  console.log(`[DeploymentExtractor] documentId=${documentId} content=${fileContent.length} chars strategy=${resolved}`);
  if (resolved === 'single-pass') {
    return singlePassExtract(documentId, warnings);
  } else {
    return chunkedExtract(documentId, warnings);
  }
}
