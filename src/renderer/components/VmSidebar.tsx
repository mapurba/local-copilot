import React, { useState } from 'react';
import VmListPane from './VmListPane';
import CreateVmForm from './CreateVmForm';

interface VM {
  name: string;
  status: string;
  powered_on: boolean;
  href: string;
  owner?: string;
  cpus?: number;
  memory_mb?: number;
  storage_gb?: number;
}

interface VmSidebarProps {
  onOpenTerminal?: (vm: VM, user?: string, command?: string) => void;
  statusMessage?: string;
}

const VmSidebar: React.FC<VmSidebarProps> = ({ onOpenTerminal, statusMessage }) => {
  const [activeTab, setActiveTab] = useState<'vms' | 'create'>('vms');
  const [status, setStatus] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  const handleFormSubmit = (formData: Record<string, unknown>) => {
    console.log('VM Form Submitted:', formData);
    // This will be handled by the chat interface
  };

  const handleStatusChange = (message: string, type: 'success' | 'error' | 'info') => {
    setStatus({ message, type });
    if (type === 'success') {
      setTimeout(() => setStatus(null), 3000);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-gray-900 border-r border-gray-700">
      {/* Sidebar Tabs */}
      <div className="flex gap-0 px-0 py-0 bg-gray-800 border-b border-gray-700">
        <button
          onClick={() => setActiveTab('vms')}
          className={`flex-1 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'vms'
              ? 'border-blue-500 text-blue-400 bg-gray-900/50'
              : 'border-transparent text-gray-400 hover:text-gray-300'
          }`}
        >
          My VMs
        </button>
        <button
          onClick={() => setActiveTab('create')}
          className={`flex-1 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'create'
              ? 'border-blue-500 text-blue-400 bg-gray-900/50'
              : 'border-transparent text-gray-400 hover:text-gray-300'
          }`}
        >
          Create VM
        </button>
      </div>

      {/* Status Message */}
      {status && (
        <div
          className={`px-4 py-2 text-xs ${
            status.type === 'success'
              ? 'bg-green-900/30 text-green-400 border-b border-green-900'
              : status.type === 'error'
              ? 'bg-red-900/30 text-red-400 border-b border-red-900'
              : 'bg-blue-900/30 text-blue-400 border-b border-blue-900'
          }`}
        >
          {status.message}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === 'vms' ? (
          <VmListPane onOpenTerminal={onOpenTerminal} />
        ) : (
          <CreateVmForm onSubmit={handleFormSubmit} onStatusChange={handleStatusChange} />
        )}
      </div>
    </div>
  );
};

export default VmSidebar;
