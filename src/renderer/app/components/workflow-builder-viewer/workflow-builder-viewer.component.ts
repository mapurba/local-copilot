import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, HostListener } from '@angular/core';
import { ChatBridgeService } from '../../services/chat-bridge.service';
import { CopilotService } from '../../services/copilot.service';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClientModule } from '@angular/common/http';
import { MonacoEditorModule } from 'ngx-monaco-editor-v2';
import { WorkflowbuilderModule } from '@iam/workflowbuilder';

@Component({
  selector: 'app-workflow-builder-viewer',
  standalone: true,
  imports: [CommonModule, FormsModule, HttpClientModule, MonacoEditorModule, WorkflowbuilderModule],
  template: `
    <div class="flex flex-col h-full">
      <div class="flex items-center justify-between mb-2 px-2">
        <div class="text-xs font-semibold text-gray-500 dark:text-gray-400">Workflow View</div>
        <div class="flex gap-2">
          <button
            type="button"
            (click)="saveArtifacts()"
            class="px-2 py-1 rounded text-xs bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-200">
            Save Artifacts
          </button>
          <button
            type="button"
            (click)="showSummary()"
            class="px-2 py-1 rounded text-xs bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-200">
            Show Summary
          </button>
          <button
            type="button"
            (click)="setView('editor')"
            [class]="viewMode === 'editor' ? 'bg-blue-600 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-200'"
            class="px-2 py-1 rounded text-xs">
            XML Editor
          </button>
          <button
            type="button"
            (click)="setView('builder')"
            [class]="viewMode === 'builder' ? 'bg-blue-600 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-200'"
            class="px-2 py-1 rounded text-xs">
            Builder
          </button>
        </div>
      </div>

      <div class="flex-1 min-h-0">
        <!-- XML Editor View -->
        <div *ngIf="viewMode === 'editor'" class="h-full editor-host">
          <ngx-monaco-editor
            class="editor-control"
            (onInit)="onEditorInit($event)"
            [options]="editorOptions"
            [(ngModel)]="currentXml"
            (ngModelChange)="onXmlEditorChange($event)">
          </ngx-monaco-editor>
        </div>

        <!-- Workflow Builder View -->
        <div *ngIf="viewMode === 'builder'" class="h-full">
          <!-- <iam-workflow-builder
            [xmlInputFromConsole]="currentXml"
            (xmlFromBuilder)="onBuilderXmlChange($any($event))"
            (errorCountFromBuilder)="onErrorCountChange($any($event))"
            [serverValidationResponseForWFBuilder]="serverValidationResponse"
            [isWorkflowSaved]="!hasChanges">
          </iam-workflow-builder> -->
          
            <iam-workflowbuilder [xmlDataFromConsole]="currentXml" >
            </iam-workflowbuilder>
        </div>
      </div>
      <div *ngIf="summaryText" class="mt-2 px-2 overflow-auto max-h-48">
        <pre class="text-xs whitespace-pre-wrap">{{summaryText}}</pre>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      height: 100%;
      width: 100%;
    }

    .editor-host {
      height: 100%;
      width: 100%;
    }

    .editor-control {
      display: block;
      height: 100%;
      width: 100%;
    }
  `]
})
export class WorkflowBuilderViewerComponent implements OnChanges {
  @Input() xml: string = '';
  @Input() serverValidationResponse: unknown[] = [];
  @Output() xmlChanged = new EventEmitter<string>();
  @Output() errorCountChanged = new EventEmitter<number>();
  @Output() hasChangesUpdate = new EventEmitter<boolean>();

  viewMode: 'editor' | 'builder' = 'builder';
  currentXml: string = '';
  hasChanges: boolean = false;
  private editorRef: { layout: () => void } | null = null;
  private originalXml: string = '';
  summaryText: string = '';

  editorOptions = {
    theme: 'vs-light',
    language: 'xml',
    readOnly: false,
    automaticLayout: true,
    minimap: { enabled: false },
    wordWrap: 'on' as const,
    formatOnPaste: true,
    formatOnType: true,
  };

