# Deployment Extractor — How It Works

`src/main/deployment/deploymentExtractor.ts`

---

## Overview

The Deployment Extractor converts an uploaded product document (PDF, text, shell script, etc.) into a structured `DeploymentIntelligence` object — the data model that drives topology design, runbook generation, and VM placement.

It uses a multi-pass LLM strategy, validated by Zod schemas, with hallucination guards and idempotency enforcement built in.

---

## Output Shape — `DeploymentIntelligence`

```
DeploymentIntelligence
├── products[]
│   ├── name, version
│   ├── supportedOS[]          ← OS constraints (type + minVersion)
│   └── services[]
│       ├── id, name, role, deployOn
│       ├── ports[]            ← exposed network ports
│       ├── installSteps[]     ← ordered shell commands
│       ├── healthCheck        ← how to verify the service is running
│       ├── configKeys[]       ← env vars OTHER services need to reach THIS service
│       ├── requiresConfigFrom ← IDs of services this service depends on at startup
│       └── resourceRequirements
└── deploymentModes[]
    ├── name (single-node | distributed | ha)
    ├── vmCount
    └── serviceAssignments     ← vmRole → serviceId[]
```

---

## Entry Point — `extractFromDocument()`

```
extractFromDocument(documentId, options?, rawContent?, chatContext?)
```

| Parameter | Purpose |
|-----------|---------|
| `documentId` | Looks up the document in the file store |
| `rawContent` | If provided, skips the file store entirely (used for chat attachments) |
| `chatContext` | User-provided context from the conversation (silent.properties vars, component lists, OS choice). Prepended to the document so the LLM honours chat specs over document defaults |
| `options.strategy` | `single-pass` (default) \| `chunked` \| `auto` |

**Decision flow:**

```
rawContent provided?
  YES → singlePassExtractFromText(rawContent)
  NO  → read from file store
        strategy = single-pass → singlePassExtract()
        strategy = chunked     → chunkedExtract()
```

---

## Single-Pass Extraction (`singlePassExtractFromText`)

Used for most documents. One big LLM call extracts the full `DeploymentIntelligence` in one shot.

### Steps

```
Pass 0 — OS / intent clarification
  ↓  Determine target OS (SLES, RHEL, Ubuntu…) and topology intent
  ↓  Result feeds OS-appropriate command generation in the main pass

Main pass — SINGLE_PASS_SYSTEM prompt
  ↓  Full document text (up to ~56 000 chars) sent to LLM
  ↓  Returns complete DeploymentIntelligence JSON

Validation
  ↓  Zod schema parse
  ↓  hasPlaceholderContent() guard — detects "Example Product", "example-service", etc.
  ↓  If placeholder detected → retry with explicit warning prepended to prompt

Command sanitization
  ↓  sanitizeInstallStepCommand() applied to every extracted shell command

Pass A — Architect review
  ↓  For each service: send relevant document excerpt + extracted steps to LLM
  ↓  LLM may add steps present in document but missed by extraction
  ↓  Strict rule: ONLY steps explicitly in the document — no invented generic steps
```

---

## Chunked 3-Pass Extraction (`chunkedExtract`)

Used for large documents where a single context window is insufficient.

```
Pass 0 — OS / intent clarification     (same as single-pass)

Pass 1 — Topology discovery
  ↓  Extracts product names, service stubs, deployment modes
  ↓  Produces the skeleton: who the services are and how they're assigned to VMs

Pass 2 — Per-service detail (parallel)
  ↓  For each service stub, extractServiceRelevantContent() scores document sections
     by keyword relevance to that service — ensures services on page 20 get their
     own context rather than being cut off by front-truncation
  ↓  One LLM call per service: ports, installSteps, healthCheck, configKeys, requiresConfigFrom

Pass A — Architect review
  ↓  Same as single-pass: doc-grounded gap-fill only

Pass 3 — Dependency cross-check
  ↓  Verifies requiresConfigFrom relationships are symmetric
  ↓  If service A depends on B, B must expose matching configKeys

Pass 4 — Gap-fill (conditional)
  ↓  Any service with fewer than 2 install steps gets a dedicated focused extraction
  ↓  Uses the most relevant document sections for that service
```

---

## Key Subsystems

### `extractServiceRelevantContent(text, serviceName, maxTokens)`

Splits the document at markdown headings, scores each section by keyword frequency (service name tokens), boosts installation/setup sections, and assembles the most relevant sections up to the token budget. Always includes the document preamble for global context.

### `sanitizeInstallStepCommand(cmd)`

Cleans every LLM-emitted shell command to run non-interactively as root:
- Strips `sudo` prefix
- Adds `-y` / `--noconfirm` to package manager installs
- Prepends `DEBIAN_FRONTEND=noninteractive` for apt
- Flags interactive editors as `# MANUAL_EDIT_REQUIRED`

### `hasPlaceholderContent(products)`

Detects hallucinated placeholder output before it reaches the UI:
- Product names matching `Example Product`, `Sample Product`, etc.
- Service IDs/names matching `example-service`, `sample-service`, etc.
- Commands referencing `$EXAMPLE_REPO_URL`, `$SERVICE_BINARY_URL`

If detected, extraction retries with a stronger prompt before falling back to a partial parse.

### `callLlmWithRetry(systemPrompt, userContent, maxTokens)`

Wraps `callLlm()` with up to 2 retries. On retry, appends `"Respond ONLY with valid JSON"` to the system prompt to force parseable output.

---

## Prompt Discipline

### `SINGLE_PASS_SYSTEM`
- Absolute rule: every field must come from the document — no placeholders
- Specifies idempotency patterns for every command category
- Defines `configKeys` vs `requiresConfigFrom` precisely to avoid common mistakes

### `PASS_ARCHITECT_SYSTEM`
- Strictly document-grounded: add a step **only** if it appears in the source document
- Explicitly forbidden: generic OS package installs, time sync, AppArmor, sysctl, firewall rules, user creation — unless the document names them
- Empty `additionalSteps` array is the correct response when nothing was missed

### `configKeys` vs `requiresConfigFrom` — the critical distinction

| Field | Meaning | Example |
|-------|---------|---------|
| `configKeys` | Env vars **other services** need to reach **this** service | `VAULT_HOST`, `VAULT_PORT` on the Vault service |
| `requiresConfigFrom` | IDs of services **this** service depends on at startup | `["vault", "postgres"]` on the API service |

This distinction is reinforced in every pass prompt to prevent the common LLM mistake of duplicating connection vars across both fields.

---

## Fallback Behaviour

| Failure scenario | Recovery |
|-----------------|---------|
| LLM returns non-JSON | `callLlmWithRetry` retries with stricter prompt |
| Output has placeholder content | Retry with explicit warning; partial parse as last resort |
| Pass 1 fails (chunked) | Falls back to single-pass |
| Per-service Pass 2 fails | Service gets empty stubs; Pass 4 attempts gap-fill |
| Pass 3 cross-check fails | Proceeds with Pass 2 results, warning logged |
| No deployment modes extracted | `planVmTopology` synthesises a single-node fallback placing all services on one VM |
