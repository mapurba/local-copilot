/**
 * Deployment Store — File-based
 *
 * Stores deployment designs and runs as JSON files:
 *   {userData}/deployment/designs/{id}.json
 *   {userData}/deployment/runs/{id}.json
 *
 * Replaces the previous SQLite-backed store.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import {
  DeploymentDesign,
  DeploymentRunState,
  DesignSummary,
} from './types';

// ── Path helpers ──────────────────────────────────────────────────────────────

function getDeploymentDir(): string {
  return path.join(app.getPath('userData'), 'deployment');
}

function getDesignsDir(): string {
  return path.join(getDeploymentDir(), 'designs');
}

function getRunsDir(): string {
  return path.join(getDeploymentDir(), 'runs');
}

function ensureDirs(): void {
  for (const dir of [getDesignsDir(), getRunsDir()]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// ── Designs ───────────────────────────────────────────────────────────────────

export function saveDesign(design: Omit<DeploymentDesign, 'id'>): string {
  ensureDirs();
  const id = randomUUID();
  const now = Date.now();
  const full: DeploymentDesign = { ...design, id, createdAt: now, updatedAt: now } as DeploymentDesign;
  fs.writeFileSync(path.join(getDesignsDir(), `${id}.json`), JSON.stringify(full, null, 2), 'utf-8');
  return id;
}

export function updateDesign(id: string, partial: Partial<DeploymentDesign>): void {
  ensureDirs();
  const existing = getDesign(id);
  const merged: DeploymentDesign = { ...existing, ...partial, id, updatedAt: Date.now() };
  fs.writeFileSync(path.join(getDesignsDir(), `${id}.json`), JSON.stringify(merged, null, 2), 'utf-8');
}

export function getDesign(id: string): DeploymentDesign {
  ensureDirs();
  const filePath = path.join(getDesignsDir(), `${id}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`DeploymentDesign not found: ${id}`);
  const design = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DeploymentDesign;
  design.id = id;
  return design;
}

export function listDesigns(): DesignSummary[] {
  ensureDirs();
  const dir = getDesignsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const summaries: DesignSummary[] = [];
  for (const file of files) {
    try {
      const design = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as DeploymentDesign;
      summaries.push({
        id: design.id,
        documentId: design.documentId,
        status: design.status,
        createdAt: design.createdAt ?? 0,
        updatedAt: design.updatedAt ?? 0,
      });
    } catch { /* skip malformed files */ }
  }
  return summaries.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export function deleteDesign(id: string): void {
  const filePath = path.join(getDesignsDir(), `${id}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// ── Runs ──────────────────────────────────────────────────────────────────────

export function saveRun(run: Omit<DeploymentRunState, 'runId'>): string {
  ensureDirs();
  const id = randomUUID();
  const full: DeploymentRunState = { ...run, runId: id } as DeploymentRunState;
  fs.writeFileSync(path.join(getRunsDir(), `${id}.json`), JSON.stringify(full, null, 2), 'utf-8');
  return id;
}

export function updateRun(id: string, partial: Partial<DeploymentRunState>): void {
  ensureDirs();
  const existing = getRun(id);
  const merged: DeploymentRunState = { ...existing, ...partial, runId: id };
  fs.writeFileSync(path.join(getRunsDir(), `${id}.json`), JSON.stringify(merged, null, 2), 'utf-8');
}

export function getRun(id: string): DeploymentRunState {
  ensureDirs();
  const filePath = path.join(getRunsDir(), `${id}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`DeploymentRunState not found: ${id}`);
  const run = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DeploymentRunState;
  run.runId = id;
  return run;
}

export function getRunsForDesign(designId: string): DeploymentRunState[] {
  ensureDirs();
  const dir = getRunsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const runs: DeploymentRunState[] = [];
  for (const file of files) {
    try {
      const run = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as DeploymentRunState;
      if (run.designId === designId) runs.push(run);
    } catch { /* skip malformed */ }
  }
  return runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

