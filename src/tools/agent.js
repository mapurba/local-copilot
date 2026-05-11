/**
 * Agent Tools
 * Delegate tasks and coordinate multi-step work across named sub-agents.
 * State is session-scoped (in-memory, reset on server restart).
 */

const agentStore = new Map();
let taskCounter = 0;

/**
 * Delegate a task to a named agent.
 * @param {string} agentName    Name of the agent (e.g. "Explore", "Implement")
 * @param {string} description  What the agent should do
 * @param {string} [context]    Optional extra context
 * @param {string[]} [subtasks] Optional ordered subtask list
 * @param {'low'|'medium'|'high'} [priority]
 */
function delegateTask(agentName, description, context, subtasks, priority = 'medium') {
  taskCounter++;
  const taskId = `task-${String(taskCounter).padStart(3, '0')}`;
  const now = Date.now();
  const task = { taskId, agentName, description, context, subtasks, priority, status: 'pending', createdAt: now, updatedAt: now };
  agentStore.set(taskId, task);
  return { task, message: `Task ${taskId} delegated to agent "${agentName}": ${description}` };
}

/**
 * Update the status (and optional result) of a task.
 * @param {string} taskId
 * @param {string} status
 * @param {string} [result]
 */
function updateAgentTask(taskId, status, result) {
  const task = agentStore.get(taskId);
  if (!task) return { task: null, message: `Task ${taskId} not found` };
  task.status = status;
  task.updatedAt = Date.now();
  if (result !== undefined) task.result = result;
  return { task, message: `Task ${taskId} updated to "${status}"` };
}

/**
 * List tasks, optionally filtered.
 * @param {string} [agentName]
 * @param {string} [status]
 */
function listAgentTasks(agentName, status) {
  let tasks = Array.from(agentStore.values());
  if (agentName) tasks = tasks.filter((t) => t.agentName === agentName);
  if (status)    tasks = tasks.filter((t) => t.status === status);
  tasks.sort((a, b) => a.createdAt - b.createdAt);
  return { tasks, total: tasks.length };
}

/** Clear all agent tasks. */
function clearAgentTasks() {
  const count = agentStore.size;
  agentStore.clear();
  taskCounter = 0;
  return { message: `Cleared ${count} agent task(s)` };
}

module.exports = { delegateTask, updateAgentTask, listAgentTasks, clearAgentTasks };
