import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CopilotService } from '../../services/copilot.service';
import { FileTreeComponent, FileNode } from '../file-tree/file-tree.component';
import { WorkflowBuilderViewerComponent } from '../workflow-builder-viewer/workflow-builder-viewer.component';
import { FormioBuilderViewerComponent } from '../formio-builder-viewer/formio-builder-viewer.component';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule, FileTreeComponent, WorkflowBuilderViewerComponent, FormioBuilderViewerComponent],
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.css']
})
export class ChatComponent implements OnInit {
  messages: Message[] = [];
  inputText: string = '';
  isLoading: boolean = false;
  outputDir: string = '';
  selectedModel: string = 'gpt-4.1';
  models: { id: string; label: string }[] = [];
  fileTree: FileNode[] = [];
  openFiles: Array<{
    path: string;
    name: string;
    kind: 'xml' | 'json';
    xml?: string;
    formSchema?: Record<string, unknown>;
    hasChanges?: boolean;
    errorCount?: number;
  }> = [];
  activeFilePath: string | null = null;
  activeTab: 'files' | 'chat' = 'chat';
  formioOptions = {
    i18n: { resources: {} },
    builder: { resource: false },
  };
  formioRenderOptions = {};

  constructor(private copilotService: CopilotService) { }

  async ngOnInit() {
    await this.loadModels();
    if (this.copilotService.isAvailable()) {
      console.log('[Chat] Loading output directory from storage...');
      const dir = await this.copilotService.getWorkflowOutputDir();
      console.log('[Chat] Got directory from storage:', dir);
      this.outputDir = this.extractDirPath(dir);
      console.log('[Chat] Final outputDir:', this.outputDir);
      await this.refreshOutputTree();
    }
  }

  onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  private extractDirPath(dir: unknown): string {
    console.log('[extractDirPath] Input:', dir);
    if (typeof dir === 'string') {
      console.log('[extractDirPath] Is string:', dir);
      return dir;
    }
    if (dir && typeof dir === 'object') {
      if ('path' in dir && typeof (dir as { path?: unknown }).path === 'string') {
        const result = (dir as { path: string }).path;
        console.log('[extractDirPath] Found path property:', result);
        return result;
      }
      if ('directory' in dir && typeof (dir as { directory?: unknown }).directory === 'string') {
        const result = (dir as { directory: string }).directory;
        console.log('[extractDirPath] Found directory property:', result);
        return result;
      }
    }
    console.log('[extractDirPath] No path found, returning empty string');
    return '';
  }

  async loadModels() {
    try {
      const models = await this.copilotService.getModels();
      console.log('Available models:', models);
      this.models = Array.isArray(models)
        ? models.filter(m => m && (m.id || m.label)).map(m => ({
            id: String(m.id || m.label || 'default'),
            label: String(m.label || m.id || 'Default Model'),
          }))
        : [];
      if (this.models.length > 0 && !this.selectedModel) {
        this.selectedModel = this.models[0].id;
      }
    } catch (error) {
      console.error('Failed to load models:', error);
    }
  }

  async sendMessage() {
    const input = this.inputText.trim();
    if (!input) {
      return;
    }

    const userMessage: Message = {
      role: 'user',
      content: this.inputText,
      timestamp: new Date()
    };
    this.messages.push(userMessage);
    this.inputText = '';

    // Check if this is a workflow generation request
    const isWorkflowRequest = this.isWorkflowGenerationRequest(input);

    this.isLoading = true;
    try {
      if (!isWorkflowRequest) {
        const llmReply = await this.copilotService.askLlm(this.selectedModel, input);
        const assistantMessage: Message = {
          role: 'assistant',
          content: llmReply || 'No response returned by the model.',
          timestamp: new Date()
        };
        this.messages.push(assistantMessage);
        return;
      }

      const result = await this.copilotService.generateWorkflow({
        modelId: this.selectedModel,
        request: input,
        outputDir: this.outputDir || undefined
      });

      if (result.success && result.files) {
        // Generate workflow summary from plan
        const summary = result.plan ? this.generateWorkflowSummary(result.plan) : '';
        
        let messageContent = `Workflow generation complete!\n\n`;
        
        if (summary) {
          messageContent += `${summary}\n\n`;
        }
        
        messageContent += `**Artifacts generated:**\n- **workflow.xml**: ${result.files.workflowPath}\n- **forms.json**: ${result.files.formsPath}`;
        
        const assistantMessage: Message = {
          role: 'assistant',
          content: messageContent,
          timestamp: new Date()
        };
        this.messages.push(assistantMessage);

        // Refresh output tree and open files
        await this.refreshOutputTree();
        if (result.files.workflowPath) {
          await this.openFile(result.files.workflowPath);
        }
        if (result.files.formsPath) {
          await this.openFile(result.files.formsPath);
        }

        if (result.critique) {
          const critiqueMessage: Message = {
            role: 'assistant',
            content: `**Critique**: ${result.critique}`,
            timestamp: new Date()
          };
          this.messages.push(critiqueMessage);
        }
      } else {
        const errorMessage: Message = {
          role: 'assistant',
          content: `Error: Workflow generation failed. Please try again.`,
          timestamp: new Date()
        };
        this.messages.push(errorMessage);
      }
    } catch (error: unknown) {
      let message = 'Unknown error occurred';
      if (error && typeof error === 'object' && 'message' in error) {
        const maybeMessage = (error as { message?: unknown }).message;
        if (typeof maybeMessage === 'string') {
          message = maybeMessage;
        }
      }
      const errorMessage: Message = {
        role: 'assistant',
        content: `Error: ${message}`,
        timestamp: new Date()
      };
      this.messages.push(errorMessage);
    } finally {
      this.isLoading = false;
    }
  }

