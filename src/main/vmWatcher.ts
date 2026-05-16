/**
 * VM Watcher — Core Engine
 *
 * Scheduling and state machine for background VM monitoring.
 * Responsibilities:
 *  - Manage the poll timer (setInterval / clearInterval)
 *  - Track per-watch state (powered-on flag, attempt counters, timeout)
 *  - Update taskTracker steps as the watch progresses
 *  - Send chat notifications to the renderer via IPC
 *
 * What it does NOT do:
 *  - Talk to VCD directly — delegated to vmWatcherActions.isVmPoweredOn()
 *  - Run SSH commands — delegated to vmWatcherActions.runSshCommands()
 *
 * See vmWatcherActions.ts for the logic layer.
 */

import { BrowserWindow } from 'electron';
import { taskTracker } from './taskTracker';
import { isVmPoweredOn, runSshCommands, isTransientSshError } from './vmWatcherActions';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WatchRequest {
  /** VM name as listed in VCD */
  vmName: string;
  /** Expected IP address (used as SSH host once VM is up) */
  ip: string;
  /** SSH username */
  username: string;
  /** SSH password */
  password: string;
  /** Shell commands to run once the VM is reachable (run sequentially) */
  commands: string[];
  /** Task ID previously created via taskTracker.createTask() */
  taskId: string;
  /** How often to poll VCD for VM status, in ms (default 30 s) */
  pollIntervalMs?: number;
  /** Give up after this many ms (default 60 min) */
  timeoutMs?: number;
}

interface ActiveWatch {
  request: WatchRequest;
  timerId: ReturnType<typeof setInterval>;
  startedAt: number;
  polls: number;
  /** Number of consecutive SSH attempts once VM is powered on */
  sshAttempts: number;
  /** VM was seen powered on — now retrying SSH */
  vmPoweredOn: boolean;
}

// ── VmWatcher singleton ───────────────────────────────────────────────────────

class VmWatcherClass {
  private static _instance: VmWatcherClass;
  private watches: Map<string, ActiveWatch> = new Map();

