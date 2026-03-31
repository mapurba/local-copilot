/**
 * Todo Tools
 *
 * Manage and track todo items for task planning during a session.
 * Mirrors the VS Code Copilot "todo" tool category (manage_todo_list).
 *
 * State is session-scoped (in-memory, reset on app restart).
 * The canonical usage is to pass the COMPLETE updated list on every call
 * so the store always reflects the current desired state.
 */

export type TodoStatus = 'not-started' | 'in-progress' | 'completed';

export interface TodoItem {
  id: number;
  title: string;
  status: TodoStatus;
}

export interface TodoResult {
  todos: TodoItem[];
  total: number;
  message: string;
}

// Session-scoped in-memory store
let sessionTodos: TodoItem[] = [];

// ─── manageTodoList ──────────────────────────────────────────────────────────

/**
 * Replace the entire todo list with the provided items.
 *
 * Rules enforced:
 * - At most one item may have status "in-progress" at a time.
 * - Each item must have a numeric id, a title string, and a valid status.
 *
 * @param todoList The complete updated list of todo items
 */
export function manageTodoList(todoList: TodoItem[]): TodoResult {
  if (!Array.isArray(todoList)) {
    return {
      todos: sessionTodos,
      total: sessionTodos.length,
      message: 'Error: todoList must be an array',
    };
  }

  const inProgress = todoList.filter((t) => t.status === 'in-progress');
  if (inProgress.length > 1) {
    return {
      todos: sessionTodos,
      total: sessionTodos.length,
      message: `Error: at most 1 item can be in-progress at a time. Found ${inProgress.length}: ${inProgress.map((t) => `#${t.id} "${t.title}"`).join(', ')}`,
    };
  }

  const validStatuses: TodoStatus[] = ['not-started', 'in-progress', 'completed'];
  for (const item of todoList) {
    if (!validStatuses.includes(item.status)) {
      return {
        todos: sessionTodos,
        total: sessionTodos.length,
        message: `Error: invalid status "${item.status}" on item #${item.id}. Valid values: ${validStatuses.join(', ')}`,
      };
    }
  }

  sessionTodos = todoList.map((t, i) => ({
    id: t.id ?? i + 1,
    title: t.title,
    status: t.status,
  }));

  const notStarted = sessionTodos.filter((t) => t.status === 'not-started').length;
  const inProg = sessionTodos.filter((t) => t.status === 'in-progress').length;
  const done = sessionTodos.filter((t) => t.status === 'completed').length;

  return {
    todos: sessionTodos,
    total: sessionTodos.length,
    message: `Todo list updated: ${sessionTodos.length} items (${done} completed, ${inProg} in-progress, ${notStarted} not-started)`,
  };
}

// ─── getTodoList ─────────────────────────────────────────────────────────────

/**
 * Return the current todo list without modifying it.
 */
export function getTodoList(): TodoResult {
  return {
    todos: sessionTodos,
    total: sessionTodos.length,
    message:
      sessionTodos.length === 0
        ? 'Todo list is empty'
        : `${sessionTodos.length} item${sessionTodos.length === 1 ? '' : 's'} in todo list`,
  };
}

// ─── clearTodoList ───────────────────────────────────────────────────────────

/**
 * Clear the entire todo list.
 */
export function clearTodoList(): TodoResult {
  sessionTodos = [];
  return { todos: [], total: 0, message: 'Todo list cleared' };
}