  async chooseOutputDir() {
    try {
      console.log('[Chat] Choosing output directory...');
      const dir = await this.copilotService.chooseWorkflowOutputDir();
      console.log('[Chat] Directory selection result:', dir);
      if (dir) {
        this.outputDir = this.extractDirPath(dir);
        console.log('[Chat] Extracted output path:', this.outputDir);
        await this.refreshOutputTree();
        console.log('[Chat] Tree refreshed after directory selection');
      } else {
        console.warn('[Chat] Directory selection cancelled');
      }
    } catch (error) {
      console.error('Failed to choose output directory:', error);
    }
  }

  async openOutputDir() {
    try {
      await this.copilotService.openWorkflowOutputDir(this.outputDir);
    } catch (error) {
      console.error('Failed to open output directory:', error);
    }
  }

  async refreshOutputTree() {
    if (!this.outputDir) {
      this.fileTree = [];
      return;
    }
    try {
      const result = await this.copilotService.listWorkflowTree();
      if (result.success && result.tree) {
        this.fileTree = result.tree as FileNode[];
        console.log('[Chat] Tree refreshed:', this.fileTree.length, 'items');
      } else {
        console.warn('[Chat] Tree refresh failed:', result.error);
        this.fileTree = [];
      }
    } catch (error) {
      console.error('[Chat] Error refreshing tree:', error);
      this.fileTree = [];
    }
  }

  async onFileSelected(node: FileNode) {
    if (!node || node.isDirectory) return;
    await this.openFile(node.path);
  }

  async openFile(filePath: string) {
    const existing = this.openFiles.find((f) => f.path === filePath);
    if (existing) {
      this.activeFilePath = existing.path;
      this.activeTab = 'files';
      this.syncActiveFormSchema();
      return;
    }

    const name = filePath.split(/[\\/]/).pop() || filePath;
    if (filePath.endsWith('.xml')) {
      const result = await this.copilotService.readWorkflowFile(filePath);
      const xml = result.success && result.content ? result.content : '';
      this.openFiles.push({ path: filePath, name, kind: 'xml', xml });
      this.activeFilePath = filePath;
    } else if (filePath.endsWith('.json')) {
      const result = await this.copilotService.readWorkflowFile(filePath);
      let formSchema: Record<string, unknown> | undefined;
      if (result.success && result.content) {
        try {
          const parsed = JSON.parse(result.content) as unknown;
          formSchema = this.extractFormSchema(parsed);
        } catch {
          formSchema = undefined;
        }
      }
      this.openFiles.push({ path: filePath, name, kind: 'json', formSchema });
      this.activeFilePath = filePath;
    } else {
      this.activeFilePath = null;
    }

    this.activeTab = 'files';
    this.syncActiveFormSchema();
  }

  get activeFile() {
    return this.openFiles.find((f) => f.path === this.activeFilePath) || null;
  }

  setActiveFile(path: string) {
    this.activeFilePath = path;
    this.activeTab = 'files';
    this.syncActiveFormSchema();
  }

  closeFile(path: string) {
    const idx = this.openFiles.findIndex((f) => f.path === path);
    if (idx === -1) return;
    this.openFiles.splice(idx, 1);
    if (this.activeFilePath === path) {
      this.activeFilePath = this.openFiles.length ? this.openFiles[0].path : null;
      this.syncActiveFormSchema();
    }
    if (!this.openFiles.length) {
      this.activeTab = 'chat';
    }
  }

