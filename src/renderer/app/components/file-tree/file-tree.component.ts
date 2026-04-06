import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

@Component({
  selector: 'app-file-tree',
  standalone: false,
  template: `
    <ul class="tree-list select-none">
      <ng-container *ngFor="let node of sortedNodes; trackBy: trackByPath">
        <li>
          <div
            class="tree-row"
            [ngClass]="{
              'is-file-active': !node.isDirectory && activeFilePath === node.path,
              'is-folder': node.isDirectory
            }"
            (click)="onNodeClick(node, $event)">
            <span class="tree-caret" *ngIf="node.isDirectory">{{ effectiveExpanded[node.path] ? '▾' : '▸' }}</span>
            <span class="tree-caret tree-caret-empty" *ngIf="!node.isDirectory"></span>
            <span class="tree-kind" [ngClass]="{ 'kind-folder': node.isDirectory, 'kind-folder-open': node.isDirectory && effectiveExpanded[node.path], 'kind-file': !node.isDirectory }">
              {{ getFileGlyph(node.name, node.isDirectory) }}
            </span>
            <span class="tree-name" [title]="node.name">{{ node.name }}</span>
            <span class="tree-ext" *ngIf="!node.isDirectory" [title]="getFileTypeLabel(node.name)">{{ getFileTypeLabel(node.name) }}</span>
          </div>
          <app-file-tree
            *ngIf="node.isDirectory && node.children && effectiveExpanded[node.path]"
            [nodes]="node.children"
            [activeFilePath]="activeFilePath"
            [expandedState]="effectiveExpanded"
            (fileSelected)="fileSelected.emit($event)"></app-file-tree>
        </li>
      </ng-container>
    </ul>
  `,
  styles: [
    `
      :host {
        display: block;
        font-size: 12px;
      }

      .tree-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .tree-list > li {
        position: relative;
        margin: 1px 0;
      }

      app-file-tree {
        margin-left: 14px;
        border-left: 1px solid rgba(148, 163, 184, 0.25);
        padding-left: 8px;
      }

      .tree-row {
        display: flex;
        align-items: center;
        gap: 7px;
        border-radius: 8px;
        border: 1px solid transparent;
        padding: 5px 8px;
        cursor: pointer;
        color: #374151;
        transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
      }

      .tree-row:hover {
        background: rgba(59, 130, 246, 0.08);
        border-color: rgba(59, 130, 246, 0.2);
      }

      .tree-row.is-file-active {
        background: linear-gradient(90deg, rgba(59, 130, 246, 0.2) 0%, rgba(59, 130, 246, 0.1) 100%);
        border-color: rgba(59, 130, 246, 0.42);
        color: #111827;
        font-weight: 600;
        box-shadow: inset 2px 0 0 rgba(37, 99, 235, 0.95);
      }

      .tree-row.is-folder {
        font-weight: 600;
      }

      .tree-caret {
        width: 12px;
        text-align: center;
        color: #64748b;
        flex: 0 0 12px;
      }

      .tree-caret-empty {
        opacity: 0.35;
      }

      .tree-kind {
        min-width: 18px;
        height: 18px;
        border-radius: 5px;
        font-size: 10px;
        line-height: 18px;
        text-align: center;
        font-weight: 700;
        font-family: Consolas, 'Courier New', monospace;
        border: 1px solid transparent;
      }

      .tree-kind.kind-folder {
        color: #92400e;
        background: rgba(245, 158, 11, 0.14);
        border-color: rgba(245, 158, 11, 0.3);
      }

      .tree-kind.kind-folder-open {
        color: #78350f;
        background: rgba(251, 191, 36, 0.2);
        border-color: rgba(217, 119, 6, 0.35);
      }

      .tree-kind.kind-file {
        color: #1e40af;
        background: rgba(59, 130, 246, 0.12);
        border-color: rgba(59, 130, 246, 0.25);
      }

      .tree-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .tree-ext {
        flex: 0 0 auto;
        font-size: 10px;
        font-weight: 700;
        color: #64748b;
        background: rgba(148, 163, 184, 0.16);
        border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 999px;
        padding: 1px 6px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }

      .tree-row.is-file-active .tree-ext {
        color: #1e3a8a;
        background: rgba(59, 130, 246, 0.2);
        border-color: rgba(59, 130, 246, 0.32);
      }

      :host-context(.dark) .tree-row {
        color: #d1d5db;
      }

      :host-context(.dark) .tree-row:hover {
        background: rgba(30, 58, 138, 0.26);
        border-color: rgba(59, 130, 246, 0.35);
      }

      :host-context(.dark) .tree-row.is-file-active {
        background: linear-gradient(90deg, rgba(30, 64, 175, 0.52) 0%, rgba(30, 64, 175, 0.28) 100%);
        border-color: rgba(59, 130, 246, 0.5);
        color: #f3f4f6;
      }

      :host-context(.dark) app-file-tree {
        border-left-color: rgba(71, 85, 105, 0.7);
      }

      :host-context(.dark) .tree-caret {
        color: #94a3b8;
      }

      :host-context(.dark) .tree-kind.kind-folder {
        color: #fcd34d;
        background: rgba(217, 119, 6, 0.3);
        border-color: rgba(245, 158, 11, 0.45);
      }

      :host-context(.dark) .tree-kind.kind-folder-open {
        color: #fde68a;
        background: rgba(180, 83, 9, 0.45);
        border-color: rgba(251, 191, 36, 0.45);
      }

      :host-context(.dark) .tree-kind.kind-file {
        color: #bfdbfe;
        background: rgba(29, 78, 216, 0.3);
        border-color: rgba(59, 130, 246, 0.45);
      }

      :host-context(.dark) .tree-ext {
        color: #cbd5e1;
        background: rgba(71, 85, 105, 0.45);
        border-color: rgba(100, 116, 139, 0.55);
      }

      :host-context(.dark) .tree-row.is-file-active .tree-ext {
        color: #dbeafe;
        background: rgba(30, 64, 175, 0.5);
        border-color: rgba(96, 165, 250, 0.6);
      }
    `
  ]
})
export class FileTreeComponent implements OnChanges {
  @Input() nodes: FileNode[] = [];
  @Input() activeFilePath: string | null = null;
  @Input() expandedState: Record<string, boolean> | null = null;
  @Output() fileSelected = new EventEmitter<FileNode>();
  private localExpanded: Record<string, boolean> = {};

