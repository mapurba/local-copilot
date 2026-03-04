import React, { useEffect, useState } from 'react';
import VmSidebar from './components/VmSidebar';
import ChatPane from './components/ChatPane';
import TerminalPane from './components/TerminalPane';
import AuthModal from './components/AuthModal';
import VcdAuthModal from './components/VcdAuthModal';

declare global {
  interface Window {
    copilot: import('./types').CopilotAPI;
  }
}

const App: React.FC = () => {
  const [authStatus, setAuthStatus] = useState<string>('Unknown');
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [user, setUser] = useState<string | undefined>();
  const [authStatusChanged, setAuthStatusChanged] = useState(0);
  const [vcdStatus, setVcdStatus] = useState<{ connected: boolean; user?: string; org?: string; host?: string }>({ connected: false });
  const [showVcdModal, setShowVcdModal] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('theme');
    return saved === 'dark' ? 'dark' : 'light';
  });
  // Terminal theme: 'auto' (follows app), 'light', 'dark'
  const [terminalTheme, setTerminalTheme] = useState<'auto' | 'light' | 'dark'>(() => {
    const saved = localStorage.getItem('terminalTheme');
    return saved === 'light' || saved === 'dark' ? saved : 'auto';
  });

  // Terminal state
  const [activeView, setActiveView] = useState<'chat' | 'terminal'>('chat');
  const [terminalTabs, setTerminalTabs] = useState<Array<{ id: string; vmName: string; ip?: string; command: string }>>([]);
  const [activeTerminalTab, setActiveTerminalTab] = useState<string | null>(null);
  const [showNewTerminalDialog, setShowNewTerminalDialog] = useState(false);
  const [newTerminalCommand, setNewTerminalCommand] = useState('');


  // Move checkAuth/checkVcd above useEffect to avoid TDZ error

  // (Removed duplicate checkAuth and checkVcd declarations)

  useEffect(() => {
    checkAuth();
    checkVcd();
  }, []);

  const checkAuth = async () => {
    try {
      const result = await window.copilot.status();
      setAuthStatus(result.status);
      setUser(result.user);
      if (result.status !== 'OK' && result.status !== 'AlreadySignedIn') {
        setShowAuthModal(true);
      }
    } catch {
      setShowAuthModal(true);
    }
  };

  const handleAuthComplete = (status: string, username?: string) => {
    setAuthStatus(status);
    setUser(username);
    if (status === 'OK' || status === 'AlreadySignedIn') {
      setShowAuthModal(false);
      // Trigger a models refresh after successful authentication
      setAuthStatusChanged(prev => prev + 1);
    }
  };

  const checkVcd = async () => {
    try {
      const result = await window.copilot.vcdStatus();
      setVcdStatus(result);
    } catch {
      setVcdStatus({ connected: false });
    }
  };

  const handleVcdComplete = (result: { connected: boolean; user?: string; org?: string; host?: string }) => {
    setVcdStatus(result);
    if (result.connected) {
      setShowVcdModal(false);
    }
  };

  const handleVcdLogout = async () => {
    await window.copilot.vcdSignOut();
    setVcdStatus({ connected: false });
  };

  const handleCopilotDisconnect = async () => {
    await window.copilot.signOut();
    setAuthStatus('Unknown');
    setUser(undefined);
    setShowAuthModal(true);
  };

  const toggleTheme = () => {
    setTheme((prev) => {
      const next = prev === 'light' ? 'dark' : 'light';
      localStorage.setItem('theme', next);
      return next;
    });
  };

  // Terminal theme selection handler
  const handleTerminalThemeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value as 'auto' | 'light' | 'dark';
    setTerminalTheme(value);
    localStorage.setItem('terminalTheme', value);
  };

  const handleOpenTerminal = (vm: { name: string; ip?: string }, user?: string, customCommand?: string) => {
    const terminalId = `term-${Date.now()}`;
    let command = customCommand;
    
    if (!command) {
      // Build SSH command if no custom command provided
      if (vm.ip) {
        command = user ? `ssh ${user}@${vm.ip}` : `ssh ${vm.ip}`;
      } else {
        command = 'bash';
      }
    }
    
    setTerminalTabs((prev) => [...prev, { id: terminalId, vmName: vm.name, ip: vm.ip, command }]);
    setActiveTerminalTab(terminalId);
    setActiveView('terminal');
  };

  const handleCloseTerminal = (id: string) => {
    setTerminalTabs((prev) => {
      const updated = prev.filter((t) => t.id !== id);
      if (activeTerminalTab === id && updated.length > 0) {
        setActiveTerminalTab(updated[0].id);
      }
      return updated;
    });
    if (terminalTabs.length === 1) {
      setActiveView('chat');
    }
  };

  const handleOpenNewTerminal = () => {
    const command = newTerminalCommand.trim() || 'bash';
    const terminalId = `term-${Date.now()}`;
    setTerminalTabs((prev) => [...prev, { id: terminalId, vmName: 'Terminal', command }]);
    setActiveTerminalTab(terminalId);
    setActiveView('terminal');
    setShowNewTerminalDialog(false);
    setNewTerminalCommand('');
  };

  return (
    <div className={`flex h-screen w-screen min-h-0 bg-gray-900 text-gray-100 overflow-hidden ${theme === 'light' ? 'theme-light' : 'theme-dark'}`}>
      {/* Sidebar - 25% */}
      <div className="w-[25%] flex flex-col min-h-0">
        {/* Auth Bar (always visible) */}
        <div className="flex flex-col gap-0 border-b border-gray-700 bg-gray-800">
          <div className="flex items-center justify-between px-4 py-2">
            <span className="text-sm font-semibold text-blue-400">VCD Management</span>
            <span className="text-xs text-gray-400">{vcdStatus.connected ? `${vcdStatus.user}@${vcdStatus.org}` : 'Not connected'}</span>
          </div>
          <div className="flex items-center justify-between px-4 pb-2 gap-2">
            {/* VCD Auth */}
            {!vcdStatus.connected ? (
              <button
                className="text-xs text-blue-400 hover:text-blue-300"
                onClick={() => setShowVcdModal(true)}
              >
                VCD Sign In
              </button>
            ) : (
              <button
                className="text-xs text-red-400 hover:text-red-300"
                onClick={handleVcdLogout}
              >
                VCD Logout
              </button>
            )}
            {/* Copilot Auth */}
            {authStatus !== 'OK' && authStatus !== 'AlreadySignedIn' ? (
              <button
                className="text-xs text-blue-400 hover:text-blue-300"
                onClick={() => setShowAuthModal(true)}
              >
                Copilot Sign In
              </button>
            ) : (
              <button
                className="text-xs text-red-400 hover:text-red-300"
                onClick={handleCopilotDisconnect}
              >
                Copilot Logout
              </button>
            )}
          </div>
        </div>
        {/* Sidebar content */}
        {vcdStatus.connected ? (
          <VmSidebar onOpenTerminal={handleOpenTerminal} />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center px-4 py-6 text-center">
            <div className="text-gray-500 text-sm mb-4">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-2 opacity-50">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-13c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5z" />
              </svg>
              <p>Connect to VCD to manage VMs</p>
            </div>
            <button
              onClick={() => setShowVcdModal(true)}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded transition-colors"
            >
              Connect to VCD
            </button>
          </div>
        )}
      </div>

      {/* Main Panel - 75% */}
      <div className="w-[75%] flex flex-col min-h-0 border-l border-gray-700">
        {/* Tab Bar */}
        <div className="bg-gray-800 border-b border-gray-700 flex items-center">
          {/* Main Tabs */}
          <div className="flex items-center flex-1">
            {/* Chat Tab */}
            <button
              onClick={() => setActiveView('chat')}
              className={`flex items-center gap-2 px-4 py-3 text-xs font-medium border-b-2 transition-colors ${
                activeView === 'chat'
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-400 hover:text-gray-300'
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              Chat
            </button>

            {/* Terminal Tabs */}
            {terminalTabs.length > 0 && (
              <>
                <button
                  onClick={() => setActiveView('terminal')}
                  className={`flex items-center gap-2 px-4 py-3 text-xs font-medium border-b-2 transition-colors ${
                    activeView === 'terminal'
                      ? 'border-blue-500 text-blue-400 '
                      : 'border-transparent text-gray-400 hover:text-gray-300'
                  }`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                  </svg>
                  Terminal
                </button>

                {/* Terminal Sub-tabs */}
                {activeView === 'terminal' && (
                  <div className="flex items-center gap-0 border-l border-gray-700">
                    {terminalTabs.map((tab, index) => (
                      <div
                        key={tab.id}
                        className={`flex items-center gap-2 px-3 py-3 text-xs border-b-2 border-l border-gray-700 cursor-pointer group transition-colors ${
                          activeTerminalTab === tab.id
                            ? 'border-b-blue-500 text-gray-100'
                            : 'border-b-transparent text-gray-400 hover:text-gray-300'
                        }`}
                        onClick={() => setActiveTerminalTab(tab.id)}
                      >
                        <span className="truncate max-w-[120px]">{tab.vmName}</span>
                        <button
                          className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 transition-colors"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCloseTerminal(tab.id);
                          }}
                          title="Close terminal"
                        >
                          ×
                        </button>
                        {index < terminalTabs.length - 1 && <div className="w-px h-4 bg-gray-700" />}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Action Buttons - Right side */}
          <div className="flex items-center gap-2 px-2">
                        {/* Terminal theme selector */}
                        <select
                          value={terminalTheme}
                          onChange={handleTerminalThemeChange}
                          className="text-xs bg-gray-700 text-gray-200 border border-gray-600 rounded px-2 py-1 focus:outline-none focus:border-blue-500"
                          title="Terminal theme"
                          style={{ minWidth: 80 }}
                        >
                          <option value="auto">Terminal: Auto</option>
                          <option value="dark">Terminal: Dark</option>
                          <option value="light">Terminal: Light</option>
                        </select>
            <button
              onClick={() => setShowNewTerminalDialog(true)}
              className="p-2 text-gray-400 hover:text-gray-300 hover:bg-gray-700 rounded transition-colors"
              title="New terminal"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              onClick={toggleTheme}
              className="p-2 text-gray-400 hover:text-gray-300 hover:bg-gray-700 rounded transition-colors"
              title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
            >
              {theme === 'light' ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Status Bar showing user info */}
        <div className="flex items-center justify-between px-4 py-2 bg-gray-850 border-b border-gray-700 text-xs">
          <div className="text-gray-400">
            {user && <span>Copilot: <span className="text-gray-300">{user}</span></span>}
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${authStatus === 'OK' || authStatus === 'AlreadySignedIn' ? 'bg-green-400' : 'bg-yellow-400'}`} />
            <span className="text-gray-400">{authStatus === 'AlreadySignedIn' ? 'Connected' : authStatus}</span>
          </div>
        </div>
        <div className="flex-1 min-h-0">
          {activeView === 'chat' ? (
            <ChatPane key={authStatusChanged} />
          ) : (
            <div className="h-full w-full min-h-0 flex flex-col">
              {terminalTabs.map((tab) => (
                <div key={tab.id} className={`h-full w-full ${activeTerminalTab === tab.id ? '' : 'hidden'}`}>
                  <TerminalPane
                    terminalId={tab.id}
                    command={tab.command}
                    terminalTheme={terminalTheme === 'auto' ? theme : terminalTheme}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Auth Modal */}
      {showAuthModal && (
        <AuthModal onComplete={handleAuthComplete} onClose={() => setShowAuthModal(false)} />
      )}

      {showVcdModal && (
        <VcdAuthModal onComplete={handleVcdComplete} onClose={() => setShowVcdModal(false)} />
      )}

      {/* New Terminal Dialog */}
      {showNewTerminalDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-96 shadow-lg">
            <h3 className="text-lg font-semibold text-gray-200 mb-4">New Terminal</h3>
            <div className="space-y-4">
              <div>
                <label className="text-sm text-gray-400 block mb-1">Command (optional)</label>
                <input
                  type="text"
                  value={newTerminalCommand}
                  onChange={(e) => setNewTerminalCommand(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleOpenNewTerminal()}
                  placeholder="e.g., ssh user@host, bash, powershell, etc."
                  className="w-full px-3 py-2 bg-gray-700 text-gray-200 border border-gray-600 rounded text-sm focus:outline-none focus:border-blue-500"
                  autoFocus
                />
              </div>
              <div className="text-xs text-gray-500">
                {newTerminalCommand ? `Will run: ${newTerminalCommand}` : `Will run: bash (or cmd.exe on Windows)`}
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => {
                    setShowNewTerminalDialog(false);
                    setNewTerminalCommand('');
                  }}
                  className="px-4 py-2 bg-gray-700 text-gray-300 rounded text-sm hover:bg-gray-600 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleOpenNewTerminal}
                  className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 transition-colors"
                >
                  Open Terminal
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
