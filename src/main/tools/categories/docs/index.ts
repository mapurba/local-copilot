/**
 * Document Tools
 * 
 * Tool registry entries for document upload, search, and Q&A.
 * Processing pipeline: parse → LLM clean → chunk → store
 */

import { toolRegistry } from '../../registry';
import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs/promises';
import { parseDocument, estimateTokenCount } from './parser';
import { analyzeDocument, cleanChunk, queryDocumentContext } from './pipeline';
import {
  insertDocument,
  updateDocumentStatus,
  getDocument,
  listDocuments,
  deleteDocument,
  insertChunks,
  getChunks,
  searchChunksByText,
  DocumentRecord,
  ChunkRecord,
} from './storage';

function generateId(): string {
  return `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function processDocument(docId: string, filePath: string, filename: string): Promise<void> {
  try {
    updateDocumentStatus(docId, 'processing');

    // 1. Parse document into raw text + sections
    console.log(`[DocPipeline] Parsing ${filename}...`);
    const parsed = await parseDocument(filePath);

    // 2. LLM analysis: clean, title, summary, tags
    console.log(`[DocPipeline] Analyzing ${filename} with LLM...`);
    const analysis = await analyzeDocument(parsed.text, filename);

    // 3. Create chunks from sections
    const chunks: ChunkRecord[] = [];
    const sections = parsed.sections.length > 0 ? parsed.sections : [{ content: parsed.text }];

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      // For large documents, clean each chunk with LLM
      let cleanedContent = section.content;
      if (sections.length > 3 && section.content.length > 500) {
        const result = await cleanChunk(section.content, analysis.title);
        cleanedContent = result.cleanedContent;
      }

      chunks.push({
        id: `${docId}-chunk-${i}`,
        documentId: docId,
        chunkIndex: i,
        content: section.content,
        cleanedContent,
        sectionTitle: section.title,
        pageNumber: section.pageNumber,
        tokenCount: estimateTokenCount(cleanedContent),
        createdAt: Date.now(),
      });
    }

    insertChunks(chunks);

    // 4. Update document as ready
    updateDocumentStatus(docId, 'ready', {
      title: analysis.title,
      summary: analysis.summary,
      tags: analysis.tags,
      processedAt: Date.now(),
    });

    console.log(`[DocPipeline] ✓ Processed ${filename}: ${chunks.length} chunks`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[DocPipeline] ✗ Failed to process ${filename}:`, message);
    updateDocumentStatus(docId, 'error', { error: message });
  }
}

