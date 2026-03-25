import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CopilotService } from '../../services/copilot.service';
import { DebugLoggerService } from '../../services/debug-logger.service';
import { DebugPanelComponent } from '../debug-panel/debug-panel.component';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule, DebugPanelComponent],
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.css']
})
export class ChatComponent implements OnInit, OnDestroy {
  messages: Message[] = [];
  inputText = '';
  isLoading = false;
  selectedModel = 'gpt-4.1';
  models: Array<{ id: string; label: string }> = [];
  availableTools: Array<{ name: string; category: string; description: string }> = [];
  showSettings = false;
  toolResult: any = null;
  selectedTool: string | null = null;
  toolsInUse: Map<string, any> = new Map();
  private toolPromptSuffix = '';
  private readonly teardownCallbacks: Array<() => void> = [];

  constructor(private copilotService: CopilotService, private debugLogger: DebugLoggerService) {}

  async ngOnInit() {
    this.debugLogger.addLog('info', 'Chat component initialized');
    await this.loadModels();
    await this.loadTools();
    this.subscribeToToolEvents();
  }

  ngOnDestroy() {
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

    this.debugLogger.addLog('info', `Message sent: "${input.substring(0, 50)}..."`);
    this.messages.push({
      role: 'user',
      content: input,
      timestamp: new Date()
    });
    this.inputText = '';
    this.isLoading = true;

    try {
      // Build a system message that includes available tools
      const enhancedPrompt = input + this.toolPromptSuffix;
      let tokenUsage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;

      this.debugLogger.startTimer(`llm-request-${this.selectedModel}`);
      this.debugLogger.logApiCall('invoke', 'LangGraph → ChatOpenAI (baseURL: api.githubcopilot.com)', {
        model: this.selectedModel,
        promptLength: enhancedPrompt.length,
        toolsCount: this.availableTools.length
      });

      const llmReply = await this.copilotService.askLlm(this.selectedModel, enhancedPrompt, (chunk, type) => {
        if (!chunk.trim()) {
          return;
        }

        if (type === 'thinking') {
          this.debugLogger.logThinking(chunk);
          return;
        }

        if (type === 'tool') {
          this.debugLogger.addLog('tool', chunk);
          return;
        }

        if (type === 'usage') {
          try {
            tokenUsage = JSON.parse(chunk) as { promptTokens?: number; completionTokens?: number; totalTokens?: number };
          } catch {
            // Ignore malformed usage chunk; do not fail chat flow.
          }
        }
      });
      
      this.debugLogger.endTimer(`llm-request-${this.selectedModel}`, 'api', 'LLM response received', {
        responseLength: llmReply?.length || 0,
        model: this.selectedModel,
        promptTokens: tokenUsage?.promptTokens,
        completionTokens: tokenUsage?.completionTokens,
        totalTokens: tokenUsage?.totalTokens,
      });

      this.debugLogger.addLog('debug', `LLM Reply: ${llmReply?.substring(0, 100)}...`);

      this.messages.push({
        role: 'assistant',
        content: llmReply || 'No response returned by the model.',
        timestamp: new Date()
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error occurred';
      this.debugLogger.logError('LLM request failed', error);
      this.messages.push({
        role: 'assistant',
        content: `Error: ${message}`,
        timestamp: new Date()
      });
    } finally {
      this.isLoading = false;
    }
  }
}
