import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CopilotService } from '../../services/copilot.service';
import { DebugLoggerService } from '../../services/debug-logger.service';
import { ChatBridgeService, PrdTodoItem } from '../../services/chat-bridge.service';
import { DebugPanelComponent } from '../debug-panel/debug-panel.component';
import { FileNode } from '../file-tree/file-tree.component';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

@Component({
  selector: 'app-chat',
  standalone: false,
  // imports: [CommonModule, FormsModule, DebugPanelComponent],
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.css']
})
export class ChatComponent implements OnInit, OnDestroy {
  messages: Message[] = [];
  inputText: string = '';
  isLoading: boolean = false;
  outputDir: string = '';
  selectedModel: string = 'gpt-4.1';
  models: { id: string; label: string }[] = [];
  fileTree: FileNode[] = [];
  openFiles: Array<{
    path: string;
    name: string;
    kind: 'xml' | 'json' | 'md';
    xml?: string;
    formSchema?: Record<string, unknown>;
    content?: string;
    hasChanges?: boolean;
    errorCount?: number;
  }> = [];
  activeFilePath: string | null = null;
  workspaceMode: 'convert' | 'editor' = 'convert';
  activeTab: 'files' | 'chat' | 'convert' = 'chat';
  workflowRequest: string = '';
  isGeneratingWorkflow: boolean = false;
  explorerPaneWidth: number = 220;
  chatPaneWidth: number = 560;
  isResizing: boolean = false;
  resizeAxis: 'vertical' | 'horizontal' = 'vertical';
  prdTodos: PrdTodoItem[] = [];
  formioOptions = {
    i18n: { resources: {} },
    builder: { resource: false },
  };
  formioRenderOptions = {};

//   constructor(private copilotService: CopilotService) { }
  // constructor(private copilotService: CopilotService, private chatBridge: ChatBridgeService) { }

  availableTools: Array<{ name: string; category: string; description: string }> = [];
  showSettings = false;
  showDebugPanel = true;
  toolResult: any = null;
  selectedTool: string | null = null;
  debugPanelPosition: 'bottom' | 'right' = 'bottom';
  toolsInUse: Map<string, any> = new Map();
  private toolPromptSuffix = '';
  private readonly teardownCallbacks: Array<() => void> = [];
  private resizingTarget: 'explorer' | 'chat' | null = null;
  private resizeStartX: number = 0;
  private resizeStartValue: number = 0;
  private lastTodoProgressSignature: string = '';
  private readonly onWindowMouseMove = (event: MouseEvent) => this.onResizeMove(event);
  private readonly onWindowMouseUp = () => this.stopResize();

  constructor(private copilotService: CopilotService, private debugLogger: DebugLoggerService,private chatBridge: ChatBridgeService) {}

  async ngOnInit() {
    this.debugLogger.addLog('info', 'Chat component initialized');
    await this.loadModels();
    await this.loadWorkflowOutputDir();
    await this.loadTools();
    this.subscribeToToolEvents();
  }

  ngOnDestroy() {
    this.stopResize();
    for (const teardown of this.teardownCallbacks) {
      teardown();
    }
    this.teardownCallbacks.length = 0;
  }

