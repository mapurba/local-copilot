import { app } from 'electron';
import fs from 'fs';
import path from 'path';

type DraftPlan = {
  id: string;
  name?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

function draftsDir(): string {
  const dir = path.join(app.getPath('userData'), 'deployment-plan-drafts');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function draftPath(id: string): string {
  return path.join(draftsDir(), `${id}.json`);
}

export function saveDeploymentDraft(plan: DraftPlan): { id: string; savedAt: string } {
  const id = String(plan.id || `draft-${Date.now()}`);
  const now = new Date().toISOString();
  const payload: DraftPlan = {
    ...plan,
    id,
    updatedAt: now,
    createdAt: plan.createdAt || now,
  };
  fs.writeFileSync(draftPath(id), JSON.stringify(payload, null, 2), 'utf-8');
  return { id, savedAt: now };
}

export function loadDeploymentDraft(id: string): DraftPlan | null {
  const p = draftPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as DraftPlan;
}

export function listDeploymentDrafts(): Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string }> {
  const dir = draftsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const drafts: Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string }> = [];

  for (const file of files) {
    try {
      const fullPath = path.join(dir, file);
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as DraftPlan;
      drafts.push({
        id: String(data.id || file.replace(/\.json$/, '')),
        name: String(data.name || 'Untitled Deployment Plan'),
        status: String(data.status || 'draft'),
        createdAt: String(data.createdAt || new Date(0).toISOString()),
        updatedAt: String(data.updatedAt || new Date(0).toISOString()),
      });
    } catch {
      // Skip malformed draft files.
    }
  }

  return drafts.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function deleteDeploymentDraft(id: string): boolean {
  const p = draftPath(id);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}
