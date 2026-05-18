import * as vscode from 'vscode';
import { listVms, normalizeVmStatus } from '../vcdApi';
import { getVcdContext } from '../vcdStore';

interface VmItem {
  name: string;
  href: string;
  powered_on: boolean;
  ip?: string;
  owner?: string;
  status?: string;
}

export class VmTreeProvider implements vscode.TreeDataProvider<VmNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private vms: VmItem[] = [];
  private loading = false;

  refresh(): void {
    this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    this._onDidChangeTreeData.fire();
    try {
      getVcdContext(); // throws if not connected
      const result = await listVms(200);
      const raw = ((result as Record<string, unknown>).vms as Record<string, unknown>[] | undefined) ?? [];
      this.vms = raw.map(normalizeVmStatus).map((v) => ({
        name: String(v.name ?? ''),
        href: String(v.href ?? ''),
        powered_on: Boolean(v.powered_on),
        ip: v.ip_address ? String(v.ip_address) : undefined,
        owner: v.owner ? String(v.owner) : undefined,
        status: v.status ? String(v.status) : undefined,
      }));
    } catch {
      this.vms = [];
    }
    this.loading = false;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: VmNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: VmNode): VmNode[] {
    if (element) return [];
    if (this.loading) return [new VmNode({ name: 'Loading…', href: '', powered_on: false }, true)];
    return this.vms.map((v) => new VmNode(v));
  }
}

class VmNode extends vscode.TreeItem {
  constructor(readonly vm: VmItem, placeholder = false) {
    super(vm.name, vscode.TreeItemCollapsibleState.None);
    if (placeholder) {
      this.iconPath = new vscode.ThemeIcon('loading~spin');
      return;
    }
    this.iconPath = new vscode.ThemeIcon(vm.powered_on ? 'vm-running' : 'vm');
    this.description = vm.ip ?? vm.status ?? (vm.powered_on ? 'on' : 'off');
    this.tooltip = `Owner: ${vm.owner ?? 'unknown'}\nHref: ${vm.href}`;
    this.contextValue = vm.powered_on ? 'vmOn' : 'vmOff';
  }
}
