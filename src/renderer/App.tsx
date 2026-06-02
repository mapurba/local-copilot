import * as React from 'react';
import { useEffect, useState, useRef } from 'react';
// Diagnostic: print React version at module load to detect duplicate/mismatched React
console.log('[App] React version (module):', (React as any)?.version);
import { ThemeProvider, Theme } from '@ux-aspects-universal/react/theming';
import { IconButton } from '@ux-aspects-universal/react/button';
import { Dialog, DialogHeader, DialogContent, DialogFooter } from '@ux-aspects-universal/react/dialog';
import { Button } from '@ux-aspects-universal/react/button';
import DocPreviewPane from './components/DocPreviewPane';
import UpdateToast from './components/UpdateToast';
import { checkForAppUpdate } from './autoUpdate';
import Sidebar from './components/Sidebar';
import ChatPane from './components/ChatPane';
import type { CheckpointPayload } from './components/DeploymentCheckpointCard';
import DeploymentPlanPane from './components/DeploymentPlanPane';
import AuthModal from './components/AuthModal';
import VcdAuthModal from './components/VcdAuthModal';
import { ToolApprovalModal } from './components/ToolApprovalModal';
import ResizablePanels from './components/ResizablePanels';
import type { DeploymentPlan } from './deploymentTypes';
import TemplateDialog from './components/TemplateDialog';

declare global {
  interface Window {
    copilot: import('./types').CopilotAPI;
  }
}

interface ProviderConfigView {
  provider: 'copilot' | 'bedrock';
  bedrock: {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    modelId: string;
    configured: boolean;
  };
}


