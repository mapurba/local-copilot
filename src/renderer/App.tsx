import React, { useEffect, useState } from 'react';
import { ThemeProvider, Theme } from '@ux-aspects-universal/react/theming';
import { IconButton } from '@ux-aspects-universal/react/button';
import UpdateToast from './components/UpdateToast';
import { checkForAppUpdate } from './autoUpdate';
import Sidebar from './components/Sidebar';
import ChatPane from './components/ChatPane';
import AuthModal from './components/AuthModal';
import VcdAuthModal from './components/VcdAuthModal';
import { ToolApprovalModal } from './components/ToolApprovalModal';
import ResizablePanels from './components/ResizablePanels';
import { MermaidEditorProvider, useMermaidEditor, MermaidEditorPane } from './components/mermaid-editor';

declare global {
  interface Window {
    copilot: import('./types').CopilotAPI;
  }
}


/** Right panel with Chat/Editor tabs — extracted so it can consume MermaidEditorContext */
const RightPanel: React.FC<{
  authStatusChanged: number;
  user?: string;
  authStatus: string;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
}> = ({ authStatusChanged, user, authStatus, theme, toggleTheme }) => {
  const { activeTab, editorSource, setActiveTab } = useMermaidEditor();

  const tabClass = (tab: 'chat' | 'editor') =>
    `flex items-center gap-2 px-4 py-3 text-xs font-medium border-b-2 transition-colors cursor-pointer bg-transparent ${
      activeTab === tab
        ? 'border-blue-500 text-blue-400'
        : 'border-transparent text-gray-400 hover:text-gray-200'
    }`;

  return (
    <div className="flex flex-col flex-1 min-h-0 border-l border-gray-700 overflow-hidden">
      {/* Tab Bar */}
      <div className="bg-gray-800 border-b border-gray-700 flex items-center">
        <div className="flex items-center flex-1">
          {/* Chat Tab */}
          <button className={tabClass('chat')} onClick={() => setActiveTab('chat')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            Chat
          </button>

          {/* Editor Tab — visible only when a diagram is loaded */}
          {editorSource && (
            <button className={tabClass('editor')} onClick={() => setActiveTab('editor')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
                <line x1="8" y1="2" x2="8" y2="18" />
                <line x1="16" y1="6" x2="16" y2="22" />
              </svg>
              Diagram
            </button>
          )}
        </div>

        {/* Action Buttons - Right side */}
        <div className="flex items-center gap-1 px-2">
          {/* Check for Update Button */}
          <IconButton
            flat
            onClick={checkForAppUpdate}
            aria-label="Check for Update"
            icon={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M23 4v6h-6" />
                <path d="M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36M20.49 15a9 9 0 0 1-14.85 3.36" />
              </svg>
            }
          />

          {/* Theme Toggle Button */}
          <IconButton
            flat
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
            icon={
              theme === 'light' ? (
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
              )
            }
          />
        </div>
      </div>

      {/* Status Bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-850 border-b border-gray-700 text-xs">
        <div className="text-gray-400">
          {user && <span>Copilot: <span className="text-gray-300">{user}</span></span>}
        </div>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${authStatus === 'OK' || authStatus === 'AlreadySignedIn' ? 'bg-green-400' : 'bg-yellow-400'}`} />
          <span className="text-gray-400">{authStatus === 'AlreadySignedIn' ? 'Connected' : authStatus}</span>
        </div>
      </div>

      {/* Content — both panes stay mounted to preserve state */}
      <div className={`flex-1 min-h-0 flex flex-col overflow-hidden ${activeTab !== 'chat' ? 'hidden' : ''}`}>
        <ChatPane key={authStatusChanged} />
      </div>
      {editorSource && (
        <div className={`flex-1 min-h-0 flex flex-col overflow-hidden ${activeTab !== 'editor' ? 'hidden' : ''}`}>
          <MermaidEditorPane />
        </div>
      )}
    </div>
  );
};


const App: React.FC = () => {
  // Update download progress state
  const [updateProgress, setUpdateProgress] = useState(0);
  const [showUpdateToast, setShowUpdateToast] = useState(false);

  // Core auth and VCD state
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

  // Tool approval state
  const [approvalRequest, setApprovalRequest] = useState<{
    requestId: string;
    toolName: string;
    category: string;
    riskLevel: string;
    description: string;
    args: unknown;
    target: string;
    impactAssessment?: string;
    timestamp: number;
  } | null>(null);

  // Check GitHub Copilot authentication status
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

  // Check VCD authentication status
  const checkVcd = async () => {
    try {
      const result = await window.copilot.vcdStatus();
      setVcdStatus(result);
    } catch {
      setVcdStatus({ connected: false });
    }
  };

  // Update progress listener effect
  useEffect(() => {
    // @ts-expect-error window.electron is added by preload script
    if (window.electron && window.electron.ipcRenderer) {
      const progressHandler = (_event: unknown, progress: number) => {
        setUpdateProgress(progress);
        setShowUpdateToast(progress < 100);
      };
      const cancelHandler = () => {
        setShowUpdateToast(false);
      };
      // @ts-expect-error window.electron is added by preload script
      window.electron.ipcRenderer.on('update-download-progress', progressHandler);
      // @ts-expect-error window.electron is added by preload script
      window.electron.ipcRenderer.on('update-cancelled', cancelHandler);
      return () => {
        // @ts-expect-error window.electron is added by preload script
        window.electron.ipcRenderer.removeListener('update-download-progress', progressHandler);
        // @ts-expect-error window.electron is added by preload script
        window.electron.ipcRenderer.removeListener('update-cancelled', cancelHandler);
      };
    }
  }, []);

  // Auth and VCD status check on mount
  useEffect(() => {
    checkAuth();
    checkVcd();

    // Listen for VCD session expiry
    const cleanupVcd = window.copilot.onVcdSessionExpired(() => {
      console.log('[App] VCD session expired, showing login modal');
      setVcdStatus({ connected: false });
      setShowVcdModal(true);
    });

    // Listen for tool approval requests
    const cleanupApproval = window.copilot.onToolApprovalRequest((_event, request) => {
      console.log('[App] Tool approval request:', request);
      setApprovalRequest(request);
    });

    return () => {
      cleanupVcd();
      cleanupApproval();
    };
  }, []);

  // Handle authentication completion
  const handleAuthComplete = (status: string, username?: string) => {
    setAuthStatus(status);
    setUser(username);
    if (status === 'OK' || status === 'AlreadySignedIn') {
      setShowAuthModal(false);
      setAuthStatusChanged(prev => prev + 1);
    }
  };

  // Handle VCD authentication completion
  const handleVcdComplete = (result: { connected: boolean; user?: string; org?: string; host?: string }) => {
    setVcdStatus(result);
    if (result.connected) {
      setShowVcdModal(false);
    }
  };

  // Handle VCD logout
  const handleVcdLogout = async () => {
    await window.copilot.vcdSignOut();
    setVcdStatus({ connected: false });
  };

  // Handle tool approval
  const handleToolApprove = async (approvalType: 'once' | 'session' | 'always') => {
    if (!approvalRequest) return;
    
    await window.copilot.sendToolApprovalResponse({
      requestId: approvalRequest.requestId,
      approved: true,
      approvalType,
    });
    
    setApprovalRequest(null);
  };

  // Handle tool denial
  const handleToolDeny = async (reason?: string) => {
    if (!approvalRequest) return;
    
    await window.copilot.sendToolApprovalResponse({
      requestId: approvalRequest.requestId,
      approved: false,
      denialReason: reason,
    });
    
    setApprovalRequest(null);
  };

  // DISABLED: Unused handler stub - kept for future reference if needed
  // const _handleCopilotDisconnect = async () => {
  //   await window.copilot.signOut();
  //   setAuthStatus('Unknown');
  //   setUser(undefined);
  //   setShowAuthModal(true);
  // };

  // Theme toggle handler
  const toggleTheme = () => {
    setTheme((prev) => {
      const next = prev === 'light' ? 'dark' : 'light';
      localStorage.setItem('theme', next);
      return next;
    });
  };

  return (
    <ThemeProvider theme={theme === 'dark' ? Theme.JatoDark : Theme.JatoLight}>
    <MermaidEditorProvider>
    <>
      <div className={`flex flex-col h-screen w-screen min-h-0 bg-gray-900 text-gray-100 overflow-hidden ${theme === 'light' ? 'theme-light' : 'theme-dark'}`}>
        <ResizablePanels
          initialLeftWidth={450}
          minLeftWidth={200}
          minRightWidth={400}
          left={
            <Sidebar
              vcdConnected={vcdStatus.connected}
              onVcdSignIn={() => setShowVcdModal(true)}
              onVcdSignOut={handleVcdLogout}
            />
          }
          right={
            <RightPanel
              authStatusChanged={authStatusChanged}
              user={user}
              authStatus={authStatus}
              theme={theme}
              toggleTheme={toggleTheme}
            />
          }
        />
      </div>

      {/* Update Toast */}
      <UpdateToast progress={updateProgress} visible={showUpdateToast} />

      {/* Auth Modal */}
      {showAuthModal && (
        <AuthModal onComplete={handleAuthComplete} onClose={() => setShowAuthModal(false)} />
      )}

      {/* VCD Auth Modal */}
      {showVcdModal && (
        <VcdAuthModal onComplete={handleVcdComplete} onClose={() => setShowVcdModal(false)} />
      )}

      {/* Tool Approval Modal */}
      <ToolApprovalModal
        request={approvalRequest}
        onApprove={handleToolApprove}
        onDeny={handleToolDeny}
      />
    </>
    </MermaidEditorProvider>
    </ThemeProvider>
  );
};

export default App;
