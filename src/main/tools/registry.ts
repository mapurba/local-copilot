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

interface Tool {
  handler: (...args: any[]) => Promise<any> | any;
  category: string;
  description: string;
}

class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(name: string, handler: (...args: any[]) => any, category: string, description: string) {
    this.tools.set(name, { handler, category, description });
    console.log(`[Tools] ✓ ${name} (${category})`);
  }

  async call(name: string, ...args: any[]): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool '${name}' not found. Use toolRegistry.list() to see available tools.`);
    }
    try {
      return await Promise.resolve(tool.handler(...args));
    } catch (err) {
      console.error(`[Tools] Error calling '${name}':`, err);
      throw err;
    }
  }

  list() {
    const items = Array.from(this.tools.entries()).map(([name, tool]) => ({
      name,
      category: tool.category,
      description: tool.description,
    }));
    return items;
  }

  listByCategory(category: string) {
    return this.list().filter((t) => t.category === category);
  }
}

export const toolRegistry = new ToolRegistry();

/**
 * Initialize all available tools
 */
export function initializeDefaultTools() {
  console.log('\n[Tools] Initializing...');

  // Arithmetic tools
  toolRegistry.register('custom:mathAdd', (a: number, b: number) => mathTools.mathAdd(a, b), 'math', 'Add: a + b');

  toolRegistry.register('custom:mathSubtract', (a: number, b: number) => mathTools.mathSubtract(a, b), 'math', 'Subtract: a - b');

  toolRegistry.register('custom:mathMultiply', (a: number, b: number) => mathTools.mathMultiply(a, b), 'math', 'Multiply: a * b');

  toolRegistry.register('custom:mathDivide', (a: number, b: number) => mathTools.mathDivide(a, b), 'math', 'Divide: a / b (safe)');

  // Equation solving
  toolRegistry.register('custom:mathSolveLinear', (a: number, b: number) => mathTools.mathSolveLinear(a, b), 'math', 'Solve linear: ax + b = 0');

  toolRegistry.register(
    'custom:mathSolveLineEquation',
    (a: number, b: number, c: number) => mathTools.mathSolveLineEquation(a, b, c),
    'math',
    'Solve line equation: ax + b = c'
  );

  toolRegistry.register(
    'custom:mathSolveQuadratic',
    (a: number, b: number, c: number) => mathTools.mathSolveQuadratic(a, b, c),
    'math',
    'Solve quadratic: ax² + bx + c = 0 (real & complex roots)'
  );

  // Polynomial tools
  toolRegistry.register(
    'custom:mathEvaluatePolynomial',
    (coefficients: number[], x: number) => mathTools.mathEvaluatePolynomial(coefficients, x),
    'math',
    'Evaluate polynomial at x'
  );

  toolRegistry.register(
    'custom:mathFindPolynomialRoots',
    (coefficients: number[], initialGuess?: number, iterations?: number) =>
      mathTools.mathFindPolynomialRoots(coefficients, initialGuess, iterations),
    'math',
    'Find polynomial roots (Newton-Raphson)'
  );

  console.log(`[Tools] Ready: ${toolRegistry.list().length} tools loaded\n`);
}
