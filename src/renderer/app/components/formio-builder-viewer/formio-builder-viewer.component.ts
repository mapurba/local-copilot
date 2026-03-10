import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormioModule } from '@iam/angular-formio';
// import { FormioAuth } from '@iam/angular-formio/auth';

@Component({
  selector: 'app-formio-builder-viewer',
  standalone: true,
  imports: [CommonModule, FormioModule],
  template: `
    <div class="flex items-center justify-between mb-2">
      <div class="text-xs font-semibold text-gray-500 dark:text-gray-400">Form View</div>
      <div class="flex gap-2">
        <button
          type="button"
          (click)="setView('builder')"
          [class]="viewMode === 'builder' ? 'bg-blue-600 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-200'"
          class="px-2 py-1 rounded text-xs">
          Builder
        </button>
        <button
          type="button"
          (click)="setView('preview')"
          [class]="viewMode === 'preview' ? 'bg-blue-600 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-200'"
          class="px-2 py-1 rounded text-xs">
          Preview
        </button>
      </div>
    </div>

    <div class="h-full">
      <form-builder
        *ngIf="viewMode === 'builder'"
        [form]="$any(localForm || {})"
        [options]="$any(formioOptions || {})">
      </form-builder>

      <formio
        *ngIf="viewMode === 'preview'"
        [form]="$any(localForm || {})"
        [options]="$any(formioOptions || {})"
        [renderOptions]="$any(renderOptions || {})">
      </formio>
    </div>
  `,
  styles: [':host { display: block; height: 100%; width: 100%; }']
})
export class FormioBuilderViewerComponent implements OnChanges {
  @Input() formJsonSchema: Record<string, unknown> | null = null;
  @Input() formioOptions: Record<string, unknown> = {};
  @Input() renderOptions: Record<string, unknown> = {};
  @Output() formChanged = new EventEmitter<Record<string, unknown>>();
  viewMode: 'builder' | 'preview' = 'builder';
  localForm: Record<string, unknown> = {};

  ngOnChanges(changes: SimpleChanges) {
    if (changes['formJsonSchema']) {
      this.localForm = this.formJsonSchema ?? {};
    }
  }

  setView(mode: 'builder' | 'preview') {
    this.viewMode = mode;
    if (mode === 'preview') {
      this.formChanged.emit(this.localForm);
    }
  }

}
