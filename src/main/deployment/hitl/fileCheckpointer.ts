/**
 * File-Based Checkpoint Saver for LangGraph
 *
 * Persists LangGraph checkpoint data to disk so the HITL deployment graph
 * survives Electron process restarts between user interactions.
 *
 * Storage layout:
 *   {userData}/deployment/graph-checkpoints/{threadId}.json
 *
 * The file format stores a list of checkpoint records; LangGraph will always
 * call put() for the latest checkpoint and getTuple() / list() to restore.
 *
 * NOTE: This implements the BaseCheckpointSaver interface from @langchain/langgraph.
 * We use dynamic require() to match the pattern in copilotChatApi.ts and avoid
 * TypeScript resolving the heavy LangGraph generic type declarations at build time.
 */

import { app } from 'electron';
import path from 'path';
import fs from 'fs';

// ── Type stubs (kept narrow to avoid pulling in full LangGraph types) ─────────

interface CheckpointTuple {
  config: RunnableConfig;
  checkpoint: Checkpoint;
  metadata: CheckpointMetadata;
  parentConfig?: RunnableConfig;
  pendingWrites?: PendingWrite[];
}

interface RunnableConfig {
  configurable?: {
    thread_id?: string;
    checkpoint_ns?: string;
    checkpoint_id?: string;
    [key: string]: unknown;
  };
}

type Checkpoint = Record<string, unknown>;
type CheckpointMetadata = Record<string, unknown>;
type PendingWrite = [string, string, unknown];

// ── Stored format ─────────────────────────────────────────────────────────────

interface StoredCheckpoint {
  config: RunnableConfig;
  checkpoint: Checkpoint;
  metadata: CheckpointMetadata;
  parentConfig?: RunnableConfig;
  pendingWrites?: PendingWrite[];
  savedAt: number;
}

interface ThreadFile {
  schemaVersion: number;
  threadId: string;
  checkpoints: StoredCheckpoint[];
}

const SCHEMA_VERSION = 1;

// ── Storage helpers ───────────────────────────────────────────────────────────

function getCheckpointDir(): string {
  const userData = app.getPath('userData');
  const dir = path.join(userData, 'deployment', 'graph-checkpoints');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function threadFilePath(threadId: string): string {
  // Sanitize thread ID to be filesystem-safe
  const safe = threadId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return path.join(getCheckpointDir(), `${safe}.json`);
}

function readThreadFile(threadId: string): ThreadFile {
  const filePath = threadFilePath(threadId);
  if (!fs.existsSync(filePath)) {
    return { schemaVersion: SCHEMA_VERSION, threadId, checkpoints: [] };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as ThreadFile;
    // Reset if schema version changed (safe reset — user just has to restart the graph)
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      return { schemaVersion: SCHEMA_VERSION, threadId, checkpoints: [] };
    }
    return parsed;
  } catch {
    return { schemaVersion: SCHEMA_VERSION, threadId, checkpoints: [] };
  }
}

function writeThreadFile(file: ThreadFile): void {
  const filePath = threadFilePath(file.threadId);
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8');
}

// ── FileCheckpointer class ────────────────────────────────────────────────────

// Dynamically load the base class so TypeScript doesn't try to resolve the
// full generic type tree of @langchain/langgraph at build time.
const { BaseCheckpointSaver } = require('@langchain/langgraph');

export class FileCheckpointer extends BaseCheckpointSaver {

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id;
    if (!threadId) return undefined;

    const file = readThreadFile(String(threadId));
    if (file.checkpoints.length === 0) return undefined;

    const checkpointId = config.configurable?.checkpoint_id;
    if (checkpointId) {
      // Fetch a specific checkpoint by ID
      const stored = file.checkpoints.find(
        (c) => c.checkpoint.id === checkpointId || c.config.configurable?.checkpoint_id === checkpointId
      );
      if (!stored) return undefined;
      return {
        config: stored.config,
        checkpoint: stored.checkpoint,
        metadata: stored.metadata,
        parentConfig: stored.parentConfig,
        pendingWrites: stored.pendingWrites,
      };
    }

    // Return the most recent checkpoint
    const latest = file.checkpoints[file.checkpoints.length - 1];
    return {
      config: latest.config,
      checkpoint: latest.checkpoint,
      metadata: latest.metadata,
      parentConfig: latest.parentConfig,
      pendingWrites: latest.pendingWrites,
    };
  }

  async *list(
    config: RunnableConfig,
    options?: { before?: RunnableConfig; limit?: number }
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id;
    if (!threadId) return;

    const file = readThreadFile(String(threadId));
    let checkpoints = [...file.checkpoints].reverse(); // newest first

    if (options?.limit) {
      checkpoints = checkpoints.slice(0, options.limit);
    }

    for (const stored of checkpoints) {
      yield {
        config: stored.config,
        checkpoint: stored.checkpoint,
        metadata: stored.metadata,
        parentConfig: stored.parentConfig,
        pendingWrites: stored.pendingWrites,
      };
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: Record<string, unknown>
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id ?? 'default';
    const checkpointId = (checkpoint.id as string | undefined) ?? `ckpt-${Date.now()}`;
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';

    const newConfig: RunnableConfig = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpointId,
      },
    };

    const file = readThreadFile(String(threadId));
    file.checkpoints.push({
      config: newConfig,
      checkpoint,
      metadata,
      parentConfig: config,
      savedAt: Date.now(),
    });

    // Keep only the last 20 checkpoints per thread to prevent unbounded growth
    if (file.checkpoints.length > 20) {
      file.checkpoints = file.checkpoints.slice(-20);
    }

    writeThreadFile(file);
    return newConfig;
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    const threadId = config.configurable?.thread_id;
    if (!threadId) return;

    const file = readThreadFile(String(threadId));
    if (file.checkpoints.length === 0) return;

    const latest = file.checkpoints[file.checkpoints.length - 1];
    if (!latest.pendingWrites) latest.pendingWrites = [];
    // Append writes tagged with taskId
    latest.pendingWrites.push(...writes.map((w) => [taskId, ...w] as unknown as PendingWrite));
    writeThreadFile(file);
  }

  /**
   * Delete all checkpoint data for a thread.
   * Called after the graph reaches END or when the user abandons the flow.
   */
  deleteThread(threadId: string): void {
    const filePath = threadFilePath(String(threadId));
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

// ── Module-level singleton ────────────────────────────────────────────────────

export const fileCheckpointer = new FileCheckpointer();
