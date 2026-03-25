import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DebugLoggerService, DebugLog } from '../../services/debug-logger.service';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

@Component({
  selector: 'app-debug-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './debug-panel.component.html',
  styleUrls: ['./debug-panel.component.css']
})
export class DebugPanelComponent implements OnInit, OnDestroy {
  logs: DebugLog[] = [];
  filteredLogs: DebugLog[] = [];
  selectedFilter: 'all' | 'info' | 'debug' | 'error' | 'tool' | 'api' | 'thinking' = 'all';
  filterOptions: Array<'all' | 'info' | 'debug' | 'error' | 'tool' | 'api' | 'thinking'> = [
    'all',
    'info',
    'debug',
    'error',
    'tool',
    'api',
    'thinking'
  ];
  searchText = '';
  isExpanded = true;
  expandedLogs: Set<string> = new Set();
  private destroy$ = new Subject<void>();

  constructor(private debugLogger: DebugLoggerService) {}

  ngOnInit(): void {
    // Load initial logs
    this.logs = this.debugLogger.getLogs();
    this.applyFilters();

    // Subscribe to new logs
    this.debugLogger.logs$.pipe(takeUntil(this.destroy$)).subscribe(log => {
      this.logs.push(log);
      if (this.logs.length > 500) {
        this.logs = this.logs.slice(-500);
      }
      this.applyFilters();
      // Auto-scroll to bottom
      setTimeout(() => {
        const scrollContainer = document.querySelector('.debug-logs-scroll');
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      }, 0);
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  applyFilters(): void {
    let filtered = this.logs;

    // Apply type filter
    if (this.selectedFilter !== 'all') {
      filtered = filtered.filter(log => log.type === this.selectedFilter);
    }

    // Apply search filter
    if (this.searchText.trim()) {
      const search = this.searchText.toLowerCase();
      filtered = filtered.filter(
        log =>
          log.message.toLowerCase().includes(search) ||
          JSON.stringify(log.details).toLowerCase().includes(search)
      );
    }

    this.filteredLogs = filtered;
  }

  onFilterChange(filter: DebugLog['type'] | 'all'): void {
    this.selectedFilter = filter;
    this.applyFilters();
  }

  onSearchChange(text: string): void {
    this.searchText = text;
    this.applyFilters();
  }

  toggleLog(logId: string): void {
    if (this.expandedLogs.has(logId)) {
      this.expandedLogs.delete(logId);
    } else {
      this.expandedLogs.add(logId);
    }
  }

  isLogExpanded(logId: string): boolean {
    return this.expandedLogs.has(logId);
  }

  clearLogs(): void {
    if (confirm('Clear all logs?')) {
      this.debugLogger.clearLogs();
      this.logs = [];
      this.filteredLogs = [];
    }
  }

  exportLogs(): void {
    const logsText = this.debugLogger.exportLogs();
    const blob = new Blob([logsText], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `debug-logs-${new Date().toISOString()}.txt`;
    a.click();
    window.URL.revokeObjectURL(url);
  }

  getLogIcon(type: DebugLog['type']): string {
    const icons: Record<DebugLog['type'], string> = {
      info: 'ℹ️',
      debug: '🐛',
      error: '❌',
      tool: '🔧',
      api: '🌐',
      thinking: '💭'
    };
    return icons[type];
  }

  togglePanel(): void {
    this.isExpanded = !this.isExpanded;
  }
}
