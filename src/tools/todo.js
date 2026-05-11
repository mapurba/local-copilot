/**
 * Todo Tools
 * Session-scoped in-memory todo list management.
 */

let sessionTodos = [];

/**
 * Replace the entire todo list with the provided items.
 * At most one item may be in-progress at a time.
 * @param {{ id: number, title: string, status: 'not-started'|'in-progress'|'completed' }[]} todoList
 */
function manageTodoList(todoList) {
  if (!Array.isArray(todoList)) {
    return { todos: sessionTodos, total: sessionTodos.length, message: 'Error: todoList must be an array' };
  }
  const inProgress = todoList.filter((t) => t.status === 'in-progress');
  if (inProgress.length > 1) {
    return { todos: sessionTodos, total: sessionTodos.length, message: `Error: at most 1 item can be in-progress. Found ${inProgress.length}.` };
  }
  const validStatuses = ['not-started', 'in-progress', 'completed'];
  for (const item of todoList) {
    if (!validStatuses.includes(item.status)) {
      return { todos: sessionTodos, total: sessionTodos.length, message: `Error: invalid status "${item.status}". Valid: ${validStatuses.join(', ')}` };
    }
  }
  sessionTodos = todoList.map((t, i) => ({ id: t.id ?? i + 1, title: t.title, status: t.status }));
  const done = sessionTodos.filter((t) => t.status === 'completed').length;
  const inProg = sessionTodos.filter((t) => t.status === 'in-progress').length;
  const notStarted = sessionTodos.filter((t) => t.status === 'not-started').length;
  return { todos: sessionTodos, total: sessionTodos.length, message: `Updated: ${done} done, ${inProg} in-progress, ${notStarted} not-started` };
}

/** Return the current todo list without modifying it. */
function getTodoList() {
  return { todos: sessionTodos, total: sessionTodos.length, message: sessionTodos.length === 0 ? 'Todo list is empty' : `${sessionTodos.length} item(s)` };
}

/** Clear the entire todo list. */
function clearTodoList() {
  sessionTodos = [];
  return { todos: [], total: 0, message: 'Todo list cleared' };
}

module.exports = { manageTodoList, getTodoList, clearTodoList };
