/**
 * Tools module entry point.
 * Exports the registry singleton and initializeDefaultTools().
 */
const { toolRegistry, initializeDefaultTools } = require('./registry');

module.exports = { toolRegistry, initializeDefaultTools };
