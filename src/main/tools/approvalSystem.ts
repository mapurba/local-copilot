/**
 * Tool Approval System
 * 
 * Manages human-in-the-loop approval workflow for tool execution.
 * VS Code-style approval UI integration via IPC.
 * 
 * Features:
 * - Risk-based approval requirements
 * - Approval request queue
 * - User preference storage (always allow/deny)
 * - Session-scoped approvals
 */

import { BrowserWindow } from 'electron';
import {
  ToolApprovalRequest,
  ToolApprovalResponse,
  ToolMetadata,
  ToolRiskLevel,
} from './types';

interface PendingApproval {
  request: ToolApprovalRequest;
  resolve: (response: ToolApprovalResponse) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

interface ApprovalPreference {
  toolName: string;
  preference: 'always-allow' | 'always-deny';
  setAt: number;
}

export class ApprovalSystem {
  private static instance: ApprovalSystem;
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  private preferences: Map<string, ApprovalPreference> = new Map();
  private sessionApprovals: Map<string, Set<string>> = new Map(); // sessionId -> tool names

  static getInstance(): ApprovalSystem {
    if (!ApprovalSystem.instance) {
      ApprovalSystem.instance = new ApprovalSystem();
    }
    return ApprovalSystem.instance;
  }

  /**
   * Check if a tool requires approval based on risk level and preferences.
   * - safe: auto-allow (read-only operations)
   * - review: show approval UI before execution
   * - dangerous: always require explicit approval
   */
  requiresApproval(
    toolName: string,
    riskLevel: ToolRiskLevel,
    sessionId?: string
  ): boolean {
    // Always-allow preference bypasses approval
    const preference = this.preferences.get(toolName);
    if (preference?.preference === 'always-allow') {
      return false;
    }
    if (preference?.preference === 'always-deny') {
      return true;
    }

    // Session-approved tools don't need approval again
    if (sessionId) {
      const sessionTools = this.sessionApprovals.get(sessionId);
      if (sessionTools?.has(toolName)) {
        return false;
      }
    }

    // Risk-based requirements
    switch (riskLevel) {
      case 'safe':      return false; // Auto-allow: read operations
      case 'review':    return true;  // Show preview: write operations
      case 'dangerous': return true;  // Require explicit approval: destructive ops
      default:          return true;
    }
  }

  /**
   * Request approval for a tool execution
   * Returns a promise that resolves when user responds
   */
  async requestApproval(
    toolName: string,
    metadata: ToolMetadata,
    args: unknown,
    target: string,
    impactAssessment?: string
  ): Promise<ToolApprovalResponse> {
    const requestId = `approval-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const request: ToolApprovalRequest = {
      requestId,
      toolName,
      category: metadata.category,
      riskLevel: metadata.riskLevel,
      description: metadata.description,
      args,
      target,
      impactAssessment,
      timestamp: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const pending: PendingApproval = {
        request,
        resolve,
        reject,
        timestamp: Date.now(),
      };

      this.pendingApprovals.set(requestId, pending);

      // Send approval request to renderer via IPC
      this.notifyRenderer(request);

      // Set timeout (2 minutes)
      setTimeout(() => {
        if (this.pendingApprovals.has(requestId)) {
          this.pendingApprovals.delete(requestId);
          reject(new Error('Approval request timed out'));
        }
      }, 120_000);
    });
  }

  /**
   * Handle approval response from renderer
   */
  handleApprovalResponse(response: ToolApprovalResponse): void {
    const pending = this.pendingApprovals.get(response.requestId);
    if (!pending) {
      console.warn(`[ApprovalSystem] No pending approval for ${response.requestId}`);
      return;
    }

    this.pendingApprovals.delete(response.requestId);

    // Store preferences if specified
    if (response.approved && response.approvalType === 'always') {
      this.setPreference(pending.request.toolName, 'always-allow');
    }

    // Store session approval
    if (response.approved && response.approvalType === 'session') {
      // sessionId would need to be tracked - placeholder for now
      const sessionId = 'current-session';
      if (!this.sessionApprovals.has(sessionId)) {
        this.sessionApprovals.set(sessionId, new Set());
      }
      this.sessionApprovals.get(sessionId)!.add(pending.request.toolName);
    }

    pending.resolve(response);
  }

  /**
   * Set user preference for a tool
   */
  setPreference(toolName: string, preference: 'always-allow' | 'always-deny'): void {
    this.preferences.set(toolName, {
      toolName,
      preference,
      setAt: Date.now(),
    });
    console.log(`[ApprovalSystem] Set preference: ${toolName} → ${preference}`);
  }

  /**
   * Get user preference for a tool
   */
  getPreference(toolName: string): 'always-allow' | 'always-deny' | undefined {
    return this.preferences.get(toolName)?.preference;
  }

  /**
   * Clear preference for a tool
   */
  clearPreference(toolName: string): void {
    this.preferences.delete(toolName);
  }

  /**
   * Clear all preferences
   */
  clearAllPreferences(): void {
    this.preferences.clear();
  }

  /**
   * Clear session approvals
   */
  clearSessionApprovals(sessionId?: string): void {
    if (sessionId) {
      this.sessionApprovals.delete(sessionId);
    } else {
      this.sessionApprovals.clear();
    }
  }

  /**
   * Get pending approval count
   */
  get pendingCount(): number {
    return this.pendingApprovals.size;
  }

  /**
   * Send approval request to renderer
   */
  private notifyRenderer(request: ToolApprovalRequest): void {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.webContents.send('tool:approval-request', request);
      console.log(`[ApprovalSystem] Sent approval request: ${request.requestId}`);
    } else {
      console.error('[ApprovalSystem] No main window available for approval request');
    }
  }

  /**
   * Load preferences from storage (placeholder - will implement persistence)
   */
  async loadPreferences(): Promise<void> {
    // TODO: Load from file or database
    console.log('[ApprovalSystem] Preferences loaded (placeholder)');
  }

  /**
   * Save preferences to storage (placeholder - will implement persistence)
   */
  async savePreferences(): Promise<void> {
    // TODO: Save to file or database
    console.log('[ApprovalSystem] Preferences saved (placeholder)');
  }
}

export const approvalSystem = ApprovalSystem.getInstance();