  get effectiveExpanded(): Record<string, boolean> {
    return this.expandedState || this.localExpanded;
  }

  get sortedNodes(): FileNode[] {
    return [...this.nodes].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['activeFilePath'] || changes['nodes']) {
      this.expandToActiveFile();
    }
  }

  trackByPath = (_index: number, node: FileNode): string => node.path;

  onNodeClick(node: FileNode, event: MouseEvent) {
    event.stopPropagation();
    if (node.isDirectory) {
      this.effectiveExpanded[node.path] = !this.effectiveExpanded[node.path];
    } else {
      this.fileSelected.emit(node);
    }
  }

  getFileGlyph(name: string, isDirectory: boolean): string {
    if (isDirectory) return 'D';
    const lower = name.toLowerCase();
    if (lower.endsWith('.xml')) return 'XML';
    if (lower.endsWith('.json')) return 'JS';
    if (lower.endsWith('.md')) return 'MD';
    if (lower.endsWith('.txt')) return 'TXT';
    return 'F';
  }

  getFileTypeLabel(name: string): string {
    const lower = name.toLowerCase();
    const parts = lower.split('.');
    if (parts.length <= 1) return 'file';
    const ext = parts[parts.length - 1] || 'file';
    return ext.length > 5 ? `${ext.slice(0, 5)}+` : ext;
  }

  private expandToActiveFile() {
    const target = (this.activeFilePath || '').trim();
    if (!target || !this.nodes.length) {
      return;
    }
    this.markAncestorsExpanded(this.nodes, target, this.effectiveExpanded);
  }

  private markAncestorsExpanded(nodes: FileNode[], targetPath: string, expanded: Record<string, boolean>): boolean {
    for (const node of nodes) {
      if (!node.isDirectory) {
        if (node.path === targetPath) {
          return true;
        }
        continue;
      }

      const children = Array.isArray(node.children) ? node.children : [];
      if (!children.length) {
        continue;
      }

      const foundInChildren = this.markAncestorsExpanded(children, targetPath, expanded);
      if (foundInChildren) {
        expanded[node.path] = true;
        return true;
      }
    }

    return false;
  }
}
