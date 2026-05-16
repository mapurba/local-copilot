/**
 * Local Tools Category
 * 
 * Exports all local file and command execution tools.
 */

import { ToolRegistry } from '../../registry';
import { registerLocalFileTools } from './file';
import { registerLocalExecuteTools } from './execute';

/**
 * Register all local category tools
 */
export function registerLocalTools(registry: ToolRegistry): void {
  console.log('[Local Tools] Registering...');
  registerLocalFileTools(registry);
  registerLocalExecuteTools(registry);
  console.log('[Local Tools] ✓ Registration complete');
}
