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
