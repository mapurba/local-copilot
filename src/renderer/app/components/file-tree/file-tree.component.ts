import { Component, Input, Output, EventEmitter } from '@angular/core';

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
      <ng-container *ngFor="let node of nodes">
        <li>
          <div
            class="tree-row"
            [ngClass]="{
              'is-file-active': !node.isDirectory && activeFilePath === node.path,
              'is-folder': node.isDirectory
            }"
            (click)="onNodeClick(node, $event)">
            <span class="tree-icon" *ngIf="node.isDirectory">{{ expanded[node.path] ? '▾' : '▸' }}</span>
            <span class="tree-icon" *ngIf="!node.isDirectory">•</span>
            <span class="tree-name" [title]="node.name">{{ node.name }}</span>
          </div>
          <app-file-tree
            *ngIf="node.isDirectory && node.children && expanded[node.path]"
            [nodes]="node.children"
            [activeFilePath]="activeFilePath"
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
        margin: 1px 0;
      }

      app-file-tree {
        margin-left: 12px;
        border-left: 1px dashed rgba(156, 163, 175, 0.35);
        padding-left: 6px;
      }

      .tree-row {
        display: flex;
        align-items: center;
        gap: 6px;
        border-radius: 6px;
        padding: 4px 6px;
        cursor: pointer;
        color: #374151;
      }

      .tree-row:hover {
        background: rgba(59, 130, 246, 0.08);
      }

      .tree-row.is-file-active {
        background: rgba(59, 130, 246, 0.16);
        color: #111827;
        font-weight: 600;
      }

      .tree-row.is-folder {
        font-weight: 600;
      }

      .tree-icon {
        width: 10px;
        text-align: center;
        color: #6b7280;
        flex: 0 0 10px;
      }

      .tree-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      :host-context(.dark) .tree-row {
        color: #d1d5db;
      }

      :host-context(.dark) .tree-row:hover {
        background: rgba(30, 58, 138, 0.35);
      }

      :host-context(.dark) .tree-row.is-file-active {
        background: rgba(30, 64, 175, 0.45);
        color: #f3f4f6;
      }

      :host-context(.dark) app-file-tree {
        border-left-color: rgba(75, 85, 99, 0.6);
      }
    `
  ]
})
export class FileTreeComponent {
  @Input() nodes: FileNode[] = [];
  @Input() activeFilePath: string | null = null;
  @Output() fileSelected = new EventEmitter<FileNode>();
  expanded: Record<string, boolean> = {};

  onNodeClick(node: FileNode, event: MouseEvent) {
    event.stopPropagation();
    if (node.isDirectory) {
      this.expanded[node.path] = !this.expanded[node.path];
    } else {
      this.fileSelected.emit(node);
    }
  }
}
