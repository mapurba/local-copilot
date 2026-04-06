import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MonacoEditorModule } from 'ngx-monaco-editor-v2';
import { MarkdownModule } from 'ngx-markdown';
import { ChatBridgeService } from '../../services/chat-bridge.service';
import { CopilotService } from '../../services/copilot.service';
import { DebugLoggerService } from '../../services/debug-logger.service';

type TodoStatus = 'not-started' | 'in-progress' | 'completed';

interface PrdTodoItem {
  id: number;
  title: string;
  details?: string;
  status: TodoStatus;
}

interface ConvertResult {
  summary?: string;
  decodedXml?: string;
  prdTodoList?: unknown;
  activities?: Array<Record<string, unknown>>;
  workflowXml?: string;
  formsJson?: string;
  forms?: unknown[];
  links?: unknown[];
  [key: string]: unknown;
}

@Component({
  selector: 'app-convert-prd',
  standalone: true,
  imports: [CommonModule, FormsModule, MonacoEditorModule, MarkdownModule],
  template: `
    <div class="prd-shell">

      <!-- ── Top bar ─────────────────────────────────────────────── -->
      <div class="prd-topbar">
        <span class="prd-title">Convert PRD</span>
        <div class="prd-topbar-actions">
          <label class="prd-btn prd-btn-upload">
            <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path d="M10 3a1 1 0 01.707.293l4 4a1 1 0 01-1.414 1.414L11 6.414V14a1 1 0 11-2 0V6.414L6.707 8.707A1 1 0 015.293 7.293l4-4A1 1 0 0110 3z"/><path d="M3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"/></svg>
            Upload PRD
            <input #fileInput type="file" accept=".xml,.prd" (change)="onFileSelected($event)" style="display:none" />
          </label>
          <button type="button" (click)="saveArtifacts()" class="prd-btn" [disabled]="!decodedXml && !summaryText">
            <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path d="M17 4H6L3 7v10a1 1 0 001 1h13a1 1 0 001-1V5a1 1 0 00-1-1zm-5 13a2 2 0 110-4 2 2 0 010 4zm3-8H5V5h10v4z"/></svg>
            Save Artifacts
          </button>
        </div>
      </div>

      <!-- ── Progress banner ─────────────────────────────────────── -->
      <div class="prd-progress-banner" *ngIf="isConverting || convertProgressPercent > 0">
        <div class="prd-progress-row">
          <span class="prd-progress-msg">{{ convertStatusMessage || 'Converting…' }}</span>
          <div class="prd-progress-right">
            <span class="prd-progress-pct">{{ convertProgressPercent }}%</span>
            <button *ngIf="isConverting" class="prd-cancel-btn" (click)="cancelConversion()" title="Stop conversion">&#x2715;</button>
          </div>
        </div>
        <div class="prd-progress-track">
          <div class="prd-progress-fill" [style.width.%]="convertProgressPercent"></div>
        </div>
      </div>

      <!-- ── Empty state (no file yet) ──────────────────────────── -->
      <div class="prd-empty" *ngIf="!decodedXml && !isConverting">
        <div class="prd-empty-icon">
          <svg width="40" height="40" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="8" y="4" width="32" height="40" rx="3" stroke-opacity=".4"/>
            <path d="M16 14h16M16 20h16M16 26h10" stroke-opacity=".4"/>
            <circle cx="36" cy="36" r="9" fill="white" stroke-width="2"/>
            <path d="M36 32v8M32 36h8" stroke-width="2.5" stroke-linecap="round"/>
          </svg>
        </div>
        <div class="prd-empty-title">No PRD loaded</div>
        <div class="prd-empty-sub">Upload an Identity Manager PRD (.xml) to decode, analyse and convert it into workflow artifacts.</div>
        <label class="prd-btn prd-btn-upload prd-btn-lg">
          <svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor"><path d="M10 3a1 1 0 01.707.293l4 4a1 1 0 01-1.414 1.414L11 6.414V14a1 1 0 11-2 0V6.414L6.707 8.707A1 1 0 015.293 7.293l4-4A1 1 0 0110 3z"/><path d="M3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"/></svg>
          Choose PRD file
          <input type="file" accept=".xml,.prd" (change)="onFileSelected($event)" style="display:none" />
        </label>
      </div>

      <!-- ── Content area (once a file is loaded) ───────────────── -->
      <div class="prd-content" *ngIf="decodedXml || isConverting">

        <!-- Tab bar -->
        <div class="prd-tabs">
          <button class="prd-tab" [class.active]="activeView === 'xml'" (click)="activeView = 'xml'">
            Decoded XML
          </button>
          <button class="prd-tab" [class.active]="activeView === 'summary'" (click)="activeView = 'summary'" [disabled]="!summaryText">
            Summary
            <span class="prd-tab-badge" *ngIf="summaryText">&#10003;</span>
          </button>
          <div class="prd-tabs-spacer"></div>
          <span class="prd-meta" *ngIf="llmUsed">&#x2728; LLM summary</span>
          <span class="prd-meta" *ngIf="!llmUsed && decodedXml">&#x26A1; Deterministic</span>
          <span class="prd-meta prd-meta-folder" *ngIf="savedFolder" [title]="savedFolder">
            &#x1F4C1; {{ savedFolder | slice:-28 }}
          </span>
        </div>

        <!-- Decoded XML editor -->
        <div class="prd-tab-body" [class.hidden]="activeView !== 'xml'">
          <ngx-monaco-editor class="prd-editor" [options]="editorOptions" [(ngModel)]="decodedXml"></ngx-monaco-editor>
        </div>

        <!-- Summary markdown view -->
        <div class="prd-tab-body prd-summary-body" [class.hidden]="activeView !== 'summary'">
          <markdown [data]="summaryText" [mermaid]="true" class="prd-markdown"></markdown>
        </div>

      </div>

    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; width: 100%; }

    .prd-shell {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
      background: #f8fafc;
    }

    /* ── Top bar ── */
    .prd-topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid #e2e8f0;
      background: #fff;
      flex-shrink: 0;
    }
    .prd-title {
      font-size: 12px;
      font-weight: 700;
      color: #374151;
      letter-spacing: .03em;
      text-transform: uppercase;
    }
    .prd-topbar-actions { display: flex; gap: 6px; }

    .prd-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 500;
      border-radius: 6px;
      border: 1px solid #d1d5db;
      background: #fff;
      color: #374151;
      cursor: pointer;
      transition: background .12s, border-color .12s;
      white-space: nowrap;
    }
    .prd-btn:hover { background: #f1f5f9; border-color: #9ca3af; }
    .prd-btn:disabled { opacity: .45; cursor: default; }
    .prd-btn-upload {
      background: #2563eb;
      border-color: #2563eb;
      color: #fff;
    }
    .prd-btn-upload:hover { background: #1d4ed8; border-color: #1d4ed8; }
    .prd-btn-lg { padding: 8px 18px; font-size: 13px; margin-top: 16px; }

    /* ── Progress banner ── */
    .prd-progress-banner {
      padding: 8px 12px;
      border-bottom: 1px solid #bfdbfe;
      background: #eff6ff;
      flex-shrink: 0;
    }
    .prd-progress-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      color: #1e40af;
      margin-bottom: 5px;
    }
    .prd-progress-right { display: flex; align-items: center; gap: 6px; }
    .prd-progress-pct { font-weight: 600; }
    .prd-cancel-btn {
      background: none;
      border: none;
      cursor: pointer;
      color: #dc2626;
      font-size: 14px;
      padding: 0 2px;
      line-height: 1;
      opacity: .8;
    }
    .prd-cancel-btn:hover { opacity: 1; }
    .prd-progress-track {
      height: 5px;
      border-radius: 999px;
      background: #bfdbfe;
      overflow: hidden;
    }
    .prd-progress-fill {
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(90deg, #3b82f6, #1d4ed8);
      transition: width .35s ease;
    }

    /* ── Empty state ── */
    .prd-empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 32px 24px;
      color: #64748b;
      text-align: center;
    }
    .prd-empty-icon { opacity: .5; margin-bottom: 4px; }
    .prd-empty-title { font-size: 15px; font-weight: 600; color: #374151; }
    .prd-empty-sub { font-size: 12px; max-width: 320px; line-height: 1.5; }

    /* ── Content tabs ── */
    .prd-content {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .prd-tabs {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 0 8px;
      border-bottom: 1px solid #e2e8f0;
      background: #fff;
      flex-shrink: 0;
    }
    .prd-tab {
      padding: 7px 12px;
      font-size: 12px;
      font-weight: 500;
      border: none;
      background: none;
      color: #64748b;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      transition: color .12s;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .prd-tab.active { color: #2563eb; border-bottom-color: #2563eb; font-weight: 600; }
    .prd-tab:hover:not(.active) { color: #374151; }
    .prd-tab:disabled { opacity: .4; cursor: default; }
    .prd-tab-badge { font-size: 10px; color: #16a34a; }
    .prd-tabs-spacer { flex: 1; }
    .prd-meta {
      font-size: 11px;
      color: #94a3b8;
      padding: 0 6px;
      white-space: nowrap;
      overflow: hidden;
      max-width: 180px;
      text-overflow: ellipsis;
    }
    .prd-meta-folder { cursor: default; }

    .prd-tab-body {
      flex: 1;
      height: 0;          /* key for Monaco layout in flex */
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .prd-tab-body.hidden {
      flex: 0 0 0;
      height: 0 !important;
      overflow: hidden;
      visibility: hidden;  /* keep in DOM so Monaco stays initialised */
    }

    .prd-editor {
      flex: 1;
      min-height: 0;
      width: 100%;
    }

    /* ── Summary markdown ── */
    .prd-summary-body { overflow-y: auto; padding: 16px; }
    .prd-markdown {
      font-size: 13px;
      line-height: 1.6;
      color: #1e293b;
    }
    .prd-markdown :is(h1, h2, h3) { font-weight: 700; margin: .8em 0 .3em; }
    .prd-markdown h1 { font-size: 1.2em; }
    .prd-markdown h2 { font-size: 1.05em; }
    .prd-markdown h3 { font-size: .95em; }
    .prd-markdown p { margin: .35em 0; }
    .prd-markdown ul, .prd-markdown ol { padding-left: 1.3em; margin: .3em 0; }
    .prd-markdown code { background: rgba(0,0,0,.06); border-radius: 3px; padding: 1px 4px; font-size: 12px; }
    .prd-markdown pre { background: rgba(0,0,0,.05); border-radius: 6px; padding: 8px 10px; overflow-x: auto; }
    .prd-markdown pre code { background: none; padding: 0; }
    .prd-markdown table { border-collapse: collapse; width: 100%; font-size: 12px; margin: .5em 0; }
    .prd-markdown th, .prd-markdown td { border: 1px solid #d1d5db; padding: 4px 8px; text-align: left; }
    .prd-markdown th { background: rgba(0,0,0,.04); font-weight: 600; }
    .prd-markdown svg { max-width: 100%; height: auto; }
  `]
})
export class ConvertPrdComponent implements OnInit, OnDestroy {
  decodedXml = '';
  summaryText = '';
  activeView: 'xml' | 'summary' = 'xml';
  private pendingQuestions: Array<{ activityId: string; kind: 'form-id' | 'addressee' | string; text: string }> = [];
  savedFolder: string | null = null;
  llmUsed = false;
  isConverting = false;
  convertProgressPercent = 0;
  convertStatusMessage = '';
  private activeConvertRequestId: string | null = null;
  private activeConvertProgressUnsub: (() => void) | null = null;
  private progressNotifiedStages = new Set<string>();
  private isCancelled = false;

