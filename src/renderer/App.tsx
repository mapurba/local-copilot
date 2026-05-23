import React, { useEffect, useState, useCallback } from 'react';
import UpdateToast from './components/UpdateToast';
import { checkForAppUpdate } from './autoUpdate';
import Sidebar from './components/Sidebar';
import ChatPane from './components/ChatPane';
import DeploymentPlanPane from './components/DeploymentPlanPane';
import AuthModal from './components/AuthModal';
import VcdAuthModal from './components/VcdAuthModal';
import ResizablePanels from './components/ResizablePanels';
import type { DeploymentPlan } from './deploymentTypes';

declare global {
  interface Window {
    copilot: import('./types').CopilotAPI;
  }
}


const App: React.FC = () => {
  // Update download progress state
  const [updateProgress, setUpdateProgress] = useState(0);
  const [showUpdateToast, setShowUpdateToast] = useState(false);

  // Core auth and VCD state
  const [authStatus, setAuthStatus] = useState<string>('Unknown');
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [user, setUser] = useState<string | undefined>();
  const [vcdStatus, setVcdStatus] = useState<{ connected: boolean; user?: string; org?: string; host?: string }>({ connected: false });
  const [showVcdModal, setShowVcdModal] = useState(false);

  // Tab and deployment state
  const [activeTab, setActiveTab] = useState<'chat' | 'deploy'>('chat');
  const [deploymentPlan, setDeploymentPlan] = useState<DeploymentPlan | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('theme');
    return saved === 'dark' ? 'dark' : 'light';
  });

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

  // Listen for deployment plan ready events from backend
  useEffect(() => {
    const handlePlanReady = (_event: unknown, plan: Record<string, unknown>) => {
      setDeploymentPlan(plan as unknown as DeploymentPlan);
      setActiveTab('deploy');
    };
    if (window.copilot.onDeploymentPlanReady) {
      const cleanup = window.copilot.onDeploymentPlanReady(handlePlanReady);
      return cleanup;
    }
  }, []);

  // Listen for deployment plan updates
  useEffect(() => {
    const handlePlanUpdate = (_event: unknown, plan: Record<string, unknown>) => {
      setDeploymentPlan(plan as unknown as DeploymentPlan);
    };
    if (window.copilot.onDeploymentPlanUpdated) {
      const cleanup = window.copilot.onDeploymentPlanUpdated(handlePlanUpdate);
      return cleanup;
    }
  }, []);

  // Listen for custom event from ChatPane to open deployment plan
  useEffect(() => {
    const handler = (e: CustomEvent<DeploymentPlan>) => {
      setDeploymentPlan(e.detail);
      setActiveTab('deploy');
    };
    window.addEventListener('open-deployment-plan', handler as EventListener);
    return () => window.removeEventListener('open-deployment-plan', handler as EventListener);
  }, []);

  // Restore the latest saved deployment plan on app startup
  useEffect(() => {
    const restoreLatestPlan = async () => {
      try {
        const listResult = await window.copilot.listDeploymentPlans();
        if (!listResult.success || !Array.isArray(listResult.plans) || listResult.plans.length === 0) {
          return;
        }

        const latest = [...listResult.plans]
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

        if (!latest?.id) return;

        const loadResult = await window.copilot.loadDeploymentPlan(latest.id);
        if (loadResult.success && loadResult.plan) {
          setDeploymentPlan(loadResult.plan as unknown as DeploymentPlan);
        }
      } catch (err) {
        console.warn('[App] Failed to restore latest deployment plan:', err);
      }
    };

    restoreLatestPlan();
  }, []);

  // Deployment plan handlers
  const handlePlanUpdate = useCallback(async (plan: DeploymentPlan) => {
    setDeploymentPlan(plan);
    await window.copilot.saveDeploymentPlan(plan as unknown as Record<string, unknown>);
  }, []);

  const handleDeployAll = useCallback(async () => {
    if (!deploymentPlan) return;
    // Deploy services in dependency order (leaf nodes first)
    const services = deploymentPlan.services;
    const deployed = new Set<string>();
    const queue = [...services].sort((a, b) => a.dependsOn.length - b.dependsOn.length);
    for (const service of queue) {
      if (service.status === 'complete') {
        deployed.add(service.id);
        continue;
      }
      await window.copilot.updateDeploymentServiceStatus({
        planId: deploymentPlan.id,
        serviceId: service.id,
        status: 'provisioning',
        statusMessage: 'Starting deployment...',
      });
    }
  }, [deploymentPlan]);

  const handleDeployService = useCallback(async (serviceId: string) => {
    if (!deploymentPlan) return;
    await window.copilot.updateDeploymentServiceStatus({
      planId: deploymentPlan.id,
      serviceId,
      status: 'provisioning',
      statusMessage: 'Starting individual service deployment...',
    });
  }, [deploymentPlan]);

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
  }, []);

  // Handle authentication completion
  const handleAuthComplete = (status: string, username?: string) => {
    setAuthStatus(status);
    setUser(username);
    if (status === 'OK' || status === 'AlreadySignedIn') {
      setShowAuthModal(false);
    }
  };

  // Handle VCD authentication completion
  const handleVcdComplete = (result: { connected: boolean; user?: string; org?: string; host?: string }) => {
    setVcdStatus(result);
    if (result.connected) {
      setShowVcdModal(false);
    }
  };

  // DISABLED: Unused handler stubs - kept for future reference if needed
  // const _handleVcdLogout = async () => {
  //   await window.copilot.vcdSignOut();
  //   setVcdStatus({ connected: false });
  // };

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

  // Handle VCD logout
  const handleVcdLogout = async () => {
    await window.copilot.vcdSignOut();
    setVcdStatus({ connected: false });
    // Optionally, reload VMs or force re-auth UI
  };

  // Listen for relogin event from VmListPane
  React.useEffect(() => {
    const handler = () => setShowVcdModal(true);
    window.addEventListener('show-vcd-login', handler);
    return () => window.removeEventListener('show-vcd-login', handler);
  }, []);

  return (
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
              onVcdLogout={handleVcdLogout}
            />
          }
          right={
            <div className="flex flex-col flex-1 min-h-0 border-l border-gray-700 overflow-hidden">
              {/* Tab Bar */}
              <div className="bg-gray-800 border-b border-gray-700 flex items-center">
                <div className="flex items-center flex-1">
                  {/* Chat Tab */}
                  <button
                    onClick={() => setActiveTab('chat')}
                    className={`flex items-center gap-2 px-4 py-3 text-xs font-medium border-b-2 transition-colors ${activeTab === 'chat' ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-400 hover:text-gray-300'}`}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    Chat
                  </button>
                  {/* Design/Deploy Tab */}
                  {deploymentPlan && (
                    <button
                      onClick={() => setActiveTab('deploy')}
                      className={`flex items-center gap-2 px-4 py-3 text-xs font-medium border-b-2 transition-colors ${activeTab === 'deploy' ? 'border-green-500 text-green-400' : 'border-transparent text-gray-400 hover:text-gray-300'}`}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                        <line x1="8" y1="21" x2="16" y2="21" />
                        <line x1="12" y1="17" x2="12" y2="21" />
                      </svg>
                      Design / Deploy
                    </button>
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

                  {/* Theme Toggle Button */}
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

              {/* Content Area */}
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                <div className={`flex-1 min-h-0 ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
                  <ChatPane />
                </div>
                {deploymentPlan && (
                  <div className={`flex-1 min-h-0 ${activeTab === 'deploy' ? 'block' : 'hidden'}`}>
                    <DeploymentPlanPane
                      plan={deploymentPlan}
                      onPlanUpdate={handlePlanUpdate}
                      onDeployAll={handleDeployAll}
                      onDeployService={handleDeployService}
                    />
                  </div>
                )}
              </div>
            </div>
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
    </>
  );
};

export default App;
