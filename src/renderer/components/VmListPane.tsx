import React, { useEffect, useState } from 'react';

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
}

interface VmListPaneProps {
  onOpenTerminal?: (vm: VM) => void;
  onRefresh?: () => void;
}

const VmListPane: React.FC<VmListPaneProps> = ({ onOpenTerminal, onRefresh }) => {
  const [vms, setVms] = useState<VM[]>([]);
  const [allVms, setAllVms] = useState<VM[]>([]);
  const [filter, setFilter] = useState<'all' | 'on' | 'off'>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadVms();
  }, []);

  useEffect(() => {
    filterVms();
  }, [allVms, filter]);

  const loadVms = async () => {
    setLoading(true);
    setError(null);
    try {
      // Call the direct VCD API via a new IPC handler
      const result = await window.copilot.listVms();
      const vms = Array.isArray(result?.vms) ? result.vms : [];
      setAllVms(vms);
      setLoading(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load VMs';
      setError(message);
      setLoading(false);
    }
  };

  const filterVms = () => {
    let filtered = allVms;
    if (filter === 'on') {
      filtered = filtered.filter((vm) => vm.powered_on);
    } else if (filter === 'off') {
      filtered = filtered.filter((vm) => !vm.powered_on);
    }
    setVms(filtered);
  };

  const handlePowerToggle = async (vm: VM, action: 'start' | 'stop') => {
    try {
      const toolName = action === 'start' ? 'start_vm' : 'stop_vm';
      // This would be executed via the chat interface
      console.log(`${action} VM: ${vm.name}`);
    } catch (err) {
      console.error(`Failed to ${action} VM:`, err);
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-900">
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

      {/* VM List */}
      <div className="flex-1 overflow-y-auto">
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
            className="border-b border-gray-700 px-4 py-3 hover:bg-gray-800/50 transition-colors group"
          >
            {/* VM Name and Status Badge */}
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <div
                  className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                    vm.powered_on ? 'bg-green-500' : 'bg-gray-500'
                  }`}
                />
                <span className="text-sm font-medium text-gray-100 truncate">{vm.name}</span>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded whitespace-nowrap ml-2 flex-shrink-0 ${
                vm.powered_on
                  ? 'bg-green-900/30 text-green-400'
                  : 'bg-gray-700 text-gray-400'
              }`}>
                {vm.status || (vm.powered_on ? 'On' : 'Off')}
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
              {vm.cpus && vm.memory_mb && (
                <div className="flex gap-2">
                  <span className="text-gray-500 min-w-fit">Resources:</span>
                  <span className="text-gray-300">{vm.cpus} CPU × {vm.memory_mb}MB RAM</span>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex gap-2 ml-4 opacity-0 group-hover:opacity-100 transition-opacity">
              {vm.powered_on ? (
                <button
                  onClick={() => handlePowerToggle(vm, 'stop')}
                  className="text-xs px-2 py-1 rounded bg-red-900/30 text-red-400 hover:bg-red-900/50 transition-colors"
                  title="Stop VM"
                >
                  Stop
                </button>
              ) : (
                <button
                  onClick={() => handlePowerToggle(vm, 'start')}
                  className="text-xs px-2 py-1 rounded bg-green-900/30 text-green-400 hover:bg-green-900/50 transition-colors"
                  title="Start VM"
                >
                  Start
                </button>
              )}
              {vm.powered_on && (
                <button
                  onClick={() => onOpenTerminal?.(vm)}
                  className="text-xs px-2 py-1 rounded bg-blue-900/30 text-blue-400 hover:bg-blue-900/50 transition-colors"
                  title="Open Terminal"
                >
                  Terminal
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default VmListPane;
