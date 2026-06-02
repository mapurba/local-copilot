/**
 * Documentation Refiner Pipeline
 *
 * TypeScript port of python_code/loaddocsfromurl/pipeline.py
 *
 * Runs a single LLM pass that:
 *  1. Silently identifies all gaps (missing prerequisites, ambiguous steps, etc.)
 *  2. Produces a complete, unambiguous, LLM-friendly rewrite of the documentation
 *
 * Mirrors the Python refiner_node system prompt exactly.
 */

import { callLlm } from './pipeline';
import {
  updateDocumentStatus,
  getDocument,
} from './storage';
import { readDocContent, saveDocContent } from './fileStore';

export type LogLevel = 'info' | 'warn' | 'error';

export interface RefineLog {
  message: string;
  level: LogLevel;
  /** true on the final entry regardless of success/failure */
  done: boolean;
}

const REFINER_SYSTEM =
  'You are an expert Technical Documentation Refiner.';

const REFINER_PROMPT = (chunk: string) => `You are an expert Technical Documentation Refiner. In a single pass, analyze and rewrite the following documentation to be complete, unambiguous, and fully LLM-friendly.

Documentation:
${chunk}

Instructions:
1. First silently identify all gaps: missing prerequisites, ambiguous steps, assumed knowledge, missing validation steps, incomplete config examples, unclear ordering, missing error handling.
2. Then produce the complete rewritten documentation that fixes every gap found.

Output requirements:
- Preserve all original content — expand and clarify, never remove.
- Add an explicit Prerequisites section (packages, users, env vars, permissions).
- Replace vague steps with precise, unambiguous instructions.
- Add a verification checkpoint after each major step.
- Complete all configuration examples — no placeholders.
- Make all implicit knowledge explicit.
- Use consistent markdown: H1/H2/H3 headings, fenced code blocks with language tags, numbered steps.

Output only the final refined documentation in clean markdown. Do not include your gap analysis or any meta-commentary. Do not truncate.`;

/**
 * Run the refiner pipeline on raw text.
 * Calls `onLog` with progress messages as the pipeline runs.
 * Returns the refined markdown string.
 */
export async function runRefinePipeline(
  rawContent: string,
  onLog: (log: RefineLog) => void
): Promise<string> {
  const inputLen = rawContent.length;
  onLog({ message: `[Pipeline] Starting refiner node (${inputLen} chars input)…`, level: 'info', done: false });

  let refined: string;
  try {
    onLog({ message: '[Pipeline] Calling LLM — this may take 30-90 s for long documents…', level: 'info', done: false });
    refined = await callLlm(REFINER_SYSTEM, REFINER_PROMPT(rawContent), 16000);
    onLog({ message: `[Pipeline] LLM returned ${refined.length} chars`, level: 'info', done: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onLog({ message: `[Pipeline] LLM call failed: ${msg}`, level: 'error', done: true });
    throw err;
  }

  onLog({ message: '[Pipeline] Refiner node complete', level: 'info', done: false });
  return refined.trim();
}

/**
 * Analyze a document that is already stored in the doc store.
 * Updates the doc status to 'processing' → 'analysed', replaces the content.
 */
export async function analyzeStoredDoc(
  docId: string,
  onLog: (log: RefineLog) => void
): Promise<void> {
  const doc = getDocument(docId);
  if (!doc) {
    throw new Error(`Document not found: ${docId}`);
  }

  const rawContent = readDocContent(docId);
  if (!rawContent) {
    throw new Error(`No content found for document: ${docId} (${doc.filename})`);
  }

  onLog({ message: `[Pipeline] Analyzing "${doc.title ?? doc.filename}" (${rawContent.length} chars)…`, level: 'info', done: false });

  updateDocumentStatus(docId, 'processing');

  try {
    const refined = await runRefinePipeline(rawContent, onLog);

    // Replace document content with refined version
    saveDocContent(docId, refined);

    // Update index: status → 'analysed', processedAt = now
    updateDocumentStatus(docId, 'ready', {
      processedAt: Date.now(),
    });

    onLog({ message: `[Pipeline] ✓ Document "${doc.title ?? doc.filename}" analysed and updated`, level: 'info', done: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateDocumentStatus(docId, 'error', { error: msg });
    onLog({ message: `[Pipeline] ✗ Analysis failed: ${msg}`, level: 'error', done: true });
    throw err;
  }
}