  constructor(private chatBridge: ChatBridgeService, private copilotService: CopilotService) {}

  ngOnChanges(changes: SimpleChanges) {
    if (changes['xml']) {
      const newXml = this.xml || '';
      this.currentXml = this.prettyPrintXml(newXml);
      this.originalXml = this.currentXml;
      this.hasChanges = false;
      this.relayoutEditorSoon();
    }
  }

  setView(mode: 'editor' | 'builder') {
    this.viewMode = mode;
    if (mode === 'editor') {
      this.relayoutEditorSoon();
    }
  }

  onXmlEditorChange(newXml: string) {
    this.hasChanges = newXml !== this.originalXml;
    this.hasChangesUpdate.emit(this.hasChanges);
    this.xmlChanged.emit(newXml);
  }

  onBuilderXmlChange(newXml: string) {
    this.currentXml = newXml;
    this.hasChanges = newXml !== this.originalXml;
    this.hasChangesUpdate.emit(this.hasChanges);
    this.xmlChanged.emit(newXml);
  }

  onErrorCountChange(count: number) {
    this.errorCountChanged.emit(count);
  }

  onEditorInit(editor: unknown) {
    if (editor && typeof editor === 'object' && 'layout' in editor && typeof (editor as { layout?: unknown }).layout === 'function') {
      this.editorRef = editor as { layout: () => void };
    }
    this.relayoutEditorSoon();
  }

  @HostListener('window:resize')
  onWindowResize() {
    this.relayoutEditorSoon();
  }

  private relayoutEditorSoon() {
    setTimeout(() => {
      try {
        this.editorRef?.layout();
      } catch {
        // Ignore layout errors during teardown.
      }
    }, 0);

    setTimeout(() => {
      try {
        this.editorRef?.layout();
      } catch {
        // Ignore layout errors during teardown.
      }
    }, 120);
  }

