/**
 * Tools Registry
 *
 * Simple, lightweight tool registration system.
 * Makes it easy to add, manage, and call tools from IPC handlers.
 *
 * Usage:
 *   toolRegistry.register('custom:myTool', handler, 'category', 'description');
 *   toolRegistry.call('custom:myTool', arg1, arg2);
 */

import * as mathTools from './math';
import * as readTools from './read';
import * as searchTools from './search';
import * as editTools from './edit';
import * as executeTools from './execute';
import * as todoTools from './todo';
import * as browserTools from './browser';
import * as agentTools from './agent';

type ToolHandler = (...args: unknown[]) => Promise<unknown> | unknown;

interface Tool {
  handler: ToolHandler;
  category: string;
  description: string;
}

interface ToolSummary {
  name: string;
  category: string;
  description: string;
}

class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  get size(): number {
    return this.tools.size;
  }

  register<TArgs extends unknown[], TResult>(
    name: string,
    handler: (...args: TArgs) => TResult | Promise<TResult>,
    category: string,
    description: string
  ) {
    this.tools.set(name, { handler: handler as ToolHandler, category, description });
    console.log(`[Tools] ✓ ${name} (${category})`);
  }

  async call<TResult = unknown>(name: string, ...args: unknown[]): Promise<TResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool '${name}' not found. Use toolRegistry.list() to see available tools.`);
    }
    try {
      return await Promise.resolve(tool.handler(...args)) as TResult;
    } catch (err) {
      console.error(`[Tools] Error calling '${name}':`, err);
      throw err;
    }
  }

  list(): ToolSummary[] {
    return Array.from(this.tools.entries()).map(([name, tool]) => ({
      name,
      category: tool.category,
      description: tool.description,
    }));
  }

  listByCategory(category: string): ToolSummary[] {
    return this.list().filter((t) => t.category === category);
  }
}

export const toolRegistry = new ToolRegistry();

/**
 * Initialize all available tools
 */
export function initializeDefaultTools() {
  if (toolRegistry.size > 0) {
    return;
  }

  console.log('\n[Tools] Initializing...');

  // ── read ─────────────────────────────────────────────────────────────────
  toolRegistry.register(
    'custom:readFile',
    readTools.readFile,
    'read',
    'Read file contents with optional offset/limit (max 2000 lines per call)'
  );
  toolRegistry.register(
    'custom:listDir',
    readTools.listDir,
    'read',
    'List directory contents with type and size info'
  );

  // ── search ───────────────────────────────────────────────────────────────
  toolRegistry.register(
    'custom:findFiles',
    searchTools.findFiles,
    'search',
    'Find files matching a glob pattern (e.g. **/*.ts, src/**)'
  );
  toolRegistry.register(
    'custom:findTextInFiles',
    searchTools.findTextInFiles,
    'search',
    'Search for text or regex pattern inside file contents'
  );

  // ── edit ─────────────────────────────────────────────────────────────────
  toolRegistry.register(
    'custom:createFile',
    editTools.createFile,
    'edit',
    'Create a new file (fails if it already exists)'
  );
  toolRegistry.register(
    'custom:writeFile',
    editTools.writeFile,
    'edit',
    'Write or overwrite a file with new content'
  );
  toolRegistry.register(
    'custom:replaceStringInFile',
    editTools.replaceStringInFile,
    'edit',
    'Replace exactly one occurrence of a string in a file'
  );
  toolRegistry.register(
    'custom:multiReplaceStringInFile',
    editTools.multiReplaceStringInFile,
    'edit',
    'Apply multiple string replacements across one or more files atomically'
  );
  toolRegistry.register(
    'custom:deleteFile',
    editTools.deleteFile,
    'edit',
    'Delete a file permanently'
  );

  // ── execute ──────────────────────────────────────────────────────────────
  toolRegistry.register(
    'custom:runCommand',
    executeTools.runCommand,
    'execute',
    'Run a shell command and return stdout, stderr, and exit code'
  );

  // ── todo ─────────────────────────────────────────────────────────────────
  toolRegistry.register(
    'custom:manageTodoList',
    todoTools.manageTodoList,
    'todo',
    'Replace the entire todo list (at most 1 item in-progress at a time)'
  );
  toolRegistry.register(
    'custom:getTodoList',
    todoTools.getTodoList,
    'todo',
    'Return the current todo list without modifying it'
  );
  toolRegistry.register(
    'custom:clearTodoList',
    todoTools.clearTodoList,
    'todo',
    'Clear the entire todo list'
  );

  // ── browser ──────────────────────────────────────────────────────────────
  toolRegistry.register(
    'custom:fetchUrl',
    browserTools.fetchUrl,
    'browser',
    'Fetch a URL and return status, headers, and body (http/https)'
  );

  // ── agent ─────────────────────────────────────────────────────────────────
  toolRegistry.register(
    'custom:delegateTask',
    agentTools.delegateTask,
    'agent',
    'Delegate a task to a named agent for tracking and execution'
  );
  toolRegistry.register(
    'custom:updateAgentTask',
    agentTools.updateAgentTask,
    'agent',
    'Update the status and result of a delegated agent task'
  );
  toolRegistry.register(
    'custom:listAgentTasks',
    agentTools.listAgentTasks,
    'agent',
    'List delegated agent tasks, optionally filtered by agent name or status'
  );
  toolRegistry.register(
    'custom:clearAgentTasks',
    agentTools.clearAgentTasks,
    'agent',
    'Clear all agent tasks for the current session'
  );

  // ── math ─────────────────────────────────────────────────────────────────
  toolRegistry.register('custom:mathAdd', mathTools.mathAdd, 'math', 'Add: a + b');
  toolRegistry.register('custom:mathSubtract', mathTools.mathSubtract, 'math', 'Subtract: a - b');
  toolRegistry.register('custom:mathMultiply', mathTools.mathMultiply, 'math', 'Multiply: a * b');
  toolRegistry.register('custom:mathDivide', mathTools.mathDivide, 'math', 'Divide: a / b (safe)');
  toolRegistry.register('custom:mathSolveLinear', mathTools.mathSolveLinear, 'math', 'Solve linear: ax + b = 0');
  toolRegistry.register('custom:mathSolveLineEquation', mathTools.mathSolveLineEquation, 'math', 'Solve line equation: ax + b = c');
  toolRegistry.register(
    'custom:mathSolveQuadratic',
    mathTools.mathSolveQuadratic,
    'math',
    'Solve quadratic: ax² + bx + c = 0 (real & complex roots)'
  );
  toolRegistry.register('custom:mathEvaluatePolynomial', mathTools.mathEvaluatePolynomial, 'math', 'Evaluate polynomial at x');
  toolRegistry.register(
    'custom:mathFindPolynomialRoots',
    mathTools.mathFindPolynomialRoots,
    'math',
    'Find polynomial roots (Newton-Raphson)'
  );

  console.log(`[Tools] Ready: ${toolRegistry.list().length} tools loaded\n`);
}
