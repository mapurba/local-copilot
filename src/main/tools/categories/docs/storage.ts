/**
 * Document Storage
 * 
 * SQLite-backed storage for uploaded documents, their parsed chunks,
 * and metadata. Uses better-sqlite3 for synchronous access in Electron main.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import { app } from 'electron';
import * as fs from 'fs';

let db: Database.Database | null = null;

function getDbPath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'documents.db');
}

export function getDocumentDb(): Database.Database {
  if (db) return db;

  const dbPath = getDbPath();
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initSchema(db);
  console.log(`[DocStore] Opened database: ${dbPath}`);
  return db;
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      original_path TEXT,
      file_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      uploaded_at INTEGER NOT NULL,
      processed_at INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      summary TEXT,
      title TEXT,
      tags TEXT DEFAULT '[]',
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      cleaned_content TEXT,
      embedding TEXT,
      section_title TEXT,
      page_number INTEGER,
      token_count INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
    CREATE INDEX IF NOT EXISTS idx_documents_uploaded_at ON documents(uploaded_at DESC);
  `);
}

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

export interface ChunkRecord {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  cleanedContent?: string;
  embedding?: number[];
  sectionTitle?: string;
  pageNumber?: number;
  tokenCount?: number;
  createdAt: number;
}

export function insertDocument(doc: Omit<DocumentRecord, 'tags'> & { tags?: string[] }): void {
  const database = getDocumentDb();
  database.prepare(`
    INSERT INTO documents (id, filename, original_path, file_type, size_bytes, uploaded_at, status, title, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    doc.id,
    doc.filename,
    doc.originalPath ?? null,
    doc.fileType,
    doc.sizeBytes,
    doc.uploadedAt,
    doc.status,
    doc.title ?? null,
    JSON.stringify(doc.tags ?? [])
  );
}

export function updateDocumentStatus(
  id: string,
  status: DocumentRecord['status'],
  extras?: { summary?: string; title?: string; tags?: string[]; error?: string; processedAt?: number }
): void {
  const database = getDocumentDb();
  database.prepare(`
    UPDATE documents SET status=?, processed_at=?, summary=?, title=?, tags=?, error=? WHERE id=?
  `).run(
    status,
    extras?.processedAt ?? (status === 'ready' ? Date.now() : null),
    extras?.summary ?? null,
    extras?.title ?? null,
    extras?.tags ? JSON.stringify(extras.tags) : null,
    extras?.error ?? null,
    id
  );
}

export function getDocument(id: string): DocumentRecord | null {
  const database = getDocumentDb();
  const row = database.prepare('SELECT * FROM documents WHERE id=?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToDocument(row) : null;
}

export function listDocuments(limit = 50): DocumentRecord[] {
  const database = getDocumentDb();
  const rows = database.prepare('SELECT * FROM documents ORDER BY uploaded_at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
  return rows.map(rowToDocument);
}

export function deleteDocument(id: string): void {
  const database = getDocumentDb();
  database.prepare('DELETE FROM documents WHERE id=?').run(id);
}

function rowToDocument(row: Record<string, unknown>): DocumentRecord {
  return {
    id: row.id as string,
    filename: row.filename as string,
    originalPath: row.original_path as string | undefined,
    fileType: row.file_type as string,
    sizeBytes: row.size_bytes as number,
    uploadedAt: row.uploaded_at as number,
    processedAt: row.processed_at as number | undefined,
    status: row.status as DocumentRecord['status'],
    summary: row.summary as string | undefined,
    title: row.title as string | undefined,
    tags: JSON.parse((row.tags as string) || '[]'),
    error: row.error as string | undefined,
  };
}

// ── Chunk CRUD ────────────────────────────────────────────────────────────────

export function insertChunks(chunks: ChunkRecord[]): void {
  const database = getDocumentDb();
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO chunks (id, document_id, chunk_index, content, cleaned_content, embedding, section_title, page_number, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMany = database.transaction((items: ChunkRecord[]) => {
    for (const c of items) {
      stmt.run(
        c.id,
        c.documentId,
        c.chunkIndex,
        c.content,
        c.cleanedContent ?? null,
        c.embedding ? JSON.stringify(c.embedding) : null,
        c.sectionTitle ?? null,
        c.pageNumber ?? null,
        c.tokenCount ?? null,
        c.createdAt
      );
    }
  });
  insertMany(chunks);
}

export function getChunks(documentId: string): ChunkRecord[] {
  const database = getDocumentDb();
  const rows = database.prepare('SELECT * FROM chunks WHERE document_id=? ORDER BY chunk_index').all(documentId) as Record<string, unknown>[];
  return rows.map(rowToChunk);
}

export function searchChunksByText(query: string, limit = 10): Array<ChunkRecord & { documentFilename: string }> {
  const database = getDocumentDb();
  const pattern = `%${query}%`;
  const rows = database.prepare(`
    SELECT c.*, d.filename as document_filename
    FROM chunks c
    JOIN documents d ON c.document_id = d.id
    WHERE (c.cleaned_content LIKE ? OR c.content LIKE ?)
    AND d.status = 'ready'
    ORDER BY c.document_id, c.chunk_index
    LIMIT ?
  `).all(pattern, pattern, limit) as Record<string, unknown>[];
  return rows.map(r => ({ ...rowToChunk(r), documentFilename: r.document_filename as string }));
}

function rowToChunk(row: Record<string, unknown>): ChunkRecord {
  return {
    id: row.id as string,
    documentId: row.document_id as string,
    chunkIndex: row.chunk_index as number,
    content: row.content as string,
    cleanedContent: row.cleaned_content as string | undefined,
    embedding: row.embedding ? JSON.parse(row.embedding as string) : undefined,
    sectionTitle: row.section_title as string | undefined,
    pageNumber: row.page_number as number | undefined,
    tokenCount: row.token_count as number | undefined,
    createdAt: row.created_at as number,
  };
}

// ── Preferences ───────────────────────────────────────────────────────────────

export function getPreference(key: string): string | null {
  const database = getDocumentDb();
  const row = database.prepare('SELECT value FROM user_preferences WHERE key=?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setPreference(key: string, value: string): void {
  const database = getDocumentDb();
  database.prepare('INSERT OR REPLACE INTO user_preferences (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, Date.now());
}
