import React, { useState } from 'react';
import VmListPane from './VmListPane';
// DISABLED: FileBrowser import removed to disable SSH2/SFTP functionality
// import FileBrowser from './FileBrowser';
// DISABLED: SavedSessionsTab import removed since terminal sessions are disabled
// import SavedSessionsTab from './SavedSessionsTab';

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

interface SavedSession {
  id: string;
  label: string;
  command: string;
  host?: string;
  username?: string;
  port?: number;
  password?: string;
  vmName?: string;
  ip?: string;
  source?: string;
  createdAt: number;
  lastUsedAt?: number;
}

interface SidebarProps {
  vcdConnected: boolean;
  onVcdSignIn?: () => void;
  onOpenTerminal?: (vm: VM, user?: string, password?: string, command?: string) => void;
  hasTerminals?: boolean;
  activeTerminalId?: string | null;
  activeTerminal?: { id: string; vmName: string; ip?: string; command: string; username?: string; password?: string } | null;
  savedSessions?: SavedSession[];
  onOpenSession?: (session: SavedSession) => void;
  onEditSession?: (session: SavedSession) => void;
  onDeleteSession?: (sessionId: string) => void;
  onRefreshSessions?: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  vcdConnected,
  onVcdSignIn,
  onOpenTerminal,
  // DISABLED: These parameters are no longer used since explorer tab was disabled
  // hasTerminals,
  // activeTerminalId,
  // activeTerminal,
  // DISABLED: Terminal session properties no longer needed
  // savedSessions,
  // onOpenSession,
  // onEditSession,
  // onDeleteSession,
  // onRefreshSessions,
}) => {
  const [activeTab, setActiveTab] = useState<'vms' | 'sessions'>('vms');

  // DISABLED: explorer tab switching logic removed to disable SSH2/SFTP functionality
  // React.useEffect(() => {
  //   if (hasTerminals && activeTab === 'vms') {
  //     setActiveTab('explorer');
  //   }
  // }, [hasTerminals]);

  const tabs = [
    { id: 'vms' as const, label: 'My VMs', icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
        <line x1="2" y1="17" x2="22" y2="17" />
      </svg>
    ) },
    // DISABLED: Explorer tab removed to disable SSH2/SFTP functionality
    // ...(hasTerminals
    //   ? [{ id: 'explorer' as const, label: 'Explorer', icon: (
    //     <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    //       <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    //     </svg>
    //   ) }]
    //   : []),
    // DISABLED: Saved Sessions tab removed - only available for terminal sessions
    // { id: 'sessions' as const, label: 'Saved Sessions', icon: (
    //   <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    //     <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    //     <polyline points="17 21 17 13 7 13 7 21" />
    //     <polyline points="7 3 7 8 15 8" />
    //   </svg>
    // ) },
  ];

  return (
    <div className="flex flex-row min-h-0 h-full w-full overflow-hidden">
      {/* Activity Bar (Icon Strip on Left) */}
      <div className="w-14 bg-gray-800 border-r border-gray-700 flex flex-col items-center py-2 gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
              activeTab === tab.id
                ? 'bg-blue-600 text-white'
                : 'text-gray-400 hover:bg-gray-700 hover:text-gray-200'
            }`}
            title={tab.label}
          >
            {tab.icon}
          </button>
        ))}
      </div>

      {/* Sidebar Panel */}
      <div className="flex flex-col flex-1 min-h-0 bg-gray-900 border-r border-gray-700 overflow-hidden">
        {/* Header with title */}
        <div className="px-4 py-3 bg-gray-800 border-b border-gray-700">
          <h2 className="text-xs font-semibold text-gray-300">
            {tabs.find(t => t.id === activeTab)?.label}
          </h2>
        </div>

        {/* Content Area */}
        <div className="flex flex-col flex-1 min-h-0 overflow-auto">
          {/* My VMs Tab */}
          {activeTab === 'vms' && (
            <>
              {vcdConnected ? (
                <VmListPane onOpenTerminal={onOpenTerminal} />
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center px-4 py-6 text-center">
                  <div className="text-gray-500 text-sm mb-4">
                    <svg
                      width="32"
                      height="32"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="mx-auto mb-2 opacity-50"
                    >
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-13c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5z" />
                    </svg>
                    <p>Connect to VCD to manage VMs</p>
                  </div>
                  <button
                    onClick={onVcdSignIn}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded transition-colors"
                  >
                    Connect to VCD
                  </button>
                </div>
              )}
            </>
          )}

          {/* Explorer Tab - DISABLED */}
          {/* {activeTab === 'explorer' && activeTerminal && (
            <FileBrowser
              terminalId={activeTerminal.id}
              command={activeTerminal.command}
              username={activeTerminal.username}
              password={activeTerminal.password}
            />
          )} */}

          {/* {activeTab === 'sessions' && (
            <SavedSessionsTab
              sessions={savedSessions}
              onOpen={onOpenSession}
              onEdit={onEditSession}
              onDelete={onDeleteSession}
              onRefresh={onRefreshSessions}
            />
          )} */}
        </div>
      </div>
    </div>
  );
};

export default Sidebar;
