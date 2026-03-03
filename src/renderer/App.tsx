import React, { useEffect, useState } from 'react';
import EditorPane from './components/EditorPane';
import ChatPane from './components/ChatPane';
import AuthModal from './components/AuthModal';

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

  useEffect(() => {
    checkAuth();
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

  return (
    <div className="flex h-screen w-screen bg-gray-900 text-gray-100 overflow-hidden">
      {/* Editor Pane - 70% */}
      <div className="w-[70%] flex flex-col border-r border-gray-700">
        <div className="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-gray-700">
          <span className="text-sm font-semibold text-blue-400">Local Copilot</span>
          <div className="flex items-center gap-3">
            {user && <span className="text-xs text-gray-400">Signed in as {user}</span>}
            <div className={`w-2 h-2 rounded-full ${authStatus === 'OK' || authStatus === 'AlreadySignedIn' ? 'bg-green-400' : 'bg-yellow-400'}`} />
            {authStatus !== 'OK' && authStatus !== 'AlreadySignedIn' && (
              <button
                className="text-xs text-blue-400 hover:text-blue-300"
                onClick={() => setShowAuthModal(true)}
              >
                Sign In
              </button>
            )}
          </div>
        </div>
        <EditorPane />
      </div>

      {/* Chat Pane - 30% */}
      <div className="w-[30%] flex flex-col">
        <ChatPane key={authStatusChanged} />
      </div>

      {/* Auth Modal */}
      {showAuthModal && (
        <AuthModal onComplete={handleAuthComplete} onClose={() => setShowAuthModal(false)} />
      )}
    </div>
  );
};

export default App;
