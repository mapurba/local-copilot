/**
 * Session Permissions System
 * 
 * Manages session-based tool access control.
 * Similar to Copilot's "Use tools for this session" feature.
 * 
 * Permission States:
 * - disabled: Tools not available
 * - enabled-with-approval: Ask before dangerous operations
 * - enabled-auto: Auto-approve reviewed tools for session
 * - enabled-trusted: Auto-approve all (explicit user trust)
 */

import {
  SessionPermissions,
  PermissionState,
  ToolCategory,
  ToolRiskLevel,
} from './types';

export class PermissionsManager {
  private static instance: PermissionsManager;
  private sessions: Map<string, SessionPermissions> = new Map();
  private currentSessionId: string | null = null;

  static getInstance(): PermissionsManager {
    if (!PermissionsManager.instance) {
      PermissionsManager.instance = new PermissionsManager();
    }
    return PermissionsManager.instance;
  }

  /**
   * Initialize a new session
   */
  initializeSession(sessionId?: string): string {
    const id = sessionId || `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    
    const permissions: SessionPermissions = {
      sessionId: id,
      globalState: 'enabled-with-approval', // Default: ask before dangerous ops
      categoryPermissions: {},
      alwaysAllowTools: [],
      alwaysDenyTools: [],
      createdAt: Date.now(),
    };

    this.sessions.set(id, permissions);
    this.currentSessionId = id;
    
    console.log(`[PermissionsManager] Initialized session: ${id}`);
    return id;
  }

  /**
   * Get current session
   */
  getCurrentSession(): SessionPermissions | null {
    if (!this.currentSessionId) {
      return null;
    }
    return this.sessions.get(this.currentSessionId) || null;
  }

  /**
   * Set global permission state for session
   */
  setGlobalState(sessionId: string, state: PermissionState): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn(`[PermissionsManager] Session not found: ${sessionId}`);
      return;
    }

    session.globalState = state;
    console.log(`[PermissionsManager] Set global state for ${sessionId}: ${state}`);
  }

  /**
   * Set category-specific permission for session
   */
  setCategoryPermission(
    sessionId: string,
    category: ToolCategory,
    state: PermissionState
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn(`[PermissionsManager] Session not found: ${sessionId}`);
      return;
    }

    if (!session.categoryPermissions) {
      session.categoryPermissions = {};
    }
    session.categoryPermissions[category] = state;
    
    console.log(`[PermissionsManager] Set ${category} permission for ${sessionId}: ${state}`);
  }

  /**
   * Check if a tool is allowed to execute
   */
  isToolAllowed(
    toolName: string,
    category: ToolCategory,
    riskLevel: ToolRiskLevel,
    sessionId?: string
  ): {
    allowed: boolean;
    requiresApproval: boolean;
    reason?: string;
  } {
    const session = sessionId
      ? this.sessions.get(sessionId)
      : this.getCurrentSession();

    if (!session) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: 'No active session',
      };
    }

    // Check always deny list
    if (session.alwaysDenyTools?.includes(toolName)) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: 'Tool is in always-deny list',
      };
    }

    // Check always allow list
    if (session.alwaysAllowTools?.includes(toolName)) {
      return {
        allowed: true,
        requiresApproval: false,
      };
    }

    // Get effective permission state (category-specific or global)
    const effectiveState = 
      session.categoryPermissions?.[category] || session.globalState;

    // Determine based on state and risk level
    switch (effectiveState) {
      case 'disabled':
        return {
          allowed: false,
          requiresApproval: false,
          reason: 'Tools are disabled for this session',
        };

      case 'enabled-with-approval':
        // Safe tools auto-allowed, others require approval
        if (riskLevel === 'safe') {
          return { allowed: true, requiresApproval: false };
        }
        return { allowed: true, requiresApproval: true };

      case 'enabled-auto':
        // Safe and review tools auto-allowed, dangerous requires approval
        if (riskLevel === 'dangerous') {
          return { allowed: true, requiresApproval: true };
        }
        return { allowed: true, requiresApproval: false };

      case 'enabled-trusted':
        // All tools auto-allowed
        return { allowed: true, requiresApproval: false };

      default:
        return {
          allowed: false,
          requiresApproval: false,
          reason: 'Unknown permission state',
        };
    }
  }

  /**
   * Add tool to always-allow list
   */
  addToAlwaysAllow(sessionId: string, toolName: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (!session.alwaysAllowTools) {
      session.alwaysAllowTools = [];
    }
    
    if (!session.alwaysAllowTools.includes(toolName)) {
      session.alwaysAllowTools.push(toolName);
    }

    // Remove from deny list if present
    if (session.alwaysDenyTools) {
      session.alwaysDenyTools = session.alwaysDenyTools.filter(t => t !== toolName);
    }

    console.log(`[PermissionsManager] Added ${toolName} to always-allow list`);
  }

  /**
   * Add tool to always-deny list
   */
  addToAlwaysDeny(sessionId: string, toolName: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (!session.alwaysDenyTools) {
      session.alwaysDenyTools = [];
    }
    
    if (!session.alwaysDenyTools.includes(toolName)) {
      session.alwaysDenyTools.push(toolName);
    }

    // Remove from allow list if present
    if (session.alwaysAllowTools) {
      session.alwaysAllowTools = session.alwaysAllowTools.filter(t => t !== toolName);
    }

    console.log(`[PermissionsManager] Added ${toolName} to always-deny list`);
  }

  /**
   * Clear session (on app restart or explicit logout)
   */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }
    console.log(`[PermissionsManager] Cleared session: ${sessionId}`);
  }

  /**
   * Clear all sessions
   */
  clearAllSessions(): void {
    this.sessions.clear();
    this.currentSessionId = null;
    console.log('[PermissionsManager] Cleared all sessions');
  }

  /**
   * Get all sessions
   */
  getAllSessions(): SessionPermissions[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get session count
   */
  get sessionCount(): number {
    return this.sessions.size;
  }
}

export const permissionsManager = PermissionsManager.getInstance();
