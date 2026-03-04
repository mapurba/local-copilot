import React, { useEffect, useState } from 'react';
import VmSidebar from './components/VmSidebar';
import ChatPane from './components/ChatPane';
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

  return (
    <div className={`flex h-screen w-screen bg-gray-900 text-gray-100 overflow-hidden ${theme === 'light' ? 'theme-light' : 'theme-dark'}`}>
      {/* Sidebar - 25% */}
      <div className="w-[25%] flex flex-col">
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
          <VmSidebar />
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
      <div className="w-[75%] flex flex-col border-l border-gray-700">
        <div className="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-gray-700">
          <span className="text-sm font-semibold text-gray-200">Local Copilot</span>
          <div className="flex items-center gap-4">
            <button
              className="text-xs px-2 py-1 rounded bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
              onClick={toggleTheme}
              title="Toggle theme"
            >
              Theme: {theme === 'light' ? 'Light' : 'Dark'}
            </button>
            {user && <span className="text-xs text-gray-400">Copilot: {user}</span>}
            <div className={`w-2 h-2 rounded-full ${authStatus === 'OK' || authStatus === 'AlreadySignedIn' ? 'bg-green-400' : 'bg-yellow-400'}`} />
            {authStatus !== 'OK' && authStatus !== 'AlreadySignedIn' && (
              <button
                className="text-xs text-blue-400 hover:text-blue-300"
                onClick={() => setShowAuthModal(true)}
              >
                Sign In
              </button>
            )}
            {(authStatus === 'OK' || authStatus === 'AlreadySignedIn') && (
              <button
                className="text-xs text-red-400 hover:text-red-300"
                onClick={handleCopilotDisconnect}
              >
                Disconnect
              </button>
            )}
          </div>
        </div>
        <ChatPane key={authStatusChanged} />
      </div>

      {/* Auth Modal */}
      {showAuthModal && (
        <AuthModal onComplete={handleAuthComplete} onClose={() => setShowAuthModal(false)} />
      )}

      {showVcdModal && (
        <VcdAuthModal onComplete={handleVcdComplete} onClose={() => setShowVcdModal(false)} />
      )}
    </div>
  );
};

export default App;
