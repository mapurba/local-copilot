import { Component, DestroyRef, ElementRef, EventEmitter, HostBinding, Input, OnDestroy, OnInit, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DebugLoggerService, DebugLog, ThinkingStep } from '../../services/debug-logger.service';

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
  isCompactMode = true;
  @Input() position: 'bottom' | 'right' = 'bottom';
  @Output() positionChange = new EventEmitter<'bottom' | 'right'>();
  @HostBinding('class.right-collapsed') get isRightCollapsed() {
    return this.position === 'right' && !this.isExpanded;
  }

  @HostBinding('style.width') hostWidth: string | null = null;
  @HostBinding('style.height') hostHeight: string | null = null;
  expandedLogs: Set<string> = new Set();
  expandedThinkingSteps: Set<string> = new Set();
  private readonly destroyRef = inject(DestroyRef);
  private readonly elRef = inject(ElementRef);

  // Resize state
  private isResizing = false;
  private resizeStartX = 0;
  private resizeStartY = 0;
  private resizeStartWidth = 400;
  private resizeStartHeight = 300;
  private readonly onMouseMove = (e: MouseEvent) => this.onResizeMove(e);
  private readonly onMouseUp = () => this.onResizeEnd();

  constructor(private debugLogger: DebugLoggerService) {
    this.expandedLogs = new Set();
  }

  ngOnDestroy(): void {
    this.onResizeEnd();
  }

  onResizeStart(e: MouseEvent): void {
    e.preventDefault();
    this.isResizing = true;
    this.resizeStartX = e.clientX;
    this.resizeStartY = e.clientY;
    const el = this.elRef.nativeElement as HTMLElement;
    this.resizeStartWidth = el.offsetWidth;
    this.resizeStartHeight = el.offsetHeight;
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mouseup', this.onMouseUp);
    document.body.style.cursor = this.position === 'right' ? 'ew-resize' : 'ns-resize';
    document.body.style.userSelect = 'none';
  }

  private onResizeMove(e: MouseEvent): void {
    if (!this.isResizing) return;
    if (this.position === 'right') {
      const delta = this.resizeStartX - e.clientX;
      const newWidth = Math.max(220, Math.min(800, this.resizeStartWidth + delta));
      this.hostWidth = newWidth + 'px';
    } else {
      const delta = this.resizeStartY - e.clientY;
      const newHeight = Math.max(100, Math.min(window.innerHeight * 0.8, this.resizeStartHeight + delta));
      this.hostHeight = newHeight + 'px';
    }
  }

  private onResizeEnd(): void {
    if (!this.isResizing) return;
    this.isResizing = false;
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mouseup', this.onMouseUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  ngOnInit(): void {
    // Load initial logs
    this.logs = this.debugLogger.getLogs();
    this.applyFilters();

    // Subscribe to new logs
    this.debugLogger.logs$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((log) => {
        this.logs.push(log);
        if (this.logs.length > 500) {
          this.logs = this.logs.slice(-500);
        }
        this.applyFilters();
        queueMicrotask(() => {
          const scrollContainer = document.querySelector<HTMLElement>('.debug-logs-scroll');
          if (scrollContainer) {
            scrollContainer.scrollTop = scrollContainer.scrollHeight;
          }
        });
      });
  }

  applyFilters(): void {
    let filtered = this.logs;

    // Apply type filter
    if (this.selectedFilter !== 'all') {
      filtered = filtered.filter(log => log.type === this.selectedFilter);
    }

    // Remove thinking logs that are subsets of the main thinking log
    // Keep only the final complete thinking chain, not intermediate ones
    if (this.selectedFilter === 'thinking' || this.selectedFilter === 'all') {
      filtered = this.deduplicateThinkingLogs(filtered);
      
      // Auto-expand thinking logs that have chains (in detailed mode only)
      if (!this.isCompactMode) {
        filtered.forEach(log => {
          if (log.type === 'thinking' && log.thinkingChain && log.thinkingChain.length > 0) {
            this.expandedLogs.add(log.id);
          }
        });
      }
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

  private deduplicateThinkingLogs(logs: DebugLog[]): DebugLog[] {
    const thinkingLogs = logs.filter(log => log.type === 'thinking');
    if (thinkingLogs.length <= 1) return logs;

    // For thinking logs: KEEP ALL that have chains (they show complete reasoning)
    // Only hide thinking logs that are PARTIAL/INCOMPLETE (missing chain data)
    const filtered = logs.filter(log => {
      if (log.type !== 'thinking') return true; // Keep non-thinking logs
      
      // IMPORTANT: Always keep thinking logs that have complete chains
      // These are the valuable content that users need to see
      if (log.thinkingChain && log.thinkingChain.length > 0) {
        return true; // Keep ALL thinking logs with chains
      }

      // Only hide thinking logs with NO chain data (empty/incomplete)
      const chain = log.thinkingChain || [];
      if (chain.length === 0) {
        // Check if a later log has more complete chain
        const hasLaterChain = thinkingLogs.some(other => {
          if (other === log || other.timestamp <= log.timestamp) return false;
          return (other.thinkingChain || []).length > 0;
        });
        return !hasLaterChain; // Hide only if a later log has better chain
      }

      return true; // Default: keep it
    });

    return filtered;
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

  toggleThinkingStep(stepId: string): void {
    if (this.expandedThinkingSteps.has(stepId)) {
      this.expandedThinkingSteps.delete(stepId);
    } else {
      this.expandedThinkingSteps.add(stepId);
    }
  }

  isLogExpanded(logId: string): boolean {
    return this.expandedLogs.has(logId);
  }

  isThinkingStepExpanded(stepId: string): boolean {
    return this.expandedThinkingSteps.has(stepId);
  }

  getThinkingStepClass(step: ThinkingStep): string {
    const categoryClass: Record<string, string> = {
      'analysis': 'thinking-category-analysis',
      'planning': 'thinking-category-planning',
      'decision': 'thinking-category-decision',
      'reasoning': 'thinking-category-reasoning',
      'synthesis': 'thinking-category-synthesis'
    };
    return categoryClass[step.category || 'reasoning'] || 'thinking-category-reasoning';
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

  moveToRight(): void {
    this.hostWidth = null;
    this.hostHeight = null;
    this.positionChange.emit('right');
  }

  moveToBottom(): void {
    this.hostWidth = null;
    this.hostHeight = null;
    this.positionChange.emit('bottom');
  }

  toggleCompactMode(): void {
    this.isCompactMode = !this.isCompactMode;
    
    // When switching to detailed mode, auto-expand all thinking logs with chains
    if (!this.isCompactMode) {
      this.filteredLogs.forEach(log => {
        if (log.type === 'thinking' && log.thinkingChain && log.thinkingChain.length > 0) {
          this.expandedLogs.add(log.id);
        }
      });
    }
  }
}
