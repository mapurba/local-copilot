/**
 * Document Parser
 * 
 * Multi-format document parser supporting:
 * - PDF  (via pdf-parse)
 * - DOCX (via mammoth)
 * - MD / TXT / JSON (raw text)
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface ParsedDocument {
  text: string;
  pageCount?: number;
  sections: Array<{
    title?: string;
    content: string;
    pageNumber?: number;
  }>;
  metadata: Record<string, unknown>;
}

/**
 * Parse a document file into raw text and sections.
 */
export async function parseDocument(filePath: string): Promise<ParsedDocument> {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case '.pdf':
      return parsePdf(filePath);
    case '.docx':
    case '.doc':
      return parseDocx(filePath);
    case '.md':
    case '.markdown':
      return parseMarkdown(filePath);
    case '.txt':
    case '.text':
    case '.log':
      return parsePlainText(filePath);
    case '.json':
      return parseJson(filePath);
    default:
      // Try as plain text
      return parsePlainText(filePath);
  }
}

async function parsePdf(filePath: string): Promise<ParsedDocument> {
  // Dynamic require to avoid TypeScript OOM on type resolution
  // pdf-parse v2 exports a PDFParse class (not a callable function like v1)
  const { PDFParse } = require('pdf-parse');
  const buffer = await fs.readFile(filePath);

  // Disable web worker — required for Node.js / Electron main process
  PDFParse.setWorker('');

  const parser = new PDFParse({ data: new Uint8Array(buffer) });

  const textResult = await parser.getText();

  let infoData: Record<string, unknown> = {};
  try {
    const infoResult = await parser.getInfo();
    infoData = (infoResult?.info as Record<string, unknown>) ?? {};
  } catch {
    // getInfo can fail for encrypted/malformed PDFs — not fatal
  }

  await parser.destroy().catch(() => undefined);

  const sections = splitIntoSections(textResult.text);

  return {
    text: textResult.text,
    pageCount: textResult.total,
    sections,
    metadata: {
      author: infoData.Author,
      title: infoData.Title,
      subject: infoData.Subject,
      pageCount: textResult.total,
    },
  };
}

async function parseDocx(filePath: string): Promise<ParsedDocument> {
  const mammoth = require('mammoth');
  const buffer = await fs.readFile(filePath);
  const result = await mammoth.extractRawText({ buffer });

  const sections = splitIntoSections(result.value);

  return {
    text: result.value,
    sections,
    metadata: {
      warnings: result.messages?.length ?? 0,
    },
  };
}

async function parseMarkdown(filePath: string): Promise<ParsedDocument> {
  const content = await fs.readFile(filePath, 'utf8');
  const sections: ParsedDocument['sections'] = [];

  // Split by markdown headings
  const parts = content.split(/^(#{1,3}\s+.+)$/m);
  let currentTitle: string | undefined;
  let currentContent = '';

  for (const part of parts) {
    if (/^#{1,3}\s+/.test(part)) {
      if (currentContent.trim()) {
        sections.push({ title: currentTitle, content: currentContent.trim() });
      }
      currentTitle = part.replace(/^#+\s+/, '').trim();
      currentContent = '';
    } else {
      currentContent += part;
    }
  }
  if (currentContent.trim()) {
    sections.push({ title: currentTitle, content: currentContent.trim() });
  }
  if (sections.length === 0) {
    sections.push({ content: content });
  }

  return { text: content, sections, metadata: { format: 'markdown' } };
}

async function parsePlainText(filePath: string): Promise<ParsedDocument> {
  const content = await fs.readFile(filePath, 'utf8');
  const sections = splitIntoSections(content);
  return { text: content, sections, metadata: { format: 'plaintext' } };
}

async function parseJson(filePath: string): Promise<ParsedDocument> {
  const content = await fs.readFile(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return parsePlainText(filePath);
  }
  const text = JSON.stringify(parsed, null, 2);
  return {
    text,
    sections: [{ content: text }],
    metadata: { format: 'json' },
  };
}

/**
 * Split raw text into logical sections by double-newlines or page markers
 */
function splitIntoSections(text: string, maxChunkSize = 2000): ParsedDocument['sections'] {
  // Normalize line endings
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Split by double newlines (paragraph breaks)
  const paragraphs = normalized.split(/\n\s*\n/).filter(p => p.trim().length > 20);

  // Merge paragraphs into chunks of up to maxChunkSize characters
  const sections: ParsedDocument['sections'] = [];
  let currentChunk = '';

  for (const paragraph of paragraphs) {
    if (currentChunk.length + paragraph.length > maxChunkSize && currentChunk.length > 0) {
      sections.push({ content: currentChunk.trim() });
      currentChunk = '';
    }
    currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
  }

  if (currentChunk.trim()) {
    sections.push({ content: currentChunk.trim() });
  }

  return sections.length > 0 ? sections : [{ content: text.slice(0, maxChunkSize) }];
}

/**
 * Estimate token count (rough: ~4 chars per token)
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}
