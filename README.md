# Copilot Chat

Minimal Electron + Angular desktop client for GitHub Copilot chat with advanced PRD-to-BPMN workflow conversion capabilities.

## ✨ Features

- **GitHub Copilot Integration**: Chat with Copilot, streaming responses
- **PRD Conversion Engine**: Transform legacy PRD XML to modern BPMN 2.0 workflows
- **AI-Powered Summarization**: Auto-generate workflow summaries with GPT-4
- **Forms Generation**: Extract and generate form schemas from PRD definitions
- **Workflow Visualization**: View BPMN diagrams and form previews
- **File Management**: Browse and manage converted artifacts

## Quick Start

```bash
# Install dependencies
npm install

# Development mode
npm run dev

# Build renderer
npm run build

# Build Electron package
npm run build:electron
```

## 📚 Documentation

### User Guides
- [Quick Start Developer Guide](docs/QUICKSTART_DEVELOPER_GUIDE.md) - 5-minute overview and common tasks
- [PRD to BPMN Conversion](docs/PRD_TO_BPMN_CONVERSION.md) - Complete conversion pipeline reference
- [Setup Guide](docs/GETTING_STARTED.md) - Initial project setup

### Technical Documentation
- [Implementation Architecture](docs/IMPLEMENTATION_ARCHITECTURE.md) - Deep technical implementation details
- [Custom Tools Guide](docs/CUSTOM_TOOLS_GUIDE.md) - Extend Copilot capabilities
- [Code Fixes Summary](docs/CODE_FIXES_SUMMARY.md) - Security and quality improvements (2026-07-21)

### Reference
- [Thinking Logs Quick Reference](docs/THINKING_LOGS_QUICK_REFERENCE.md) - Copilot thinking traces
- [Log Deduplication Summary](docs/LOG_DEDUPLICATION_SUMMARY.md) - Debug log utilities

## 🔄 PRD Conversion Workflow

### Overview

The application includes a sophisticated workflow conversion engine that:

1. **Parses** legacy PRD (Process Request Definition) XML files
2. **Extracts** process structure, forms, data items, and transitions
3. **Generates** modern BPMN 2.0 workflow definitions
4. **Creates** JSON form schemas with validation rules
5. **Optionally summarizes** with AI (GPT-4) for human-friendly documentation

### Quick Example

```typescript
import { ipcRenderer } from 'electron';

// Convert a PRD file to BPMN + forms
const result = await ipcRenderer.invoke('workflow:convertPrd', {
  content: prdXmlString,           // Or: filePath: '/path/to/process.xml'
  modelId: 'gpt-4-turbo',          // Optional: enables AI summarization
  fileName: 'my-process.xml'
});

if (result.success) {
  console.log(`✓ Saved to: ${result.outputDir}`);
  console.log(`  BPMN Workflow: ${result.workflows[0]}`);
  console.log(`  Forms Schema: ${result.forms[0]}`);
  console.log(`  Summary: ${result.summaries[0]}`);
}
```

### Output Structure

```
workflow-agent/output/converted-prd-{timestamp}/
├── decoded-0.xml           # Original PRD (formatted)
├── workflow-0.xml          # BPMN 2.0 workflow
├── forms-0.json            # Forms array
├── forms-0/
│   ├── form1.json          # Individual form schemas
│   └── form2.json
├── summary-0.md            # AI-generated summary (if LLM enabled)
└── todo-0.md               # Extracted action items
```

### Key Capabilities

| Feature | Capability |
|---------|-----------|
| PRD Parsing | Extracts activities, forms, data items, transitions |
| BPMN Generation | Maps PRD elements to BPMN 2.0 standard format |
| Form Extraction | Creates JSON schemas with field types and validation |
| AI Summarization | Generates technical and beginner-friendly documentation |
| Batch Processing | Convert multiple PRDs in sequence or parallel |
| Progress Tracking | Real-time conversion progress with stage reporting |

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────┐
│     User Interface (Angular)                     │
│  • Copilot chat component                        │
│  • PRD converter UI                              │
│  • BPMN diagram viewer                           │
│  • Form preview                                  │
└────────────────┬─────────────────────────────────┘
                 │ IPC
                 ▼
