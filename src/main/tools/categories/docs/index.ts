/**
 * Document Tools
 *
 * Tool registry entries for document upload, status, list, delete, getContent, readFile, and ask.
 * Processing pipeline: parse → LLM analyze → save full .md file (no chunking, no DB)
 */

import { toolRegistry } from '../../registry';
import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs/promises';
import { parseDocument } from './parser';
import { analyzeDocument } from './pipeline';
import {
  insertDocument,
  updateDocumentStatus,
} from './storage';
import { saveDocContent } from './fileStore';

function generateId(): string {
  return `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function processDocument(docId: string, filePath: string, filename: string): Promise<void> {
  try {
    updateDocumentStatus(docId, 'processing');

    // 1. Parse document into raw text
    console.log(`[DocPipeline] Parsing ${filename}...`);
    const parsed = await parseDocument(filePath);

    // 2. LLM analysis: clean, title, summary, tags, full markdown
    console.log(`[DocPipeline] Analyzing ${filename} with LLM...`);
    const analysis = await analyzeDocument(parsed.text, filename);

    // 3. Save full cleaned markdown to disk
    saveDocContent(docId, analysis.cleanedMarkdown);

    // 4. Mark document as ready
    updateDocumentStatus(docId, 'ready', {
      title: analysis.title,
      summary: analysis.summary,
      tags: analysis.tags,
      processedAt: Date.now(),
    });

    console.log(`[DocPipeline] ✓ Processed ${filename}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[DocPipeline] ✗ Failed to process ${filename}:`, message);
    updateDocumentStatus(docId, 'error', { error: message });
  }
}

export function registerDocTools() {
  // ── docs:upload ───────────────────────────────────────────────────────────
  // Called by the IPC handler (docs:openAndUpload) via toolRegistry.execute.
  // All other doc operations (list, get, delete, getContent) are handled
  // directly in ipcHandlers.ts without going through the tool registry.
  toolRegistry.register(
    'docs:upload',
    async (args: { filePath: string }) => {
      const filePath = args.filePath;
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat) {
        return { success: false, error: `File not found: ${filePath}` };
      }

      const filename = path.basename(filePath);
      const ext = path.extname(filename).toLowerCase();
      const supportedExts = ['.pdf', '.docx', '.doc', '.md', '.markdown', '.txt', '.text', '.log', '.json'];
      if (!supportedExts.includes(ext)) {
        return { success: false, error: `Unsupported file type: ${ext}. Supported: ${supportedExts.join(', ')}` };
      }

      const docId = generateId();
      insertDocument({
        id: docId,
        filename,
        originalPath: filePath,
        fileType: ext.replace('.', ''),
        sizeBytes: stat.size,
        uploadedAt: Date.now(),
        status: 'pending',
      });

      // Start async processing (non-blocking)
      processDocument(docId, filePath, filename).catch(err => {
        console.error(`[DocPipeline] Background processing error for ${docId}:`, err);
      });

      return {
        success: true,
        docId,
        filename,
        status: 'processing',
        message: `Document "${filename}" is being processed.`,
      };
    },
    {
      category: 'docs',
      description: 'Upload and process a document. Called internally by the UI upload handler.',
      target: 'local',
      riskLevel: 'review',
      schema: z.object({
        filePath: z.string().describe('Absolute path to the document file to upload'),
      }),
    }
  );

  console.log('[Doc Tools] Registered: upload (1 tool — others handled via IPC directly)');
}