  subscribeToToolEvents() {
    // Listen for tool calls made by the LLM
    const toolCalledOff = this.copilotService.onToolCalled((toolName, result, args) => {
      this.toolsInUse.set(toolName, result);
      this.debugLogger.logTool(toolName, args ?? [], result);
      console.log('[Chat] Tool called by LLM:', toolName, result);
    });

    // Listen for tool errors
    const toolErrorOff = this.copilotService.onToolError((toolName, error) => {
      this.debugLogger.logError(`Tool error in ${toolName}`, error);
      this.messages.push({
        role: 'assistant',
        content: `⚠️ Tool error: ${toolName}\nError: ${error}`,
        timestamp: new Date()
      });
      console.log('[Chat] Tool error:', toolName, error);
    });

    this.teardownCallbacks.push(toolCalledOff, toolErrorOff);

    const bridgeAssistantSub = this.chatBridge.assistantMessages$.subscribe((msg) => {
      this.messages.push({
        role: 'assistant',
        content: msg.content,
        timestamp: new Date(),
      });
    });

    const bridgeArtifactsSub = this.chatBridge.prdArtifactsSaved$.subscribe(async (event) => {
      try {
        if (event.outputDir) {
          this.outputDir = event.outputDir;
        }

        await this.refreshOutputTree();

        const generatedFiles = Array.isArray(event.files) ? event.files : [];
        for (const f of generatedFiles) {
          if (typeof f !== 'string') continue;
          if (f.endsWith('.xml') || f.endsWith('.json') || f.endsWith('.md')) {
            await this.openFile(f);
          }
        }
      } catch (err) {
        console.warn('[Chat] Failed to apply PRD artifact event:', err);
      }
    });

    const bridgeTodoSub = this.chatBridge.prdTodo$.subscribe((items) => {
      this.prdTodos = Array.isArray(items) ? items : [];
      this.publishTodoProgressToChat();
    });

    this.teardownCallbacks.push(
      () => bridgeAssistantSub.unsubscribe(),
      () => bridgeArtifactsSub.unsubscribe(),
      () => bridgeTodoSub.unsubscribe(),
    );
  }

  onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  async loadModels() {
    try {
      this.debugLogger.startTimer('load-models');
      const models = await this.copilotService.getModels();
      this.models = Array.isArray(models)
        ? models.filter((model) => model && (model.id || model.label)).map((model) => ({
            id: String(model.id || model.label || 'default'),
            label: String(model.label || model.id || 'Default Model'),
          }))
        : [];

      if (this.models.length > 0 && !this.models.some((model) => model.id === this.selectedModel)) {
        this.selectedModel = this.models[0].id;
      }
      this.debugLogger.endTimer('load-models', 'info', 'Models loaded', { count: this.models.length });
    } catch (error) {
      this.debugLogger.logError('Failed to load models', error);
    }
  }

  async loadTools() {
    try {
      this.debugLogger.startTimer('load-tools');
      this.availableTools = await this.copilotService.getAvailableTools();
      this.toolPromptSuffix = this.availableTools.length > 0
        ? `\n\nAvailable tools you can use:\n${this.availableTools
            .map((tool) => `- ${tool.name}: ${tool.description}`)
            .join('\n')}`
        : '';
      this.debugLogger.endTimer('load-tools', 'info', 'Tools loaded', { count: this.availableTools.length, tools: this.availableTools.map(t => t.name) });
    } catch (error) {
      this.debugLogger.logError('Failed to load tools', error);
    }
  }

  openSettings() {
    this.showSettings = true;
  }

  closeSettings(event?: Event) {
    if (event) {
      event.preventDefault();
    }
    this.showSettings = false;
  }

