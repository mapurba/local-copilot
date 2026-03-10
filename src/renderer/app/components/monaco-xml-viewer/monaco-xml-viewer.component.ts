import { Component, HostListener, Input } from '@angular/core';

@Component({
  selector: 'app-monaco-xml-viewer',
  standalone: false,
  template: `
    <div class="editor-host">
      <ngx-monaco-editor
        class="editor-control"
        (onInit)="onEditorInit($event)"
        [options]="editorOptions"
        [ngModel]="formattedXml">
      </ngx-monaco-editor>
    </div>
  `,
  styles: [
    `
      .editor-control {
        display: block;
        height: 100vh;
        width: 100%;
      }

    `
  ]
})
export class MonacoXmlViewerComponent {
  private editorRef: { layout: () => void } | null = null;

  @Input()
  set xml(value: string) {
    this.formattedXml = this.prettyPrintXml(value || '');
    this.relayoutEditorSoon();
  }

  get xml(): string {
    return this.formattedXml;
  }

  formattedXml = '';

  editorOptions = {
    theme: 'vs-light',
    language: 'xml',
    readOnly: true,
    automaticLayout: true,
    minimap: { enabled: false },
    // scrollBeyondLastLine: true,
    // padding: { top: 10, bottom: 40 },
    // lineHeight: 20,
    // wordWrap: 'on',
  };

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
      // Insert line breaks between adjacent tags first.
      const withBreaks = input
        .replace(/>\s*</g, '><')
        .replace(/(>)(<)(\/*)/g, '$1\n$2$3');

      const lines = withBreaks.split('\n');
      let indentLevel = 0;
      const formatted: string[] = [];

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }

        const isClosingTag = /^<\//.test(line);
        const isCommentOrDecl = /^<\?|^<!/.test(line);
        const isSelfClosing = /\/>$/.test(line);
        const hasFullTagWithText = /^<[^!?/][^>]*>[^<]+<\/[^>]+>$/.test(line);

        if (isClosingTag && indentLevel > 0) {
          indentLevel -= 1;
        }

        const indent = '  '.repeat(Math.max(indentLevel, 0));
        formatted.push(indent + line);

        if (!isClosingTag && !isSelfClosing && !isCommentOrDecl && !hasFullTagWithText && /^<[^/!][^>]*>$/.test(line)) {
          indentLevel += 1;
        }
      }

      return formatted.join('\n');
    } catch {
      // Fall back to original content if formatting fails.
      return xml;
    }
  }
}
