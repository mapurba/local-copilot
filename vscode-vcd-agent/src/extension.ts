import * as vscode from 'vscode';
import * as path from 'path';
import { initVcdAuth, vcdStatus, vcdSignOut, vcdSignIn } from './vcdAuth';
import { VCD_HOST, API_VERSION, ORG_OPTIONS } from './vcdConfig';
import { setLogPath } from './apiLogger';
import { setDocStoragePath } from './docs/storage';
import { setLocalWorkspacePath } from './tools/local';
import { registerVcdTools } from './tools/vcd';
import { registerSshTools } from './tools/ssh';
import { registerTaskTools } from './tools/tasks';
import { registerLocalTools } from './tools/local';
import { registerDocsTools } from './tools/docs';
import { registerChatParticipant } from './chat/participant';
import { VmTreeProvider } from './views/vmTreeProvider';
import { TaskTreeProvider } from './views/taskTreeProvider';
import { DocsTreeProvider } from './views/docsTreeProvider';
import { allocateFreeIp } from './vcdApi';
import { setPendingForm, VcdCreateForm } from './vcdStore';

let statusBarItem: vscode.StatusBarItem;

// ---------------------------------------------------------------------------
// VM Form — WebviewView (bottom panel, like Terminal/Output)
// ---------------------------------------------------------------------------
class VmFormViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vcdAgent.vmForm';
  private _view?: vscode.WebviewView;
  private _pendingForm?: Record<string, unknown>;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._pendingForm
      ? buildVmFormHtml(this._pendingForm)
      : '<body style="padding:16px;font-family:var(--vscode-font-family);color:var(--vscode-foreground)">No pending VM form.</body>';

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'fetchIp') {
        const result = await allocateFreeIp();
        if (result.success && result.ip) {
          webviewView.webview.postMessage({ type: 'ipAllocated', ip: result.ip });
        } else {
          webviewView.webview.postMessage({ type: 'ipError', error: result.error ?? 'Failed to allocate IP' });
        }
      } else if (msg.type === 'deploy') {
        setPendingForm(msg.draft as VcdCreateForm);
        webviewView.webview.html = '<body style="padding:16px;font-family:var(--vscode-font-family);color:var(--vscode-foreground)">✅ Deploying VM… switch to the chat panel.</body>';
        await vscode.commands.executeCommand('workbench.action.chat.open', '@vcd deploy the VM (confirmed)');
      }
    });
  }

  showForm(form: Record<string, unknown>): void {
    this._pendingForm = form;
    if (this._view) {
      this._view.webview.html = buildVmFormHtml(form);
      this._view.show(true); // focus the panel
    }
  }
}

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  // ── Storage paths ───────────────────────────────────────────────────────────
  const globalStoragePath = ctx.globalStorageUri.fsPath;
  setLogPath(path.join(globalStoragePath, 'api-calls.log'));
  setDocStoragePath(globalStoragePath);
  setLocalWorkspacePath(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? globalStoragePath);

  // ── Auth ────────────────────────────────────────────────────────────────────
  initVcdAuth(ctx.secrets);

  // ── Status bar ──────────────────────────────────────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBarItem.command = 'vcdAgent.connect';
  ctx.subscriptions.push(statusBarItem);
  await refreshStatusBar();

  // ── Register all LM tools ───────────────────────────────────────────────────
  registerVcdTools(ctx);
  registerSshTools(ctx);
  registerTaskTools(ctx);
  registerLocalTools(ctx);
  registerDocsTools(ctx);

  // ── Chat participant ────────────────────────────────────────────────────────
  registerChatParticipant(ctx);

  // ── Tree views ──────────────────────────────────────────────────────────────
  const vmProvider = new VmTreeProvider();
  const taskProvider = new TaskTreeProvider();
  const docsProvider = new DocsTreeProvider();
  const vmFormProvider = new VmFormViewProvider();

  ctx.subscriptions.push(
    vscode.window.createTreeView('vcdAgent.vms', { treeDataProvider: vmProvider, showCollapseAll: false }),
    vscode.window.createTreeView('vcdAgent.tasks', { treeDataProvider: taskProvider, showCollapseAll: true }),
    vscode.window.createTreeView('vcdAgent.docs', { treeDataProvider: docsProvider, showCollapseAll: false }),
    vscode.window.registerWebviewViewProvider(VmFormViewProvider.viewType, vmFormProvider),
    taskProvider,
    docsProvider
  );

  // ── Commands ────────────────────────────────────────────────────────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand('vcdAgent.connect', async () => {
      const org = await vscode.window.showQuickPick(ORG_OPTIONS, {
        title: `Connect to ${VCD_HOST} — 1/3`,
        placeHolder: 'Select your VCD organization',
        ignoreFocusOut: true,
      });
      if (!org) return;

      const username = await vscode.window.showInputBox({
        title: `Connect to ${VCD_HOST} — 2/3`,
        prompt: `Username for ${org}`,
        ignoreFocusOut: true,
      });
      if (!username) return;

      const password = await vscode.window.showInputBox({
        title: `Connect to ${VCD_HOST} — 3/3`,
        prompt: `Password for ${username}@${org}`,
        password: true,
        ignoreFocusOut: true,
      });
      if (!password) return;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Connecting to ${VCD_HOST}…`, cancellable: false },
        async () => {
          try {
            await vcdSignIn({ host: VCD_HOST, org, username, password, apiVersion: API_VERSION });
            const s = await vcdStatus();
            await refreshStatusBar(s.org, s.host);
            vmProvider.refresh();
            vscode.window.showInformationMessage(`VCD Agent: Connected to ${s.org ?? VCD_HOST}`);
          } catch (err) {
            vscode.window.showErrorMessage(`VCD login failed: ${(err as Error).message}`);
          }
        }
      );
    }),

    vscode.commands.registerCommand('vcdAgent.disconnect', async () => {
      await vcdSignOut();
      await refreshStatusBar();
      vscode.window.showInformationMessage('VCD Agent: Disconnected.');
    }),

    vscode.commands.registerCommand('vcdAgent.refreshVms', () => {
      vmProvider.refresh();
    }),

    vscode.commands.registerCommand('vcdAgent.configureTools', async () => {
      // Show a multi-select quick pick of all registered vcd-agent tools
      const allTools = vscode.lm.tools.filter((t) => t.name.startsWith('vcd-agent_'));
      const disabled = new Set<string>(
        vscode.workspace.getConfiguration('vcdAgent').get<string[]>('disabledTools', [])
      );
      const picks = allTools.map((t) => ({
        label: t.name.replace('vcd-agent_', ''),
        description: t.description ?? '',
        picked: !disabled.has(t.name),
        toolName: t.name,
      }));
      const selected = await vscode.window.showQuickPick(picks, {
        canPickMany: true,
        title: 'Configure VCD Agent Tools',
        placeHolder: 'Check tools to enable them',
      });
      if (!selected) return;
      const enabledNames = new Set(selected.map((p) => p.toolName));
      const newDisabled = allTools.map((t) => t.name).filter((n) => !enabledNames.has(n));
      await vscode.workspace.getConfiguration('vcdAgent').update('disabledTools', newDisabled, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Tools configured: ${selected.length} enabled.`);
    }),

    vscode.commands.registerCommand('vcdAgent.openTaskLog', async (taskId?: string) => {
      if (!taskId) {
        vscode.window.showInformationMessage('No task selected.');
        return;
      }
      const channel = vscode.window.createOutputChannel(`VCD Task: ${taskId}`);
      channel.show();
      // TODO: stream full log content into the output channel
    }),

    // Internal command: show VM form in the bottom panel (called from chat participant)
    vscode.commands.registerCommand('vcdAgent.showVmForm', async (form: unknown) => {
      vmFormProvider.showForm((form ?? {}) as Record<string, unknown>);
      // Focus the panel view — VS Code auto-generates this command for contributed views
      await vscode.commands.executeCommand('vcdAgent.vmForm.focus');
    }),

    // Legacy fallback: open VM form as a standalone editor panel
    vscode.commands.registerCommand('vcdAgent.openVmForm', async (form: unknown) => {
      const panel = vscode.window.createWebviewPanel(
        'vcdVmForm',
        'Create VM — Review & Deploy',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      panel.webview.html = buildVmFormHtml(form);
      panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'fetchIp') {
          const result = await allocateFreeIp();
          if (result.success && result.ip) {
            panel.webview.postMessage({ type: 'ipAllocated', ip: result.ip });
          } else {
            panel.webview.postMessage({ type: 'ipError', error: result.error ?? 'Failed to allocate IP' });
          }
        } else if (msg.type === 'deploy') {
          setPendingForm(msg.draft as VcdCreateForm);
          panel.dispose();
          await vscode.commands.executeCommand('workbench.action.chat.open', '@vcd deploy the VM (confirmed)');
        }
      });
    })
  );

  // ── Restore VCD session if stored ──────────────────────────────────────────
  const status = await vcdStatus();
  if (status.connected) {
    await refreshStatusBar(status.org, status.host);
    vmProvider.refresh();
  }
}