┌──────────────────────────────────────────────────┐
│     Electron Main Process                        │
│  • GitHub Copilot API integration                │
│  • LSP client for Copilot communication          │
│  • PRD conversion engine                         │
│  • LLM integration (GPT-4)                       │
│  • File system & workspace management            │
│  • Auto-updater                                  │
└──────────────────────────────────────────────────┘
```

## 📸 Screenshots

### Workflow Studio - PRD Converter

The main interface provides an integrated workflow studio for converting legacy PRD files:

![Workflow Studio Interface](./assets/workflow-studio.png)

**Key Features Shown:**
- **Left Panel**: Workspace explorer displaying generated artifacts from PRD conversions (forms, workflows, summaries)
- **Center Panel**: PRD conversion interface with upload/paste functionality, file browser, and artifact management
- **Right Panel**: Integrated Copilot chat assistant providing AI-powered guidance and summaries
- **Model Selector**: Easy switching between AI models (GPT-4.1, GPT-3.5, etc.)
- **Bidirectional Workflow**: Upload PRD → Get BPMN + Forms → Ask Copilot for clarifications

The interface maintains VS Code-like familiarity with explorer, editor, and chat panels all visible simultaneously.

## 📁 Project Structure

```
.
├── src/
│   ├── main/                      # Electron main process
│   │   ├── index.ts              # App entry point
│   │   ├── ipcHandlers.ts        # IPC request handlers
│   │   ├── copilotChatApi.ts     # GitHub Copilot chat integration
│   │   ├── lspClient.ts          # LSP server communication
│   │   ├── tokenManager.ts       # Authentication token handling
│   │   ├── apiLogger.ts          # API request logging
│   │   ├── autoUpdater.ts        # Auto-update mechanism
│   │   ├── workflow/
│   │   │   ├── prdConverter.ts   # PRD parsing & BPMN generation
│   │   │   ├── llm.ts            # LLM integration
│   │   │   ├── storage.ts        # Artifact persistence
│   │   │   ├── agent.ts          # Workflow execution
│   │   │   └── workflowschema.ts # BPMN validation
│   │   └── tools/                # Custom tool implementations
│   │
│   ├── preload/
│   │   └── preload.ts            # IPC bridge (secure context)
│   │
│   └── renderer/
│       ├── main.ts               # Angular entry point
│       ├── styles.css            # Global styles
│       └── app/
│           ├── components/
│           │   ├── chat/         # Chat component
│           │   ├── convert-prd/  # PRD converter UI
│           │   ├── file-tree/    # File browser
│           │   ├── workflow-builder-viewer/  # BPMN renderer
│           │   └── formio-builder-viewer/    # Form viewer
│           └── app.module.ts     # Angular app module
│
├── docs/
│   ├── QUICKSTART_DEVELOPER_GUIDE.md
│   ├── PRD_TO_BPMN_CONVERSION.md
│   ├── IMPLEMENTATION_ARCHITECTURE.md
│   ├── CODE_FIXES_SUMMARY.md
│   ├── GETTING_STARTED.md
│   ├── CUSTOM_TOOLS_GUIDE.md
│   └── (additional guides)
│
├── package.json
├── tsconfig.json
├── tsconfig.electron.json
├── angular.json
└── README.md
```

## 🔧 Development

### Environment Setup

```bash
# Set GitHub Copilot credentials
export GITHUB_COPILOT_TOKEN=ghu_xxxxxxxxxxxx

# Optional: Set update URL
export COPILOT_CHAT_UPDATE_URL=https://releases.example.com/latest.json

# Optional: Set LLM model
export COPILOT_LLM_MODEL=gpt-4-turbo
```

### Common Commands

```bash
# Install dependencies
npm install