  switchToChatTab() {
    this.activeTab = 'chat';
  }

  onFormSchemaChanged(updatedSchema: unknown) {
    const active = this.activeFile;
    if (active && active.kind === 'json') {
      if (updatedSchema && typeof updatedSchema === 'object') {
        active.formSchema = updatedSchema as Record<string, unknown>;
      }
    }
  }

  private extractFormSchema(parsed: unknown): Record<string, unknown> | undefined {
    if (!parsed) {
      return undefined;
    }

    // Direct Form.io schema object
    if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj['components'])) {
        return obj;
      }
      // Wrapped single form: { form: { ... } }
      const wrapped = obj['form'];
      if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
        return wrapped as Record<string, unknown>;
      }
    }

    // Common workflow output shape: [ { form: { ... } }, ... ]
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const maybeForm = (item as Record<string, unknown>)['form'];
        if (maybeForm && typeof maybeForm === 'object' && !Array.isArray(maybeForm)) {
          return maybeForm as Record<string, unknown>;
        }
      }
    }

    return undefined;
  }

  private generateWorkflowSummary(plan: {
    forms?: Array<{ id: string; components?: unknown[] }>;
    activities?: Array<{ id: string; type: string }>;
    flows?: Array<{ source: string; target: string }>;
  } | null | undefined): string {
    if (!plan) {
      return '';
    }

    const lines: string[] = ['## Workflow Summary'];

    // Forms section
    if (plan.forms && Array.isArray(plan.forms) && plan.forms.length > 0) {
      lines.push('');
      lines.push(`### Forms (${plan.forms.length})`);
      for (const form of plan.forms) {
        const componentCount = Array.isArray(form.components) ? form.components.length : 0;
        lines.push(`- **${form.id}**: ${componentCount} field${componentCount !== 1 ? 's' : ''}`);
      }
    }

    // Activities section
    if (plan.activities && Array.isArray(plan.activities) && plan.activities.length > 0) {
      lines.push('');
      lines.push(`### Activities (${plan.activities.length})`);
      
      const activityByType: Record<string, number> = {};
      for (const activity of plan.activities) {
        const type = activity.type || 'unknown';
        activityByType[type] = (activityByType[type] || 0) + 1;
      }

      for (const [type, count] of Object.entries(activityByType)) {
        lines.push(`- **${type}**: ${count}`);
      }
    }

    // Flows section
    if (plan.flows && Array.isArray(plan.flows) && plan.flows.length > 0) {
      lines.push('');
      lines.push(`### Workflow Flow`);
      lines.push(`${plan.flows.length} transition${plan.flows.length !== 1 ? 's' : ''} connecting activities`);
    }

    return lines.join('\n');
  }

  private syncActiveFormSchema() {
    // No-op: active file data is the source of truth for the viewer.
  }

  private isWorkflowGenerationRequest(input: string): boolean {
    const lowerInput = input.toLowerCase();
    // Keywords that indicate a workflow generation request
    const workflowKeywords = [
      'create',
      'generate',
      'build',
      'workflow',
      'process',
      'form',
      'approval',
      'onboarding',
      'termination',
      'access',
      'request'
    ];
    
    return workflowKeywords.some(keyword => lowerInput.includes(keyword));
  }

  onWorkflowXmlChanged(newXml: string) {
    const active = this.activeFile;
    if (active && active.kind === 'xml') {
      active.xml = newXml;
    }
  }

  onWorkflowHasChangesUpdate(hasChanges: boolean) {
    const active = this.activeFile;
    if (active && active.kind === 'xml') {
      active.hasChanges = hasChanges;
    }
  }

  async saveActiveFile() {
    const active = this.activeFile;
    if (!active) {
      return;
    }

    try {
      let content = '';
      if (active.kind === 'xml' && active.xml) {
        content = active.xml;
      } else if (active.kind === 'json' && active.formSchema) {
        content = JSON.stringify(active.formSchema, null, 2);
      }

      if (content) {
        await this.copilotService.saveWorkflowFile(active.path, content);
        active.hasChanges = false;
        
        // Show success message
        const successMsg: Message = {
          role: 'assistant',
          content: `✓ Saved: ${active.name}`,
          timestamp: new Date()
        };
        this.messages.push(successMsg);
      }
    } catch (error) {
      const errorMsg: Message = {
        role: 'assistant',
        content: `Error saving file: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: new Date()
      };
      this.messages.push(errorMsg);
    }
  }

  get hasUnsavedChanges(): boolean {
    return this.openFiles.some(f => f.hasChanges);
  }
}
