import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChatComponent } from './components/chat/chat.component';
import { OnInit } from '@angular/core';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, ChatComponent],
  template: `
    <div [ngClass]="theme() === 'dark' ? 'dark' : 'light'" class="flex flex-col h-screen w-screen min-h-0 light">
      <div class="flex flex-col flex-1 min-h-0">
        <!-- Header -->
        <div class="border-b border-gray-700 px-2 py-2 flex items-center justify-between">
          <div class="flex items-center gap-4">
            <h1 class="text-lg font-bold m-0">Workflow Generator</h1>
            <div class="text-xs">
              <span *ngIf="user()">User: <span class="">{{ user() }}</span></span>
              <span *ngIf="!user()" class="text-yellow-400">Not authenticated</span>
            </div>
          </div>

          <div class="flex items-center gap-3">
            <div class="flex items-center gap-1 px-3 py-1 rounded bg-gray-700">
              <div
                class="w-2 h-2 rounded-full"
                [ngClass]="(authStatus() === 'OK' || authStatus() === 'AlreadySignedIn') ? 'bg-green-400' : 'bg-yellow-400'">
              </div>
              <span class="text-xs text-gray-300">{{ authStatus() === 'AlreadySignedIn' ? 'Connected' : authStatus() }}</span>
            </div>

            <button
              class="p-1.5 text-gray-400 hover:text-green-400 hover:bg-gray-700 rounded transition-colors"
              title="Check for Update">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M23 4v6h-6" />
                <path d="M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36M20.49 15a9 9 0 0 1-14.85 3.36" />
              </svg>
            </button>

            <button
              (click)="toggleTheme()"
              class="p-1.5 text-gray-400 hover:text-yellow-400 hover:bg-gray-700 rounded transition-colors"
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
          </div>
        </div>

        <!-- Main Content -->
        <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
          <app-chat></app-chat>
        </div>
      </div>
    </div>
  `,
  styles: [':host { display: block; height: 100vh; }']
})

export class App implements OnInit {
  protected readonly title = signal('Workflow Agent');
  protected readonly theme = signal<'light' | 'dark'>('light');
  protected readonly user = signal<string | undefined>(undefined);
  protected readonly authStatus = signal<string>('Unknown');

  async ngOnInit() {
    if ((window as any).copilot?.status) {
      try {
        const result = await (window as any).copilot.status();
        this.authStatus.set(result.status || 'Unknown');
        this.user.set(result.user || undefined);
      } catch (e) {
        this.authStatus.set('Unknown');
        this.user.set(undefined);
      }
    }
  }

  toggleTheme() {
    this.theme.set(this.theme() === 'light' ? 'dark' : 'light');
  }
}
