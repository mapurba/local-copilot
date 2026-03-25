import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CopilotService } from '../../services/copilot.service';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.css']
})
export class ChatComponent implements OnInit {
  messages: Message[] = [];
  inputText = '';
  isLoading = false;
  selectedModel = 'gpt-4.1';
  models: Array<{ id: string; label: string }> = [];

  constructor(private copilotService: CopilotService) {}

  async ngOnInit() {
    await this.loadModels();
  }

  onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  async loadModels() {
    try {
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
    } catch (error) {
      console.error('Failed to load models:', error);
    }
  }

  async sendMessage() {
    const input = this.inputText.trim();
    if (!input) {
      return;
    }

    this.messages.push({
      role: 'user',
      content: input,
      timestamp: new Date()
    });
    this.inputText = '';
    this.isLoading = true;

    try {
      const llmReply = await this.copilotService.askLlm(this.selectedModel, input);
      this.messages.push({
        role: 'assistant',
        content: llmReply || 'No response returned by the model.',
        timestamp: new Date()
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error occurred';
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
