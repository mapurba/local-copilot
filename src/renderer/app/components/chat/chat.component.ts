import { Component, OnInit } from '@angular/core';
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
export class ChatComponent implements OnInit {
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

  constructor(private copilotService: CopilotService, private debugLogger: DebugLoggerService) {}

  async ngOnInit() {
    this.debugLogger.addLog('info', 'Chat component initialized');
    await this.loadModels();
    await this.loadTools();
    this.subscribeToToolEvents();
  }

  subscribeToToolEvents() {
    // Listen for tool calls made by the LLM
    this.copilotService.onToolCalled((toolName, result) => {
      this.toolsInUse.set(toolName, result);
      this.debugLogger.logTool(toolName, [], result);
      this.messages.push({
        role: 'assistant',
        content: `🔧 Used tool: ${toolName}\nResult: ${JSON.stringify(result, null, 2)}`,
        timestamp: new Date()
      });
      console.log('[Chat] Tool called by LLM:', toolName, result);
    });

    // Listen for tool errors
    this.copilotService.onToolError((toolName, error) => {
      this.debugLogger.logError(`Tool error in ${toolName}`, error);
      this.messages.push({
        role: 'assistant',
        content: `⚠️ Tool error: ${toolName}\nError: ${error}`,
        timestamp: new Date()
      });
      console.log('[Chat] Tool error:', toolName, error);
    });
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
      const result = await this.copilotService.callTool(toolName, ...(args ? Object.values(args) : []));

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
      const toolsDescription = this.availableTools.length > 0
        ? `\n\nAvailable tools you can use:\n${this.availableTools
            .map((t) => `- ${t.name}: ${t.description}`)
            .join('\n')}`
        : '';

      const enhancedPrompt = input + toolsDescription;

      this.debugLogger.startTimer(`llm-request-${this.selectedModel}`);
      this.debugLogger.logApiCall('POST', '/chat/completions', {
        model: this.selectedModel,
        promptLength: enhancedPrompt.length,
        toolsCount: this.availableTools.length
      });

      const llmReply = await this.copilotService.askLlm(this.selectedModel, enhancedPrompt);
      
      this.debugLogger.endTimer(`llm-request-${this.selectedModel}`, 'api', 'LLM response received', {
        responseLength: llmReply?.length || 0,
        model: this.selectedModel
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