  async callTool(toolName: string, args?: any) {
    try {
      this.isLoading = true;
      this.selectedTool = toolName;
      this.toolResult = null;

      this.debugLogger.startTimer(`tool-${toolName}`);
      this.debugLogger.addLog('tool', `Calling tool: ${toolName}`, { args });

      // Add message to chat
      this.messages.push({
        role: 'user',
        content: `Tool: ${toolName}${args ? ' ' + JSON.stringify(args) : ''}`,
        timestamp: new Date()
      });

      // Call the tool - tools are already bound via service
      const result = await this.copilotService.invokeTool(toolName, args);

      this.debugLogger.endTimer(`tool-${toolName}`, 'tool', `Tool result: ${toolName}`, result);
      this.toolResult = result;
      this.messages.push({
        role: 'assistant',
        content: `Tool result: ${JSON.stringify(result, null, 2)}`,
        timestamp: new Date()
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to call tool';
      this.debugLogger.logError(`Tool failed: ${toolName}`, error);
      this.toolResult = { error: message };
      this.messages.push({
        role: 'assistant',
        content: `Tool error: ${message}`,
        timestamp: new Date()
      });
    } finally {
      this.isLoading = false;
      this.selectedTool = null;
    }
  }

  async sendMessage() {
    const input = this.inputText.trim();
    if (!input) {
      return;
    }

    // Log the user message once
    this.debugLogger.addLog('info', `User: ${input.substring(0, 60)}${input.length > 60 ? '...' : ''}`);
    this.messages.push({
      role: 'user',
      content: input,
      timestamp: new Date()
    });
    this.chatBridge.sendUserMessage(input);
    this.inputText = '';

    const generationPrompt = this.extractWorkflowGenerationPrompt(input);
    if (generationPrompt) {
      this.workflowRequest = generationPrompt;
      await this.generateWorkflowFromRequest();
      return;
    }

    this.isLoading = true;

    try {
      // Build enhanced prompt with tool info
      const toolUsageGuidance = this.availableTools.length > 0
        ? '\n\nTool usage rule: Reuse the available tools whenever they can help answer accurately. Prefer tool calls over assumptions, avoid duplicating logic available through tools, and cite the tool outcome in your response.'
        : '';
      const enhancedPrompt = `${input}${toolUsageGuidance}${this.toolPromptSuffix}`;
      let tokenUsage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;

      // Start fresh thinking chain for this request
      this.debugLogger.startThinkingChain();

      // Log initial analysis
      this.debugLogger.addThinkingStep(
        `Processing: "${input.substring(0, 80)}..."`,
        'analysis',
        { inputLength: input.length, toolsAvailable: this.availableTools.length }
      );

      // Log that we're about to invoke the LLM
      this.debugLogger.startTimer(`llm-request-${this.selectedModel}`);

      const llmReply = await this.copilotService.askLlm(
        this.selectedModel,
        enhancedPrompt,
        (chunk, type) => {
          if (!chunk.trim()) {
            return;
          }

          if (type === 'thinking') {
            // Try to parse structured JSON from LangGraph node events
            let thinkingContent = chunk.trim();
            let category: 'analysis' | 'planning' | 'decision' | 'reasoning' | 'synthesis' = 'reasoning';
            let metadata: Record<string, any> = { source: 'llm_stream' };

            try {
              const parsed = JSON.parse(thinkingContent);
              if (parsed.node === 'agent') {
                thinkingContent = `LangGraph agent node (${parsed.messageCount} messages in state)`;
                category = 'analysis';
                metadata = { node: 'agent', messageCount: parsed.messageCount };
              } else if (parsed.node === 'tools') {
                thinkingContent = `LangGraph tools node — invoking ${parsed.toolCount} tool(s): ${(parsed.tools || []).join(', ')}`;
                category = 'decision';
                metadata = { node: 'tools', toolCount: parsed.toolCount, tools: parsed.tools };
              } else {
                metadata = { ...metadata, ...parsed };
              }
            } catch {
              // Plain text thinking chunk — categorize by content
              const lower = thinkingContent.toLowerCase();
              if (lower.includes('analyze') || lower.includes('understand')) {
                category = 'analysis';
              } else if (lower.includes('plan') || lower.includes('approach') || lower.includes('need to')) {
                category = 'planning';
              } else if (lower.includes('decid') || lower.includes('choose') || lower.includes('select')) {
                category = 'decision';
              } else if (lower.includes('conclude') || lower.includes('therefore') || lower.includes('result') || lower.includes('final')) {
                category = 'synthesis';
              }
            }

            this.debugLogger.addThinkingStep(
              thinkingContent,
              category,
              metadata,
              Math.ceil(thinkingContent.split(' ').length)
            );
            return;
          }

          if (type === 'tool') {
            try {
              const parsed = JSON.parse(chunk);
              if (parsed.phase === 'start') {
                this.debugLogger.addThinkingStep(
                  `Calling tool: ${parsed.name}`,
                  'decision',
                  { toolName: parsed.name, arguments: parsed.args, phase: 'invoking' }
                );
              } else if (parsed.phase === 'result') {
                this.debugLogger.addThinkingStep(
                  `Tool result: ${parsed.name}`,
                  'synthesis',
                  { toolName: parsed.name, arguments: parsed.args, result: parsed.result, phase: 'completed' }
                );
              }
            } catch {
              // Fallback for plain text tool chunk
              this.debugLogger.addThinkingStep(
                `Tool: ${chunk}`,
                'decision',
                { toolCall: true, raw: chunk }
              );
            }
            return;
          }

          if (type === 'usage') {
            try {
              tokenUsage = JSON.parse(chunk) as { promptTokens?: number; completionTokens?: number; totalTokens?: number };
            } catch {
              // Ignore malformed usage
            }
          }
        }
      );

      // Log completion with stats (not a duplicate thanks to deduplication)
      this.debugLogger.endTimer(`llm-request-${this.selectedModel}`, 'api', 'LLM response received', {
        responseLength: llmReply?.length || 0,
        model: this.selectedModel,
        tokens: tokenUsage?.totalTokens
      });

      // Add synthesis thinking step
      this.debugLogger.addThinkingStep(
        `Generated response (${llmReply?.length || 0} chars)`,
        'synthesis',
        { model: this.selectedModel }
      );

      // Log reasoning stats once
      const stats = this.debugLogger.getThinkingStats();
      if (stats.stepCount > 0) {
        this.debugLogger.addLog('info', `Reasoning: ${stats.stepCount} steps, ${stats.totalTokens} tokens`, stats.byCategory);
      }

      this.messages.push({
        role: 'assistant',
        content: llmReply || 'No response returned by the model.',
        timestamp: new Date()
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error occurred';
      this.debugLogger.logError('LLM request failed', error);
      this.debugLogger.addThinkingStep(
        `Failed: ${message}`,
        'synthesis',
        { error: true }
      );
      this.messages.push({
        role: 'assistant',
        content: `Error: ${message}`,
        timestamp: new Date()
      });
    } finally {
      this.isLoading = false;
    }
  }

  async generateFromComposer() {
    const input = this.inputText.trim();
    if (!input || this.isGeneratingWorkflow) {
      return;
    }

    this.messages.push({
      role: 'user',
      content: input,
      timestamp: new Date(),
    });
    this.chatBridge.sendUserMessage(input);
    this.workflowRequest = input;
    this.inputText = '';
    await this.generateWorkflowFromRequest();
  }

  async chooseOutputDir() {
    try {
      console.log('[Chat] Choosing output directory...');
      const dir = await this.copilotService.chooseWorkflowOutputDir();
      console.log('[Chat] Directory selection result:', dir);
      if (dir) {
        this.outputDir = this.extractDirPath(dir);
        console.log('[Chat] Extracted output path:', this.outputDir);
        await this.refreshOutputTree();
        console.log('[Chat] Tree refreshed after directory selection');
      } else {
        console.warn('[Chat] Directory selection cancelled');
      }
    } catch (error) {
      console.error('Failed to choose output directory:', error);
    }
  }

  async openOutputDir() {
    try {
      await this.copilotService.openWorkflowOutputDir(this.outputDir);
    } catch (error) {
      console.error('Failed to open output directory:', error);
    }
  }

  async refreshOutputTree() {
    if (!this.outputDir) {
      this.fileTree = [];
      return;
    }
    try {
      const result = await this.copilotService.listWorkflowTree();
      if (result.success && result.tree) {
        this.fileTree = result.tree as FileNode[];
        console.log('[Chat] Tree refreshed:', this.fileTree.length, 'items');
      } else {
        console.warn('[Chat] Tree refresh failed:', result.error);
        this.fileTree = [];
      }
    } catch (error) {
      console.error('[Chat] Error refreshing tree:', error);
      this.fileTree = [];
    }
  }

  async onFileSelected(node: FileNode) {
    if (!node || node.isDirectory) return;
    await this.openFile(node.path);
  }

  async openFile(filePath: string) {
    const existing = this.openFiles.find((f) => f.path === filePath);
    if (existing) {
      this.activeFilePath = existing.path;
      this.activeTab = 'files';
      this.workspaceMode = 'editor';
      this.syncActiveFormSchema();
      return;
    }

    const name = filePath.split(/[\\/]/).pop() || filePath;
    if (filePath.endsWith('.xml')) {
      const result = await this.copilotService.readWorkflowFile(filePath);
      const xml = result.success && result.content ? result.content : '';
      this.openFiles.push({ path: filePath, name, kind: 'xml', xml });
      this.activeFilePath = filePath;
    } else if (filePath.endsWith('.json')) {
      const result = await this.copilotService.readWorkflowFile(filePath);
      let formSchema: Record<string, unknown> | undefined;
      if (result.success && result.content) {
        try {
          const parsed = JSON.parse(result.content) as unknown;
          formSchema = this.extractFormSchema(parsed);
        } catch {
          formSchema = undefined;
        }
      }
      this.openFiles.push({ path: filePath, name, kind: 'json', formSchema });
      this.activeFilePath = filePath;
    } else if (filePath.endsWith('.md')) {
      const result = await this.copilotService.readWorkflowFile(filePath);
      const content = result.success && result.content ? result.content : '';
      this.openFiles.push({ path: filePath, name, kind: 'md', content });
      this.activeFilePath = filePath;
    } else {
      this.activeFilePath = null;
    }

    this.activeTab = 'files';
    this.workspaceMode = 'editor';
    this.syncActiveFormSchema();
  }

  get activeFile() {
    return this.openFiles.find((f) => f.path === this.activeFilePath) || null;
  }

  setActiveFile(path: string) {
    this.activeFilePath = path;
    this.activeTab = 'files';
    this.workspaceMode = 'editor';
    this.syncActiveFormSchema();
  }

  closeFile(path: string) {
    const idx = this.openFiles.findIndex((f) => f.path === path);
    if (idx === -1) return;
    this.openFiles.splice(idx, 1);
    if (this.activeFilePath === path) {
      this.activeFilePath = this.openFiles.length ? this.openFiles[0].path : null;
      this.syncActiveFormSchema();
    }
    if (!this.openFiles.length) {
      this.activeTab = 'chat';
    }
  }

  switchToChatTab() {
    this.activeTab = 'chat';
  }

  async switchToFilesTab() {
    this.activeTab = 'files';
    await this.refreshOutputTree();
  }

  switchToConvertTab() {
    this.activeTab = 'convert';
  }

  switchWorkspaceMode(mode: 'convert' | 'editor') {
    this.workspaceMode = mode;
  }

  toggleDebugPanel() {
    this.showDebugPanel = !this.showDebugPanel;
  }

  toggleDebugPosition() {
    this.debugPanelPosition = this.debugPanelPosition === 'bottom' ? 'right' : 'bottom';
  }

  startResize(target: 'explorer' | 'chat', event: MouseEvent) {
    if (window.innerWidth <= 1100) {
      return;
    }

    this.resizingTarget = target;
    this.resizeStartX = event.clientX;

    if (target === 'explorer') this.resizeStartValue = this.explorerPaneWidth;
    else this.resizeStartValue = this.chatPaneWidth;

    this.isResizing = true;
    this.resizeAxis = 'vertical';
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', this.onWindowMouseMove);
    window.addEventListener('mouseup', this.onWindowMouseUp);
    event.preventDefault();
  }

  stopResize() {
    this.resizingTarget = null;
    this.isResizing = false;
    this.resizeAxis = 'vertical';
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    window.removeEventListener('mousemove', this.onWindowMouseMove);
    window.removeEventListener('mouseup', this.onWindowMouseUp);
  }

  private onResizeMove(event: MouseEvent) {
    if (!this.resizingTarget) {
      return;
    }

    if (this.resizingTarget === 'explorer') {
      const delta = event.clientX - this.resizeStartX;
      this.explorerPaneWidth = this.clamp(this.resizeStartValue + delta, 180, 360);
      return;
    }

    if (this.resizingTarget === 'chat') {
      const delta = event.clientX - this.resizeStartX;
      this.chatPaneWidth = this.clamp(this.resizeStartValue - delta, 460, 860);
      return;
    }
  }

  private clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
  }

  private publishTodoProgressToChat() {
    if (!this.prdTodos.length) {
      this.lastTodoProgressSignature = '';
      return;
    }

    const completed = this.prdTodos.filter((t) => t.status === 'completed').length;
    const inProgress = this.prdTodos.filter((t) => t.status === 'in-progress').length;
    const pending = this.prdTodos.filter((t) => t.status === 'not-started').length;
    const total = this.prdTodos.length;

    const signature = `${completed}/${inProgress}/${pending}/${total}`;
    if (signature === this.lastTodoProgressSignature) {
      return;
    }
    this.lastTodoProgressSignature = signature;

    const summary = `PRD Todo Progress: ${completed}/${total} completed, ${inProgress} in progress, ${pending} pending.`;
    this.messages.push({
      role: 'assistant',
      content: summary,
      timestamp: new Date(),
    });
  }

  async generateWorkflowFromRequest() {
    const request = this.workflowRequest.trim();
    if (!request || this.isGeneratingWorkflow) {
      return;
    }

    this.isGeneratingWorkflow = true;
    try {
      let targetOutputDir = this.outputDir;
      if (!targetOutputDir) {
        const dir = await this.copilotService.chooseWorkflowOutputDir();
        targetOutputDir = this.extractDirPath(dir);
        this.outputDir = targetOutputDir;
      }

      if (!targetOutputDir) {
        this.messages.push({
          role: 'assistant',
          content: 'Select an output folder before generating a workflow.',
          timestamp: new Date(),
        });
        return;
      }

      const result = await this.copilotService.generateWorkflow({
        modelId: this.selectedModel,
        request,
        outputDir: targetOutputDir,
      });

      if (!result.success) {
        this.messages.push({
          role: 'assistant',
          content: `Workflow generation failed: ${result.error || 'Unknown error'}`,
          timestamp: new Date(),
        });
        return;
      }

      if (result.outputDir) {
        this.outputDir = result.outputDir;
      }

      await this.refreshOutputTree();
      this.activeTab = 'files';

      if (result.files?.workflowPath) {
        await this.openFile(result.files.workflowPath);
      }
      if (result.files?.formsPath) {
        await this.openFile(result.files.formsPath);
      }

      const summary = this.generateWorkflowSummary(result.plan);
      this.messages.push({
        role: 'assistant',
        content: summary || `Workflow generated in ${result.outputDir || targetOutputDir}`,
        timestamp: new Date(),
      });
      this.workflowRequest = '';
    } catch (error) {
      this.messages.push({
        role: 'assistant',
        content: `Workflow generation error: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: new Date(),
      });
    } finally {
      this.isGeneratingWorkflow = false;
    }
  }

  onFormSchemaChanged(updatedSchema: unknown) {
    const active = this.activeFile;
    if (active && active.kind === 'json') {
      if (updatedSchema && typeof updatedSchema === 'object') {
        active.formSchema = updatedSchema as Record<string, unknown>;
      }
    }
  }

  private extractFormSchema(parsed: unknown): Record<string, unknown> | undefined {
    if (!parsed) {
      return undefined;
    }

    // Direct Form.io schema object
    if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj['components'])) {
        return obj;
      }
      // Wrapped single form: { form: { ... } }
      const wrapped = obj['form'];
      if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
        return wrapped as Record<string, unknown>;
      }
    }

    // Common workflow output shape: [ { form: { ... } }, ... ]
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const maybeForm = (item as Record<string, unknown>)['form'];
        if (maybeForm && typeof maybeForm === 'object' && !Array.isArray(maybeForm)) {
          return maybeForm as Record<string, unknown>;
        }
      }
    }

    return undefined;
  }

  private generateWorkflowSummary(plan: {
    forms?: Array<{ id: string; components?: unknown[] }>;
    activities?: Array<{ id: string; type: string }>;
    flows?: Array<{ source: string; target: string }>;
  } | null | undefined): string {
    if (!plan) {
      return '';
    }

    const lines: string[] = ['## Workflow Summary'];

    // Forms section
    if (plan.forms && Array.isArray(plan.forms) && plan.forms.length > 0) {
      lines.push('');
      lines.push(`### Forms (${plan.forms.length})`);
      for (const form of plan.forms) {
        const componentCount = Array.isArray(form.components) ? form.components.length : 0;
        lines.push(`- **${form.id}**: ${componentCount} field${componentCount !== 1 ? 's' : ''}`);
      }
    }

    // Activities section
    if (plan.activities && Array.isArray(plan.activities) && plan.activities.length > 0) {
      lines.push('');
      lines.push(`### Activities (${plan.activities.length})`);
      
      const activityByType: Record<string, number> = {};
      for (const activity of plan.activities) {
        const type = activity.type || 'unknown';
        activityByType[type] = (activityByType[type] || 0) + 1;
      }

      for (const [type, count] of Object.entries(activityByType)) {
        lines.push(`- **${type}**: ${count}`);
      }
    }

    // Flows section
    if (plan.flows && Array.isArray(plan.flows) && plan.flows.length > 0) {
      lines.push('');
      lines.push(`### Workflow Flow`);
      lines.push(`${plan.flows.length} transition${plan.flows.length !== 1 ? 's' : ''} connecting activities`);
    }

    return lines.join('\n');
  }

  private syncActiveFormSchema() {
    // No-op: active file data is the source of truth for the viewer.
  }

  private extractDirPath(input: unknown): string {
    console.log('[extractDirPath] Input:', input);
    if (typeof input === 'string') {
      console.log('[extractDirPath] Is string:', input);
      return input;
    }
    if (input && typeof input === 'object') {
      if ('path' in (input as any) && typeof (input as any).path === 'string') {
        const p = (input as any).path;
        console.log('[extractDirPath] Found path property:', p);
        return p;
      }
      if ('directory' in (input as any) && typeof (input as any).directory === 'string') {
        const d = (input as any).directory;
        console.log('[extractDirPath] Found directory property:', d);
        return d;
      }
    }
    console.log('[extractDirPath] No path found, returning empty string');
    return '';
  }

  private async loadWorkflowOutputDir() {
    try {
      const dir = await this.copilotService.getWorkflowOutputDir();
      this.outputDir = this.extractDirPath(dir?.path || '');
      if (this.outputDir) {
        await this.refreshOutputTree();
      }
    } catch {
      this.outputDir = '';
      this.fileTree = [];
    }
  }

  private isWorkflowGenerationRequest(input: string): boolean {
    const lowerInput = input.toLowerCase();
    if (lowerInput.startsWith('/generate')) return true;
    if (lowerInput.length < 40) return false;

    const hasAction = /(create|generate|build|design|implement|draft)/.test(lowerInput);
    const hasWorkflowScope = /(workflow|process|approval|onboarding|offboarding|provision|access request|form)/.test(lowerInput);
    return hasAction && hasWorkflowScope;
  }

  private extractWorkflowGenerationPrompt(input: string): string | null {
    const trimmed = input.trim();
    const lower = trimmed.toLowerCase();

    if (lower.startsWith('/generate')) {
      const prompt = trimmed.slice('/generate'.length).trim();
      return prompt || null;
    }

    return this.isWorkflowGenerationRequest(trimmed) ? trimmed : null;
  }

  onWorkflowXmlChanged(newXml: string) {
    const active = this.activeFile;
    if (active && active.kind === 'xml') {
      active.xml = newXml;
    }
  }

  onWorkflowHasChangesUpdate(hasChanges: boolean) {
    const active = this.activeFile;
    if (active && active.kind === 'xml') {
      active.hasChanges = hasChanges;
    }
  }

  async saveActiveFile() {
    const active = this.activeFile;
    if (!active) {
      return;
    }

    try {
      let content = '';
      if (active.kind === 'xml' && active.xml) {
        content = active.xml;
      } else if (active.kind === 'json' && active.formSchema) {
        content = JSON.stringify(active.formSchema, null, 2);
      }

      if (content) {
        await this.copilotService.saveWorkflowFile(active.path, content);
        active.hasChanges = false;
        
        // Show success message
        const successMsg: Message = {
          role: 'assistant',
          content: `✓ Saved: ${active.name}`,
          timestamp: new Date()
        };
        this.messages.push(successMsg);
      }
    } catch (error) {
      const errorMsg: Message = {
        role: 'assistant',
        content: `Error saving file: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: new Date()
      };
      this.messages.push(errorMsg);
    }
  }

  get hasUnsavedChanges(): boolean {
    return this.openFiles.some(f => f.hasChanges);
  }
}
