/**
 * Document Storage — VS Code extension port
 *
 * Uses sql.js (pure WASM SQLite — no native rebuild needed).
 * DB path injected at startup via setDocStoragePath() from extension.ts.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import initSqlJs, { Database } from 'sql.js';

let db: Database | null = null;
let storagePath = '';

export function setDocStoragePath(p: string): void {
  storagePath = p;
}

function getDbFilePath(): string {
  return path.join(storagePath, 'documents.db');
}

async function getDb(): Promise<Database> {
  if (db) return db;
  const SQL = await initSqlJs();

  const dbPath = getDbFilePath();
  let buf: Buffer | null = null;
  try {
    buf = await fs.readFile(dbPath);
  } catch {
    // First run — no existing file
  }

  db = buf ? new SQL.Database(buf) : new SQL.Database();
  initSchema(db);
  console.log(`[DocStore] Opened database: ${dbPath}`);
  return db;
}

async function persistDb(): Promise<void> {
  if (!db) return;
  const data = db.export();
  await fs.mkdir(storagePath, { recursive: true });
  await fs.writeFile(getDbFilePath(), Buffer.from(data));
}

function initSchema(database: Database): void {
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
      section_title TEXT,
      page_number INTEGER,
      token_count INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_docs_status ON documents(status);
    CREATE INDEX IF NOT EXISTS idx_docs_uploaded ON documents(uploaded_at);
  `);
}

function genId(): string {
  return `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function chunkId(): string {
  return `chunk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

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

export async function insertDocument(doc: Omit<DocumentRecord, 'id'>): Promise<string> {
  const database = await getDb();
  const id = genId();
  database.run(
    `INSERT INTO documents (id, filename, original_path, file_type, size_bytes, uploaded_at, status, title, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, doc.filename, doc.originalPath ?? null, doc.fileType, doc.sizeBytes, doc.uploadedAt, doc.status, doc.title ?? null, JSON.stringify(doc.tags)]
  );
  await persistDb();
  return id;
}

export async function updateDocumentStatus(
  id: string,
  status: string,
  extra?: { summary?: string; title?: string; tags?: string[]; error?: string; processedAt?: number }
): Promise<void> {
  const database = await getDb();
  const fields: string[] = ['status = ?'];
  const vals: SqlValue[] = [status as SqlValue];
  if (extra?.summary !== undefined) { fields.push('summary = ?'); vals.push(extra.summary); }
  if (extra?.title !== undefined) { fields.push('title = ?'); vals.push(extra.title); }
  if (extra?.tags !== undefined) { fields.push('tags = ?'); vals.push(JSON.stringify(extra.tags)); }
  if (extra?.error !== undefined) { fields.push('error = ?'); vals.push(extra.error); }
  if (extra?.processedAt !== undefined) { fields.push('processed_at = ?'); vals.push(extra.processedAt); }
  vals.push(id);
  database.run(`UPDATE documents SET ${fields.join(', ')} WHERE id = ?`, vals);
  await persistDb();
}

export async function insertChunk(
  documentId: string,
  chunkIndex: number,
  content: string,
  cleanedContent?: string
): Promise<void> {
  const database = await getDb();
  database.run(
    `INSERT INTO chunks (id, document_id, chunk_index, content, cleaned_content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [chunkId(), documentId, chunkIndex, content, cleanedContent ?? null, Date.now()] as SqlValue[]
  );
  await persistDb();
}

function rowToDoc(row: Record<string, unknown>): DocumentRecord {
  return {
    id: String(row.id),
    filename: String(row.filename),
    originalPath: row.original_path ? String(row.original_path) : undefined,
    fileType: String(row.file_type),
    sizeBytes: Number(row.size_bytes),
    uploadedAt: Number(row.uploaded_at),
    processedAt: row.processed_at ? Number(row.processed_at) : undefined,
    status: String(row.status) as DocumentRecord['status'],
    summary: row.summary ? String(row.summary) : undefined,
    title: row.title ? String(row.title) : undefined,
    tags: row.tags ? (JSON.parse(String(row.tags)) as string[]) : [],
    error: row.error ? String(row.error) : undefined,
  };
}

import type { SqlValue } from 'sql.js';

function stmtToRows(database: Database, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const stmt = database.prepare(sql);
  stmt.bind(params as SqlValue[]);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as Record<string, unknown>);
  }
  stmt.free();
  return rows;
}

export async function listDocuments(): Promise<DocumentRecord[]> {
  const database = await getDb();
  const rows = stmtToRows(database, 'SELECT * FROM documents ORDER BY uploaded_at DESC');
  return rows.map(rowToDoc);
}

export async function getDocument(id: string): Promise<DocumentRecord | null> {
  const database = await getDb();
  const rows = stmtToRows(database, 'SELECT * FROM documents WHERE id = ?', [id]);
  return rows.length > 0 ? rowToDoc(rows[0]) : null;
}

export async function deleteDocument(id: string): Promise<void> {
  const database = await getDb();
  database.run('DELETE FROM documents WHERE id = ?', [id]);
  await persistDb();
}

export async function searchChunks(query: string, limit = 20): Promise<Array<{ documentId: string; content: string; chunkIndex: number }>> {
  const database = await getDb();
  const q = `%${query.toLowerCase()}%`;
  const rows = stmtToRows(
    database,
    `SELECT document_id, chunk_index, coalesce(cleaned_content, content) as content
     FROM chunks WHERE lower(content) LIKE ? OR lower(cleaned_content) LIKE ?
     LIMIT ?`,
    [q, q, limit]
  );
  return rows.map((r) => ({
    documentId: String(r.document_id),
    content: String(r.content),
    chunkIndex: Number(r.chunk_index),
  }));
}

export async function getChunks(documentId: string): Promise<Array<{ chunkIndex: number; content: string }>> {
  const database = await getDb();
  const rows = stmtToRows(
    database,
    'SELECT chunk_index, coalesce(cleaned_content, content) as content FROM chunks WHERE document_id = ? ORDER BY chunk_index',
    [documentId]
  );
  return rows.map((r) => ({ chunkIndex: Number(r.chunk_index), content: String(r.content) }));
}
