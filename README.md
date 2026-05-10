## Design Overview

This project is a minimal Electron + Angular desktop client for GitHub Copilot chat, designed for extensibility and clarity:

- **Architecture**:  
  - Electron provides the desktop shell.  
  - Angular powers the renderer/UI.  
  - The main process handles authentication, IPC, chat streaming, and tool execution.  
  - The preload script securely exposes APIs to the renderer via `window.copilot`.

- **Tool System**:  
  - Tools are simple functions registered in the main process and can be called by the LLM or UI.  
  - All file operations are sandboxed to a configurable workspace directory.  
  - Adding new tools is as simple as creating a file in `src/main/tools/` and registering it.

- **Authentication**:  
  - Supports GitHub Copilot authentication via device code flow or token.

- **Debug Panel**:  
  - Real-time display of tool calls, LLM thinking chains, and API logs.  
  - Toggleable and resizable in the UI.

- **Development**:  
  - Hot reload for both Angular and Electron processes.  
  - All IPC, preload, and service wiring for tools is already in place.