const App: React.FC = () => {
  // Template dialog state (moved inside component to avoid invalid hook call)
  const [templateDialog, setTemplateDialog] = useState<{
    open: boolean;
    serviceId?: string;
    vmName?: string;
    os?: string;
    initialTemplateId?: string;
    initialTemplateName?: string;
    resolve?: (result: { templateId: string; templateName?: string } | null) => void;
  }>({ open: false });

  // Open draft dialog state (moved inside component)
  const [openDraftDialog, setOpenDraftDialog] = useState<{
    open: boolean;
    drafts: Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string }>;
    resolve?: (id: string | null) => void;
  }>({ open: false, drafts: [] });

  // Update download progress state
  const [updateProgress, setUpdateProgress] = useState(0);
  const [showUpdateToast, setShowUpdateToast] = useState(false);

  // Core auth and VCD state
  const [authStatus, setAuthStatus] = useState<string>('Unknown');
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [user, setUser] = useState<string | undefined>();
  const [providerConfig, setProviderConfig] = useState<ProviderConfigView | null>(null);
  const [vcdStatus, setVcdStatus] = useState<{ connected: boolean; user?: string; org?: string; host?: string }>({ connected: false });
  const [showVcdModal, setShowVcdModal] = useState(false);
  const [activeTab, setActiveTab] = useState<'chat' | 'deploy' | 'preview'>('chat');
  const [deployTabOpen, setDeployTabOpen] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<{ docId: string; title: string; content: string } | null>(null);
  const [deploymentPlan, setDeploymentPlan] = useState<DeploymentPlan | null>(null);
  const [currentDraftSavedAt, setCurrentDraftSavedAt] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('theme');
    return saved === 'dark' ? 'dark' : 'light';
  });

  // HITL Deployment Graph checkpoint state
  const [checkpointPayload, setCheckpointPayload] = useState<CheckpointPayload | null>(null);
  const [checkpointLoading, setCheckpointLoading] = useState(false);

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

  const applyProviderConfig = (cfg: ProviderConfigView) => {
    setProviderConfig(cfg);
    window.dispatchEvent(new CustomEvent('ai-provider-changed', { detail: cfg.provider }));
  };

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
    const boot = async () => {
      try {
        const cfg = await window.copilot.getProviderConfig();
        applyProviderConfig(cfg);
        if (cfg.provider === 'bedrock') {
          setUser(undefined);
          setAuthStatus(cfg.bedrock.configured ? 'Bedrock' : 'BedrockNotConfigured');
          setShowAuthModal(!cfg.bedrock.configured);
        } else {
          await checkAuth();
        }
      } catch {
        await checkAuth();
      }
      await checkVcd();
    };

    void boot();

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

    const cleanupPlan = window.copilot.onDeploymentPlanReady((_event, plan) => {
      const deployment = plan as unknown as DeploymentPlan;
      setDeploymentPlan(deployment);
      setDeployTabOpen(true);
      setActiveTab('deploy');
      setCheckpointPayload(null);
      setCheckpointLoading(false);
      void saveDraft(deployment);
    });

    const cleanupCheckpoint = window.copilot.onDeploymentCheckpoint((_event, payload) => {
      console.log('[App] Deployment checkpoint:', payload);
      setCheckpointPayload(payload as CheckpointPayload);
      setCheckpointLoading(false);
      // Switch to chat tab so the user sees the checkpoint card
      setActiveTab('chat');
    });

    const cleanupGraphComplete = window.copilot.onDeploymentGraphComplete((_event, payload) => {
      console.log('[App] Deployment graph complete:', payload);
      setCheckpointPayload(null);
      setCheckpointLoading(false);
    });

    const handlePreviewDoc = (e: Event) => {
      const { docId, title, content } = (e as CustomEvent<{ docId: string; title: string; content: string }>).detail;
      setPreviewDoc({ docId, title, content });
      setActiveTab('preview');
    };
    window.addEventListener('preview-doc', handlePreviewDoc);

    return () => {
      cleanupVcd();
      cleanupApproval();
      cleanupPlan();
      cleanupCheckpoint();
      cleanupGraphComplete();
      window.removeEventListener('preview-doc', handlePreviewDoc);
    };
  }, []);

  useEffect(() => {
    if (!deploymentPlan) return;
    const timer = setTimeout(() => {
      void saveDraft(deploymentPlan);
    }, 350);
    return () => clearTimeout(timer);
  }, [deploymentPlan]);

  // Handle authentication completion
  const handleAuthComplete = (status: string, username?: string) => {
    setAuthStatus(status);
    setUser(username);
    if (status === 'OK' || status === 'AlreadySignedIn') {
      setShowAuthModal(false);
    }
  };

  const handleProviderConfigChange = (cfg: ProviderConfigView) => {
    applyProviderConfig(cfg);
    if (cfg.provider === 'bedrock') {
      setUser(undefined);
      setAuthStatus(cfg.bedrock.configured ? 'Bedrock' : 'BedrockNotConfigured');
      setShowAuthModal(!cfg.bedrock.configured);
      return;
    }

    setShowAuthModal(false);
    void checkAuth();
  };

  const handlePlanUpdate = (plan: DeploymentPlan) => {
    setDeploymentPlan(plan);
  };

  const saveDraft = async (plan: DeploymentPlan) => {
    const res = await window.copilot.saveDeploymentDraft(plan as unknown as Record<string, unknown>);
    if (res.success && res.savedAt) {
      setCurrentDraftSavedAt(res.savedAt);
    }
  };

  const handleOpenDraft = async () => {
    const listRes = await window.copilot.listDeploymentDrafts();
    if (!listRes.success || !listRes.drafts.length) {
      window.alert('No deployment drafts found.');
      return;
    }
    return new Promise<void>((resolve) => {
      setOpenDraftDialog({
        open: true,
        drafts: listRes.drafts,
        resolve: (id) => {
          setOpenDraftDialog((d) => ({ ...d, open: false }));
          if (id) {
            window.copilot.loadDeploymentDraft(id).then((loadRes) => {
              if (!loadRes.success || !loadRes.plan) {
                window.alert(loadRes.error || `Unable to load draft: ${id}`);
                resolve();
                return;
              }
              setDeploymentPlan(loadRes.plan as unknown as DeploymentPlan);
              setDeployTabOpen(true);
              setActiveTab('deploy');
              resolve();
            });
          } else {
            resolve();
          }
        },
      });
    });
  };

  const handleLoadDraftFromSidebar = async (id: string) => {
    try {
      const loadRes = await window.copilot.loadDeploymentDraft(id);
      if (!loadRes.success || !loadRes.plan) {
        window.alert(loadRes.error || `Unable to load draft: ${id}`);
        return;
      }
      setDeploymentPlan(loadRes.plan as unknown as DeploymentPlan);
      setDeployTabOpen(true);
      setActiveTab('deploy');
    } catch (e: any) {
      window.alert(e?.message || String(e));
    }
  };

  const handleDeleteDraftFromSidebar = async (id: string) => {
    const confirmed = window.confirm(`Delete draft ${id}? This cannot be undone.`);
    if (!confirmed) return;

    try {
      const delRes = await window.copilot.deleteDeploymentDraft(id);
      if (!delRes.success) {
        window.alert(delRes.error || 'Failed to delete draft.');
        return;
      }
      if (deploymentPlan && deploymentPlan.id === id) {
        setDeploymentPlan(null);
        setDeployTabOpen(false);
        setActiveTab('chat');
        setCurrentDraftSavedAt(null);
      }
    } catch (e: any) {
      window.alert(e?.message || String(e));
    }
  };

  const handleDeleteDraft = async () => {
    if (!deploymentPlan) return;
    const confirmed = window.confirm(`Delete draft ${deploymentPlan.id}? This cannot be undone.`);
    if (!confirmed) return;

    const delRes = await window.copilot.deleteDeploymentDraft(deploymentPlan.id);
    if (!delRes.success) {
      window.alert(delRes.error || 'Failed to delete draft.');
      return;
    }

    setDeploymentPlan(null);
    setActiveTab('chat');
    setCurrentDraftSavedAt(null);
  };

  const handleCloseDraft = () => {
    setDeployTabOpen(false);
    setActiveTab('chat');
  };

  const handleDiscardDraft = () => {
    const confirmed = window.confirm('Discard current draft from the UI? You can still load it later if saved.');
    if (!confirmed) return;

    setDeploymentPlan(null);
    setDeployTabOpen(false);
    setActiveTab('chat');
  };

  const handleStartFresh = () => {
    const confirmed = window.confirm('Start fresh and clear the current deployment draft from screen?');
    if (!confirmed) return;

    setDeploymentPlan(null);
    setDeployTabOpen(false);
    setActiveTab('chat');
    setCurrentDraftSavedAt(null);
  };

  const handleStopAllDeployments = () => {
    if (!deploymentPlan) return;

    const confirmed = window.confirm('Stop all running deployments in this draft?');
    if (!confirmed) return;

    setDeploymentPlan((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        updatedAt: new Date().toISOString(),
        status: 'failed',
        services: prev.services.map((service) => {
          if (service.status === 'provisioning' || service.status === 'installing' || service.status === 'running') {
            return {
              ...service,
              status: 'failed',
              statusMessage: 'Stopped by user',
              deploymentLog: [
                service.deploymentLog,
                `[${new Date().toLocaleTimeString()}] Deployment stopped by user.`,
              ]
                .filter(Boolean)
                .join('\n'),
            };
          }
          return service;
        }),
      };
    });
  };

  const appendServiceLog = (
    serviceId: string,
    message: string,
    patch?: Partial<DeploymentPlan['services'][number]>
  ) => {
    setDeploymentPlan((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        updatedAt: new Date().toISOString(),
        status: 'deploying',
        services: prev.services.map((service) =>
          service.id === serviceId
            ? {
                ...service,
                ...(patch || {}),
                deploymentLog: [service.deploymentLog, `[${new Date().toLocaleTimeString()}] ${message}`]
                  .filter(Boolean)
                  .join('\n'),
              }
            : service
        ),
      };
    });
  };

  const updateServiceFields = (serviceId: string, patch: Partial<DeploymentPlan['services'][number]>) => {
    setDeploymentPlan((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        updatedAt: new Date().toISOString(),
        services: prev.services.map((service) => (service.id === serviceId ? { ...service, ...patch } : service)),
      };
    });
  };

  const resolveTemplateForService = async (serviceId: string, vmName: string, os?: string) => {
    const current = deploymentPlan?.services.find((s) => s.id === serviceId);
    // Check camelCase (set via updateServiceFields during session), then snake_case
    // (loaded from persisted JSON), then the plan-level global template.
    const existingTemplateId = (
      current?.templateId?.trim() ||
      (current as any)?.vm_template_id?.trim() ||
      deploymentPlan?.vm_template_id?.trim()
    );
    const existingTemplateName = (
      current?.templateName?.trim() ||
      (current as any)?.vm_template_name?.trim() ||
      deploymentPlan?.vm_template_name?.trim()
    );
    if (existingTemplateId) {
      return { templateId: existingTemplateId, templateName: existingTemplateName || undefined };
    }

    // Try to parse runbook metadata (template id/name, vm name, ip)
    const parseRunbookMetadata = (runbook?: string) => {
      const meta: { templateId?: string; templateName?: string; vmName?: string; ipAddress?: string } = {};
      if (!runbook) return meta;
      const text = runbook;

      // Template id (labelled)
      const tplIdRegexes = [/(?:TEMPLATE_ID|template_id|template-id|template)\s*[:=]\s*([0-9a-fA-F-]{36})/i, /template:\s*([0-9a-fA-F-]{36})/i];
      for (const r of tplIdRegexes) {
        const m = r.exec(text);
        if (m) {
          meta.templateId = m[1].trim();
          break;
        }
      }
      // Fallback: if exactly one UUID present in the runbook, use it as a candidate
      if (!meta.templateId) {
        const uuids = Array.from(new Set((text.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g) || [])));
        if (uuids.length === 1) meta.templateId = uuids[0];
      }

      // Template name (labelled)
      const tplName = /(?:TEMPLATE_NAME|template_name|template-name|template)\s*[:=]\s*([^\n\r]+)/i.exec(text);
      if (tplName) meta.templateName = tplName[1].trim().replace(/["']/g, '');

      // VM name patterns: bolded VM from markdown or vm_name= style
      const vmBold = /\*\*VM:\*\*\s*(\S+)/i.exec(text);
      if (vmBold) meta.vmName = vmBold[1].trim();
      if (!meta.vmName) {
        const vmNameMatch = /(?:VM_NAME|vm_name|vm-name|vm)\s*[:=]\s*([A-Za-z0-9_.\-]+)/i.exec(text);
        if (vmNameMatch) meta.vmName = vmNameMatch[1].trim();
      }

      // IP address patterns
      const ipBold = /\*\*IP:\*\*\s*(\d{1,3}(?:\.\d{1,3}){3})/i.exec(text);
      if (ipBold) meta.ipAddress = ipBold[1].trim();
      if (!meta.ipAddress) {
        const ipMatch = /(?:IP_ADDRESS|ip_address|ip-address|ip)\s*[:=]\s*(\d{1,3}(?:\.\d{1,3}){3})/i.exec(text);
        if (ipMatch) meta.ipAddress = ipMatch[1].trim();
      }

      return meta;
    };

    const metadata = parseRunbookMetadata(current?.runbook || '');
    // If VM name found in runbook and not set, update it
    if (metadata.vmName && !current?.vmName) {
      updateServiceFields(serviceId, { vmName: metadata.vmName });
      appendServiceLog(serviceId, `Pre-filled VM name from runbook: ${metadata.vmName}`);
    }
    // If IP found in runbook and not set, update it
    if (metadata.ipAddress && !current?.ip) {
      updateServiceFields(serviceId, { ip: metadata.ipAddress });
      appendServiceLog(serviceId, `Pre-filled IP from runbook: ${metadata.ipAddress}`);
    }

    // If template id found in runbook, use it directly
    if (metadata.templateId) {
      updateServiceFields(serviceId, { templateId: metadata.templateId, templateName: metadata.templateName || current?.templateName });
      appendServiceLog(serviceId, `Pre-filled template from runbook: ${metadata.templateId}${metadata.templateName ? ` (${metadata.templateName})` : ''}`);
      return { templateId: metadata.templateId, templateName: metadata.templateName };
    }

    // Show modal dialog for template selection, prefill with global template if available
    return new Promise<{ templateId: string; templateName?: string } | null>((resolve) => {
      setTemplateDialog({
        open: true,
        serviceId,
        vmName,
        os,
        initialTemplateId: deploymentPlan?.vm_template_id || '',
        initialTemplateName: metadata.templateName || deploymentPlan?.vm_template_name || '',
        resolve,
      });
    });
  };
  // Template dialog handlers
  const handleTemplateDialogSubmit = (templateId: string, templateName?: string) => {
    if (templateDialog.resolve) templateDialog.resolve({ templateId, templateName });
    setTemplateDialog((d) => ({ ...d, open: false }));
  };
  const handleTemplateDialogCancel = () => {
    if (templateDialog.resolve) templateDialog.resolve(null);
    setTemplateDialog((d) => ({ ...d, open: false }));
  };
  // Open draft dialog UI
  const renderOpenDraftDialog = () => {
    if (!openDraftDialog.open) return null;
    return (
      <Dialog onClose={() => openDraftDialog.resolve && openDraftDialog.resolve(null)} aria-label="Open Draft">
        <DialogHeader>Open Deployment Draft</DialogHeader>
        <DialogContent>
          <ul className="flex flex-col gap-2 max-h-64 overflow-y-auto">
            {openDraftDialog.drafts.map((d) => (
              <li key={d.id} className="flex items-center gap-2">
                <button
                  className="px-2 py-1 bg-gray-700 hover:bg-blue-700 text-white rounded"
                  onClick={() => openDraftDialog.resolve && openDraftDialog.resolve(d.id)}
                >
                  {d.name} <span className="text-xs text-gray-400">({d.id})</span>
                </button>
                <span className="text-xs text-gray-400">{d.status} | {new Date(d.updatedAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </DialogContent>
        <DialogFooter>
          <Button secondary onClick={() => openDraftDialog.resolve && openDraftDialog.resolve(null)}>Cancel</Button>
        </DialogFooter>
      </Dialog>
    );
  };

  const ensureServiceIp = async (serviceId: string, vmName: string, currentIp?: string) => {
    if (currentIp && currentIp.trim()) {
      return currentIp.trim();
    }

    appendServiceLog(serviceId, 'No IP assigned yet. Requesting a free IP from VCD pool...');
    const ipResult = await window.copilot.allocateFreeIp();
    if (!ipResult.success || !ipResult.ip) {
      throw new Error(ipResult.error || `Failed to allocate IP for ${vmName}`);
    }

    const assignedIp = ipResult.ip.trim();
    updateServiceFields(serviceId, { ip: assignedIp });
    appendServiceLog(serviceId, `Allocated IP ${assignedIp}.`);
    return assignedIp;
  };

  const deployServiceById = async (serviceId: string): Promise<boolean> => {
    if (!deploymentPlan) return false;
    const service = deploymentPlan.services.find((s) => s.id === serviceId);
    if (!service) return false;
    // Delegate to VM-group deployment so co-located services are combined
    const vmName = service.vmName || serviceId;
    const colocated = deploymentPlan.services
      .filter((s) => (s.vmName || s.id) === vmName && (s.status === 'pending' || s.status === 'failed'));
    const ids = colocated.length > 0 ? colocated.map((s) => s.id) : [serviceId];
    return deployVmGroup(vmName, ids);
  };

  /**
   * Deploy all services that share the same VM as one unit.
   * Creates the VM once with a combined runbook containing every service's steps.
   */
  const deployVmGroup = async (vmName: string, serviceIds: string[]): Promise<boolean> => {
    if (!deploymentPlan) return false;
    const services = serviceIds
      .map((id) => deploymentPlan.services.find((s) => s.id === id))
      .filter(Boolean) as typeof deploymentPlan.services;
    if (services.length === 0) return false;

    if (!vcdStatus.connected) {
      setShowVcdModal(true);
      for (const svc of services) {
        appendServiceLog(svc.id, 'VCD session is not connected. Please sign in and retry.', {
          status: 'failed',
          statusMessage: 'VCD login required',
        });
      }
      return false;
    }

    // Mark all co-located services as provisioning
    for (const svc of services) {
      appendServiceLog(svc.id, `Starting VM provisioning for "${svc.name}" on ${vmName}...`, {
        status: 'provisioning',
        statusMessage: 'Preparing deployment request',
      });
    }

    try {
      // Resolve template once for this VM (primary service drives the dialog if needed)
      const primary = services[0];
      const resolvedTemplate = await resolveTemplateForService(primary.id, vmName, primary.os);
      if (!resolvedTemplate) {
        for (const svc of services) {
          appendServiceLog(svc.id, 'Deployment cancelled. Template ID was not provided.', {
            status: 'failed',
            statusMessage: 'Template selection cancelled',
          });
        }
        return false;
      }

      for (const svc of services) {
        updateServiceFields(svc.id, {
          templateId: resolvedTemplate.templateId,
          templateName: resolvedTemplate.templateName,
          vm_template_id: resolvedTemplate.templateId,
          vm_template_name: resolvedTemplate.templateName,
        } as any);
      }
      appendServiceLog(primary.id, `Using template ${resolvedTemplate.templateName || resolvedTemplate.templateId}.`);

      // Allocate or reuse the shared IP for this VM
      const existingIp = services.find((s) => s.ip?.trim())?.ip;
      const assignedIp = await ensureServiceIp(primary.id, vmName, existingIp);
      // Propagate the same IP to every co-located service
      for (const svc of services) {
        if (!svc.ip?.trim() || svc.ip !== assignedIp) {
          updateServiceFields(svc.id, { ip: assignedIp });
        }
      }

      // Build combined runbook — one #!/bin/bash header then per-service sections
      const combinedRunbook = [
        '#!/bin/bash',
        `# Combined deployment script for VM: ${vmName}`,
        `# Services: ${services.map((s) => s.name).join(', ')}`,
        '',
        ...services.map((svc, idx) => {
          // Strip shebang from non-first runbooks
          const rb = (svc.runbook || '').replace(/^#!\/[^\n]*\n?/, '').trim();
          return `# ${'─'.repeat(60)}\n# Service ${idx + 1}/${services.length}: ${svc.name}\n# ${'─'.repeat(60)}\n${rb}`;
        }),
      ].join('\n\n');

      const label = services.length > 1
        ? `${services.length} services (${services.map((s) => s.name).join(', ')})`
        : `"${services[0].name}"`;

      for (const svc of services) {
        appendServiceLog(svc.id, `Deploying ${label} on VM ${vmName}...`, {
          status: 'installing',
          statusMessage: 'Submitting VM creation request',
        });
      }

      const deployResult = await window.copilot.deployVm({
        vm_name: vmName,
        template_id: resolvedTemplate.templateId,
        template_name: resolvedTemplate.templateName,
        ip_address: assignedIp,
        ip_allocation_mode: 'MANUAL',
        power_on: true,
        custom_script: combinedRunbook,
      });

      if (!deployResult.success) {
        throw new Error(deployResult.error || 'Unknown VM deployment error');
      }

      for (const svc of services) {
        appendServiceLog(svc.id, `VM ${vmName} created. All services on this VM are deployed together.`, {
          status: 'running',
          statusMessage: 'VM create request submitted',
        });
      }

      const resultPreview = JSON.stringify(deployResult.result ?? {}, null, 2);
      if (resultPreview && resultPreview !== '{}') {
        appendServiceLog(primary.id, `Backend response:\n${resultPreview}`);
      }

      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const svc of services) {
        appendServiceLog(svc.id, `Deployment failed: ${msg}`, {
          status: 'failed',
          statusMessage: msg,
        });
      }
      return false;
    }
  };

  const handleDeployService = async (serviceId: string) => {
    await deployServiceById(serviceId);
  };

  const handleDeployAll = async () => {
    if (!deploymentPlan) return;

    // Group pending/failed services by vmName — each VM is deployed once
    const vmGroups = new Map<string, string[]>();
    for (const svc of deploymentPlan.services) {
      if (svc.status !== 'pending' && svc.status !== 'failed') continue;
      const key = svc.vmName || svc.id;
      if (!vmGroups.has(key)) vmGroups.set(key, []);
      vmGroups.get(key)!.push(svc.id);
    }

    if (vmGroups.size === 0) return;

    // Sort VMs: those whose services have fewer dependencies go first
    const sorted = [...vmGroups.entries()].sort(([, aIds], [, bIds]) => {
      const minDeps = (ids: string[]) =>
        Math.min(...ids.map((id) => deploymentPlan.services.find((s) => s.id === id)?.dependsOn.length ?? 0));
      return minDeps(aIds) - minDeps(bIds);
    });

    let allSucceeded = true;
    for (const [vmName, serviceIds] of sorted) {
      const ok = await deployVmGroup(vmName, serviceIds);
      if (!ok) allSucceeded = false;
    }

    setDeploymentPlan((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        updatedAt: new Date().toISOString(),
        status: allSucceeded ? 'complete' : 'failed',
      };
    });
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
    <>
      {/* Template Dialog for missing template info */}
      <TemplateDialog
        open={templateDialog.open}
        vmName={templateDialog.vmName || ''}
        os={templateDialog.os}
        initialTemplateId={templateDialog.initialTemplateId}
        initialTemplateName={templateDialog.initialTemplateName}
        onSubmit={handleTemplateDialogSubmit}
        onCancel={handleTemplateDialogCancel}
      />
      {renderOpenDraftDialog()}
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
              onLoadDraft={handleLoadDraftFromSidebar}
              onDeleteDraft={handleDeleteDraftFromSidebar}
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
                  {deploymentPlan && deployTabOpen && (
                    <div className="flex items-center">
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
                      <button
                        onClick={handleCloseDraft}
                        className="px-1.5 py-3 text-gray-600 hover:text-gray-300 transition-colors"
                        title="Close tab"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  )}
                  {previewDoc && (
                    <div className="flex items-center">
                      <button
                        onClick={() => setActiveTab('preview')}
                        className={`flex items-center gap-2 px-4 py-3 text-xs font-medium border-b-2 transition-colors ${activeTab === 'preview' ? 'border-purple-500 text-purple-400' : 'border-transparent text-gray-400 hover:text-gray-300'}`}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                        Preview
                      </button>
                      <button
                        onClick={() => { setPreviewDoc(null); setActiveTab('chat'); }}
                        className="px-1.5 py-3 text-gray-600 hover:text-gray-300 transition-colors"
                        title="Close preview"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>

                {deploymentPlan && deployTabOpen && (
                  <div className="flex items-center gap-1 px-2 border-l border-gray-700">
                    {/* <button
                      onClick={handleOpenDraft}
                      className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded"
                    >
                      Open Draft
                    </button>
                    <button
                      onClick={() => void saveDraft(deploymentPlan)}
                      className="px-2 py-1 text-xs bg-blue-700 hover:bg-blue-600 text-white rounded"
                    >
                      Save Draft
                    </button>
                    <button
                      onClick={handleStopAllDeployments}
                      className="px-2 py-1 text-xs bg-yellow-700 hover:bg-yellow-600 text-white rounded"
                    >
                      Stop All
                    </button>
                    <button
                      onClick={handleCloseDraft}
                      className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded"
                    >
                      Close
                    </button>
                    <button
                      onClick={handleDiscardDraft}
                      className="px-2 py-1 text-xs bg-orange-700 hover:bg-orange-600 text-white rounded"
                    >
                      Discard
                    </button>
                    <button
                      onClick={handleDeleteDraft}
                      className="px-2 py-1 text-xs bg-red-700 hover:bg-red-600 text-white rounded"
                    >
                      Delete
                    </button>
                    <button
                      onClick={handleStartFresh}
                      className="px-2 py-1 text-xs bg-emerald-700 hover:bg-emerald-600 text-white rounded"
                    >
                      Start Fresh
                    </button> */}
                  </div>
                )}

                {/* Action Buttons - Right side */}
                <div className="flex items-center gap-1 px-2">
                  <button
                    onClick={() => setShowAuthModal(true)}
                    className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded"
                    title="AI provider settings"
                  >
                    Provider
                  </button>

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
                  {providerConfig?.provider === 'copilot' && user && <span>Copilot: <span className="text-gray-300">{user}</span></span>}
                  {providerConfig?.provider === 'bedrock' && (
                    <span>
                      Provider: <span className="text-gray-300">Bedrock</span>
                      {providerConfig.bedrock.region ? <span className="text-gray-500"> | {providerConfig.bedrock.region}</span> : null}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {deploymentPlan && currentDraftSavedAt && (
                    <span className="text-gray-500">Draft saved: {new Date(currentDraftSavedAt).toLocaleTimeString()}</span>
                  )}
                  <div className={`w-2 h-2 rounded-full ${(providerConfig?.provider === 'bedrock' && providerConfig?.bedrock.configured) || authStatus === 'OK' || authStatus === 'AlreadySignedIn' ? 'bg-green-400' : 'bg-yellow-400'}`} />
                  <span className="text-gray-400">
                    {providerConfig?.provider === 'bedrock'
                      ? (providerConfig.bedrock.configured ? 'Bedrock Connected' : 'Bedrock Not Configured')
                      : (authStatus === 'AlreadySignedIn' ? 'Connected' : authStatus)}
                  </span>
                </div>
              </div>

              {/* Content Pane */}
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                <div className={`${activeTab === 'chat' ? 'flex flex-1 min-h-0 flex-col' : 'hidden'}`}>
                  <ChatPane
                    checkpointPayload={checkpointPayload}
                    checkpointLoading={checkpointLoading}
                    onCheckpointSubmit={async (threadId, answers) => {
                      setCheckpointLoading(true);
                      await window.copilot.resumeDeploymentGraph(threadId, answers);
                    }}
                    onCheckpointCancel={async (threadId) => {
                      setCheckpointPayload(null);
                      await window.copilot.clearDeploymentGraph(threadId);
                    }}
                  />
                </div>
                {deploymentPlan && deployTabOpen && (
                  <div className={`${activeTab === 'deploy' ? 'flex flex-1 min-h-0 flex-col' : 'hidden'}`}>
                    <DeploymentPlanPane
                      plan={deploymentPlan}
                      onPlanUpdate={handlePlanUpdate}
                      onDeployAll={handleDeployAll}
                      onDeployService={handleDeployService}
                    />
                  </div>
                )}
                {previewDoc && (
                  <div className={`${activeTab === 'preview' ? 'flex flex-1 min-h-0 flex-col' : 'hidden'}`}>
                    <DocPreviewPane title={previewDoc.title} content={previewDoc.content} />
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
        <AuthModal
          onComplete={handleAuthComplete}
          onClose={() => setShowAuthModal(false)}
          providerConfig={providerConfig}
          onProviderConfigChange={handleProviderConfigChange}
          theme={theme}
          copilotAuthStatus={authStatus}
          copilotUser={user}
        />
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
    </ThemeProvider>
  );
};

export default App;
