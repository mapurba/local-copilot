/**
 * File-based document store
 *
 * Replaces the SQLite-backed document storage.
 * Each uploaded document is processed once by the LLM, then saved as:
 *
 *   {userData}/docs/index.json       — array of DocMeta (all document metadata)
 *   {userData}/docs/{docId}.md       — cleaned/structured markdown content
 *
 * The agent reads documents via docs:readFile tool, which reads the .md file
 * directly — no DB, no chunk search, no semantic retrieval.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export interface DocMeta {
  id: string;
  filename: string;
  originalPath?: string;
  fileType: string;
  sizeBytes: number;
  uploadedAt: number;
  processedAt?: number;
  status: 'pending' | 'processing' | 'ready' | 'analysed' | 'error';
  summary?: string;
  title?: string;
  tags: string[];
  error?: string;
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function getDocsDir(): string {
  return path.join(app.getPath('userData'), 'docs');
}

function getIndexPath(): string {
  return path.join(getDocsDir(), 'index.json');
}

export function getDocFilePath(id: string): string {
  return path.join(getDocsDir(), `${id}.md`);
}

function ensureDir(): void {
  const dir = getDocsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Index I/O ─────────────────────────────────────────────────────────────────

function readIndex(): DocMeta[] {
  ensureDir();
  const indexPath = getIndexPath();
  if (!fs.existsSync(indexPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as DocMeta[];
  } catch {
    return [];
  }
}

function writeIndex(docs: DocMeta[]): void {
  ensureDir();
  fs.writeFileSync(getIndexPath(), JSON.stringify(docs, null, 2), 'utf-8');
}

// ── Public API ────────────────────────────────────────────────────────────────

export function saveDocMeta(doc: DocMeta): void {
  const docs = readIndex();
  const idx = docs.findIndex((d) => d.id === doc.id);
  if (idx >= 0) {
    docs[idx] = doc;
  } else {
    docs.unshift(doc); // newest first
  }
  writeIndex(docs);
}

export function getDocMeta(id: string): DocMeta | null {
  return readIndex().find((d) => d.id === id) ?? null;
}

export function listDocMetas(limit = 50): DocMeta[] {
  return readIndex().slice(0, limit);
}

export function deleteDocMeta(id: string): void {
  writeIndex(readIndex().filter((d) => d.id !== id));
  // Remove the .md file too
  const mdPath = getDocFilePath(id);
  if (fs.existsSync(mdPath)) {
    try { fs.unlinkSync(mdPath); } catch { /* best effort */ }
  }
}

/**
 * Write the cleaned markdown content for a document.
 * Called once when the document finishes LLM processing.
 */
export function saveDocContent(id: string, content: string): void {
  ensureDir();
  fs.writeFileSync(getDocFilePath(id), content, 'utf-8');
}

/**
 * Read the cleaned markdown content for a document.
 * Returns null if the file does not exist yet.
 */
export function readDocContent(id: string): string | null {
  const p = getDocFilePath(id);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf-8');
}
