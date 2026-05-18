import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  listDocuments,
  getDocument,
  deleteDocument,
  searchChunks,
  getChunks,
  insertDocument,
  insertChunk,
  updateDocumentStatus,
} from '../docs/storage';

function ok(data: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(data))]);
}

async function parseDocument(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>;
    const buf = await fs.readFile(filePath);
    const result = await pdfParse(buf);
    return result.text;
  }
  if (ext === '.docx' || ext === '.doc') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }
  // Plain text, markdown, json, log, etc.
  return fs.readFile(filePath, 'utf8');
}

function chunkText(text: string, chunkSize = 2000, overlap = 200): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + chunkSize));
    start += chunkSize - overlap;
  }
  return chunks;
}

async function askLlm(prompt: string): Promise<string> {
  const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
  if (!model) return '';
  const resp = await model.sendRequest(
    [vscode.LanguageModelChatMessage.User(prompt)],
    {},
    new vscode.CancellationTokenSource().token
  );
  let out = '';
  for await (const chunk of resp.stream) {
    if (chunk instanceof vscode.LanguageModelTextPart) out += chunk.value;
  }
  return out;
}

export function registerDocsTools(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    // ── docsUpload ───────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ file_path: string }>('vcd-agent_docsUpload', {
      prepareInvocation(params) {
        return { confirmationMessages: { title: 'Upload Document', message: new vscode.MarkdownString(`Upload \`${params.input.file_path}\` to document storage?`) } };
      },
      async invoke(params) {
        const filePath = params.input.file_path;
        const stat = await fs.stat(filePath).catch(() => null);
        if (!stat) return ok({ error: `File not found: ${filePath}` });

        const filename = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase().replace('.', '');
        const docId = await insertDocument({
          filename,
          originalPath: filePath,
          fileType: ext,
          sizeBytes: stat.size,
          uploadedAt: Date.now(),
          status: 'processing',
          tags: [],
        });

        // Process asynchronously — don't block the tool response
        (async () => {
          try {
            const text = await parseDocument(filePath);
            const chunks = chunkText(text);
            for (let i = 0; i < chunks.length; i++) {
              await insertChunk(docId, i, chunks[i]);
            }
            const summary = await askLlm(`Summarize this document in 3 sentences:\n\n${text.slice(0, 4000)}`);
            const title = await askLlm(`Give a short title (5 words max) for this document:\n\n${text.slice(0, 1000)}`);
            await updateDocumentStatus(docId, 'ready', {
              summary, title: title.trim(), processedAt: Date.now(),
            });
          } catch (e) {
            await updateDocumentStatus(docId, 'error', { error: e instanceof Error ? e.message : String(e) });
          }
        })();

        return ok({ docId, filename, status: 'processing', message: 'Document upload started. Use docs_status to check progress.' });
      },
    }),

    // ── docsStatus ───────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ doc_id: string }>('vcd-agent_docsStatus', {
      async invoke(params) {
        const doc = await getDocument(params.input.doc_id);
        if (!doc) return ok({ error: `Document not found: ${params.input.doc_id}` });
        return ok({ id: doc.id, filename: doc.filename, status: doc.status, error: doc.error });
      },
    }),

    // ── docsList ─────────────────────────────────────────────────────────────
    vscode.lm.registerTool('vcd-agent_docsList', {
      async invoke() {
        const docs = await listDocuments();
        return ok({ count: docs.length, documents: docs.map((d) => ({
          id: d.id, filename: d.filename, status: d.status, title: d.title, summary: d.summary?.slice(0, 200),
        })) });
      },
    }),

    // ── docsSearch ───────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ query: string; limit?: number }>('vcd-agent_docsSearch', {
      async invoke(params) {
        const results = await searchChunks(params.input.query, params.input.limit ?? 10);
        return ok({ count: results.length, results });
      },
    }),

    // ── docsAsk ──────────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ question: string; doc_id?: string }>('vcd-agent_docsAsk', {
      async invoke(params) {
        let context: string;
        if (params.input.doc_id) {
          const chunks = await getChunks(params.input.doc_id);
          context = chunks.map((c) => c.content).join('\n\n').slice(0, 12000);
        } else {
          const results = await searchChunks(params.input.question, 8);
          context = results.map((r) => r.content).join('\n\n').slice(0, 12000);
        }
        const answer = await askLlm(`Based on the following document content, answer: ${params.input.question}\n\n---\n${context}`);
        return ok({ answer, contextUsed: context.length });
      },
    }),

    // ── docsGetContent ───────────────────────────────────────────────────────
    vscode.lm.registerTool<{ doc_id: string; chunk_index?: number }>('vcd-agent_docsGetContent', {
      async invoke(params) {
        const chunks = await getChunks(params.input.doc_id);
        if (params.input.chunk_index !== undefined) {
          const chunk = chunks.find((c) => c.chunkIndex === params.input.chunk_index);
          return ok({ docId: params.input.doc_id, chunk: chunk?.content ?? null });
        }
        return ok({ docId: params.input.doc_id, chunks: chunks.map((c) => c.content).join('\n\n') });
      },
    }),

    // ── docsDelete ───────────────────────────────────────────────────────────
    vscode.lm.registerTool<{ doc_id: string }>('vcd-agent_docsDelete', {
      prepareInvocation(params) {
        return { confirmationMessages: { title: '⚠ Delete Document', message: new vscode.MarkdownString(`Permanently delete document \`${params.input.doc_id}\`?`) } };
      },
      async invoke(params) {
        await deleteDocument(params.input.doc_id);
        return ok({ deleted: params.input.doc_id });
      },
    })
  );
}
