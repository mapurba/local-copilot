import React, { useEffect, useState } from 'react';
import ConfirmDialog from './ConfirmDialog';
import { Button, IconButton } from '@ux-aspects-universal/react/button';
import { Card, CardChipList, CardContent, CardFooter, CardHeader, CardSubtitle, CardTitle } from '@ux-aspects-universal/react/card';
import { Chip } from '@ux-aspects-universal/react/chip';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@ux-aspects-universal/react/dialog';
import { Form, FormField, FormFieldLabel } from '@ux-aspects-universal/react/form';
import { TextInput } from '@ux-aspects-universal/react/text-input';
import { Checkbox } from '@ux-aspects-universal/react/checkbox';

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
        <IconButton
          flat
          onClick={() => { loadVms(); onRefresh?.(); }}
          isDisabled={loading}
          aria-label="Refresh VM list"
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          }
        />
      </div>

      {/* Filter Buttons */}
      <div className="flex gap-2 px-4 py-2 bg-gray-850 border-b border-gray-700">
        {(['all', 'on', 'off'] as const).map((f) => (
          filter === f ? (
            <Button key={f} primary size="small" onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'on' ? 'Running' : 'Stopped'}
            </Button>
          ) : (
            <Button key={f} secondary flat size="small" onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'on' ? 'Running' : 'Stopped'}
            </Button>
          )
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
          <div key={vm.href} style={{ margin: '8px 12px' }}>
            <Card>
              <CardHeader
                avatar={
                  <span style={{
                    width: 10, height: 10, borderRadius: '50%', flexShrink: 0, display: 'inline-block',
                    background: vm.powered_on ? '#16a34a' : '#6b7280',
                  }} />
                }
              >
                <CardTitle>{vm.name}</CardTitle>
                {vm.owner && <CardSubtitle>{vm.owner}</CardSubtitle>}
              </CardHeader>

              <CardChipList>
                <Chip size="small" style={vm.powered_on
                  ? { background: '#16a34a', color: 'white', border: 'none' }
                  : { background: '#dc2626', color: 'white', border: 'none' }}>
                  {vm.status || (vm.powered_on ? 'POWERED_ON' : 'POWERED_OFF')}
                </Chip>
                {vm.osType && <Chip size="small">{vm.osType}{vm.osVersion ? ` (${vm.osVersion})` : ''}</Chip>}
              </CardChipList>

              {(vm.ip || vm.cpus) && (
                <CardContent size="small">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
                    {vm.ip && <span><strong>IP:</strong> <code>{vm.ip}</code></span>}
                    {vm.cpus && vm.memory_mb && <span>{vm.cpus} CPU × {vm.memory_mb} MB RAM</span>}
                  </div>
                </CardContent>
              )}

              <CardFooter
                leading={
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {vm.powered_on ? (
                      <Button secondary flat size="small" isDisabled={pendingAction?.href === vm.href} onClick={() => handlePowerToggle(vm, 'stop')}>
                        {pendingAction?.href === vm.href && pendingAction.action === 'stop' ? 'Stopping…' : 'Stop'}
                      </Button>
                    ) : (
                      <Button primary flat size="small" isDisabled={pendingAction?.href === vm.href} onClick={() => handlePowerToggle(vm, 'start')}>
                        {pendingAction?.href === vm.href && pendingAction.action === 'start' ? 'Starting…' : 'Start'}
                      </Button>
                    )}
                    <Button secondary flat size="small" isDisabled={pendingAction?.href === vm.href} onClick={() => handleDeleteVm(vm)}>
                      {pendingAction?.href === vm.href && pendingAction.action === 'delete' ? 'Deleting…' : 'Delete'}
                    </Button>
                    <Button secondary flat size="small" isDisabled={pendingAction?.href === vm.href} onClick={() => handleCreateSnapshot(vm)}>
                      {pendingAction?.href === vm.href && pendingAction.action === 'snapshot' ? 'Snapshot…' : 'Snapshot'}
                    </Button>
                    <Button secondary flat size="small" isDisabled={pendingAction?.href === vm.href} onClick={() => handleRevertSnapshot(vm)}>
                      {pendingAction?.href === vm.href && pendingAction.action === 'revert' ? 'Reverting…' : 'Revert'}
                    </Button>
                    <Button secondary flat size="small" isDisabled={pendingAction?.href === vm.href} onClick={() => handleCreateCopy(vm)}>
                      {pendingAction?.href === vm.href && pendingAction.action === 'copy' ? 'Copying…' : 'Copy'}
                    </Button>
                  </div>
                }
              />
            </Card>
          </div>
        ))}
      </div>

      {/* Confirm dialog for snapshot/revert actions */}
      {renderConfirmDialog()}

      {/* Terminal Input Dialog */}
      {terminalVm && (
        <Dialog onClose={() => setTerminalVm(null)} aria-label="SSH Terminal" style={{ width: '24rem' }}>
          <DialogHeader>SSH Terminal: {terminalVm.name}</DialogHeader>
          <DialogContent>
            <Form orientation="vertical">
              <FormField>
                <FormFieldLabel>Username (optional)</FormFieldLabel>
                <TextInput
                  value={terminalUser}
                  onValueChange={setTerminalUser}
                  placeholder="e.g., root, ubuntu"
                />
              </FormField>
              <FormField>
                <FormFieldLabel>Password (optional)</FormFieldLabel>
                <TextInput
                  type="password"
                  value={terminalPassword}
                  onValueChange={setTerminalPassword}
                  placeholder="SSH password"
                />
              </FormField>
              <FormField>
                <FormFieldLabel>Custom Command (optional)</FormFieldLabel>
                <TextInput
                  value={terminalCommand}
                  onValueChange={setTerminalCommand}
                  placeholder={`e.g., ssh ${terminalVm.ip}`}
                />
              </FormField>
              <p style={{ fontSize: 11, opacity: 0.6, margin: 0 }}>
                {terminalCommand ? `Will run: ${terminalCommand}` : terminalUser ? `Will run: ssh ${terminalUser}@${terminalVm.ip}` : `Will run: ssh ${terminalVm.ip}`}
              </p>
            </Form>
          </DialogContent>
          <DialogFooter>
            <Button secondary flat onClick={() => setTerminalVm(null)}>Cancel</Button>
            <Button primary onClick={handleTerminalSubmit}>Open Terminal</Button>
          </DialogFooter>
        </Dialog>
      )}

      {/* Copy VM Form Dialog */}
      {copyFormVm && (
        <Dialog onClose={() => setCopyFormVm(null)} aria-label="Create VM Copy" style={{ width: '30rem', maxWidth: '95vw' }}>
          <DialogHeader>Create VM Copy</DialogHeader>
          <DialogContent>
            <p style={{ fontSize: 12, opacity: 0.7, marginTop: 0 }}>Source VM: {copyFormVm.name}</p>
            <Form orientation="vertical">
              <FormField>
                <FormFieldLabel>Target vApp</FormFieldLabel>
                <select
                  value={copyTargetVappHref}
                  onChange={(e) => setCopyTargetVappHref(e.target.value)}
                  style={{ width: '100%', padding: '6px 10px', borderRadius: 4, fontSize: 13, border: '1px solid var(--uxa-text-input__border-color, #ccc)', background: 'var(--uxa-text-input__background-color, #fff)', color: 'inherit' }}
                >
                  <option value="" disabled>
                    {vappsLoading ? 'Loading vApps…' : 'Select target vApp'}
                  </option>
                  {vapps.map((vapp) => (
                    <option key={vapp.href} value={vapp.href}>{vapp.name}</option>
                  ))}
                </select>
              </FormField>
              <FormField>
                <FormFieldLabel>New VM Name</FormFieldLabel>
                <TextInput
                  value={copyVmName}
                  onValueChange={setCopyVmName}
                  placeholder="Enter copied VM name"
                />
              </FormField>
              <FormField>
                <FormFieldLabel>Description (optional)</FormFieldLabel>
                <TextInput
                  value={copyDescription}
                  onValueChange={setCopyDescription}
                  placeholder="Describe this copy"
                />
              </FormField>
              <FormField>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <Checkbox
                    isChecked={copyPowerOn}
                    onCheckedChange={(checked) => setCopyPowerOn(checked)}
                  />
                  Power on copied VM after creation
                </label>
              </FormField>
            </Form>
          </DialogContent>
          <DialogFooter>
            <Button
              secondary flat
              isDisabled={pendingAction?.href === copyFormVm.href && pendingAction.action === 'copy'}
              onClick={() => setCopyFormVm(null)}
            >
              Cancel
            </Button>
            <Button
              primary
              isDisabled={pendingAction?.href === copyFormVm.href && pendingAction.action === 'copy'}
              onClick={submitCreateCopy}
            >
              {pendingAction?.href === copyFormVm.href && pendingAction.action === 'copy' ? 'Creating Copy…' : 'Create Copy'}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
};

export default VmListPane;
