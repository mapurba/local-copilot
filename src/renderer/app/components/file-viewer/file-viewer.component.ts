import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-file-viewer',
  standalone: false,
  template: `
    <ng-container *ngIf="file && file.endsWith('.xml')">
      <!-- Monaco editor placeholder for XML -->
      <div class="h-full w-full bg-white dark:bg-gray-900 border rounded p-2">
        <pre class="overflow-auto text-xs text-gray-900 dark:text-white">{{ content }}</pre>
      </div>
    </ng-container>
    <ng-container *ngIf="file && file.endsWith('.json')">
      <!-- Form.io renderer placeholder -->
      <div class="h-full w-full bg-white dark:bg-gray-900 border rounded p-2">
        <pre class="overflow-auto text-xs text-gray-900 dark:text-white">{{ content }}</pre>
        <!-- TODO: Integrate Form.io renderer here -->
      </div>
    </ng-container>
    <ng-container *ngIf="file && file.endsWith('.md')">
      <div class="h-full w-full bg-white dark:bg-gray-900 border rounded p-3 overflow-auto">
        <markdown [data]="content || ''" [mermaid]="true" class="prose dark:prose-invert max-w-none"></markdown>
      </div>
    </ng-container>
    <ng-container *ngIf="file && !file.endsWith('.xml') && !file.endsWith('.json') && !file.endsWith('.md')">
      <div class="h-full w-full bg-white dark:bg-gray-900 border rounded p-3 overflow-auto">
        <pre class="text-xs text-gray-900 dark:text-white whitespace-pre-wrap">{{ content }}</pre>
      </div>
    </ng-container>
    <ng-container *ngIf="!file">
      <div class="text-gray-400 p-4">Select a file to view</div>
    </ng-container>
  `,
  styles: [':host { display: block; height: 100%; width: 100%; }']
})
export class FileViewerComponent {
  @Input() file: string | null = null;
  @Input() content: string | null = null;
}
