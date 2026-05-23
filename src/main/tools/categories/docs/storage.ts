/**
 * Document Storage — File-based
 *
 * Delegates to fileStore.ts for all I/O.
 * Documents are stored as:
 *   {userData}/docs/index.json    — metadata index
 *   {userData}/docs/{docId}.md    — cleaned markdown content per document
 *
 * The previous SQLite-backed implementation has been removed because
 * chunk-based retrieval caused the LLM to receive incomplete context
 * and hallucinate. The full document file is now used instead.
 */

import {
  saveDocMeta,
  getDocMeta,
  listDocMetas,
  deleteDocMeta as _deleteDocMeta,
  saveDocContent,
  readDocContent,
} from './fileStore';



// ── Document CRUD ─────────────────────────────────────────────────────────────

export interface DocumentRecord {
  id: string;
  filename: string;
  originalPath?: string;
  fileType: string;
  sizeBytes: number;
  uploadedAt: number;
  processedAt?: number;
  status: 'pending' | 'processing' | 'ready' | 'error';
  summary?: string;
  title?: string;
  tags: string[];
  error?: string;
}

export function insertDocument(doc: Omit<DocumentRecord, 'tags'> & { tags?: string[] }): void {
  saveDocMeta({
    id: doc.id,
    filename: doc.filename,
    originalPath: doc.originalPath,
    fileType: doc.fileType,
    sizeBytes: doc.sizeBytes,
    uploadedAt: doc.uploadedAt,
    status: doc.status,
    title: doc.title,
    summary: doc.summary,
    tags: doc.tags ?? [],
  });
}

export function updateDocumentStatus(
  id: string,
  status: DocumentRecord['status'],
  extras?: { summary?: string; title?: string; tags?: string[]; error?: string; processedAt?: number; cleanedMarkdown?: string }
): void {
  const existing = getDocMeta(id);
  if (!existing) return;
  saveDocMeta({
    ...existing,
    status,
    processedAt: extras?.processedAt ?? (status === 'ready' ? Date.now() : existing.processedAt),
    summary: extras?.summary ?? existing.summary,
    title: extras?.title ?? existing.title,
    tags: extras?.tags ?? existing.tags,
    error: extras?.error ?? existing.error,
  });
  if (extras?.cleanedMarkdown) {
    saveDocContent(id, extras.cleanedMarkdown);
  }
}

export function getDocument(id: string): DocumentRecord | null {
  return getDocMeta(id) ?? null;
}

export function listDocuments(limit = 50): DocumentRecord[] {
  return listDocMetas(limit);
}

export function deleteDocument(id: string): void {
  _deleteDocMeta(id);
}

// ── Chunk compatibility shim ──────────────────────────────────────────────────
// getChunks is kept for code that hasn't been updated yet.
// Returns the full file content as a single "chunk" so the deployment
// extractor always has complete document context.

export interface ChunkRecord {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  cleanedContent?: string;
  createdAt: number;
}

export function getChunks(documentId: string): ChunkRecord[] {
  const content = readDocContent(documentId);
  if (!content) return [];
  return [{
    id: `${documentId}-chunk-0`,
    documentId,
    chunkIndex: 0,
    content,
    cleanedContent: content,
    createdAt: Date.now(),
  }];
}

/** No-op — kept for import compatibility only */
export function searchChunksByText(_query: string, _limit = 10): never[] {
  return [];
}

