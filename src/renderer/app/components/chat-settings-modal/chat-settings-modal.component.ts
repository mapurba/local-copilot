import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';

interface RegisteredTool {
  name: string;
  category: string;
  description: string;
}

@Component({
  selector: 'app-chat-settings-modal',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './chat-settings-modal.component.html',
  styleUrl: './chat-settings-modal.component.css'
})
export class ChatSettingsModalComponent {
  @Input() availableTools: RegisteredTool[] = [];
  @Input() activeTool: string | null = null;
  @Input() busy = false;

  @Output() close = new EventEmitter<void>();
  @Output() toolSelected = new EventEmitter<string>();

  onOverlayClick(): void {
    this.close.emit();
  }

  onCloseClick(event?: Event): void {
    event?.preventDefault();
    this.close.emit();
  }

  onToolSelect(toolName: string): void {
    if (this.busy) {
      return;
    }
    this.toolSelected.emit(toolName);
  }
}
