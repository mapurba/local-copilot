import React, { useState, useRef, useEffect, useCallback } from 'react';
import EditorPane from './EditorPane';
import ConfirmDialog from './ConfirmDialog';
import ModelSelector from './ModelSelector';
import ResponseRenderer from './ResponseRenderer';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  type?: 'text' | 'tool-call' | 'tool-result';
}

interface VmDraftForm {
  vm_name: string;
  template_id: string;
  template_name?: string;
  network_name?: string;
  ip_allocation_mode?: string;
  ip_address?: string;
  gateway?: string;
  dns_servers?: string;
  power_on?: boolean;
  storage_profile_id?: string;
  compute_policy_id?: string;
  setup_ilm?: boolean;
  ilm_version?: string;
  custom_env_content?: string;
  custom_shell_script?: string;
}

interface VmCopyDraftForm {
  vm_name_or_href: string;
  new_vm_name: string;
  target_vapp_href?: string;
  description?: string;
  power_on?: boolean;
}

interface VApp {
  name: string;
  href: string;
  status?: string;
  owner?: string;
}

const CHAT_WELCOME_MESSAGE = [
  'Welcome. I can help you manage VMs using natural language.',
  '',
  '**What you can ask me:**',
  '- List VMs, vApps, templates, and recent tasks',
  '- Start, stop, delete, snapshot, and revert VM snapshots',
  '- Create or clone VMs with a review form before execution',
  '- Set up ILM and upload a custom .env during VM creation',
  '- Resize VM CPU and memory',
  '- Check VM status and troubleshoot failed actions',
  '',
  '**Try prompts like:**',
  '- "Show all running VMs"',
  '- "Create a snapshot for vm-app-01"',
  '- "Clone vm-db-01 to app-vapp"',
  '- "Resize vm-web-02 to 4 CPU and 8192 MB RAM"',
  '- "Show tasks from the last 30 minutes"',
  '- "Create a new Ubuntu VM with name appurbatest and setup ILM 1.3.0"',
  '- "Create a VM with setup ILM and I will upload a custom .env"',
  '- "Create a new SLES 15 SP6 VM with name appurbatest"',
].join('\n');