export function deactivate(): void {
  statusBarItem?.dispose();
}

async function refreshStatusBar(org?: string, host?: string): Promise<void> {
  if (org) {
    statusBarItem.text = `$(vm) VCD: ${org}`;
    statusBarItem.tooltip = `Connected to ${host ?? ''}`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = '$(vm) VCD: Not connected';
    statusBarItem.tooltip = 'Click to connect to VCD';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  statusBarItem.show();
}

function buildVmFormHtml(form: unknown): string {
  const f = (form ?? {}) as Record<string, unknown>;
  const data = JSON.stringify(f);
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Create VM</title>
<style>
  body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 640px; }
  h2 { margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: 160px 1fr; gap: 6px 12px; align-items: center; }
  label { font-size: 12px; opacity: .8; text-align: right; }
  input, select { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 8px; }
  .ip-row { display: flex; gap: 6px; }
  .ip-row input { flex: 1; }
  .btn { padding: 6px 16px; border: none; cursor: pointer; font-size: 13px; }
  .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); margin-top: 20px; padding: 8px 32px; }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .msg { margin-top: 8px; font-size: 12px; opacity: .75; }
  .section { grid-column: 1 / -1; margin-top: 12px; font-size: 11px; opacity: .5; text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 2px; }
</style>
</head>
<body>
<h2>Review VM Deployment</h2>
<div class="grid" id="form"></div>
<button class="btn btn-primary" onclick="deploy()">Deploy</button>
<div class="msg" id="msg"></div>
<script>
  const vscode = acquireVsCodeApi();
  const f = ${data};

  const FIELDS = [
    { section: 'Identity' },
    { key: 'vm_name',            label: 'VM Name',             type: 'text' },
    { key: 'template_name',      label: 'Template',            type: 'text', readonly: true },
    { key: 'template_id',        label: 'Template ID',         type: 'text', readonly: true },
    { section: 'Network' },
    { key: 'network_name',       label: 'Network',             type: 'text' },
    { key: 'ip_allocation_mode', label: 'IP Mode',             type: 'select', options: ['DHCP','MANUAL'] },
    { key: 'ip_address',         label: 'IP Address',          type: 'ip' },
    { key: 'gateway',            label: 'Gateway',             type: 'text' },
    { key: 'dns_servers',        label: 'DNS Servers',         type: 'text' },
    { section: 'Resources' },
    { key: 'storage_profile_id', label: 'Storage Profile ID',  type: 'text' },
    { key: 'compute_policy_id',  label: 'Compute Policy ID',   type: 'text' },
    { key: 'power_on',           label: 'Power On',            type: 'select', options: ['true','false'] },
    { section: 'ILM Setup (optional)' },
    { key: 'setup_ilm',          label: 'Setup ILM',           type: 'select', options: ['false','true'] },
    { key: 'ilm_version',        label: 'ILM Version',         type: 'text' },
  ];

  const container = document.getElementById('form');
  FIELDS.forEach(field => {
    if (field.section) {
      container.innerHTML += '<div class="section">' + field.section + '</div>';
      return;
    }
    const val = f[field.key] !== undefined ? String(f[field.key]) : '';
    let input = '';
    if (field.type === 'select') {
      const opts = field.options.map(o => '<option value="' + o + '"' + (val === o ? ' selected' : '') + '>' + o + '</option>').join('');
      input = '<select id="' + field.key + '">' + opts + '</select>';
    } else if (field.type === 'ip') {
      input = '<div class="ip-row"><input id="' + field.key + '" value="' + val + '" /><button class="btn btn-secondary" onclick="fetchIp()">Fetch IP</button></div>';
    } else {
      input = '<input id="' + field.key + '" value="' + val + '"' + (field.readonly ? ' readonly style="opacity:.6"' : '') + ' />';
    }
    container.innerHTML += '<label>' + field.label + '</label><div>' + input + '</div>';
  });

  function fetchIp() {
    document.getElementById('msg').textContent = 'Allocating IP…';
    vscode.postMessage({ type: 'fetchIp' });
  }

  function deploy() {
    const keys = ['vm_name','template_name','template_id','network_name','ip_allocation_mode',
                  'ip_address','gateway','dns_servers','storage_profile_id','compute_policy_id',
                  'power_on','setup_ilm','ilm_version'];
    const draft = {};
    keys.forEach(k => {
      const el = document.getElementById(k);
      if (el) draft[k] = el.value;
    });
    // carry over fields not shown in the form
    if (f.custom_env_content) draft.custom_env_content = f.custom_env_content;
    vscode.postMessage({ type: 'deploy', draft });
  }

  window.addEventListener('message', ev => {
    const msg = ev.data;
    if (msg.type === 'ipAllocated') {
      const el = document.getElementById('ip_address');
      if (el) el.value = msg.ip;
      const modeEl = document.getElementById('ip_allocation_mode');
      if (modeEl) modeEl.value = 'MANUAL';
      document.getElementById('msg').textContent = 'IP allocated: ' + msg.ip;
    } else if (msg.type === 'ipError') {
      document.getElementById('msg').textContent = '⚠ ' + msg.error;
    }
  });
</script>
</body>
</html>`;
}
