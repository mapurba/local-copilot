import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChatComponent } from './components/chat/chat.component';
import { OnInit } from '@angular/core';
import { CopilotService } from './services/copilot.service';

@Component({
  selector: 'app-root',
  standalone: false,
  template: `
    <div
      [ngClass]="theme() === 'dark' ? 'dark bg-slate-950 text-slate-100' : 'light bg-slate-100 text-slate-900'"
      class="h-screen w-screen min-h-0">
      <div class="flex flex-col h-full min-h-0">
        <!-- Header -->
        <div
          [ngClass]="theme() === 'dark' ? 'border-slate-800 bg-slate-900/80' : 'border-slate-200 bg-white/80'"
          class="border-b px-4 py-3 backdrop-blur flex items-center justify-between gap-4">
          <div class="flex items-center gap-4">
            <h1 class="text-lg font-bold m-0">Copilot Chat</h1>
            <div [ngClass]="theme() === 'dark' ? 'text-slate-300' : 'text-slate-600'" class="text-xs">
              <span *ngIf="user()">User: <span class="font-semibold">{{ user() }}</span></span>
              <span *ngIf="!user()" [ngClass]="theme() === 'dark' ? 'text-amber-400' : 'text-amber-600'">Not authenticated</span>
            </div>
          </div>

          <div class="flex items-center gap-3">
            <div [ngClass]="theme() === 'dark' ? 'bg-slate-800' : 'bg-slate-100'" class="flex items-center gap-1 px-3 py-1 rounded-md">
              <div
                class="w-2 h-2 rounded-full"
                [ngClass]="(authStatus() === 'OK' || authStatus() === 'AlreadySignedIn') ? 'bg-green-400' : 'bg-yellow-400'">
              </div>
              <span [ngClass]="theme() === 'dark' ? 'text-slate-300' : 'text-slate-700'" class="text-xs">{{ authStatus() === 'AlreadySignedIn' ? 'Connected' : authStatus() }}</span>
            </div>

            <button
              (click)="checkForUpdate()"
              class="p-1.5 text-slate-500 hover:text-emerald-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-emerald-400 dark:hover:bg-slate-800 rounded-md transition-colors"
              title="Check for Update">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M23 4v6h-6" />
                <path d="M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36M20.49 15a9 9 0 0 1-14.85 3.36" />
              </svg>
            </button>

            <button
              (click)="toggleTheme()"
              class="p-1.5 text-slate-500 hover:text-amber-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-amber-400 dark:hover:bg-slate-800 rounded-md transition-colors"
              title="Switch theme">
              <ng-container *ngIf="theme() === 'light'; else darkIcon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              </ng-container>
              <ng-template #darkIcon>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              </ng-template>
            </button>

            <button
              *ngIf="!isAuthenticated()"
              (click)="startSignIn()"
              class="px-3 py-1.5 rounded bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 transition-colors">
              Sign In
            </button>

            <button
              *ngIf="pendingVerification()"
              (click)="confirmSignIn()"
              class="px-3 py-1.5 rounded bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 transition-colors">
              I've Authorized
            </button>

            <button
              *ngIf="isAuthenticated()"
              (click)="performSignOut()"
              class="px-3 py-1.5 rounded bg-gray-700 text-white text-xs font-semibold hover:bg-gray-600 transition-colors">
              Sign Out
            </button>
          </div>
        </div>

        <div *ngIf="pendingVerification()" class="border-b border-blue-700/40 bg-blue-950/40 px-4 py-3 text-sm text-blue-100">
          <div class="font-semibold mb-1">GitHub device sign-in started</div>
          <div class="mb-1">Open: {{ verificationUri() }}</div>
          <div>Code: <span class="font-mono font-semibold">{{ userCode() }}</span></div>
        </div>

        <!-- Main Content -->
        <div class="flex-1 min-h-0 flex overflow-hidden p-3 sm:p-4 gap-4">
          <aside
            [ngClass]="theme() === 'dark' ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-white'"
            class="hidden md:flex w-64 shrink-0 rounded-2xl border p-4">
            <div class="w-full">
              <div [ngClass]="theme() === 'dark' ? 'text-slate-400' : 'text-slate-500'" class="text-xs uppercase tracking-[0.2em] mb-2">Extension Space</div>
              <div
                [ngClass]="theme() === 'dark' ? 'border-slate-700 text-slate-300' : 'border-slate-300 text-slate-600'"
                class="rounded-xl border border-dashed p-3 text-sm">
                Reserved for future modules.
              </div>
              <div [ngClass]="theme() === 'dark' ? 'text-slate-400' : 'text-slate-500'" class="mt-3 text-xs">
                Add new tools, navigation, or panels here.
              </div>
            </div>
          </aside>

          <section
            [ngClass]="theme() === 'dark' ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-white'"
            class="flex-1 min-h-0 overflow-hidden rounded-2xl border p-2 sm:p-3">
            <app-chat></app-chat>
          </section>
        </div>
      </div>
    </div>
  `,
  styles: [':host { display: block; height: 100vh; }']
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
