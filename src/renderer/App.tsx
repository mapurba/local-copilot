import React, { useEffect, useState } from 'react';
import UpdateToast from './components/UpdateToast';
import { checkForAppUpdate } from './autoUpdate';
import Sidebar from './components/Sidebar';
import ChatPane from './components/ChatPane';
import TerminalPane from './components/TerminalPane';
import AuthModal from './components/AuthModal';
import VcdAuthModal from './components/VcdAuthModal';
import ResizablePanels from './components/ResizablePanels';

declare global {
  interface Window {
    copilot: import('./types').CopilotAPI;
  }
}

const App: React.FC = () => {
  // Update download progress state (must be inside the component)
  const [updateProgress, setUpdateProgress] = useState(0);
  const [showUpdateToast, setShowUpdateToast] = useState(false);

  useEffect(() => {
    // Listen for update progress and cancellation events from main process
    if (window.electron && window.electron.ipcRenderer) {
      const progressHandler = (_event: any, progress: number) => {
        setUpdateProgress(progress);
        setShowUpdateToast(progress < 100);
      };
      const cancelHandler = () => {
        setShowUpdateToast(false);
      };
      window.electron.ipcRenderer.on('update-download-progress', progressHandler);
      window.electron.ipcRenderer.on('update-cancelled', cancelHandler);
      return () => {
        window.electron.ipcRenderer.removeListener('update-download-progress', progressHandler);
        window.electron.ipcRenderer.removeListener('update-cancelled', cancelHandler);
      };
    } else if (window.copilot && window.copilot.onUpdateProgress) {
      // If you expose a custom API
      return window.copilot.onUpdateProgress((progress: number) => {
        setUpdateProgress(progress);
        setShowUpdateToast(progress < 100);
      });
    }
  }, []);
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
  const [terminalTabs, setTerminalTabs] = useState<Array<{ id: string; vmName: string; ip?: string; command: string; username?: string; password?: string }>>([]);
  const [activeTerminalTab, setActiveTerminalTab] = useState<string | null>(null);
  const [showNewTerminalDialog, setShowNewTerminalDialog] = useState(false);
  const [newTerminalCommand, setNewTerminalCommand] = useState('');
  const [newTerminalLabel, setNewTerminalLabel] = useState('');
  const [newTerminalUsername, setNewTerminalUsername] = useState('');
  const [newTerminalPassword, setNewTerminalPassword] = useState('');
  const [newTerminalSave, setNewTerminalSave] = useState(false);
  const [savedSessions, setSavedSessions] = useState<Array<{ id: string; label: string; command: string; host?: string; username?: string; port?: number; password?: string; vmName?: string; ip?: string; source?: string; createdAt: number; lastUsedAt?: number }>>([]);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);


  // Move checkAuth/checkVcd above useEffect to avoid TDZ error

  // (Removed duplicate checkAuth and checkVcd declarations)

  useEffect(() => {
    checkAuth();
    checkVcd();
  }, []);

  useEffect(() => {
    if (!showNewTerminalDialog) return;
    window.copilot.listSavedTerminalSessions().then((result) => {
      if (result.success) {
        setSavedSessions(result.sessions);
      }
    });
  }, [showNewTerminalDialog]);

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

  const handleOpenTerminal = (vm: { name: string; ip?: string }, user?: string, password?: string, customCommand?: string) => {
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
    
    setTerminalTabs((prev) => [...prev, { id: terminalId, vmName: vm.name, ip: vm.ip, command, username: user, password }]);
    setActiveTerminalTab(terminalId);
    setActiveView('terminal');

    if (vm.ip && (user || password)) {
      window.copilot.saveTerminalSession({
        label: vm.name,
        command,
        host: vm.ip,
        username: user,
        password,
        vmName: vm.name,
        ip: vm.ip,
        source: 'vm',
      }).then((result) => {
        if (result.success) {
          window.copilot.listSavedTerminalSessions().then((sessionsResult) => {
            if (sessionsResult.success) {
              setSavedSessions(sessionsResult.sessions);
            }
          });
        }
      });
    }
  };

  const handleCloseTerminal = (id: string) => {
    window.copilot.fileDisconnect({ terminalId: id }).catch(() => undefined);
    delete passwordSentRef.current[id];
    delete hostKeyAcceptedRef.current[id];
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
    setTerminalTabs((prev) => [...prev, { id: terminalId, vmName: newTerminalLabel || 'Terminal', command, username: newTerminalUsername || undefined, password: newTerminalPassword || undefined }]);
    setActiveTerminalTab(terminalId);
    setActiveView('terminal');
    setShowNewTerminalDialog(false);
    setNewTerminalCommand('');
    setNewTerminalLabel('');
    setNewTerminalUsername('');
    setNewTerminalPassword('');
    setNewTerminalSave(false);
    setEditingSessionId(null);

    if (newTerminalSave && command) {
      window.copilot.saveTerminalSession({
        id: editingSessionId || undefined,
        label: newTerminalLabel || command,
        command,
        username: newTerminalUsername || undefined,
        password: newTerminalPassword || undefined,
        source: 'manual',
      }).then(() => {
        window.copilot.listSavedTerminalSessions().then((result) => {
          if (result.success) {
            setSavedSessions(result.sessions);
          }
        });
      });
    }
  };

  const handleSaveSessionOnly = () => {
    const command = newTerminalCommand.trim();
    if (!command) return;
    window.copilot.saveTerminalSession({
      id: editingSessionId || undefined,
      label: newTerminalLabel || command,
      command,
      username: newTerminalUsername || undefined,
      password: newTerminalPassword || undefined,
      source: 'manual',
    }).then(() => {
      window.copilot.listSavedTerminalSessions().then((result) => {
        if (result.success) {
          setSavedSessions(result.sessions);
        }
      });
    });
  };

  const passwordSentRef = React.useRef<Record<string, boolean>>({});
  const hostKeyAcceptedRef = React.useRef<Record<string, boolean>>({});
  const terminalTabsRef = React.useRef(terminalTabs);

  useEffect(() => {
    terminalTabsRef.current = terminalTabs;
  }, [terminalTabs]);

  const handleTerminalData = React.useCallback((terminalId: string, data: string) => {
    const tab = terminalTabsRef.current.find((item) => item.id === terminalId);
    if (!tab?.password) return;

    const lower = data.toLowerCase();
    if (!hostKeyAcceptedRef.current[terminalId] && /are you sure you want to continue connecting/.test(lower)) {
      hostKeyAcceptedRef.current[terminalId] = true;
      window.copilot.terminalInput({ terminalId, data: 'yes\r' });
      return;
    }

    if (!passwordSentRef.current[terminalId] && /password:/i.test(data)) {
      passwordSentRef.current[terminalId] = true;
      window.copilot.terminalInput({ terminalId, data: `${tab.password}\r` });
    }
  }, []);

  const activeTerminal = terminalTabs.find((tab) => tab.id === activeTerminalTab) || null;

  return (
    <>
      <div className={`flex flex-col h-screen w-screen min-h-0 bg-gray-900 text-gray-100 overflow-hidden ${theme === 'light' ? 'theme-light' : 'theme-dark'}`}>
      <ResizablePanels
        initialLeftWidth={320}
        minLeftWidth={200}
        minRightWidth={400}
        left={
          <Sidebar
            vcdConnected={vcdStatus.connected}
            onVcdSignIn={() => setShowVcdModal(true)}
            onOpenTerminal={handleOpenTerminal}
            hasTerminals={terminalTabs.length > 0}
            activeTerminalId={activeTerminalTab}
            activeTerminal={activeTerminal}
            savedSessions={savedSessions}
            onOpenSession={(session) => {
              const terminalId = `term-${Date.now()}`;
              setTerminalTabs((prev) => [...prev, {
                id: terminalId,
                vmName: session.label,
                ip: session.ip,
                command: session.command,
                username: session.username,
                password: session.password,
              }]);
              setActiveTerminalTab(terminalId);
              setActiveView('terminal');
              window.copilot.saveTerminalSession({
                id: session.id,
                label: session.label,
                command: session.command,
                host: session.host,
                username: session.username,
                port: session.port,
                password: session.password,
                vmName: session.vmName,
                ip: session.ip,
                source: session.source === 'vm' ? 'vm' : 'manual',
              });
            }}
            onEditSession={(session) => {
              setShowNewTerminalDialog(true);
              setEditingSessionId(session.id);
              setNewTerminalLabel(session.label);
              setNewTerminalCommand(session.command);
              setNewTerminalUsername(session.username || '');
              setNewTerminalPassword(session.password || '');
              setNewTerminalSave(true);
            }}
            onDeleteSession={(sessionId) => {
              window.copilot.deleteTerminalSession({ id: sessionId }).then(() => {
                setSavedSessions((prev) => prev.filter((item) => item.id !== sessionId));
              });
            }}
            onRefreshSessions={() => {
              window.copilot.listSavedTerminalSessions().then((result) => {
                if (result.success) {
                  setSavedSessions(result.sessions);
                }
              });
            }}
          />
        }
        right={<div className="flex flex-col flex-1 min-h-0 border-l border-gray-700 overflow-hidden">
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
            {/* Check for Update Button */}
            <button
              onClick={checkForAppUpdate}
              className="p-2 text-gray-400 hover:text-green-400 hover:bg-gray-700 rounded transition-colors"
              title="Check for Update"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M23 4v6h-6" />
                <path d="M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36M20.49 15a9 9 0 0 1-14.85 3.36" />
              </svg>
            </button>
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
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <div className={`h-full w-full ${activeView === 'chat' ? '' : 'hidden'}`}>
            <ChatPane key={authStatusChanged} />
          </div>
          <div className={`h-full w-full min-h-0 flex flex-col ${activeView === 'terminal' ? '' : 'hidden'}`}>
            {terminalTabs.map((tab) => (
              <div key={tab.id} className={`h-full w-full ${activeTerminalTab === tab.id ? '' : 'hidden'}`}>
                <TerminalPane
                  terminalId={tab.id}
                  command={tab.command}
                  onData={handleTerminalData}
                  terminalTheme={terminalTheme === 'auto' ? theme : terminalTheme}
                />
              </div>
            ))}
          </div>
        </div>
        </div>}
      />
      <UpdateToast progress={updateProgress} visible={showUpdateToast} />
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
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-96 shadow-lg max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-gray-200 mb-4">
              {editingSessionId ? 'Edit Session' : 'New Terminal'}
            </h3>
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
              <div>
                <label className="text-sm text-gray-400 block mb-1">Label (optional)</label>
                <input
                  type="text"
                  value={newTerminalLabel}
                  onChange={(e) => setNewTerminalLabel(e.target.value)}
                  placeholder="e.g., Prod Web VM"
                  className="w-full px-3 py-2 bg-gray-700 text-gray-200 border border-gray-600 rounded text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="text-sm text-gray-400 block mb-1">Username (optional)</label>
                <input
                  type="text"
                  value={newTerminalUsername}
                  onChange={(e) => setNewTerminalUsername(e.target.value)}
                  placeholder="e.g., root, ubuntu"
                  className="w-full px-3 py-2 bg-gray-700 text-gray-200 border border-gray-600 rounded text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="text-sm text-gray-400 block mb-1">Password (optional)</label>
                <input
                  type="password"
                  value={newTerminalPassword}
                  onChange={(e) => setNewTerminalPassword(e.target.value)}
                  placeholder="SSH password"
                  className="w-full px-3 py-2 bg-gray-700 text-gray-200 border border-gray-600 rounded text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-gray-400">
                <input
                  type="checkbox"
                  checked={newTerminalSave}
                  onChange={(e) => setNewTerminalSave(e.target.checked)}
                />
                Save this session
              </label>
              <div className="text-xs text-gray-500">
                {newTerminalCommand ? `Will run: ${newTerminalCommand}` : `Will run: bash (or cmd.exe on Windows)`}
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => {
                    setShowNewTerminalDialog(false);
                    setNewTerminalCommand('');
                    setNewTerminalLabel('');
                    setNewTerminalUsername('');
                    setNewTerminalPassword('');
                    setNewTerminalSave(false);
                    setEditingSessionId(null);
                  }}
                  className="px-4 py-2 bg-gray-700 text-gray-300 rounded text-sm hover:bg-gray-600 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveSessionOnly}
                  className="px-4 py-2 bg-gray-700 text-gray-200 rounded text-sm hover:bg-gray-600 transition-colors"
                  disabled={!newTerminalCommand.trim()}
                >
                  {editingSessionId ? 'Update Session' : 'Save Session'}
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
      {/* End of main app div */}
      {/* Toast and modals are rendered here, outside the main layout div but inside the fragment */}
      <UpdateToast progress={updateProgress} visible={showUpdateToast} />
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
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-96 shadow-lg max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-gray-200 mb-4">
              {editingSessionId ? 'Edit Session' : 'New Terminal'}
            </h3>
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
              <div>
                <label className="text-sm text-gray-400 block mb-1">Label (optional)</label>
                <input
                  type="text"
                  value={newTerminalLabel}
                  onChange={(e) => setNewTerminalLabel(e.target.value)}
                  placeholder="e.g., Prod Web VM"
                  className="w-full px-3 py-2 bg-gray-700 text-gray-200 border border-gray-600 rounded text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="text-sm text-gray-400 block mb-1">Username (optional)</label>
                <input
                  type="text"
                  value={newTerminalUsername}
                  onChange={(e) => setNewTerminalUsername(e.target.value)}
                  placeholder="e.g., root, ubuntu"
                  className="w-full px-3 py-2 bg-gray-700 text-gray-200 border border-gray-600 rounded text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="text-sm text-gray-400 block mb-1">Password (optional)</label>
                <input
                  type="password"
                  value={newTerminalPassword}
                  onChange={(e) => setNewTerminalPassword(e.target.value)}
                  placeholder="SSH password"
                  className="w-full px-3 py-2 bg-gray-700 text-gray-200 border border-gray-600 rounded text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-gray-400">
                <input
                  type="checkbox"
                  checked={newTerminalSave}
                  onChange={(e) => setNewTerminalSave(e.target.checked)}
                />
                Save this session
              </label>
              <div className="text-xs text-gray-500">
                {newTerminalCommand ? `Will run: ${newTerminalCommand}` : `Will run: bash (or cmd.exe on Windows)`}
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => {
                    setShowNewTerminalDialog(false);
                    setNewTerminalCommand('');
                    setNewTerminalLabel('');
                    setNewTerminalUsername('');
                    setNewTerminalPassword('');
                    setNewTerminalSave(false);
                    setEditingSessionId(null);
                  }}
                  className="px-4 py-2 bg-gray-700 text-gray-300 rounded text-sm hover:bg-gray-600 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveSessionOnly}
                  className="px-4 py-2 bg-gray-700 text-gray-200 rounded text-sm hover:bg-gray-600 transition-colors"
                  disabled={!newTerminalCommand.trim()}
                >
                  {editingSessionId ? 'Update Session' : 'Save Session'}
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
    </>
  );
};

export default App;
