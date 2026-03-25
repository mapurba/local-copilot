/**
 * Agent Tools
 *
 * Delegate tasks and coordinate multi-step work across sub-agents.
 * Mirrors the VS Code Copilot "agent" tool category.
 *
 * In this local-copilot context, "agents" are named task scopes the LLM can
 * create, delegate work to, and track completion for — useful for decomposing
 * large requests into parallel or sequential workstreams.
 *
 * State is session-scoped (in-memory, reset on app restart).
 */

export type AgentTaskStatus = 'pending' | 'in-progress' | 'completed' | 'failed';
export type AgentPriority = 'low' | 'medium' | 'high';

export interface AgentTask {
  taskId: string;
  agentName: string;
  description: string;
  context?: string;
  subtasks?: string[];
  priority: AgentPriority;
  status: AgentTaskStatus;
  createdAt: number;
  updatedAt: number;
  result?: string;
}

export interface AgentResult {
  task: AgentTask;
  message: string;
}

export interface AgentListResult {
  tasks: AgentTask[];
  total: number;
  byStatus: Record<AgentTaskStatus, number>;
}

// Session-scoped in-memory store
const agentStore = new Map<string, AgentTask>();
let taskCounter = 0;

// ─── delegateTask ────────────────────────────────────────────────────────────

/**
 * Delegate a task to a named agent for tracking and execution.
 *
 * @param agentName   The agent to delegate to (e.g. "Explore", "Implement", "Review")
 * @param description Clear description of what the agent should accomplish
 * @param context     Optional additional context, constraints, or relevant file paths
 * @param subtasks    Optional ordered list of subtask descriptions
 * @param priority    Task urgency: "low" | "medium" | "high" (default: "medium")
 */
export function delegateTask(
  agentName: string,
  description: string,
  context?: string,
  subtasks?: string[],
  priority: AgentPriority = 'medium',
): AgentResult {
  taskCounter++;
  const taskId = `task-${taskCounter.toString().padStart(3, '0')}`;
  const now = Date.now();
  const task: AgentTask = {
    taskId,
    agentName,
    description,
    context,
    subtasks,
    priority,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  agentStore.set(taskId, task);
  return {
    task,
    message: `Task ${taskId} delegated to agent "${agentName}": ${description}`,
  };
}

// ─── updateAgentTask ─────────────────────────────────────────────────────────

/**
 * Update the status (and optional result) of a delegated task.
 *
 * @param taskId  The task ID returned by delegateTask
 * @param status  New status value
 * @param result  Optional result summary or output from the agent
 */
export function updateAgentTask(
  taskId: string,
  status: AgentTaskStatus,
  result?: string,
): AgentResult {
  const task = agentStore.get(taskId);
  if (!task) {
    return {
      task: {
        taskId,
        agentName: 'unknown',
        description: '',
        priority: 'medium',
        status: 'failed',
        createdAt: 0,
        updatedAt: 0,
      },
      message: `Task ${taskId} not found`,
    };
  }
  task.status = status;
  task.updatedAt = Date.now();
  if (result !== undefined) task.result = result;
  return { task, message: `Task ${taskId} updated to "${status}"` };
}

// ─── listAgentTasks ──────────────────────────────────────────────────────────

/**
 * List all delegated agent tasks, optionally filtered by agent name or status.
 *
 * @param agentName  Filter by agent name (omit for all agents)
 * @param status     Filter by task status (omit for all statuses)
 */
export function listAgentTasks(
  agentName?: string,
  status?: AgentTaskStatus,
): AgentListResult {
  let tasks = Array.from(agentStore.values());
  if (agentName) tasks = tasks.filter((t) => t.agentName === agentName);
  if (status) tasks = tasks.filter((t) => t.status === status);
  tasks.sort((a, b) => a.createdAt - b.createdAt);

  const byStatus: Record<AgentTaskStatus, number> = {
    pending: 0,
    'in-progress': 0,
    completed: 0,
    failed: 0,
  };
  for (const t of agentStore.values()) byStatus[t.status]++;

  return { tasks, total: tasks.length, byStatus };
}

// ─── clearAgentTasks ─────────────────────────────────────────────────────────

/**
 * Clear all delegated agent tasks for the current session.
 */
export function clearAgentTasks(): { message: string } {
  const count = agentStore.size;
  agentStore.clear();
  taskCounter = 0;
  return { message: `Cleared ${count} agent task${count === 1 ? '' : 's'}` };
}
