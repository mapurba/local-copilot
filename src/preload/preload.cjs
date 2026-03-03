const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('copilot', {
  status: () => ipcRenderer.invoke('copilot:status'),
  signIn: () => ipcRenderer.invoke('copilot:signIn'),
  signInConfirm: (userCode) => ipcRenderer.invoke('copilot:signInConfirm', userCode),
  signOut: () => ipcRenderer.invoke('copilot:signOut'),
  getModels: () => ipcRenderer.invoke('copilot:getModels'),
  sendChatMessage: (modelId, messages) =>
    ipcRenderer.invoke('copilot:sendChatMessage', modelId, messages),
  onChatStream: (callback) => {
    ipcRenderer.on('chat:stream-chunk', callback);
    return () => ipcRenderer.removeListener('chat:stream-chunk', callback);
  },
  onChatEnd: (callback) => {
    ipcRenderer.on('chat:stream-end', callback);
    return () => ipcRenderer.removeListener('chat:stream-end', callback);
  },
  onChatError: (callback) => {
    ipcRenderer.on('chat:stream-error', callback);
    return () => ipcRenderer.removeListener('chat:stream-error', callback);
  },
});
