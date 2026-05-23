/**
 * Tool System Types
 * 
 * Defines all types for the unified tool registry supporting:
 * - Local and remote (SSH) execution
 * - Human-in-the-loop approval
 * - Session-based permissions
 * - Risk classification
 */

/**
 * Tool execution target - where the tool runs
 */
export type ToolTarget = 'local' | 'remote' | 'both';

/**
 * Tool risk level for approval system
 */
export type ToolRiskLevel = 
  | 'safe'       // Auto-allow, no approval needed (read operations)
  | 'review'     // Show preview before execution (write operations)
  | 'dangerous'; // Require explicit approval (destructive operations)

/**
 * Tool category for organization and permissions
 */
export type ToolCategory = 
  | 'vcd'        // VMware Cloud Director operations
  | 'ssh'        // Remote SSH execution
  | 'local'      // Local file/command operations
  | 'agent'      // Agent delegation
  | 'browser'    // HTTP/web operations
  | 'todo'       // Task management
  | 'docs'       // Document search/retrieval
  | 'deployment'; // Deployment intelligence & orchestration

/**
 * Tool execution status
 */
export type ToolExecutionStatus = 'pending' | 'approved' | 'denied' | 'executing' | 'completed' | 'failed';

/**
 * Tool metadata for registration
 */
export interface ToolMetadata {
  name: string;
  category: ToolCategory;
  description: string;
  target: ToolTarget;
  riskLevel: ToolRiskLevel;
  requiresApproval?: boolean; // Override based on session settings
  schema?: unknown; // Zod schema for LangChain integration
}

/**
 * Tool handler function signature
 */
export type ToolHandler<T = unknown, R = unknown> = (args: T, context?: ToolExecutionContext) => Promise<R> | R;

/**
 * Execution context passed to tool handlers
 */
export interface ToolExecutionContext {
  sessionId?: string;
  userId?: string;
  target?: 'local' | string; // 'local' or remote VM identifier
  sshSession?: string; // SSH session ID for remote tools
  workspacePath?: string;
  approved?: boolean; // Whether human approval was granted
  approvalMetadata?: {
    approvedBy?: string;
    approvedAt?: number;
    approvalType?: 'once' | 'session' | 'always';
  };
}

/**
 * Registered tool with metadata and handler
 */
export interface RegisteredTool<T = unknown, R = unknown> {
  metadata: ToolMetadata;
  handler: ToolHandler<T, R>;
  registeredAt: number;
}

/**
 * Tool execution request
 */
export interface ToolExecutionRequest<T = unknown> {
  toolName: string;
  args: T;
  context?: ToolExecutionContext;
  requestId?: string;
}

/**
 * Tool execution result
 */
export interface ToolExecutionResult<R = unknown> {
  success: boolean;
  result?: R;
  error?: string;
  executionTime?: number;
  requiresApproval?: boolean;
  approvalRequest?: ToolApprovalRequest;
}

/**
 * Approval request for human-in-the-loop
 */
export interface ToolApprovalRequest {
  requestId: string;
  toolName: string;
  category: ToolCategory;
  riskLevel: ToolRiskLevel;
  description: string;
  args: unknown;
  target: string; // 'local' or remote VM name/IP
  impactAssessment?: string;
  timestamp: number;
}

/**
 * Approval response from user
 */
export interface ToolApprovalResponse {
  requestId: string;
  approved: boolean;
  approvalType?: 'once' | 'session' | 'always';
  denialReason?: string;
}

/**
 * Session permission state
 */
export type PermissionState = 
  | 'disabled'              // Tools not available
  | 'enabled-with-approval' // Ask before dangerous operations
  | 'enabled-auto'          // Auto-approve reviewed tools
  | 'enabled-trusted';      // Auto-approve all (explicit trust)

/**
 * Session permissions configuration
 */
export interface SessionPermissions {
  sessionId: string;
  globalState: PermissionState;
  categoryPermissions?: Partial<Record<ToolCategory, PermissionState>>;
  alwaysAllowTools?: string[]; // Tool names that are always allowed
  alwaysDenyTools?: string[]; // Tool names that are always denied
  createdAt: number;
  expiresAt?: number;
}

/**
 * Tool list response
 */
export interface ToolListResponse {
  tools: Array<{
    name: string;
    category: ToolCategory;
    description: string;
    target: ToolTarget;
    riskLevel: ToolRiskLevel;
    available: boolean;
  }>;
  totalCount: number;
}

/**
 * SSH session info for remote tools
 */
export interface SSHSessionInfo {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  connected: boolean;
  connectedAt?: number;
  lastActivity?: number;
}

/**
 * Tool execution log entry
 */
export interface ToolExecutionLog {
  id: string;
  toolName: string;
  category: ToolCategory;
  args: unknown;
  result?: unknown;
  error?: string;
  target: string;
  executionTime: number;
  timestamp: number;
  approved: boolean;
  approvalType?: 'once' | 'session' | 'always';
  userId?: string;
  sessionId?: string;
}
