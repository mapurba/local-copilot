// Renderer process: trigger update check via IPC
export function checkForAppUpdate() {
  if (window.copilot && window.copilot.checkForUpdate) {
    window.copilot.checkForUpdate();
  } else {
    alert('Update check not supported in this build.');
  }
}
