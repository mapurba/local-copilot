import { app } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: string; // ISO timestamp
  type?: 'text' | 'tool-call' | 'tool-result';
  attachments?: Array<{ name: string }>;
}

export interface Conversation {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
}

function getDir(): string {
  return path.join(app.getPath('userData'), 'chat-history');
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(getDir(), { recursive: true });
}

function fileForId(id: string): string {
  return path.join(getDir(), `${id}.json`);
}

export async function createConversation(name?: string): Promise<Conversation> {
  await ensureDir();
  const id = randomUUID();
  const conv: Conversation = {
    id,
    name: name || `Conversation ${new Date().toISOString()}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
  };
  await fs.writeFile(fileForId(id), JSON.stringify(conv, null, 2), 'utf8');
  return conv;
}

export async function listConversations(): Promise<Array<{ id: string; name: string; createdAt: string; updatedAt: string }>> {
  await ensureDir();
  const files = await fs.readdir(getDir());
  const out: Array<{ id: string; name: string; createdAt: string; updatedAt: string }> = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(getDir(), f), 'utf8');
      const conv = JSON.parse(raw) as Conversation;
      out.push({ id: conv.id, name: conv.name, createdAt: conv.createdAt, updatedAt: conv.updatedAt });
    } catch {
      // ignore corrupt files
    }
  }
  // newest first
  out.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
  return out;
}

export async function getConversation(id: string): Promise<Conversation | null> {
  try {
    const raw = await fs.readFile(fileForId(id), 'utf8');
    const conv = JSON.parse(raw) as Conversation;
    return conv;
  } catch (err) {
    return null;
  }
}

export async function appendMessage(id: string, message: StoredMessage): Promise<Conversation> {
  await ensureDir();
  const conv = (await getConversation(id)) || (await createConversation());
  conv.messages.push(message);
  conv.updatedAt = new Date().toISOString();
  await fs.writeFile(fileForId(conv.id), JSON.stringify(conv, null, 2), 'utf8');
  return conv;
}

export async function clearConversation(id: string): Promise<Conversation | null> {
  const conv = await getConversation(id);
  if (!conv) return null;
  conv.messages = [];
  conv.updatedAt = new Date().toISOString();
  await fs.writeFile(fileForId(conv.id), JSON.stringify(conv, null, 2), 'utf8');
  return conv;
}

export async function deleteConversation(id: string): Promise<boolean> {
  try {
    await fs.unlink(fileForId(id));
    return true;
  } catch {
    return false;
  }
}
