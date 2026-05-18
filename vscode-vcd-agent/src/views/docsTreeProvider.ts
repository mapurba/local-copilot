import * as vscode from 'vscode';
import { listDocuments } from '../docs/storage';

type DocItem = vscode.TreeItem & { docId?: string };

export class DocsTreeProvider implements vscode.TreeDataProvider<DocItem>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<DocItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(element: DocItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DocItem): Promise<DocItem[]> {
    if (element) return [];
    try {
      const docs = await listDocuments();
      return docs.map((d) => {
        const item = new vscode.TreeItem(
          d.title ?? d.filename,
          vscode.TreeItemCollapsibleState.None
        ) as DocItem;
        item.docId = d.id;
        item.description = d.status === 'ready' ? d.fileType : d.status;
        item.tooltip = d.summary ?? d.filename;
        item.iconPath = statusIcon(d.status);
        item.contextValue = 'vcdDoc';
        return item;
      });
    } catch {
      return [];
    }
  }
}

function statusIcon(status: string): vscode.ThemeIcon {
  switch (status) {
    case 'ready': return new vscode.ThemeIcon('file-text');
    case 'processing': return new vscode.ThemeIcon('loading~spin');
    case 'error': return new vscode.ThemeIcon('error');
    default: return new vscode.ThemeIcon('file');
  }
}
