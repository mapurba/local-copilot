/**
 * Tools Module Entry Point
 * 
 * Exports:
 * - Tool registry singleton
 * - Approval system
 * - Permissions manager
 * - Types
 * - Initialization function
 */

export * from './types';
export * from './registry';
export * from './approvalSystem';
export * from './sessionPermissions';

// Re-export singletons for convenience
export { toolRegistry, initializeDefaultTools } from './registry';
export { approvalSystem } from './approvalSystem';
export { permissionsManager } from './sessionPermissions';