const ChatPane: React.FC = () => {
  // Confirmation dialog state
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmMessage, setConfirmMessage] = useState('');
  const [confirmAction, setConfirmAction] = useState<null | (() => void)>(null);
  // Helper to show confirmation dialog for any operation
  const requestConfirmation = (message: string, action: () => void) => {
    setConfirmMessage(message);
    setConfirmAction(() => action);
    setConfirmOpen(true);
  };
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: CHAT_WELCOME_MESSAGE },
  ]);
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState('gpt-4');
  const [isStreaming, setIsStreaming] = useState(false);
  const [useTools, setUseTools] = useState(true);
  const [pendingForm, setPendingForm] = useState<VmDraftForm | null>(null);
  // Store last known template list for local lookup
  const lastTemplatesRef = useRef<Array<{ id: string; name: string }>>([]);
  const [pendingCopyForm, setPendingCopyForm] = useState<VmCopyDraftForm | null>(null);
  const [vapps, setVapps] = useState<VApp[]>([]);
  const [vappsLoading, setVappsLoading] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const [isCopyingVm, setIsCopyingVm] = useState(false);
  const [fetchingIp, setFetchingIp] = useState(false);
  const [showShellEditor, setShowShellEditor] = useState(false);
  const [shellScriptDraft, setShellScriptDraft] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void)[]>([]);

  useEffect(() => {
    const unsubChunk = window.copilot.onChatStream((_event: unknown, chunk: string, type?: string) => {
      const messageType = (type as 'text' | 'tool-call' | 'tool-result' | undefined) || 'text';
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant' && last.streaming) {
          return [...prev.slice(0, -1), { ...last, content: last.content + chunk, type: messageType }];
        }
        return [...prev, { role: 'assistant', content: chunk, streaming: true, type: messageType }];
      });
    });

    const unsubEnd = window.copilot.onChatEnd(() => {
      setIsStreaming(false);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.streaming) return [...prev.slice(0, -1), { ...last, streaming: false }];
        return prev;
      });
    });

    const unsubError = window.copilot.onChatError((_event: unknown, message: string) => {
      setIsStreaming(false);
      setMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${message}` }]);
    });

    // Listen for VM draft form emitted by the backend after create_vm_draft tool
    const unsubDraft = window.copilot.onVmDraft((_event: unknown, form: Record<string, unknown>) => {
      console.log('[ChatPane] onVmDraft event received');
      console.log('[ChatPane] Form data:', form);
      setIsStreaming(false);
      setPendingCopyForm(null);
      // If template list is present, store for local lookup
      if (Array.isArray(form.templates)) {
        lastTemplatesRef.current = form.templates.map((t: any) => ({ id: String(t.id), name: String(t.name) }));
      }
      setPendingForm({
        vm_name: String(form.vm_name || ''),
        template_id: String(form.template_id || ''),
        template_name: form.template_name ? String(form.template_name) : undefined,
        network_name: form.network_name ? String(form.network_name) : undefined,
        ip_allocation_mode: form.ip_allocation_mode ? String(form.ip_allocation_mode) : 'DHCP',
        ip_address: form.ip_address ? String(form.ip_address) : '',
        gateway: form.gateway ? String(form.gateway) : undefined,
        dns_servers: form.dns_servers ? String(form.dns_servers) : undefined,
        power_on: form.power_on !== undefined ? Boolean(form.power_on) : true,
        storage_profile_id: form.storage_profile_id ? String(form.storage_profile_id) : undefined,
        compute_policy_id: form.compute_policy_id ? String(form.compute_policy_id) : undefined,
        setup_ilm: form.setup_ilm !== undefined ? Boolean(form.setup_ilm) : false,
        ilm_version: form.ilm_version ? String(form.ilm_version) : undefined,
        custom_env_content: form.custom_env_content ? String(form.custom_env_content) : undefined,
      });
      console.log('[ChatPane] Pending form state updated');
    });

    const unsubCopyDraft = window.copilot.onVmCopyDraft((_event: unknown, form: Record<string, unknown>) => {
      console.log('[ChatPane] onVmCopyDraft event received');
      console.log('[ChatPane] Copy form data:', form);
      setIsStreaming(false);
      setPendingForm(null);
      setPendingCopyForm({
        vm_name_or_href: String(form.vm_name_or_href || ''),
        new_vm_name: String(form.new_vm_name || ''),
        target_vapp_href: form.target_vapp_href ? String(form.target_vapp_href) : '',
        description: form.description ? String(form.description) : '',
        power_on: form.power_on !== undefined ? Boolean(form.power_on) : false,
      });
    });

    cleanupRef.current = [unsubChunk, unsubEnd, unsubError, unsubDraft, unsubCopyDraft];
    return () => cleanupRef.current.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pendingForm, pendingCopyForm]);

  const loadVapps = useCallback(async () => {
    setVappsLoading(true);
    try {
      const result = await window.copilot.listVapps();
      const items = Array.isArray(result?.vapps) ? result.vapps : [];
      const normalized: VApp[] = items.map((item) => ({
        name: String(item.name || 'Unknown'),
        href: String(item.href || ''),
        status: item.status ? String(item.status) : undefined,
        owner: item.owner ? String(item.owner) : undefined,
      })).filter((item) => Boolean(item.href));
      setVapps(normalized);
      setPendingCopyForm((prev) => {
        if (!prev || prev.target_vapp_href) return prev;
        if (!normalized.length) return prev;
        return { ...prev, target_vapp_href: normalized[0].href };
      });
    } catch (err) {
      console.error('[ChatPane] Failed to load vApps:', err);
      setVapps([]);
    } finally {
      setVappsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (pendingCopyForm && vapps.length === 0 && !vappsLoading) {
      loadVapps();
    }
  }, [pendingCopyForm, vapps.length, vappsLoading, loadVapps]);

  const sendMessage = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    const userMsg: Message = { role: 'user', content: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsStreaming(true);

    const historyForApi = [...messages, userMsg]
      .filter((m) => !m.streaming)
      .map((m) => ({ role: m.role, content: m.content }));

    if (useTools) {
      await window.copilot.sendChatMessageWithTools(selectedModel, historyForApi);
    } else {
      await window.copilot.sendChatMessage(selectedModel, historyForApi);
    }
  }, [input, isStreaming, messages, selectedModel, useTools]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const updateForm = (key: keyof VmDraftForm, value: string | boolean) => {
    setPendingForm((prev) => prev ? { ...prev, [key]: value } : null);
  };

  const handleEnvFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !pendingForm) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result;
      const content = typeof result === 'string' ? result : '';
      updateForm('custom_env_content', content);
    };
    reader.readAsText(file);
  };

  const handleShellFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !pendingForm) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result;
      const content = typeof result === 'string' ? result : '';
      updateForm('custom_shell_script', content);
    };
    reader.readAsText(file);
  };

  const handleEditShellScript = () => {
    setShellScriptDraft(pendingForm?.custom_shell_script || '');
    setShowShellEditor(true);
  };

  const handleSaveShellScript = () => {
    updateForm('custom_shell_script', shellScriptDraft);
    setShowShellEditor(false);
  };

  const handleCancelShellEdit = () => {
    setShowShellEditor(false);
  };

  const updateCopyForm = (key: keyof VmCopyDraftForm, value: string | boolean) => {
    setPendingCopyForm((prev) => prev ? { ...prev, [key]: value } : null);
  };

  const handleFetchFreeIp = async () => {
    if (!pendingForm) return;
    setFetchingIp(true);
    try {
      const result = await window.copilot.allocateFreeIp();
      if (result.success && result.ip) {
        updateForm('ip_address', result.ip);
        updateForm('ip_allocation_mode', 'MANUAL');
      } else {
        console.error('[ChatPane] Failed to allocate IP:', result.error);
        alert(`Failed to allocate IP: ${result.error || 'Unknown error'}`);
      }
    } catch (err) {
      console.error('[ChatPane] Error allocating IP:', err);
      alert(`Error allocating IP: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setFetchingIp(false);
    }
  };

  const doDeployVm = async () => {
    if (!pendingForm) return;
    setIsDeploying(true);
    try {
      const result = await window.copilot.deployVm(pendingForm as unknown as Record<string, unknown>);
      setPendingForm(null);
      if (result.success) {
        const envUpdate = (result.result as { env_update?: { changesSummary?: string; rationale?: string; usedFallback?: boolean } } | undefined)?.env_update;
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `OK: VM **${pendingForm.vm_name}** creation started successfully!` },
          { role: 'assistant', content: `VM IP : **${pendingForm.ip_address}** allocated.` },
          { role: 'assistant', content: `User Name : Root , Password : Password1!` },
        ]);
        if (envUpdate) {
          const fallbackNote = envUpdate.usedFallback ? '\n\nNote: Used fallback update (LLM unavailable).' : '';
          const summary = envUpdate.changesSummary ? `\n\nChanges:\n${envUpdate.changesSummary}` : '';
          const rationale = envUpdate.rationale ? `\n\nNotes: ${envUpdate.rationale}` : '';
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: `Understood custom .env. Modified with VM IP.${summary}${rationale}${fallbackNote}` },
          ]);
        }
      } else {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `Error: VM creation failed: ${result.error}` },
        ]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Deployment failed';
      setMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${msg}` }]);
    } finally {
      setIsDeploying(false);
    }
  };
  const handleDeployVm = () => {
    requestConfirmation('Are you sure you want to deploy this VM?', doDeployVm);
  };

  const handleCancelReview = () => {
    setPendingForm(null);
    setMessages((prev) => [...prev, { role: 'assistant', content: 'VM creation cancelled.' }]);
  };

  const doCopyVm = async () => {
    if (!pendingCopyForm) return;
    if (!pendingCopyForm.new_vm_name.trim()) {
      setMessages((prev) => [...prev, { role: 'assistant', content: 'Error: VM name is required for copy.' }]);
      return;
    }
    if (!pendingCopyForm.target_vapp_href) {
      setMessages((prev) => [...prev, { role: 'assistant', content: 'Error: Target vApp is required for copy.' }]);
      return;
    }
    setIsCopyingVm(true);
    try {
      const result = await window.copilot.createVmCopy({
        vmNameOrHref: pendingCopyForm.vm_name_or_href,
        newVmName: pendingCopyForm.new_vm_name.trim(),
        targetVappHref: pendingCopyForm.target_vapp_href,
        description: pendingCopyForm.description?.trim() || undefined,
        powerOn: Boolean(pendingCopyForm.power_on),
      });
      const copiedName = pendingCopyForm.new_vm_name;
      setPendingCopyForm(null);
      if (result.success) {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `OK: VM copy **${copiedName}** has been started successfully.` },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `Error: VM copy failed: ${result.error || 'Unknown error'}` },
        ]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'VM copy failed';
      setMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${msg}` }]);
    } finally {
      setIsCopyingVm(false);
    }
  };
  const handleCopyVm = () => {
    requestConfirmation('Are you sure you want to create a copy of this VM?', doCopyVm);
  };
  // ConfirmDialog rendering
  // Only one confirm dialog at a time
  const handleConfirm = () => {
    setConfirmOpen(false);
    if (confirmAction) confirmAction();
  };
  const handleDeny = () => {
    setConfirmOpen(false);
    setConfirmAction(null);
  };

  const handleCancelCopyReview = () => {
    setPendingCopyForm(null);
    setMessages((prev) => [...prev, { role: 'assistant', content: 'VM copy cancelled.' }]);
  };

  const getMessageColor = (message: Message) => {
    if (message.role === 'user') return 'msg-user';
    switch (message.type) {
      case 'tool-call': return 'msg-tool-call';
      case 'tool-result': return 'msg-tool-result';
      default: return 'msg-assistant';
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-800 border-b border-gray-700">
        <span className="text-sm font-semibold text-gray-200">Copilot Chat</span>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-gray-300 hover:text-gray-100 cursor-pointer">
            <input
              type="checkbox"
              checked={useTools}
              onChange={(e) => setUseTools(e.target.checked)}
              disabled={isStreaming}
              className="w-4 h-4"
            />
            <span>Enable Tools</span>
          </label>
          <ModelSelector selectedModel={selectedModel} onModelChange={setSelectedModel} />
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && !pendingForm && !pendingCopyForm && (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 text-sm space-y-2">
            <span className="text-4xl">:)</span>
            <p>Ask about your VMs or create new ones</p>
            {useTools && (
              <p className="text-xs text-gray-400">Tip: Tools enabled. Try "list my VMs" or "create a new VM"</p>
            )}
          </div>
        )}

        {messages.map((msg, idx) => (
          <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-xl px-4 py-3 text-sm ${getMessageColor(msg)}`}>
              {msg.role === 'assistant' ? (
                <div>
                  <ResponseRenderer content={msg.content} />
                  {msg.streaming && (
                    <span className="inline-block w-2 h-4 bg-blue-400 animate-pulse ml-1 align-text-bottom" />
                  )}
                </div>
              ) : (
                <p className="whitespace-pre-wrap">{msg.content}</p>
              )}
            </div>
          </div>
        ))}

        {/* Confirmation Dialog for all destructive/critical actions */}
        <ConfirmDialog
          open={confirmOpen}
          message={confirmMessage}
          onConfirm={handleConfirm}
          onCancel={handleDeny}
        />
        {/* VM Review & Deploy Form */}
        {pendingForm && (
          <div className="flex justify-start">
            <div className="w-full max-w-lg bg-gray-800 rounded-xl border border-blue-500/40 overflow-hidden shadow-lg">
              {/* Form header */}
              <div className="px-5 py-3 bg-gray-750 border-b border-gray-700 flex items-center gap-2">
                <svg className="text-blue-400" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <span className="text-sm font-semibold text-gray-200">Review &amp; edit VM details before deploying</span>
              </div>

              <div className="p-5 space-y-3">
                {/* VM NAME row */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">VM NAME</label>
                    <input
                      type="text"
                      value={pendingForm.vm_name}
                      onChange={(e) => updateForm('vm_name', e.target.value)}
                      className="w-full bg-gray-700 text-gray-100 text-xs rounded px-2.5 py-1.5 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                </div>
                {/* TEMPLATE ID + TEMPLATE NAME row (no auto-fetch) */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">TEMPLATE ID</label>
                    <input
                      type="text"
                      value={pendingForm.template_id}
                      onChange={(e) => updateForm('template_id', e.target.value)}
                      className="w-full bg-gray-700 text-gray-100 text-xs rounded px-2.5 py-1.5 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">TEMPLATE NAME</label>
                    <input
                      type="text"
                      value={pendingForm.template_name || ''}
                      readOnly
                      className="w-full bg-gray-700 text-gray-100 text-xs rounded px-2.5 py-1.5 border border-gray-600 opacity-80 cursor-not-allowed font-mono"
                    />
                  </div>
                </div>

                {/* Network + IP Address */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">NETWORK</label>
                    <input
                      type="text"
                      value={pendingForm.network_name || ''}
                      onChange={(e) => updateForm('network_name', e.target.value)}
                      className="w-full bg-gray-700 text-gray-100 text-xs rounded px-2.5 py-1.5 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">IP ADDRESS</label>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={pendingForm.ip_address || ''}
                        onChange={(e) => updateForm('ip_address', e.target.value)}
                        placeholder="Auto (DHCP)"
                        className="flex-1 bg-gray-700 text-gray-100 text-xs rounded px-2.5 py-1.5 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 min-w-0"
                      />
                      <button
                        onClick={handleFetchFreeIp}
                        disabled={fetchingIp}
                        className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-xs font-medium px-2 py-1.5 rounded whitespace-nowrap"
                      >
                        {fetchingIp ? '...' : 'Fetch Free IP'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Gateway + DNS */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">GATEWAY</label>
                    <input
                      type="text"
                      value={pendingForm.gateway || ''}
                      onChange={(e) => updateForm('gateway', e.target.value)}
                      className="w-full bg-gray-700 text-gray-100 text-xs rounded px-2.5 py-1.5 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">DNS SERVERS</label>
                    <input
                      type="text"
                      value={pendingForm.dns_servers || ''}
                      onChange={(e) => updateForm('dns_servers', e.target.value)}
                      placeholder="e.g. 8.8.8.8,8.8.4.4"
                      className="w-full bg-gray-700 text-gray-100 text-xs rounded px-2.5 py-1.5 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                </div>

                {/* Power On + Storage Profile */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">POWER ON</label>
                    <select
                      value={pendingForm.power_on ? 'Yes' : 'No'}
                      onChange={(e) => updateForm('power_on', e.target.value === 'Yes')}
                      className="w-full bg-gray-700 text-gray-100 text-xs rounded px-2.5 py-1.5 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      <option>Yes</option>
                      <option>No</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">STORAGE PROFILE</label>
                    <input
                      type="text"
                      value={pendingForm.storage_profile_id || ''}
                      onChange={(e) => updateForm('storage_profile_id', e.target.value)}
                      className="w-full bg-gray-700 text-gray-100 text-xs rounded px-2.5 py-1.5 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                    />
                  </div>
                </div>

                {/* Compute Policy */}
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">COMPUTE POLICY</label>
                  <input
                    type="text"
                    value={pendingForm.compute_policy_id || ''}
                    onChange={(e) => updateForm('compute_policy_id', e.target.value)}
                    className="w-full bg-gray-700 text-gray-100 text-xs rounded px-2.5 py-1.5 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                  />
                </div>

                {/* Setup ILM */}
                {pendingForm.setup_ilm && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="flex items-center gap-2 text-xs font-medium text-gray-400 cursor-pointer">
                          <input type="checkbox" checked={pendingForm.setup_ilm} onChange={(e) => updateForm('setup_ilm', e.target.checked)} className="w-3.5 h-3.5" />
                          SETUP ILM
                        </label>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-400 mb-1">ILM VERSION</label>
                        <input
                          type="text"
                          value={pendingForm.ilm_version || 'latest'}
                          onChange={(e) => updateForm('ilm_version', e.target.value)}
                          className="w-full bg-gray-700 text-gray-100 text-xs rounded px-2.5 py-1.5 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-400 mb-1">CUSTOM .ENV FILE (optional)</label>
                      <input
                        type="file"
                        accept=".env,text/plain"
                        onChange={handleEnvFileChange}
                        className="w-full text-xs text-gray-400"
                      />
                      {pendingForm.custom_env_content && (
                        <div className="mt-1 text-xs text-green-400">.env file loaded ({pendingForm.custom_env_content.length} chars)</div>
                      )}
                    </div>
                  </>
                )}

                {/* Custom Shell Script Upload/Edit */}
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">CUSTOM SHELL SCRIPT (optional, Linux VMs only)</label>
                  <div className="flex gap-2">
                    <input
                      type="file"
                      accept=".sh,text/x-shellscript,text/plain"
                      onChange={handleShellFileChange}
                      className="text-xs text-gray-400"
                    />
                    <button
                      type="button"
                      className="px-2 py-1 rounded bg-gray-700 text-gray-200 text-xs font-medium hover:bg-gray-600 border border-gray-600"
                      onClick={handleEditShellScript}
                    >
                      {pendingForm.custom_shell_script ? 'Edit Script' : 'Add/Edit Script'}
                    </button>
                  </div>
                  {pendingForm.custom_shell_script && (
                    <div className="mt-1 text-xs text-green-400">Shell script loaded ({pendingForm.custom_shell_script.length} chars)</div>
                  )}
                </div>
                      {/* Monaco Editor Modal for Shell Script */}
                      {showShellEditor && (
                        <EditorPane
                          language="shell"
                          value={shellScriptDraft}
                          onChange={setShellScriptDraft}
                          onSave={handleSaveShellScript}
                          onCancel={handleCancelShellEdit}
                          title="Edit Custom Shell Script"
                        />
                      )}
              </div>

              {/* Actions */}
              <div className="px-5 py-3 bg-gray-750 border-t border-gray-700 flex gap-3 justify-end">
                <button
                  onClick={handleCancelReview}
                  disabled={isDeploying}
                  className="px-4 py-1.5 rounded text-xs font-medium bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeployVm}
                  disabled={isDeploying}
                  className="px-4 py-1.5 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-60 flex items-center gap-2"
                >
                  {isDeploying && <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                  {isDeploying ? 'Deploying...' : 'Deploy VM'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* VM Copy Review Form */}
        {pendingCopyForm && (
          <div className="flex justify-start">
            <div className="w-full max-w-lg bg-gray-800 rounded-xl border border-violet-500/40 overflow-hidden shadow-lg">
              <div className="px-5 py-3 bg-gray-750 border-b border-gray-700 flex items-center gap-2">
                <svg className="text-violet-400" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M9 9h6v6H9z" />
                </svg>
                <span className="text-sm font-semibold text-gray-200">Review &amp; edit VM copy details</span>
              </div>

              <div className="p-5 space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">SOURCE VM</label>
                  <input
                    type="text"
                    value={pendingCopyForm.vm_name_or_href}
                    onChange={(e) => updateCopyForm('vm_name_or_href', e.target.value)}
                    className="w-full bg-gray-700 text-gray-100 text-xs rounded px-2.5 py-1.5 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-violet-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">TARGET VAPP</label>
                  <select
                    value={pendingCopyForm.target_vapp_href || ''}
                    onChange={(e) => updateCopyForm('target_vapp_href', e.target.value)}
                    className="w-full bg-gray-700 text-gray-100 text-xs rounded px-2.5 py-1.5 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-violet-500"
                  >
                    <option value="" disabled>
                      {vappsLoading ? 'Loading vApps...' : 'Select a vApp'}
                    </option>
                    {vapps.map((vapp) => (
                      <option key={vapp.href} value={vapp.href}>
                        {vapp.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">NEW VM NAME</label>
                    <input
                      type="text"
                      value={pendingCopyForm.new_vm_name}
                      onChange={(e) => updateCopyForm('new_vm_name', e.target.value)}
                      className="w-full bg-gray-700 text-gray-100 text-xs rounded px-2.5 py-1.5 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-violet-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">POWER ON</label>
                    <select
                      value={pendingCopyForm.power_on ? 'Yes' : 'No'}
                      onChange={(e) => updateCopyForm('power_on', e.target.value === 'Yes')}
                      className="w-full bg-gray-700 text-gray-100 text-xs rounded px-2.5 py-1.5 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-violet-500"
                    >
                      <option>Yes</option>
                      <option>No</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">DESCRIPTION</label>
                  <textarea
                    value={pendingCopyForm.description || ''}
                    onChange={(e) => updateCopyForm('description', e.target.value)}
                    rows={3}
                    className="w-full bg-gray-700 text-gray-100 text-xs rounded px-2.5 py-1.5 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-violet-500"
                  />
                </div>
              </div>

              <div className="px-5 py-3 bg-gray-750 border-t border-gray-700 flex gap-3 justify-end">
                <button
                  onClick={handleCancelCopyReview}
                  disabled={isCopyingVm}
                  className="px-4 py-1.5 rounded text-xs font-medium bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCopyVm}
                  disabled={isCopyingVm}
                  className="px-4 py-1.5 rounded text-xs font-medium bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-60 flex items-center gap-2"
                >
                  {isCopyingVm && <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                  {isCopyingVm ? 'Copying...' : 'Create Copy'}
                </button>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="px-4 py-3 bg-gray-800 border-t border-gray-700">
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Copilot... (Enter to send, Shift+Enter for newline)"
            disabled={isStreaming}
            rows={3}
            className="flex-1 bg-gray-700 text-gray-100 text-sm rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500 border border-gray-600 placeholder-gray-500 disabled:opacity-50"
          />
          <button
            onClick={sendMessage}
            disabled={isStreaming || !input.trim()}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg px-4 py-2 text-sm font-semibold transition-colors h-[4.5rem] flex items-center justify-center"
          >
            {isStreaming ? (
              <span className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
            ) : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatPane;
