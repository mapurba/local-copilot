import React, { useEffect, useState } from 'react';
import ConfirmDialog from './ConfirmDialog';

interface VM {
  name: string;
  status: string;
  powered_on: boolean;
  href: string;
  ip?: string;
  owner?: string;
  cpus?: number;
  memory_mb?: number;
  storage_gb?: number;
  osType?: string;
  osVersion?: string;
}

interface VApp {
  name: string;
  href: string;
  status?: string;
  owner?: string;
}

interface VmListPaneProps {
  onOpenTerminal?: (vm: VM, user?: string, password?: string, command?: string) => void;
  onRefresh?: () => void;
}

const VmListPane: React.FC<VmListPaneProps> = ({ onOpenTerminal, onRefresh }) => {
  // Confirm dialog state for snapshot/revert actions.
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    type: 'snapshot' | 'revert' | null;
    vm: VM | null;
  }>({ open: false, type: null, vm: null });
  const [snapshotDescription, setSnapshotDescription] = useState('');

  const [vms, setVms] = useState<VM[]>([]);
  const [allVms, setAllVms] = useState<VM[]>([]);
  const [filter, setFilter] = useState<'all' | 'on' | 'off'>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{
    href: string;
    action: 'start' | 'stop' | 'delete' | 'snapshot' | 'revert' | 'copy';
  } | null>(null);
  const [terminalVm, setTerminalVm] = useState<VM | null>(null);
  const [terminalUser, setTerminalUser] = useState<string>('');
  const [terminalPassword, setTerminalPassword] = useState<string>('');
  const [terminalCommand, setTerminalCommand] = useState<string>('');
  const [copyFormVm, setCopyFormVm] = useState<VM | null>(null);
  const [copyVmName, setCopyVmName] = useState<string>('');
  const [copyDescription, setCopyDescription] = useState<string>('');
  const [copyPowerOn, setCopyPowerOn] = useState<boolean>(false);
  const [vapps, setVapps] = useState<VApp[]>([]);
  const [vappsLoading, setVappsLoading] = useState(false);
  const [copyTargetVappHref, setCopyTargetVappHref] = useState<string>('');

  useEffect(() => {
    loadVms();
  }, []);

  useEffect(() => {
    let filtered = allVms;
    if (filter === 'on') {
      filtered = filtered.filter((vm) => vm.powered_on);
    } else if (filter === 'off') {
      filtered = filtered.filter((vm) => !vm.powered_on);
    }
    setVms(filtered);
  }, [allVms, filter]);

  const loadVms = async () => {
    setLoading(true);
    setError(null);
    try {
      // Call the direct VCD API via a new IPC handler
      const result = await window.copilot.listVms();
      const vms = Array.isArray(result?.vms) ? result.vms : [];
      const normalized: VM[] = vms.map((item) => ({
        name: String(item.name || 'Unknown'),
        status: String(item.status || ''),
        powered_on: Boolean(item.powered_on),
        href: String(item.href || ''),
        ip: item.ip ? String(item.ip) : undefined,
        owner: item.owner ? String(item.owner) : undefined,
        cpus: typeof item.cpus === 'number' ? item.cpus : undefined,
        memory_mb: typeof item.memory_mb === 'number' ? item.memory_mb : undefined,
        storage_gb: typeof item.storage_gb === 'number' ? item.storage_gb : undefined,
        osType: item.osType ? String(item.osType) : undefined,
        osVersion: item.osVersion ? String(item.osVersion) : undefined,
      }));
      setAllVms(normalized);
      setLoading(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load VMs';
      setError(message);
      setLoading(false);
    }
  };

  const loadVapps = async () => {
    setVappsLoading(true);
    try {
      const result = await window.copilot.listVapps();
      // DEBUG: Show the result in the console and as an alert for troubleshooting
      // eslint-disable-next-line no-console
      console.log('DEBUG: listVapps result', result);
      if (!result || typeof result !== 'object') {
        window.alert('DEBUG: listVapps returned null or non-object: ' + JSON.stringify(result));
      } else if (!Array.isArray(result.vapps)) {
        window.alert('DEBUG: listVapps result.vapps is not an array: ' + JSON.stringify(result));
      } else if (result.vapps.length === 0) {
        window.alert('DEBUG: listVapps result.vapps is an empty array');
      }
      const items = Array.isArray(result?.vapps) ? result.vapps : [];
      const normalized: VApp[] = items
        .map((item) => ({
          name: String(item.name || 'Unknown'),
          href: String(item.href || ''),
          status: item.status ? String(item.status) : undefined,
          owner: item.owner ? String(item.owner) : undefined,
        }))
        .filter((item) => Boolean(item.href));
      setVapps(normalized);
      if (!copyTargetVappHref && normalized.length > 0) {
        setCopyTargetVappHref(normalized[0].href);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load vApps';
      setError(message);
      setVapps([]);
    } finally {
      setVappsLoading(false);
    }
  };

  const handlePowerToggle = async (vm: VM, action: 'start' | 'stop') => {
    setError(null);
    setPendingAction({ href: vm.href, action });
    try {
      const result = action === 'start'
        ? await window.copilot.powerOnVm(vm.href)
        : await window.copilot.powerOffVm(vm.href);

      if (!result.success) {
        throw new Error(result.error || `Failed to ${action} VM`);
      }

      await loadVms();
    } catch (err) {
      const message = err instanceof Error ? err.message : `Failed to ${action} VM`;
      setError(message);
    } finally {
      setPendingAction(null);
    }
  };

  const handleDeleteVm = async (vm: VM) => {
    setError(null);
    const confirmed = window.confirm(`Delete VM "${vm.name}"? This will power it off first.`);
    if (!confirmed) return;

    setPendingAction({ href: vm.href, action: 'delete' });
    try {
      const result = await window.copilot.deleteVm({ href: vm.href, powered_on: vm.powered_on });
      if (!result.success) {
        throw new Error(result.error || 'Failed to delete VM');
      }
      await loadVms();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete VM';
      setError(message);
    } finally {
      setPendingAction(null);
    }
  };

  const handleCreateSnapshot = (vm: VM) => {
    setError(null);
    setSnapshotDescription('');
    setConfirmDialog({ open: true, type: 'snapshot', vm });
  };

  const doCreateSnapshot = async () => {
    if (!confirmDialog.vm) return;
    setConfirmDialog({ open: false, type: null, vm: null });
    setPendingAction({ href: confirmDialog.vm.href, action: 'snapshot' });
    try {
      const result = await window.copilot.createSnapshot({
        vmNameOrHref: confirmDialog.vm.href,
        description: snapshotDescription.trim() || undefined,
      });
      if (!result.success) throw new Error(result.error || 'Failed to create snapshot');
      await loadVms();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create snapshot';
      setError(message);
    } finally {
      setPendingAction(null);
    }
  };

  const handleRevertSnapshot = (vm: VM) => {
    setError(null);
    setConfirmDialog({ open: true, type: 'revert', vm });
  };

  const doRevertSnapshot = async () => {
    if (!confirmDialog.vm) return;
    setConfirmDialog({ open: false, type: null, vm: null });
    setPendingAction({ href: confirmDialog.vm.href, action: 'revert' });
    try {
      const result = await window.copilot.revertSnapshot({ vmNameOrHref: confirmDialog.vm.href });
      if (!result.success) throw new Error(result.error || 'Failed to revert snapshot');
      await loadVms();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to revert snapshot';
      setError(message);
    } finally {
      setPendingAction(null);
    }
  };
  // ConfirmDialog rendering
  const renderConfirmDialog = () => {
    if (!confirmDialog.open || !confirmDialog.vm) return null;
    if (confirmDialog.type === 'snapshot') {
      return (
        <ConfirmDialog
          open={true}
          title={`Create Snapshot`}
          message={
            <div>
              <div>Snapshot for <b>{confirmDialog.vm.name}</b></div>
              <div className="mt-2">
                <label className="block text-xs mb-1 text-gray-400">Description (optional):</label>
                <input
                  type="text"
                  value={snapshotDescription}
                  onChange={e => setSnapshotDescription(e.target.value)}
                  className="w-full bg-gray-700 text-gray-100 text-xs rounded px-2.5 py-1.5 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-violet-500"
                  autoFocus
                />
              </div>
            </div>
          }
          onConfirm={doCreateSnapshot}
          onCancel={() => setConfirmDialog({ open: false, type: null, vm: null })}
          confirmLabel="Create"
          cancelLabel="Cancel"
        />
      );
    }
    if (confirmDialog.type === 'revert') {
      return (
        <ConfirmDialog
          open={true}
          title={`Revert Snapshot`}
          message={`Revert VM "${confirmDialog.vm.name}" to its latest/current snapshot?`}
          onConfirm={doRevertSnapshot}
          onCancel={() => setConfirmDialog({ open: false, type: null, vm: null })}
          confirmLabel="Revert"
          cancelLabel="Cancel"
        />
      );
    }
    return null;
  };

  const handleCreateCopy = (vm: VM) => {
    setError(null);
    setCopyFormVm(vm);
    setCopyVmName(`${vm.name}-copy`);
    setCopyDescription(`Copy of ${vm.name}`);
    setCopyPowerOn(false);
    setCopyTargetVappHref('');
    loadVapps();
  };

  const submitCreateCopy = async () => {
    if (!copyFormVm) return;
    const newVmName = copyVmName.trim();
    if (!newVmName) {
      setError('VM name is required to create a copy.');
      return;
    }
    if (!copyTargetVappHref) {
      setError('Target vApp is required to create a copy.');
      return;
    }

    setPendingAction({ href: copyFormVm.href, action: 'copy' });
    try {
      const result = await window.copilot.createVmCopy({
        vmNameOrHref: copyFormVm.href,
        newVmName,
        targetVappHref: copyTargetVappHref,
        powerOn: copyPowerOn,
        description: copyDescription.trim() || undefined,
      });
      if (!result.success) throw new Error(result.error || 'Failed to create VM copy');
      setCopyFormVm(null);
      await loadVms();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create VM copy';
      setError(message);
    } finally {
      setPendingAction(null);
    }
  };

  const handleListSnapshots = async () => {
    setError(null);
    try {
      const result = await window.copilot.listSnapshots();
      if (!result.success) throw new Error(result.error || 'Failed to list snapshots');
      const snapshots = Array.isArray(result.snapshots) ? result.snapshots : [];
      if (snapshots.length === 0) {
        window.alert('No snapshots found.');
        return;
      }
      const lines = snapshots.slice(0, 20).map((snap, idx) => {
        const name = String(snap.name || '(unnamed)');
        const vmName = String(snap.vm_name || 'unknown-vm');
        const created = String(snap.created || '');
        return `${idx + 1}. ${name} | VM: ${vmName}${created ? ` | ${created}` : ''}`;
      });
      const suffix = snapshots.length > 20 ? `\n...and ${snapshots.length - 20} more` : '';
      window.alert(`Snapshots (${snapshots.length})\n\n${lines.join('\n')}${suffix}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to list snapshots';
      setError(message);
    }
  };

  const handleTerminalClick = (vm: VM) => {
    setTerminalVm(vm);
    setTerminalUser('');
    setTerminalPassword('');
    setTerminalCommand('');
  };

  const handleTerminalSubmit = () => {
    if (!terminalVm) return;
    const command = terminalCommand || (terminalUser ? `ssh ${terminalUser}@${terminalVm.ip}` : `ssh ${terminalVm.ip}`);
    onOpenTerminal?.(terminalVm, terminalUser, terminalPassword, command);
    setTerminalVm(null);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-gray-900 overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-800 border-b border-gray-700">
        <span className="text-sm font-semibold text-gray-200">Virtual Machines</span>
        <button
          onClick={() => {
            loadVms();
            onRefresh?.();
          }}
          disabled={loading}
          className="p-1.5 hover:bg-gray-700 rounded transition-colors"
          title="Refresh VM list"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      {/* Filter Buttons */}
      <div className="flex gap-2 px-4 py-2 bg-gray-850 border-b border-gray-700">
        {(['all', 'on', 'off'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              filter === f
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            {f === 'all' ? 'All' : f === 'on' ? 'Running' : 'Stopped'}
          </button>
        ))}
      </div>

      {/* <div className="px-4 py-2 bg-gray-850 border-b border-gray-700">
        <button
          onClick={handleListSnapshots}
          className="text-xs px-3 py-1.5 rounded bg-indigo-900/30 text-indigo-300 hover:bg-indigo-900/50 transition-colors"
          title="List all snapshots"
        >
          List Snapshots
        </button>
      </div> */}

      {/* VM List */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {error && (
          <div className="px-4 py-3 text-sm text-red-400 bg-red-900/20 border-b border-red-800">
            {error}
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center h-full text-gray-400">
            <div className="animate-spin w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full mr-2" />
            Loading VMs...
          </div>
        )}

        {!loading && vms.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 text-sm">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-2 opacity-50">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="2" y1="17" x2="22" y2="17" />
              <line x1="6" y1="21" x2="6" y2="17" />
              <line x1="10" y1="21" x2="10" y2="17" />
              <line x1="14" y1="21" x2="14" y2="17" />
              <line x1="18" y1="21" x2="18" y2="17" />
            </svg>
            No VMs found
          </div>
        )}

        {!loading && vms.map((vm) => (
          <div
            key={vm.href}
            className="vm-card border-b border-gray-700 px-4 py-3 hover:bg-gray-800/50 transition-colors group"
          >
            {/* VM Name and Status Badge */}
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <div
                  className={`vm-dot w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                    vm.powered_on ? 'bg-green-500' : 'bg-gray-500'
                  }`}
                />
                <span className="vm-name text-sm font-medium text-gray-100 truncate">{vm.name}</span>
              </div>
              <span className={`vm-status text-xs font-semibold px-2.5 py-1 rounded whitespace-nowrap ml-2 flex-shrink-0 ${
                vm.powered_on
                  ? 'bg-green-700 text-white shadow-sm'
                  : 'bg-red-700 text-white shadow-sm'
              }`}>
                {vm.status || (vm.powered_on ? 'POWERED ON' : 'POWERED OFF')}
              </span>
            </div>

            {/* VM Details */}
            <div className="text-xs text-gray-400 space-y-1 ml-4 mb-2">
              {vm.ip && (
                <div className="flex gap-2">
                  <span className="text-gray-500 min-w-fit">IP:</span>
                  <span className="text-gray-300 font-mono truncate">{vm.ip}</span>
                </div>
              )}
              {vm.owner && (
                <div className="flex gap-2">
                  <span className="text-gray-500 min-w-fit">Owner:</span>
                  <span className="text-gray-300 truncate">{vm.owner}</span>
                </div>
              )}
              {vm.osType && (
                <div className="flex gap-2">
                  <span className="text-gray-500 min-w-fit">OS:</span>
                  <span className="text-gray-300 truncate">
                    {vm.osType}
                    {vm.osVersion ? ` (${vm.osVersion})` : ''}
                  </span>
                </div>
              )}
              {vm.cpus && vm.memory_mb && (
                <div className="flex gap-2">
                  <span className="text-gray-500 min-w-fit">Resources:</span>
                  <span className="text-gray-300">{vm.cpus} CPU × {vm.memory_mb}MB RAM</span>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="vm-actions flex gap-2 ml-4">
              {vm.powered_on ? (
                <button
                  onClick={() => handlePowerToggle(vm, 'stop')}
                  disabled={pendingAction?.href === vm.href}
                  className="vm-action vm-action-stop text-xs px-2 py-1 rounded bg-red-900/30 text-red-400 hover:bg-red-900/50 transition-colors disabled:opacity-50"
                  title="Stop VM"
                >
                  {pendingAction?.href === vm.href && pendingAction.action === 'stop' ? 'Stopping...' : 'Stop'}
                </button>
              ) : (
                <button
                  onClick={() => handlePowerToggle(vm, 'start')}
                  disabled={pendingAction?.href === vm.href}
                  className="vm-action vm-action-start text-xs px-2 py-1 rounded bg-green-900/30 text-green-400 hover:bg-green-900/50 transition-colors disabled:opacity-50"
                  title="Start VM"
                >
                  {pendingAction?.href === vm.href && pendingAction.action === 'start' ? 'Starting...' : 'Start'}
                </button>
              )}
              
              <button
                onClick={() => handleDeleteVm(vm)}
                disabled={pendingAction?.href === vm.href}
                className="vm-action vm-action-delete text-xs px-2 py-1 rounded bg-gray-800 text-gray-300 hover:bg-red-900/40 hover:text-red-300 transition-colors disabled:opacity-50"
                title="Delete VM"
              >
                {pendingAction?.href === vm.href && pendingAction.action === 'delete' ? 'Deleting...' : 'Delete'}
              </button>
              <button
                onClick={() => handleCreateSnapshot(vm)}
                disabled={pendingAction?.href === vm.href}
                className="vm-action text-xs px-2 py-1 rounded bg-cyan-900/30 text-cyan-300 hover:bg-cyan-900/50 transition-colors disabled:opacity-50"
                title="Create snapshot"
              >
                {pendingAction?.href === vm.href && pendingAction.action === 'snapshot' ? 'Snapshot...' : 'Snapshot'}
              </button>
              <button
                onClick={() => handleRevertSnapshot(vm)}
                disabled={pendingAction?.href === vm.href}
                className="vm-action text-xs px-2 py-1 rounded bg-amber-900/30 text-amber-300 hover:bg-amber-900/50 transition-colors disabled:opacity-50"
                title="Revert snapshot"
              >
                {pendingAction?.href === vm.href && pendingAction.action === 'revert' ? 'Reverting...' : 'Revert'}
              </button>
              <button
                onClick={() => handleCreateCopy(vm)}
                disabled={pendingAction?.href === vm.href}
                className="vm-action text-xs px-2 py-1 rounded bg-violet-900/30 text-violet-300 hover:bg-violet-900/50 transition-colors disabled:opacity-50"
                title="Create copy of VM"
              >
                {pendingAction?.href === vm.href && pendingAction.action === 'copy' ? 'Copying...' : 'Copy'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Confirm dialog for snapshot/revert actions */}
      {renderConfirmDialog()}

      {/* Terminal Input Dialog */}
      {terminalVm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 rounded">
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-96 shadow-lg">
            <h3 className="text-lg font-semibold text-gray-200 mb-4">SSH Terminal: {terminalVm.name}</h3>
            <div className="space-y-4">
              <div>
                <label className="text-sm text-gray-400 block mb-1">Username (optional)</label>
                <input
                  type="text"
                  value={terminalUser}
                  onChange={(e) => setTerminalUser(e.target.value)}
                  placeholder="e.g., root, ubuntu"
                  className="w-full px-3 py-2 bg-gray-700 text-gray-200 border border-gray-600 rounded text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="text-sm text-gray-400 block mb-1">Password (optional)</label>
                <input
                  type="password"
                  value={terminalPassword}
                  onChange={(e) => setTerminalPassword(e.target.value)}
                  placeholder="SSH password"
                  className="w-full px-3 py-2 bg-gray-700 text-gray-200 border border-gray-600 rounded text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="text-sm text-gray-400 block mb-1">Custom Command (optional)</label>
                <input
                  type="text"
                  value={terminalCommand}
                  onChange={(e) => setTerminalCommand(e.target.value)}
                  placeholder={`e.g., ssh ${terminalVm.ip}`}
                  className="w-full px-3 py-2 bg-gray-700 text-gray-200 border border-gray-600 rounded text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="text-xs text-gray-500">
                {terminalCommand ? `Will run: ${terminalCommand}` : terminalUser ? `Will run: ssh ${terminalUser}@${terminalVm.ip}` : `Will run: ssh ${terminalVm.ip}`}
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setTerminalVm(null)}
                  className="px-4 py-2 bg-gray-700 text-gray-300 rounded text-sm hover:bg-gray-600 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleTerminalSubmit}
                  className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 transition-colors"
                >
                  Open Terminal
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Copy VM Form Dialog */}
      {copyFormVm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 rounded">
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-[480px] max-w-[95vw] shadow-lg">
            <h3 className="text-lg font-semibold text-gray-200 mb-1">Create VM Copy</h3>
            <p className="text-xs text-gray-400 mb-4">Source VM: {copyFormVm.name}</p>

            <div className="space-y-4">
              <div>
                <label className="text-sm text-gray-400 block mb-1">Target vApp</label>
                <select
                  value={copyTargetVappHref}
                  onChange={(e) => setCopyTargetVappHref(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-700 text-gray-200 border border-gray-600 rounded text-sm focus:outline-none focus:border-violet-500"
                >
                  <option value="" disabled>
                    {vappsLoading ? 'Loading vApps...' : 'Select target vApp'}
                  </option>
                  {vapps.map((vapp) => (
                    <option key={vapp.href} value={vapp.href}>{vapp.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-sm text-gray-400 block mb-1">New VM Name</label>
                <input
                  type="text"
                  value={copyVmName}
                  onChange={(e) => setCopyVmName(e.target.value)}
                  placeholder="Enter copied VM name"
                  className="w-full px-3 py-2 bg-gray-700 text-gray-200 border border-gray-600 rounded text-sm focus:outline-none focus:border-violet-500"
                />
              </div>

              <div>
                <label className="text-sm text-gray-400 block mb-1">Description (optional)</label>
                <textarea
                  value={copyDescription}
                  onChange={(e) => setCopyDescription(e.target.value)}
                  rows={3}
                  placeholder="Describe this copy"
                  className="w-full px-3 py-2 bg-gray-700 text-gray-200 border border-gray-600 rounded text-sm focus:outline-none focus:border-violet-500"
                />
              </div>

              <label className="flex items-center gap-2 text-sm text-gray-300 select-none">
                <input
                  type="checkbox"
                  checked={copyPowerOn}
                  onChange={(e) => setCopyPowerOn(e.target.checked)}
                  className="rounded border-gray-500 bg-gray-700 text-violet-500 focus:ring-violet-500"
                />
                Power on copied VM after creation
              </label>

              <div className="flex gap-2 justify-end pt-1">
                <button
                  onClick={() => setCopyFormVm(null)}
                  disabled={pendingAction?.href === copyFormVm.href && pendingAction.action === 'copy'}
                  className="px-4 py-2 bg-gray-700 text-gray-300 rounded text-sm hover:bg-gray-600 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={submitCreateCopy}
                  disabled={pendingAction?.href === copyFormVm.href && pendingAction.action === 'copy'}
                  className="px-4 py-2 bg-violet-600 text-white rounded text-sm hover:bg-violet-700 transition-colors disabled:opacity-50"
                >
                  {pendingAction?.href === copyFormVm.href && pendingAction.action === 'copy' ? 'Creating Copy...' : 'Create Copy'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default VmListPane;