  static getInstance(): VmWatcherClass {
    if (!VmWatcherClass._instance) {
      VmWatcherClass._instance = new VmWatcherClass();
    }
    return VmWatcherClass._instance;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Start watching a VM.  Returns immediately; work happens in the background.
   */
  watch(req: WatchRequest): void {
    const pollMs = req.pollIntervalMs ?? 30_000;
    const timeoutMs = req.timeoutMs ?? 60 * 60_000;

    console.log(`[VmWatcher] Starting watch for VM "${req.vmName}" @ ${req.ip} (poll every ${pollMs / 1000}s, timeout ${timeoutMs / 60000}min)`);

    const active: ActiveWatch = {
      request: req,
      startedAt: Date.now(),
      polls: 0,
      sshAttempts: 0,
      vmPoweredOn: false,
      timerId: setInterval(() => this._poll(req.taskId, timeoutMs), pollMs),
    };

    this.watches.set(req.taskId, active);

    // Log the first step immediately
    const step = taskTracker.beginStep(req.taskId, `Waiting for VM "${req.vmName}" to power on…`);
    if (step) taskTracker.completeStep(req.taskId, step.id, `Polling every ${pollMs / 1000}s, timeout ${timeoutMs / 60000}min.`, 0);
  }

  /**
   * Cancel a running watch by its taskId.
   */
  cancel(taskId: string): boolean {
    const active = this.watches.get(taskId);
    if (!active) return false;
    clearInterval(active.timerId);
    this.watches.delete(taskId);
    taskTracker.completeTask(taskId, 'Cancelled by user');
    console.log(`[VmWatcher] Cancelled watch ${taskId}`);
    return true;
  }

  /** List all active watch task IDs. */
  listActive(): string[] {
    return [...this.watches.keys()];
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async _poll(taskId: string, timeoutMs: number): Promise<void> {
    const active = this.watches.get(taskId);
    if (!active) return;

    active.polls++;
    const elapsed = Date.now() - active.startedAt;

    // ── Timeout check ──────────────────────────────────────────────────────
    if (elapsed > timeoutMs) {
      this._stopWatch(taskId);
      const msg = `Watch timed out after ${Math.round(elapsed / 60000)} minutes. VM "${active.request.vmName}" never became reachable.`;
      console.warn(`[VmWatcher] ${msg}`);
      taskTracker.completeTask(taskId, msg);
      this._notifyChat(`**VM Watch — Timed Out**\n\n${msg}`);
      return;
    }

    // ── Phase 1: wait for VM to power on ──────────────────────────────────
    if (!active.vmPoweredOn) {
      let poweredOn: boolean;
      try {
        poweredOn = await isVmPoweredOn(active.request.vmName);
        console.log(`[VmWatcher] Poll #${active.polls} "${active.request.vmName}": powered_on=${poweredOn}`);
      } catch (err) {
        console.warn(`[VmWatcher] VCD poll error for "${active.request.vmName}":`, err);
        return; // transient error — retry next interval
      }

      if (!poweredOn) return;

      // Transition to phase 2
      active.vmPoweredOn = true;
      const step = taskTracker.beginStep(taskId, `VM "${active.request.vmName}" is up — waiting for SSH…`);
      if (step) taskTracker.completeStep(taskId, step.id, 'VM powered on. SSH will be retried each poll until it succeeds.', 0);
    }

    // ── Phase 2: retry SSH until it answers ───────────────────────────────
    const MAX_SSH_ATTEMPTS = 20;

    // Fail fast if no usable IP
    if (!active.request.ip || active.request.ip.trim() === '') {
      this._stopWatch(taskId);
      const msg = `Cannot SSH — no IP address was provided for VM "${active.request.vmName}".`;
      const step = taskTracker.beginStep(taskId, 'SSH failed — no IP');
      if (step) taskTracker.completeStep(taskId, step.id, msg, 1);
      taskTracker.completeTask(taskId, msg);
      this._notifyChat(`**VM Watch — Failed**\n\n${msg}`);
      return;
    }

    active.sshAttempts++;
    console.log(`[VmWatcher] SSH attempt #${active.sshAttempts} → ${active.request.ip}`);

    try {
      const results = await runSshCommands(
        { ip: active.request.ip, username: active.request.username, password: active.request.password },
        active.request.commands
      );

      this._stopWatch(taskId);

      const output = results.map((r) => `$ ${r.command}\n${r.stdout || r.stderr || '(no output)'}`).join('\n\n');
      const step = taskTracker.beginStep(taskId, `SSH connected — running commands…`);
      if (step) taskTracker.completeStep(taskId, step.id, output, 0);
      taskTracker.completeTask(taskId);

      this._notifyChat([
        `**VM Watch — Completed** ✓`,
        ``,
        `VM **${active.request.vmName}** (${active.request.ip}) is now reachable.`,
        ``,
        ...results.map((r) => [`**\`${r.command}\`**`, '```', (r.stdout || r.stderr || '(no output)').trim(), '```'].join('\n')),
      ].join('\n'));

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      if (isTransientSshError(errMsg) && active.sshAttempts < MAX_SSH_ATTEMPTS) {
        console.warn(`[VmWatcher] SSH attempt #${active.sshAttempts} failed (${errMsg}) — will retry`);
        return;
      }

      this._stopWatch(taskId);

      const step = taskTracker.beginStep(taskId, `SSH failed`);
      if (step) taskTracker.completeStep(taskId, step.id, errMsg, 1);
      taskTracker.completeTask(taskId, errMsg);

      const reason = active.sshAttempts >= MAX_SSH_ATTEMPTS
        ? `SSH did not respond after ${active.sshAttempts} attempts.`
        : `SSH failed: \`${errMsg}\``;
      this._notifyChat(`**VM Watch — SSH Failed**\n\nVM "${active.request.vmName}" powered on but ${reason}`);
    }
  }

  private _stopWatch(taskId: string): void {
    const active = this.watches.get(taskId);
    if (!active) return;
    clearInterval(active.timerId);
    this.watches.delete(taskId);
  }

  private _notifyChat(message: string): void {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) return;
    win.webContents.send('chat:watch-notification', { message });
    console.log('[VmWatcher] Notification sent to renderer');
  }
}

export const vmWatcher = VmWatcherClass.getInstance();
