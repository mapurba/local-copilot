import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChatComponent } from './components/chat/chat.component';
import { OnInit } from '@angular/core';
import { CopilotService } from './services/copilot.service';

@Component({
  selector: 'app-root',
  standalone: false,
  template: `
    <div [ngClass]="theme() === 'dark' ? 'shell-dark' : 'shell-light'" class="app-shell">
      <div class="app-frame">
        <header class="app-header">
          <div class="app-brand">
            <div class="brand-mark">WF</div>
            <div class="brand-text">
              <h1>Workflow Studio</h1>
              <div class="brand-subtitle">
                <span *ngIf="user()">{{ user() }}</span>
                <span *ngIf="!user()">Not authenticated</span>
              </div>
            </div>
          </div>

          <div class="header-actions">
            <div class="status-chip">
              <span class="status-dot" [ngClass]="(authStatus() === 'OK' || authStatus() === 'AlreadySignedIn') ? 'ok' : 'warn'"></span>
              <span>{{ authStatus() === 'AlreadySignedIn' ? 'Connected' : authStatus() }}</span>
            </div>

            <button (click)="checkForUpdate()" class="tool-btn" title="Check for Update">Update</button>
            <button (click)="toggleTheme()" class="tool-btn" title="Switch theme">Theme</button>

            <button *ngIf="!isAuthenticated()" (click)="startSignIn()" class="action-btn action-primary">Sign In</button>
            <button *ngIf="pendingVerification()" (click)="confirmSignIn()" class="action-btn action-accent">I've Authorized</button>
            <button *ngIf="isAuthenticated()" (click)="performSignOut()" class="action-btn action-neutral">Sign Out</button>
          </div>
        </header>

        <div *ngIf="pendingVerification()" class="verify-banner rounded-xl px-4 py-3 text-sm">
          <div class="font-semibold mb-1">GitHub device sign-in started</div>
          <div class="mb-1">Open: {{ verificationUri() }}</div>
          <div>Code: <span class="font-mono font-semibold">{{ userCode() }}</span></div>
        </div>

        <main class="app-main">
          <section class="chat-stage">
            <app-chat></app-chat>
          </section>
        </main>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      height: 100vh;
    }

    .app-shell {
      height: 100vh;
      width: 100vw;
      overflow: hidden;
      color: #0f172a;
      background: #eef2f7;
    }

    .shell-dark {
      background: #0b1220;
      color: #e2e8f0;
    }

    .app-frame {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      padding: 10px;
      gap: 10px;
    }

    .app-header,
    .chat-stage,
    .verify-banner {
      border: 1px solid #cbd5e1;
      background: #ffffff;
      border-radius: 12px;
    }

    .shell-dark .app-header,
    .shell-dark .chat-stage,
    .shell-dark .verify-banner {
      border-color: #334155;
      background: #111827;
    }

    .app-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      flex-wrap: wrap;
    }

    .app-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .brand-mark {
      width: 30px;
      height: 30px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.03em;
      background: linear-gradient(130deg, #0ea5e9 0%, #2563eb 100%);
      color: #fff;
      flex: 0 0 auto;
    }

    .brand-text h1 {
      font-size: 16px;
      margin: 0;
      line-height: 1.1;
      font-weight: 700;
    }

    .brand-subtitle {
      font-size: 12px;
      opacity: 0.8;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 360px;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .status-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 10px;
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
    }

    .shell-dark .status-chip {
      background: #1f2937;
      border-color: #475569;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
    }

    .status-dot.ok { background: #34d399; }
    .status-dot.warn { background: #fbbf24; }

    .tool-btn,
    .action-btn {
      border-radius: 8px;
      font-size: 12px;
      font-weight: 700;
      padding: 6px 10px;
      border: 1px solid transparent;
      line-height: 1;
    }

    .tool-btn {
      background: #f8fafc;
      color: inherit;
      border-color: #cbd5e1;
    }

    .shell-dark .tool-btn {
      background: #1f2937;
      border-color: #475569;
    }

    .action-primary {
      background: #2563eb;
      border-color: #2563eb;
      color: #fff;
    }

    .action-accent {
      background: #0f766e;
      border-color: #0f766e;
      color: #fff;
    }

    .action-neutral {
      background: #334155;
      border-color: #334155;
      color: #fff;
    }

    .verify-banner {
      padding: 10px 12px;
      font-size: 13px;
      color: #0f172a;
    }

    .shell-dark .verify-banner {
      color: #dbeafe;
    }

    .app-main {
      flex: 1;
      min-height: 0;
    }

    .chat-stage {
      height: 100%;
      min-height: 0;
      overflow: hidden;
      padding: 4px;
    }
  `]
})

export class App implements OnInit {
  protected readonly title = signal('Copilot Chat');
  protected readonly theme = signal<'light' | 'dark'>(
    (localStorage.getItem('theme') as 'light' | 'dark') === 'dark' ? 'dark' : 'light'
  );
  protected readonly user = signal<string | undefined>(undefined);
  protected readonly authStatus = signal<string>('Unknown');
  protected readonly userCode = signal('');
  protected readonly verificationUri = signal('');

  constructor(private copilotService: CopilotService) {}

  async ngOnInit() {
    this.applyTheme(this.theme());
    await this.refreshStatus();
  }

  toggleTheme() {
    const next = this.theme() === 'light' ? 'dark' : 'light';
    this.theme.set(next);
    localStorage.setItem('theme', next);
    this.applyTheme(next);
  }

  isAuthenticated() {
    return this.authStatus() === 'OK' || this.authStatus() === 'AlreadySignedIn';
  }

  pendingVerification() {
    return !!this.userCode() && !!this.verificationUri() && !this.isAuthenticated();
  }

  async startSignIn() {
    try {
      const result = await this.copilotService.signIn();
      this.userCode.set(result.userCode || '');
      this.verificationUri.set(result.verificationUri || '');
      this.authStatus.set(result.status || 'Pending');
    } catch (error) {
      console.error('Failed to start sign-in:', error);
      this.authStatus.set('SignInFailed');
    }
  }

  async confirmSignIn() {
    try {
      await this.copilotService.confirmSignIn();
      this.userCode.set('');
      this.verificationUri.set('');
      await this.refreshStatus();
    } catch (error) {
      console.error('Failed to confirm sign-in:', error);
      this.authStatus.set('SignInFailed');
    }
  }

  async performSignOut() {
    try {
      await this.copilotService.signOut();
    } finally {
      this.userCode.set('');
      this.verificationUri.set('');
      await this.refreshStatus();
    }
  }

  checkForUpdate() {
    this.copilotService.checkForUpdate();
  }

  private async refreshStatus() {
    try {
      const result = await this.copilotService.getStatus();
      this.authStatus.set(result.status || 'Unknown');
      this.user.set(result.user || undefined);
    } catch {
      this.authStatus.set('Unknown');
      this.user.set(undefined);
    }
  }

  private applyTheme(theme: 'light' | 'dark') {
    const root = document.documentElement;
    const body = document.body;

    root.classList.toggle('dark', theme === 'dark');
    root.classList.toggle('light', theme === 'light');

    body.classList.toggle('dark', theme === 'dark');
    body.classList.toggle('light', theme === 'light');
  }
}