# Start development mode
npm run dev          # Runs Electron with hot reload

# Build
npm run build        # Build renderer only
npm run build:electron  # Build Electron package

# Debug
npm run dev -- --inspect-brk  # Debug main process

# Format code
npm run format       # ESLint + Prettier

# Type checking
npm run typecheck    # Run TypeScript compiler
```

### Development Renderer

- URL: `http://localhost:4100`
- Hot reload: Enabled
- DevTools: Available via `F12`

## 🔒 Security Fixes (2026-07-21)

The following critical security and quality issues were addressed:

1. **LSP Client Race Condition** - Prevents duplicate initialization requests
2. **Windows Path Traversal** - Case-insensitive path validation on Windows
3. **HTTP Redirect Handling** - Follows 301/302 redirects in downloads
4. **TLS Verification** - Enforces strict TLS in production builds
5. **Angular Deprecation** - Updated to modern `provideHttpClient()` API

See [CODE_FIXES_SUMMARY.md](docs/CODE_FIXES_SUMMARY.md) for detailed information.

## 🚀 Building for Production

```bash
# Build renderer
npm run build

# Build Electron package (creates dist-electron/)
npm run build:electron

# Create installer (Windows)
npm run build:electron -- --win

# Create DMG (macOS)
npm run build:electron -- --mac

# Create AppImage (Linux)
npm run build:electron -- --linux
```

## 📊 Performance

| Component | Benchmark |
|-----------|-----------|
| Small PRD parse (<100KB) | <100ms |
| Medium PRD (100KB-1MB) | 100-500ms |
| Large PRD (>1MB) | 500ms-2s |
| LLM summarization | 5-30s (network dependent) |
| BPMN rendering | <200ms |
| Form schema generation | <50ms |

## 🐛 Troubleshooting

### Issue: Copilot chat not connecting
- Check `GITHUB_COPILOT_TOKEN` environment variable
- Verify token is valid (not expired)
- Check network connectivity
- Review logs: `src/main/apiLogger.ts`

### Issue: PRD conversion fails
- Validate XML syntax: `xmllint file.xml`
- Check if PRD has required elements (`<ProcessDefinition>`, `<Activities>`)
- Review conversion progress logs
- See [PRD_TO_BPMN_CONVERSION.md](docs/PRD_TO_BPMN_CONVERSION.md#troubleshooting)

### Issue: LLM summary not generating
- Check model name is correct
- Verify network connectivity
- Check API rate limits
- Review error logs in DevTools (F12)

### Issue: BPMN diagram won't render
- Validate BPMN XML: https://bpmn.io
- Check for namespace issues
- Ensure all element IDs are unique
- Review browser console logs

## 📝 Notes

- Dev renderer runs on `http://localhost:4100`
- Renderer build output: `dist-electron/renderer-angular`
- Main process output: `dist-electron/main`
- Safe to delete: `dist`, `dist-electron`, `release` folders
- LSP server: Auto-started from `@github/copilot-language-server`
- Workspace directory: `~/.local/share/copilot-chat/workspace` (Linux/macOS) or `%APPDATA%\copilot-chat\workspace` (Windows)

## 📄 License

Proprietary - GitHub Copilot Integration

## 🤝 Contributing

Follow the patterns in existing code:
- Use TypeScript with strict mode
- Add JSDoc comments to public functions
- Write unit tests for utilities
- Keep components focused and testable
- Update documentation when adding features

## 🔗 Resources

- [GitHub Copilot Docs](https://github.com/features/copilot)
- [Electron Documentation](https://www.electronjs.org/docs)
- [Angular Documentation](https://angular.io/docs)
- [BPMN 2.0 Specification](https://www.omg.org/spec/BPMN/2.0/)
- [Node.js API Reference](https://nodejs.org/api/)

---

**Last Updated:** 2026-07-21  
**Version:** 1.0.0