  editorOptions = {
    theme: 'vs-light',
    language: 'xml',
    readOnly: false,
    automaticLayout: true,
    wordWrap: 'on' as const,
  };

  constructor(
    private chatBridge: ChatBridgeService,
    private copilotService: CopilotService,
    private debugLogger: DebugLoggerService
  ) {}

  ngOnDestroy() {
    this.stopConvertProgressTracking();
  }

  ngOnInit() {
    // listen for user replies from chat and consume pending PRD questions
    this.chatBridge.userMessages$.subscribe(async (m) => {
      try {
        const messageContent = (m as { content?: unknown } | null)?.content;
        const text = typeof messageContent === 'string' ? messageContent : '';
        if (!text) return;
        if (!this.pendingQuestions || this.pendingQuestions.length === 0) return;
        const pending = this.pendingQuestions.shift()!;
        // apply answer to decodedXml
        if (pending.kind === 'form-id') {
          this.decodedXml = this.insertFormIdForActivity(this.decodedXml, pending.activityId, text);
        } else if (pending.kind === 'addressee') {
          this.decodedXml = this.insertAddresseeForActivity(this.decodedXml, pending.activityId, text);
        }

        // re-run conversion on modified decoded XML to refresh summary / workflow
        try {
          const requestId = this.createConvertRequestId('chat-followup');
          this.startConvertProgressTracking(requestId, 'follow-up update');
          const res = await this.copilotService.convertPrd({ content: this.decodedXml, requestId });
          if (res && res.success && res.result) {
            const out = this.pickBestResult(res.result);
            this.summaryText = out.summary || (out.summary === undefined ? JSON.stringify(out, null, 2) : '');
            this.decodedXml = out.decodedXml || this.decodedXml;
            this.chatBridge.sendPrdTodo(this.normalizeTodoList(out.prdTodoList));
            this.chatBridge.sendAssistantMessage(`Applied answer to '${pending.text}': ${text}`);
          }
        } catch (e) {
          this.chatBridge.sendAssistantMessage(`Failed to re-run conversion after answer: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          this.stopConvertProgressTracking();
        }
      } catch {
        // ignore
      }
    });
  }

  cancelConversion() {
    this.isCancelled = true;
    if (this.activeConvertRequestId) {
      this.copilotService.cancelConvertPrd(this.activeConvertRequestId);
    }
    this.stopConvertProgressTracking();
    this.convertStatusMessage = 'Conversion cancelled.';
    this.convertProgressPercent = 0;
  }

  async onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    this.isCancelled = false;
    const file = input.files[0];
    const requestId = this.createConvertRequestId(file.name);
    this.startConvertProgressTracking(requestId, file.name);
    this.chatBridge.sendAssistantMessage(`Processing PRD: ${file.name}`);
    const reader = new FileReader();
    reader.onload = async () => {
      const content = typeof reader.result === 'string' ? reader.result : '';
      const previewDecoded = this.extractPreviewDecodedXml(content);
      if (previewDecoded) {
        this.decodedXml = previewDecoded;
        await this.yieldToUi();
      }

      try {
        // prefer a configured model if available, otherwise omit modelId
        let modelId: string | undefined = undefined;
        try {
          const models = await this.copilotService.getModels();
          if (Array.isArray(models) && models.length) modelId = String(models[0].id || models[0].label || models[0]);
        } catch {
          modelId = undefined;
        }

        const res = await this.copilotService.convertPrd({ content, modelId, fileName: file.name, requestId });
        if (this.isCancelled) return;
        if (res && res.success && res.result) {
          const out = this.pickBestResult(res.result);
          this.summaryText = out.summary || (out.summary === undefined ? JSON.stringify(out, null, 2) : '');
          this.chatBridge.sendPrdTodo(this.normalizeTodoList(out.prdTodoList));
          this.savedFolder = res && res.saved && res.saved.outputDir ? res.saved.outputDir : this.savedFolder;
          // If we passed a modelId earlier, assume LLM summary was requested
          this.llmUsed = !!(modelId);
          this.decodedXml = out.decodedXml || this.decodedXml;
          // Auto-switch to summary tab when content is ready
          if (this.summaryText) this.activeView = 'summary';

          // Quick heuristics: ask chat about missing forms/addressee on user activities
          const questions: string[] = [];
          if (Array.isArray(out.activities)) {
            out.activities.forEach((a: Record<string, unknown>) => {
              try {
                const activityType = typeof a['type'] === 'string' ? a['type'] : '';
                if (activityType === 'user-activity') {
                  const o = (a['obj'] && typeof a['obj'] === 'object') ? (a['obj'] as Record<string, unknown>) : {};
                  const activityId = typeof a['id'] === 'string' ? a['id'] : '<unknown>';
                  if (!o['@_form-id'] && !o['form-id']) {
                    const q = `User activity '${activityId}' is missing a form-id. Which form should be used?`;
                    questions.push(q);
                    this.pendingQuestions.push({ activityId, kind: 'form-id', text: q });
                  }
                  if (!o['@_addressee'] && !o['addressee']) {
                    const q2 = `User activity '${activityId}' has no addressee configured. Who should be the approver?`;
                    questions.push(q2);
                    this.pendingQuestions.push({ activityId, kind: 'addressee', text: q2 });
                  }
                }
              } catch {
                // ignore
              }
            });
          }
          if (questions.length) this.chatBridge.sendAssistantMessage(`PRD analysis questions:\n- ${questions.join('\n- ')}`);

          // If saved artifacts were returned, notify
          if (res && res.saved && res.saved.outputDir) {
            const parts: string[] = [];
            if (res.saved.decoded && res.saved.decoded.length) parts.push(`Decoded: ${res.saved.decoded.join(', ')}`);
            if (res.saved.summaries && res.saved.summaries.length) parts.push(`Summaries: ${res.saved.summaries.join(', ')}`);
            if (res.saved.todos && res.saved.todos.length) parts.push(`Todo: ${res.saved.todos.join(', ')}`);
            if (res.saved.forms && res.saved.forms.length) parts.push(`Forms: ${res.saved.forms.join(', ')}`);
            this.chatBridge.sendAssistantMessage(`Artifacts saved to ${res.saved.outputDir}\n${parts.join('\n')}`);
            this.chatBridge.sendPrdArtifactsSaved({
              outputDir: res.saved.outputDir,
              files: [
                ...(Array.isArray(res.saved.workflows) ? res.saved.workflows : []),
                ...(Array.isArray(res.saved.forms) ? res.saved.forms : []),
                ...(Array.isArray(res.saved.summaries) ? res.saved.summaries : []),
              ],
            });
          }
        } else {
          this.summaryText = `Conversion failed: ${res && res.error ? res.error : 'Unknown'}`;
          this.chatBridge.sendAssistantMessage(this.summaryText);
        }
      } catch (e) {
        this.summaryText = `Conversion error: ${e instanceof Error ? e.message : String(e)}`;
        this.chatBridge.sendPrdTodo([]);
        this.chatBridge.sendAssistantMessage(this.summaryText);
      } finally {
        this.stopConvertProgressTracking();
      }
    };
    reader.readAsText(file);
    input.value = '';
  }

  private createConvertRequestId(source: string): string {
    const safe = (source || 'prd').replace(/[^a-zA-Z0-9-_\.]/g, '-').slice(0, 40) || 'prd';
    return `convert-${safe}-${Date.now()}`;
  }

  private startConvertProgressTracking(requestId: string, source: string): void {
    this.stopConvertProgressTracking();

    this.isConverting = true;
    this.convertProgressPercent = 1;
    this.convertStatusMessage = `Starting conversion for ${source}`;
    this.activeConvertRequestId = requestId;
    this.progressNotifiedStages.clear();
    this.debugLogger.addLog('tool', 'convert_prd:start', { requestId, source });
    this.publishLiveTodoForStage('started');

    this.activeConvertProgressUnsub = this.copilotService.onConvertPrdProgress((evt) => {
      if (!evt || evt.requestId !== this.activeConvertRequestId) {
        return;
      }

      if (typeof evt.percent === 'number' && Number.isFinite(evt.percent)) {
        this.convertProgressPercent = Math.max(0, Math.min(100, Math.round(evt.percent)));
      }
      this.convertStatusMessage = evt.message || evt.stage || 'Converting PRD';

      this.debugLogger.addLog('tool', `convert_prd:${evt.stage}`, {
        requestId: evt.requestId,
        message: evt.message,
        percent: evt.percent,
        details: evt.details,
      });

      this.publishLiveTodoForStage(evt.stage);

      const stage = String(evt.stage || '').toLowerCase();
      const shouldNotifyChat = ['started', 'parsing', 'llm-summary', 'saving', 'completed', 'failed'].includes(stage);
      if (shouldNotifyChat && !this.progressNotifiedStages.has(stage)) {
        this.progressNotifiedStages.add(stage);
        this.chatBridge.sendAssistantMessage(`PRD convert: ${evt.message}`);
      }
    });
  }

  private stopConvertProgressTracking(): void {
    if (this.activeConvertProgressUnsub) {
      this.activeConvertProgressUnsub();
      this.activeConvertProgressUnsub = null;
    }

    if (this.isConverting && this.convertProgressPercent < 100) {
      this.convertProgressPercent = 100;
    }
    this.isConverting = false;
    this.activeConvertRequestId = null;
  }

  private publishLiveTodoForStage(rawStage: string): void {
    const stage = String(rawStage || '').toLowerCase();
    const step = this.resolveLiveTodoStep(stage);
    const items: PrdTodoItem[] = [
      {
        id: 1,
        title: 'Import PRD file',
        details: 'PRD upload has started.',
        status: step > 1 ? 'completed' : step === 1 ? 'in-progress' : 'not-started',
      },
      {
        id: 2,
        title: 'Decode srvprvProcessXML payload',
        details: 'Extracting ds-attribute srvprvProcessXML from CDATA and decoding base64.',
        status: step > 2 ? 'completed' : step === 2 ? 'in-progress' : 'not-started',
      },
      {
        id: 3,
        title: 'Separate process artifacts',
        details: 'Separating forms, data item mappings, and process workflow XML.',
        status: step > 3 ? 'completed' : step === 3 ? 'in-progress' : 'not-started',
      },
      {
        id: 4,
        title: 'Analyze relationships',
        details: 'Analyzing activity, form usage, and data mappings in process XML.',
        status: step > 4 ? 'completed' : step === 4 ? 'in-progress' : 'not-started',
      },
      {
        id: 5,
        title: 'Create PRD todo list',
        details: 'Building migration checklist from analysis findings.',
        status: step > 5 ? 'completed' : step === 5 ? 'in-progress' : 'not-started',
      },
      {
        id: 6,
        title: 'Start implementation',
        details: 'Generating workflow XML and form artifacts.',
        status: step > 6 ? 'completed' : step === 6 ? 'in-progress' : 'not-started',
      },
      {
        id: 7,
        title: 'Store workflow and split forms',
        details: 'Saving workflow XML and individual form files to output folder.',
        status: step > 7 ? 'completed' : step === 7 ? 'in-progress' : 'not-started',
      },
    ];

    if (stage === 'failed') {
      const active = items.find((item) => item.status === 'in-progress');
      if (active) {
        active.details = `${active.details} Conversion failed before completion.`;
      }
    }

    this.chatBridge.sendPrdTodo(items);
  }

  private resolveLiveTodoStep(stage: string): number {
    switch (stage) {
      case 'started':
      case 'reading-file':
        return 1;
      case 'parsing':
        return 2;
      case 'parsed':
        return 3;
      case 'llm-summary':
      case 'llm-summary-item':
      case 'llm-summary-complete':
        return 4;
      case 'saving':
      case 'output-ready':
        return 5;
      case 'saving-item':
        return 6;
      case 'completed':
        return 8;
      case 'failed':
        return 6;
      default:
        return 1;
    }
  }

  async saveArtifacts() {
    try {
      // open choose output dir (IPC returns either a string path or an object { cancelled, path })
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      const choose = await this.copilotService.chooseWorkflowOutputDir();
      let outputDir = '';
      if (!choose) {
        this.chatBridge.sendAssistantMessage('Save cancelled.');
        return;
      }
      if (typeof choose === 'string') {
        outputDir = choose;
      } else if (typeof choose === 'object') {
        const choice = choose as { cancelled?: boolean; path?: string };
        if (choice.cancelled) {
          this.chatBridge.sendAssistantMessage('Save cancelled.');
          return;
        }
        outputDir = choice.path || '';
      }
      if (!outputDir) { this.chatBridge.sendAssistantMessage('No output dir selected'); return; }

      const ts = Date.now();
      const decodedName = `decoded-${ts}.xml`;
      const summaryName = `summary-${ts}.md`;
      const joinSep = outputDir.endsWith('\\') || outputDir.endsWith('/') ? '' : '\\';
      const decodedPath = `${outputDir}${joinSep}${decodedName}`;
      const summaryPath = `${outputDir}${joinSep}${summaryName}`;

      const saved: string[] = [];
      if (this.decodedXml) {
        const r1 = await this.copilotService.saveWorkflowFile(decodedPath, this.decodedXml);
        if (r1 && r1.success) saved.push(decodedPath);
      }
      if (this.summaryText) {
        const r2 = await this.copilotService.saveWorkflowFile(summaryPath, this.summaryText);
        if (r2 && r2.success) saved.push(summaryPath);
      }
      if (saved.length) this.chatBridge.sendAssistantMessage(`Saved: ${saved.join(', ')}`);
      else this.chatBridge.sendAssistantMessage('No artifacts to save');
    } catch (e) {
      this.chatBridge.sendAssistantMessage(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private pickBestResult(result: unknown): ConvertResult {
    if (!result) return {};
    const maybeResults = (result as { results?: unknown }).results;
    const rawCandidates = Array.isArray(maybeResults) ? maybeResults : [result];
    const candidates = rawCandidates.filter(
      (candidate): candidate is ConvertResult => !!candidate && typeof candidate === 'object'
    );
    if (!candidates.length) return {};

    let best = candidates[0];
    let bestScore = this.scoreResult(candidates[0]);
    for (let i = 1; i < candidates.length; i++) {
      const score = this.scoreResult(candidates[i]);
      if (score > bestScore) {
        bestScore = score;
        best = candidates[i];
      }
    }
    return best || {};
  }

  private scoreResult(candidate: ConvertResult): number {
    const activities = Array.isArray(candidate.activities) ? candidate.activities.length : 0;
    const links = Array.isArray(candidate.links) ? candidate.links.length : 0;
    const forms = Array.isArray(candidate.forms) ? candidate.forms.length : 0;
    const hasWorkflow = typeof candidate.workflowXml === 'string' && candidate.workflowXml.length > 0;
    const hasFormsJson = typeof candidate.formsJson === 'string' && candidate.formsJson.length > 0;
    const hasDecoded = typeof candidate.decodedXml === 'string' && candidate.decodedXml.length > 0;

    return (hasWorkflow ? 120 : 0)
      + (hasFormsJson ? 80 : 0)
      + (hasDecoded ? 20 : 0)
      + (activities * 2)
      + links
      + (forms * 4);
  }

  private extractPreviewDecodedXml(prdXml: string): string {
    if (!prdXml) return '';
    const process = this.decodeAttr(prdXml, 'srvprvProcessXML');
    if (process) return process;

    const xmlData = this.decodeAttr(prdXml, 'XMLData');
    if (xmlData) return xmlData;

    const request = this.decodeAttr(prdXml, 'srvprvRequestXML');
    return request;
  }

  private decodeAttr(xmlText: string, attrName: string): string {
    const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`ds-attr-name\\s*=\\s*["']${escaped}["'][\\s\\S]*?<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, 'i');
    const match = pattern.exec(xmlText);
    if (!match || !match[1]) return '';
    const raw = match[1].trim();
    if (!raw) return '';
    const cleaned = raw.replace(/\s+/g, '');

    try {
      const binary = atob(cleaned);
      const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
      if (typeof TextDecoder !== 'undefined') {
        return new TextDecoder('utf-8').decode(bytes);
      }
      return binary;
    } catch {
      return raw;
    }
  }

  private async yieldToUi(): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 0);
    });
  }

  private insertFormIdForActivity(xml: string, activityId: string, formId: string): string {
    if (!xml || !activityId) return xml;
    try {
      const re = new RegExp(`(<[^>]*\\bactivity-id=(?:"|')${this.escapeRegExp(activityId)}(?:"|')[^>]*)(>)`, 'g');
      return xml.replace(re, (match, group1, close) => {
        if (/\bform-id=/.test(group1)) return match; // already has form-id
        return `${group1} form-id="${this.escapeXmlAttr(String(formId))}"${close}`;
      });
    } catch {
      return xml;
    }
  }

  private insertAddresseeForActivity(xml: string, activityId: string, addressee: string): string {
    if (!xml || !activityId) return xml;
    try {
      const re = new RegExp(`(<[^>]*\\bactivity-id=(?:"|')${this.escapeRegExp(activityId)}(?:"|')[^>]*)(>)`, 'g');
      return xml.replace(re, (match, group1, close) => {
        if (/\baddressee=/.test(group1)) return match; // already has addressee
        return `${group1} addressee="${this.escapeXmlAttr(String(addressee))}"${close}`;
      });
    } catch {
      return xml;
    }
  }

  private escapeRegExp(s: string) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private escapeXmlAttr(s: string) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private normalizeTodoList(todoList: unknown): PrdTodoItem[] {
    if (!Array.isArray(todoList) || todoList.length === 0) {
      return [];
    }

    const normalized = todoList.map((t, idx) => {
      const item = t as { id?: unknown; title?: unknown; details?: unknown; status?: unknown };
      const rawStatus = String(item.status || 'not-started');
      const status: TodoStatus =
        rawStatus === 'completed' || rawStatus === 'in-progress' ? rawStatus : 'not-started';

      return {
        id: Number.isFinite(Number(item.id)) ? Number(item.id) : idx + 1,
        title: item.title ? String(item.title) : `Task ${idx + 1}`,
        details: item.details ? String(item.details) : '',
        status,
      };
    });

    // When there are no outstanding conversion questions, promote remaining in-progress items.
    if (this.pendingQuestions.length === 0) {
      return normalized.map((todo) =>
        todo.status === 'in-progress' ? { ...todo, status: 'completed' as TodoStatus } : todo
      );
    }

    return normalized;
  }
}
