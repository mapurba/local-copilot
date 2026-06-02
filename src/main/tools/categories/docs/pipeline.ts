/**
 * Document LLM Pipeline
 * 
 * Uses the GitHub Copilot LLM to:
 * 1. Clean and structure raw parsed text
 * 2. Generate a summary and extract tags
 * 3. Create a well-formatted markdown from messy source documents
 */

import { tokenManager } from '../../../../main/tokenManager';
import https from 'https';

interface LlmCleanResult {
  title: string;
  summary: string;
  tags: string[];
  cleanedMarkdown: string;
}

interface ChunkCleanResult {
  cleanedContent: string;
}

const CHAT_API_HOST = 'api.githubcopilot.com';

/**
 * Make a direct HTTPS chat completion request to GitHub Copilot
 */
export async function callLlm(systemPrompt: string, userContent: string, maxTokens = 4096): Promise<string> {
  const token = await tokenManager.getToken();

  const body = JSON.stringify({
    model: 'gpt-4.1',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    max_tokens: maxTokens,
    temperature: 0.3,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: CHAT_API_HOST,
        path: '/chat/completions',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Copilot-Integration-Id': 'vscode-chat',
          'Editor-Version': 'vscode/1.90.0',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const content = json.choices?.[0]?.message?.content ?? '';
            resolve(content);
          } catch (e) {
            reject(new Error(`LLM response parse error: ${e}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Full document analysis: clean, summarize, extract tags, produce markdown
 */
export async function analyzeDocument(rawText: string, filename: string): Promise<LlmCleanResult> {
  const truncated = rawText.slice(0, 12000); // Stay within token budget

  const systemPrompt = `You are a document analyst. Given raw text extracted from a document, produce:
1. A clean, well-structured Markdown version of the document content
2. A concise title
3. A 2-3 sentence summary
4. Up to 8 relevant tags

Respond ONLY with valid JSON in this exact format:
{
  "title": "...",
  "summary": "...",
  "tags": ["tag1", "tag2"],
  "cleanedMarkdown": "..."
}

Rules for cleanedMarkdown:
- Fix OCR artifacts and formatting issues
- Use proper Markdown headings, lists, and tables
- Remove redundant whitespace and page numbers
- Preserve all meaningful content
- Make it well-structured and readable`;

  const userContent = `Filename: ${filename}\n\nRaw content:\n\n${truncated}`;

  const response = await callLlm(systemPrompt, userContent, 6000);

  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = response.match(/```json\s*([\s\S]+?)\s*```/) || response.match(/(\{[\s\S]+\})/);
  const jsonStr = jsonMatch?.[1] ?? response;

  try {
    const result = JSON.parse(jsonStr);
    return {
      title: result.title ?? filename,
      summary: result.summary ?? '',
      tags: Array.isArray(result.tags) ? result.tags : [],
      cleanedMarkdown: result.cleanedMarkdown ?? rawText,
    };
  } catch {
    // Fallback if JSON parse fails
    return {
      title: filename,
      summary: response.slice(0, 300),
      tags: [],
      cleanedMarkdown: rawText,
    };
  }
}

/**
 * Clean an individual chunk of text (for large documents processed in pieces)
 */
export async function cleanChunk(rawChunk: string, documentContext: string): Promise<ChunkCleanResult> {
  const systemPrompt = `You are a document cleaner. Fix formatting issues, remove artifacts, and return clean readable text.
Keep all meaningful content. Do not summarize or shorten — preserve full content.
Return ONLY the cleaned text, no explanations.`;

  const userContent = `Document context: ${documentContext}\n\nChunk to clean:\n\n${rawChunk}`;

  const cleaned = await callLlm(systemPrompt, userContent, 2048);
  return { cleanedContent: cleaned.trim() };
}

/**
 * Answer a question about a document using its chunks as context
 */
export async function queryDocumentContext(question: string, contextChunks: string[], documentTitle: string): Promise<string> {
  const context = contextChunks.slice(0, 5).join('\n\n---\n\n');

  const systemPrompt = `You are a document assistant. Answer questions based ONLY on the provided document context.
If the answer is not in the context, say so clearly. Be concise and accurate.`;

  const userContent = `Document: "${documentTitle}"\n\nContext:\n${context}\n\nQuestion: ${question}`;

  return await callLlm(systemPrompt, userContent, 2048);
}
