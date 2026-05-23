/**
 * Central Tool Registry
 * 
 * Manages registration, discovery, and execution of all tools.
 * Supports:
 * - Category-based organization
 * - Risk-based approval workflow
 * - Session-based permissions
 * - Local and remote execution
 * - Tool metadata and schema
 */

import {
  ToolMetadata,
  ToolHandler,
  RegisteredTool,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolCategory,
  ToolListResponse,
  ToolRiskLevel,
} from './types';

export class ToolRegistry {
  private tools: Map<string, RegisteredTool<unknown, unknown>> = new Map();
  private initialized = false;

  /**
   * Get the singleton instance
   */
  private static instance: ToolRegistry;
  
  static getInstance(): ToolRegistry {
    if (!ToolRegistry.instance) {
      ToolRegistry.instance = new ToolRegistry();
    }
    return ToolRegistry.instance;
  }

  /**
   * Register a tool
   */
  register<T = unknown, R = unknown>(
    name: string,
    handler: ToolHandler<T, R>,
    metadata: Omit<ToolMetadata, 'name'>
  ): void {
    if (this.tools.has(name)) {
      console.warn(`[ToolRegistry] Tool '${name}' already registered, overwriting...`);
    }

    const tool: RegisteredTool<unknown, unknown> = {
      metadata: { name, ...metadata },
      handler: handler as ToolHandler<unknown, unknown>,
      registeredAt: Date.now(),
    };

    this.tools.set(name, tool);
    console.log(`[ToolRegistry] ✓ Registered ${name} (${metadata.category}, ${metadata.riskLevel})`);
  }

  /**
   * Unregister a tool
   */
  unregister(name: string): boolean {
    const deleted = this.tools.delete(name);
    if (deleted) {
      console.log(`[ToolRegistry] ✗ Unregistered ${name}`);
    }
    return deleted;
  }

  /**
   * Check if a tool exists
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get tool metadata
   */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Execute a tool
   */
  async execute<T = unknown, R = unknown>(
    request: ToolExecutionRequest<T>
  ): Promise<ToolExecutionResult<R>> {
    const startTime = Date.now();
    const { toolName, args, context } = request;

    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        success: false,
        error: `Tool '${toolName}' not found. Available: ${this.listNames().join(', ')}`,
        executionTime: Date.now() - startTime,
      };
    }

    try {
      // Check if approval is required (will be enhanced with approval system)
      if (tool.metadata.requiresApproval && !context?.approved) {
        return {
          success: false,
          requiresApproval: true,
          error: 'Tool requires approval before execution',
          executionTime: Date.now() - startTime,
        };
      }

      // Execute the tool
      const result = await Promise.resolve(tool.handler(args, context));

      return {
        success: true,
        result: result as R,
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      console.error(`[ToolRegistry] Error executing '${toolName}':`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime,
      };
    }
  }

  /**
   * List all registered tools
   */
  list(category?: ToolCategory): ToolListResponse {
    const allTools = Array.from(this.tools.values());
    const filtered = category
      ? allTools.filter((t) => t.metadata.category === category)
      : allTools;

    return {
      tools: filtered.map((t) => ({
        name: t.metadata.name,
        category: t.metadata.category,
        description: t.metadata.description,
        target: t.metadata.target,
        riskLevel: t.metadata.riskLevel,
        available: true, // Will be enhanced with permission checks
      })),
      totalCount: filtered.length,
    };
  }

  /**
   * List tool names only
   */
  listNames(category?: ToolCategory): string[] {
    return this.list(category).tools.map((t) => t.name);
  }

  /**
   * List tools by category
   */
  listByCategory(): Map<ToolCategory, string[]> {
    const byCategory = new Map<ToolCategory, string[]>();
    
    for (const tool of this.tools.values()) {
      const category = tool.metadata.category;
      if (!byCategory.has(category)) {
        byCategory.set(category, []);
      }
      byCategory.get(category)!.push(tool.metadata.name);
    }

    return byCategory;
  }

  /**
   * List tools by risk level
   */
  listByRiskLevel(riskLevel: ToolRiskLevel): string[] {
    return Array.from(this.tools.values())
      .filter((t) => t.metadata.riskLevel === riskLevel)
      .map((t) => t.metadata.name);
  }

  /**
   * Get total registered tool count
   */
  get size(): number {
    return this.tools.size;
  }

  /**
   * Clear all registered tools
   */
  clear(): void {
    this.tools.clear();
    this.initialized = false;
    console.log('[ToolRegistry] Cleared all tools');
  }

  /**
   * Mark registry as initialized
   */
  setInitialized(value: boolean): void {
    this.initialized = value;
  }

  /**
   * Check if registry is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get tools for LangChain integration
   * Returns tools with Zod schemas for LangGraph binding
   */
  getToolsForLangChain(category?: ToolCategory): Array<{
    name: string;
    description: string;
    schema: unknown;
  }> {
    const tools = category
      ? Array.from(this.tools.values()).filter((t) => t.metadata.category === category)
      : Array.from(this.tools.values());

    return tools
      .filter((t) => t.metadata.schema) // Only tools with schemas
      .map((t) => ({
        name: t.metadata.name,
        description: t.metadata.description,
        schema: t.metadata.schema!,
      }));
  }
}

/**
 * Export singleton instance
 */
export const toolRegistry = ToolRegistry.getInstance();

/**
 * Initialize all default tools
 * This will be called once on app startup
 */
export async function initializeDefaultTools(): Promise<void> {
  if (toolRegistry.isInitialized()) {
    console.log('[ToolRegistry] Already initialized, skipping...');
    return;
  }

  console.log('\n[ToolRegistry] Initializing tool categories...\n');

  try {
    // Local tools (file, execute)
    const { registerLocalTools } = await import('./categories/local');
    registerLocalTools(toolRegistry);

    // VCD tools (VM management)
    const { registerVcdTools } = await import('./categories/vcd');
    registerVcdTools();

    // SSH tools (remote execution)
    const { registerSshTools } = await import('./categories/ssh');
    registerSshTools();

    // Document tools (upload, parse, search, Q&A)
    const { registerDocTools } = await import('./categories/docs');
    registerDocTools();

    // Deployment intelligence & orchestration tools
    const { registerDeploymentTools } = await import('./categories/deployment');
    registerDeploymentTools();

    toolRegistry.setInitialized(true);
    
    const byCategory = toolRegistry.listByCategory();
    console.log('\n[ToolRegistry] ✓ Initialization complete');
    console.log(`[ToolRegistry] Total tools: ${toolRegistry.size}`);
    
    for (const [category, tools] of byCategory.entries()) {
      console.log(`[ToolRegistry]   - ${category}: ${tools.length} tools`);
    }
    console.log('');
    
  } catch (error) {
    console.error('[ToolRegistry] ✗ Initialization failed:', error);
    throw error;
  }
}
