import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, HostListener } from '@angular/core';
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

  viewMode: 'editor' | 'builder' = 'editor';
  currentXml: string = '';
  hasChanges: boolean = false;
  private editorRef: { layout: () => void } | null = null;
  private originalXml: string = '';

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
}
