/**
 * Workspace Context
 * Simple path resolver using process.cwd() as workspace root.
 */
const path = require('path');

const workspaceContext = {
  getWorkspacePath() {
    return process.cwd();
  },
  resolvePath(filePath) {
    if (path.isAbsolute(filePath)) return filePath;
    return path.resolve(process.cwd(), filePath);
  },
  relativePath(fullPath) {
    return path.relative(process.cwd(), fullPath).replace(/\\/g, '/');
  },
};

module.exports = { workspaceContext };