export function registerDocTools() {
  // ── docs:upload ───────────────────────────────────────────────────────────
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
        message: `Document "${filename}" is being processed. Use docs:status to check progress.`,
      };
    },
    {
      category: 'docs',
      description: 'Upload and process a document (PDF, DOCX, MD, TXT). Runs LLM analysis to clean and structure content.',
      target: 'local',
      riskLevel: 'review',
      schema: z.object({
        filePath: z.string().describe('Absolute path to the document file to upload'),
      }),
    }
  );

  // ── docs:status ───────────────────────────────────────────────────────────
  toolRegistry.register(
    'docs:status',
    async (args: { docId: string }) => {
      const doc = getDocument(args.docId);
      if (!doc) {
        return { found: false, error: `Document not found: ${args.docId}` };
      }
      const chunkCount = doc.status === 'ready' ? getChunks(doc.id).length : 0;
      return { found: true, ...doc, chunkCount };
    },
    {
      category: 'docs',
      description: 'Check the processing status of an uploaded document',
      target: 'local',
      riskLevel: 'safe',
      schema: z.object({
        docId: z.string().describe('Document ID returned from docs:upload'),
      }),
    }
  );

  // ── docs:list ─────────────────────────────────────────────────────────────
  toolRegistry.register(
    'docs:list',
    async (args: { limit?: number }) => {
      const docs = listDocuments(args.limit ?? 20);
      return {
        count: docs.length,
        documents: docs.map(d => ({
          id: d.id,
          filename: d.filename,
          title: d.title ?? d.filename,
          status: d.status,
          fileType: d.fileType,
          sizeBytes: d.sizeBytes,
          uploadedAt: d.uploadedAt,
          summary: d.summary,
          tags: d.tags,
        })),
      };
    },
    {
      category: 'docs',
      description: 'List all uploaded documents with their processing status',
      target: 'local',
      riskLevel: 'safe',
      schema: z.object({
        limit: z.number().optional().describe('Maximum number of documents to return (default 20)'),
      }),
    }
  );

  // ── docs:search ───────────────────────────────────────────────────────────
  toolRegistry.register(
    'docs:search',
    async (args: { query: string; limit?: number }) => {
      const results = searchChunksByText(args.query, args.limit ?? 10);
      return {
        query: args.query,
        count: results.length,
        results: results.map(r => ({
          documentId: r.documentId,
          documentFilename: r.documentFilename,
          chunkIndex: r.chunkIndex,
          sectionTitle: r.sectionTitle,
          pageNumber: r.pageNumber,
          snippet: (r.cleanedContent ?? r.content).slice(0, 500),
        })),
      };
    },
    {
      category: 'docs',
      description: 'Search across all processed documents for relevant content',
      target: 'local',
      riskLevel: 'safe',
      schema: z.object({
        query: z.string().describe('Search query text'),
        limit: z.number().optional().describe('Maximum results (default 10)'),
      }),
    }
  );

  // ── docs:ask ──────────────────────────────────────────────────────────────
  toolRegistry.register(
    'docs:ask',
    async (args: { question: string; docId?: string }) => {
      let chunks: Array<{ cleanedContent?: string; content: string }> = [];
      let documentTitle = 'All Documents';

      if (args.docId) {
        const doc = getDocument(args.docId);
        if (!doc) return { error: `Document not found: ${args.docId}` };
        if (doc.status !== 'ready') return { error: `Document is not ready yet (status: ${doc.status})` };
        chunks = getChunks(args.docId);
        documentTitle = doc.title ?? doc.filename;
      } else {
        // Search across all documents
        const searchResults = searchChunksByText(args.question, 8);
        chunks = searchResults;
        documentTitle = 'All Documents';
      }

      const contextChunks = chunks
        .slice(0, 8)
        .map(c => c.cleanedContent ?? c.content);

      const answer = await queryDocumentContext(args.question, contextChunks, documentTitle);
      return { question: args.question, document: documentTitle, answer };
    },
    {
      category: 'docs',
      description: 'Ask a question about a specific document or across all documents',
      target: 'local',
      riskLevel: 'safe',
      schema: z.object({
        question: z.string().describe('Question to ask about the document(s)'),
        docId: z.string().optional().describe('Specific document ID (omit to search all documents)'),
      }),
    }
  );

  // ── docs:getContent ───────────────────────────────────────────────────────
  toolRegistry.register(
    'docs:getContent',
    async (args: { docId: string; chunkIndex?: number }) => {
      const doc = getDocument(args.docId);
      if (!doc) return { error: `Document not found: ${args.docId}` };

      const chunks = getChunks(args.docId);
      if (args.chunkIndex !== undefined) {
        const chunk = chunks[args.chunkIndex];
        if (!chunk) return { error: `Chunk ${args.chunkIndex} not found` };
        return {
          docId: args.docId,
          chunkIndex: args.chunkIndex,
          sectionTitle: chunk.sectionTitle,
          content: chunk.cleanedContent ?? chunk.content,
        };
      }

      return {
        docId: args.docId,
        title: doc.title ?? doc.filename,
        summary: doc.summary,
        chunkCount: chunks.length,
        fullContent: chunks.map(c => c.cleanedContent ?? c.content).join('\n\n'),
      };
    },
    {
      category: 'docs',
      description: 'Get the full cleaned content of a document or a specific chunk',
      target: 'local',
      riskLevel: 'safe',
      schema: z.object({
        docId: z.string().describe('Document ID'),
        chunkIndex: z.number().optional().describe('Specific chunk index (omit for full document)'),
      }),
    }
  );

  // ── docs:delete ───────────────────────────────────────────────────────────
  toolRegistry.register(
    'docs:delete',
    async (args: { docId: string }) => {
      const doc = getDocument(args.docId);
      if (!doc) return { success: false, error: `Document not found: ${args.docId}` };
      deleteDocument(args.docId);
      return { success: true, message: `Document "${doc.filename}" deleted` };
    },
    {
      category: 'docs',
      description: 'Delete an uploaded document and all its chunks',
      target: 'local',
      riskLevel: 'dangerous',
      schema: z.object({
        docId: z.string().describe('Document ID to delete'),
      }),
    }
  );

  console.log('[Doc Tools] Registered: upload, status, list, search, ask, getContent, delete = 7 tools');
}
