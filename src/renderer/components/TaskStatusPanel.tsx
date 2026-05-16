import React, { useState, useEffect, useCallback } from 'react';

// ── Types (mirror of taskTracker.ts) ─────────────────────────────────────────
type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';
type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

interface TaskStep {
  id: string;
  description: string;
  command?: string;
  status: StepStatus;
  output?: string;
  logId?: string;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number;
}

interface Task {
  id: string;
  name: string;
  description?: string;
  sshSessionId?: string;
  status: TaskStatus;
  steps: TaskStep[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function elapsedLabel(startMs: number, endMs?: number): string {
  const ms = (endMs ?? Date.now()) - startMs;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m`;
}

function StepStatusIcon({ status }: { status: StepStatus }) {
  if (status === 'done') return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-green-400 flex-shrink-0">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
  if (status === 'failed') return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-red-400 flex-shrink-0">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
  if (status === 'running') return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-blue-400 animate-spin flex-shrink-0">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
  if (status === 'skipped') return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-500 flex-shrink-0">
      <line x1="5" y1="12" x2="19" y2="12" /><polyline points="15 8 19 12 15 16" />
    </svg>
  );
  return <div className="w-3.5 h-3.5 rounded-full border border-gray-600 flex-shrink-0" />;
}

function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const styles: Record<TaskStatus, string> = {
    running:   'bg-blue-900/50 text-blue-300 border-blue-700',
    completed: 'bg-green-900/50 text-green-300 border-green-700',
    failed:    'bg-red-900/50 text-red-300 border-red-700',
    cancelled: 'bg-gray-700 text-gray-400 border-gray-600',
  };
  const icons: Record<TaskStatus, React.ReactNode> = {
    running: <svg className="w-3 h-3 animate-spin mr-1" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" strokeOpacity="0.25" /><path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" /></svg>,
    completed: null,
    failed: null,
    cancelled: null,
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 text-xs rounded border ${styles[status]}`}>
      {icons[status]}
      {status}
    </span>
  );
}

function StepRow({ step }: { step: TaskStep }) {
  const [expanded, setExpanded] = useState(step.status === 'failed');
  const duration = step.startedAt
    ? elapsedLabel(step.startedAt, step.completedAt)
    : null;

  return (
    <div className="ml-4 border-l border-gray-700 pl-3 py-1">
      <button
        onClick={() => step.output && setExpanded(!expanded)}
        className="w-full flex items-start gap-2 text-left group"
      >
        <div className="mt-0.5"><StepStatusIcon status={step.status} /></div>
        <div className="flex-1 min-w-0">
          <span className={`text-xs ${step.status === 'failed' ? 'text-red-300' : step.status === 'done' ? 'text-gray-300' : 'text-gray-400'}`}>
            {step.description}
          </span>
          {step.command && (
            <div className="text-xs text-gray-500 font-mono truncate mt-0.5">$ {step.command}</div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {duration && <span className="text-xs text-gray-600">{duration}</span>}
          {step.exitCode !== undefined && step.exitCode !== 0 && (
            <span className="text-xs text-red-500">exit {step.exitCode}</span>
          )}
          {step.output && (
            <svg
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className={`text-gray-600 transition-transform ${expanded ? 'rotate-180' : ''}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          )}
        </div>
      </button>

      {expanded && step.output && (
        <pre className="mt-1 ml-5 text-xs bg-gray-950 text-gray-300 p-2 rounded overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto border border-gray-800">
          {step.output}
        </pre>
      )}
    </div>
  );
}

function TaskCard({ task, defaultOpen }: { task: Task; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [cancelling, setCancelling] = useState(false);
  const done = task.steps.filter((s) => s.status === 'done').length;
  const failed = task.steps.filter((s) => s.status === 'failed').length;
  const total = task.steps.length;
  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;
  const elapsed = elapsedLabel(task.createdAt, task.completedAt);

  const handleCancel = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (cancelling) return;
    setCancelling(true);
    try {
      await window.copilot.taskCancel(task.id);
    } catch (err) {
      console.error('[TaskStatusPanel] cancel error:', err);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-750 text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-gray-200 truncate">{task.name}</span>
            <TaskStatusBadge status={task.status} />
          </div>
          {total > 0 && (
            <div className="flex items-center gap-2 mt-1">
              <div className="flex-1 h-1 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    task.status === 'failed' ? 'bg-red-500' : task.status === 'completed' ? 'bg-green-500' : 'bg-blue-500'
                  }`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <span className="text-xs text-gray-500 flex-shrink-0">
                {done}/{total} steps {failed > 0 ? `· ${failed} failed` : ''}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs text-gray-600">{elapsed}</span>
          {task.status === 'running' && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              title="Cancel task"
              className="flex items-center gap-1 px-1.5 py-0.5 text-xs rounded border border-red-800 bg-red-950/40 text-red-400 hover:bg-red-900/60 hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {cancelling ? (
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" strokeOpacity="0.25" />
                  <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              )}
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={`text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </button>

      {/* Steps */}
      {open && (
        <div className="bg-gray-900 py-2 space-y-0.5">
          {task.description && (
            <p className="px-3 ml-4 text-xs text-gray-500 mb-2">{task.description}</p>
          )}
          {task.steps.length === 0 ? (
            <p className="px-3 ml-4 text-xs text-gray-600">No steps recorded yet…</p>
          ) : (
            task.steps.map((step) => <StepRow key={step.id} step={step} />)
          )}
          {task.error && (
            <div className="mx-3 mt-2 px-2 py-1 bg-red-950/50 border border-red-800 rounded text-xs text-red-300">
              {task.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────
const TaskStatusPanel: React.FC = () => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTasks = useCallback(async () => {
    try {
      const result = await window.copilot.taskList();
      if (result.success && result.tasks) {
        setTasks(result.tasks);
      }
    } catch (err) {
      console.error('[TaskStatusPanel] taskList error:', err);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchTasks().finally(() => setLoading(false));
  }, [fetchTasks]);

  // Re-fetch whenever the main process notifies us of a change
  useEffect(() => {
    const unsub = window.copilot.onTaskUpdated(() => {
      fetchTasks();
    });
    return unsub;
  }, [fetchTasks]);

  // Also poll while any task is running (covers cases where IPC event is missed)
  useEffect(() => {
    const hasRunning = tasks.some((t) => t.status === 'running');
    if (!hasRunning) return;
    const timer = setInterval(fetchTasks, 1500);
    return () => clearInterval(timer);
  }, [tasks, fetchTasks]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-gray-500 text-xs">
        Loading…
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 px-4 text-center text-gray-500">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-40">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        <p className="text-xs">No tasks yet.</p>
        <p className="text-xs mt-1 opacity-60">Long-running operations like software installs will appear here.</p>
      </div>
    );
  }

  const running = tasks.filter((t) => t.status === 'running');
  const done = tasks.filter((t) => t.status !== 'running');

  return (
    <div className="flex flex-col gap-2 p-2 overflow-y-auto">
      {running.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500 font-semibold px-1">RUNNING</p>
          {running.map((t) => <TaskCard key={t.id} task={t} defaultOpen={true} />)}
        </div>
      )}
      {done.length > 0 && (
        <div className="space-y-2">
          {running.length > 0 && <p className="text-xs text-gray-500 font-semibold px-1 mt-2">HISTORY</p>}
          {done.map((t) => <TaskCard key={t.id} task={t} defaultOpen={false} />)}
        </div>
      )}
    </div>
  );
};

export default TaskStatusPanel;
