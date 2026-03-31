import { app } from 'electron';
import fs from 'fs/promises';
import path from 'path';

function settingsPath() {
  return path.join(app.getPath('userData'), 'workflow-settings.json');
}

export async function getWorkflowSettings(): Promise<Record<string, any>> {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed ?? {};
  } catch {
    return {};
  }
}

export async function setWorkflowOutputDir(outputDir: string) {
  const settings = await getWorkflowSettings();
  const next = { ...settings, outputDir };
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
}

export async function getWorkflowOutputDir(): Promise<string | undefined> {
  const settings = await getWorkflowSettings();
  return settings.outputDir;
}
