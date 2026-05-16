/**
 * SSH Category Index
 * Registers all SSH tools: session, command, file, system
 */

export { getActiveSession } from './session';
export { registerSshSessionTools } from './session';
export { registerSshCommandTools } from './command';
export { registerSshFileTools } from './file';
export { registerSshSystemTools } from './system';

export function registerSshTools() {
  const { registerSshSessionTools } = require('./session');
  const { registerSshCommandTools } = require('./command');
  const { registerSshFileTools } = require('./file');
  const { registerSshSystemTools } = require('./system');

  registerSshSessionTools();
  registerSshCommandTools();
  registerSshFileTools();
  registerSshSystemTools();

  console.log('[SSH Tools] Registered: session (3) + command (6) + file (8) + system (7) = 24 tools');
}
