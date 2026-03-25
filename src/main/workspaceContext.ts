/**
 * Workspace Context Manager
 *
 * Manages the workspace root directory for all file operations.
 * All tools resolve file paths relative to this workspace.
 *
 * Default: C:\Users\<username>\AppData\Roaming\local-copilot\workspace (Windows)
 *          ~/.local/share/local-copilot/workspace (Linux)
 *          ~/Library/Application Support/local-copilot/workspace (macOS)
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

export class WorkspaceContext {
  private workspacePath: string;
  private isInitialized = false;

  constructor() {
    this.workspacePath = this.getDefaultWorkspacePath();
  }

  /**
   * Get the default workspace path based on the OS and user home directory.
   */
  private getDefaultWorkspacePath(): string {
    const home = os.homedir();
    const platform = process.platform;

    if (platform === 'win32') {
      return path.join(home, 'AppData', 'Roaming', 'local-copilot', 'workspace');
    } else if (platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', 'local-copilot', 'workspace');
    } else {
      return path.join(home, '.local', 'share', 'local-copilot', 'workspace');
    }
  }

  /**
   * Initialize the workspace directory (create if it doesn't exist).
   */
  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.workspacePath, { recursive: true });
      this.isInitialized = true;
      console.log(`[Workspace] Initialized: ${this.workspacePath}`);
    } catch (err) {
      console.error(`[Workspace] Failed to initialize: ${err}`);
      throw err;
    }
  }

  /**
   * Get the current workspace path.
   */
  getWorkspacePath(): string {
    return this.workspacePath;
  }

  /**
   * Set a custom workspace path and initialize it.
   */
  async setWorkspacePath(newPath: string): Promise<void> {
    try {
      const resolved = path.resolve(newPath);
      await fs.mkdir(resolved, { recursive: true });
      this.workspacePath = resolved;
      this.isInitialized = true;
      console.log(`[Workspace] Changed to: ${this.workspacePath}`);
    } catch (err) {
      console.error(`[Workspace] Failed to set workspace: ${err}`);
      throw err;
    }
  }

  /**
   * Resolve a file path relative to the workspace.
   * If the path is absolute and outside the workspace, throws an error for security.
   *
   * @param filePath Path relative to workspace, or absolute path (must be within workspace)
   * @returns Absolute path within the workspace
   */
  resolvePath(filePath: string): string {
    const resolved = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(this.workspacePath, filePath);

    // Security: ensure the resolved path is within the workspace
    const normalized = path.normalize(resolved);
    const workspaceNorm = path.normalize(this.workspacePath);

    if (!normalized.startsWith(workspaceNorm)) {
      throw new Error(
        `Path "${filePath}" resolves outside workspace. Workspace: ${workspaceNorm}, Resolved: ${normalized}`
      );
    }

    return resolved;
  }

  /**
   * Get a relative path from the workspace root for display purposes.
   */
  relativePath(absolutePath: string): string {
    return path.relative(this.workspacePath, absolutePath);
  }

  /**
   * Check if workspace is initialized.
   */
  isReady(): boolean {
    return this.isInitialized;
  }
}

// Singleton instance
export const workspaceContext = new WorkspaceContext();