  private prettyPrintXml(xml: string): string {
    const input = (xml || '').trim();
    if (!input) {
      return '';
    }

    try {
      const withBreaks = input
        .replace(/>\s*</g, '><')
        .replace(/(>)(<)(\/*)/g, '$1\n$2$3');

      const lines = withBreaks.split('\n');
      let indent = 0;
      const formatted: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Closing tag
        if (trimmed.startsWith('</')) {
          indent = Math.max(0, indent - 1);
        }

        formatted.push('  '.repeat(indent) + trimmed);

        // Opening tag (not self-closing)
        if (trimmed.startsWith('<') && !trimmed.startsWith('</') && !trimmed.endsWith('/>') && !trimmed.startsWith('<?') && !trimmed.startsWith('<!--')) {
          indent++;
        }
      }

      return formatted.join('\n');
    } catch {
      return input;
    }
  }

  saveChanges() {
    this.originalXml = this.currentXml;
    this.hasChanges = false;
    this.hasChangesUpdate.emit(false);
  }

  resetChanges() {
    this.currentXml = this.originalXml;
    this.hasChanges = false;
    this.hasChangesUpdate.emit(false);
  }

  async onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
      const file = input.files[0];
      const reader = new FileReader();
    reader.onload = async () => {
      const content = typeof reader.result === 'string' ? reader.result : '';
      try {
        // pick a model if available and pass modelId to enable LLM deep summary in main process
        let modelId: string | undefined = undefined;
        try {
          const models = await this.copilotService.getModels();
          if (Array.isArray(models) && models.length) modelId = models[0].id || models[0].label || models[0];
        } catch {
          modelId = undefined;
        }
        const res = await this.copilotService.convertPrd({ content, fileName: file.name, modelId });
        if (res && res.success && res.result) {
          // if results.results (multiple) choose first
          const out = res.result.results ? res.result.results[0] : res.result;
          this.summaryText = out.summary || (out.summary === undefined ? JSON.stringify(out, null, 2) : '');
          this.currentXml = out.decodedXml || '';
          this.xmlChanged.emit(this.currentXml);
          this.setView('editor');
          // Heuristic questions for user review: missing forms/addressee on user activities
          const questions: string[] = [];
          if (Array.isArray(out.activities)) {
            out.activities.forEach((a: any) => {
              try {
                if (a.type === 'user-activity') {
                  const o = a.obj || {};
                  if (!o['@_form-id'] && !o['form-id']) questions.push(`User activity '${a.id}' is missing a form-id. Which form should be used?`);
                  if (!o['@_addressee'] && !o['addressee']) questions.push(`User activity '${a.id}' has no addressee configured. Who should be the approver?`);
                }
              } catch {
                // ignore malformed entries
              }
            });
          }
          if (questions.length) {
            const msg = `I analyzed the uploaded PRD and found items needing clarification:\n- ${questions.join('\n- ')}`;
            this.chatBridge.sendAssistantMessage(msg);
          }
          // If saved artifacts were returned from main process, notify user in chat with paths
          if (res && res.saved && res.saved.outputDir) {
            const savedMsgParts: string[] = [];
            if (res.saved.decoded && res.saved.decoded.length) savedMsgParts.push(`Decoded XML: ${res.saved.decoded.join(', ')}`);
            if (res.saved.summaries && res.saved.summaries.length) savedMsgParts.push(`Summaries: ${res.saved.summaries.join(', ')}`);
            if (res.saved.workflows && res.saved.workflows.length) savedMsgParts.push(`Workflows: ${res.saved.workflows.join(', ')}`);
            if (res.saved.forms && res.saved.forms.length) savedMsgParts.push(`Forms: ${res.saved.forms.join(', ')}`);
            const savedMsg = `Analysis artifacts were saved to: ${res.saved.outputDir}\n${savedMsgParts.join('\n')}`;
            this.chatBridge.sendAssistantMessage(savedMsg);
          }
        } else {
          this.summaryText = `Conversion failed: ${res && res.error ? res.error : 'Unknown'}`;
        }
      } catch (e) {
        this.summaryText = `Conversion error: ${e instanceof Error ? e.message : String(e)}`;
      }
    };
    reader.readAsText(file);
    // reset input so same file can be re-selected
    input.value = '';
  }

  async saveArtifacts() {
    try {
      // chooseWorkflowOutputDir may return a string or an object { cancelled, path }
      const choose = await this.copilotService.chooseWorkflowOutputDir();
      let outputDir = '';
      if (!choose) {
        this.chatBridge.sendAssistantMessage('Save cancelled.');
        return;
      }
      if (typeof choose === 'string') outputDir = choose;
      else if (typeof choose === 'object') {
        if ((choose as any).cancelled) {
          this.chatBridge.sendAssistantMessage('Save cancelled.');
          return;
        }
        outputDir = (choose as any).path || '';
      }
      if (!outputDir) {
        this.chatBridge.sendAssistantMessage('No output directory selected.');
        return;
      }

      const ts = Date.now();
      const decodedName = `decoded-${ts}.xml`;
      const summaryName = `summary-${ts}.md`;
      const joinSep = outputDir.endsWith('\\') || outputDir.endsWith('/') ? '' : '\\';
      const decodedPath = `${outputDir}${joinSep}${decodedName}`;
      const summaryPath = `${outputDir}${joinSep}${summaryName}`;

      const savedParts: string[] = [];
      if (this.currentXml) {
        const r1 = await this.copilotService.saveWorkflowFile(decodedPath, this.currentXml);
        if (r1 && r1.success) savedParts.push(`Decoded XML: ${decodedPath}`);
      }
      if (this.summaryText) {
        const r2 = await this.copilotService.saveWorkflowFile(summaryPath, this.summaryText);
        if (r2 && r2.success) savedParts.push(`Summary: ${summaryPath}`);
      }

      if (savedParts.length) {
        this.chatBridge.sendAssistantMessage(`Saved artifacts to: ${outputDir}\n- ${savedParts.join('\n- ')}`);
      } else {
        this.chatBridge.sendAssistantMessage('No artifacts were available to save.');
      }
    } catch (e) {
      this.chatBridge.sendAssistantMessage(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  showSummary() {
    // toggle view to show summary in editor if present
    if (this.summaryText) {
      this.setView('editor');
    }
  }
}
