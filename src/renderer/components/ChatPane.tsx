import React, { useState, useRef, useEffect, useCallback } from 'react';
import ConfirmDialog from './ConfirmDialog';
import ModelSelector from './ModelSelector';
import ResponseRenderer from './ResponseRenderer';
import ConfigureToolsPanel from './ConfigureToolsPanel';
import DeploymentCheckpointCard from './DeploymentCheckpointCard';
import type { CheckpointPayload } from './DeploymentCheckpointCard';
import { Button, IconButton } from '@ux-aspects-universal/react/button';
import { TextArea } from '@ux-aspects-universal/react/text-input';

interface ChatPaneProps {
  checkpointPayload?: CheckpointPayload | null;
  checkpointLoading?: boolean;
  onCheckpointSubmit?: (threadId: string, answers: Record<string, unknown>) => void;
  onCheckpointCancel?: (threadId: string) => void;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  type?: 'text' | 'tool-call' | 'tool-result';
  attachments?: Array<{ name: string }>;
}

interface DocPickerItem {
  id: string;
  filename: string;
  title?: string;
  status: string;
}

interface AttachedDoc {
  id: string;
  title: string;
  content: string;
  summary?: string;      // LLM-generated summary — used for compact mode
  alreadySent?: boolean; // true after the first full send; switches to compact mode
  forceFullContent?: boolean; // user override: send full content even on follow-ups
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
  setup_idm?: boolean;
  idm_custom_env_content?: string;
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

function buildWelcomeMessage(vmName: string): string {
  return [
    'Welcome. I can help you manage VMs using natural language.',
    '',
    '**What you can ask me:**',
    '- List VMs, vApps, templates, and recent tasks',
    '- Start, stop, delete, snapshot, and revert VM snapshots',
    '- Create or clone VMs with a review form before execution',
    '- Set up ILM and upload a custom .env during VM creation',
    '- Set up IDM and upload a custom .env during VM creation',
    '- Resize VM CPU and memory',
    '- Check VM status and troubleshoot failed actions',
    '- **Analyze product docs and generate a full deployment design with topology diagram**',
    '- **Assign real IPs from the VCD pool to a deployment design**',
    '- **Orchestrate a full automated multi-VM deployment end-to-end**',
    '',
    '**Try prompts like:**',
    '- "Show all running VMs"',
    `- "Create a snapshot for ${vmName}-app"`,
    `- "Clone ${vmName}-db to app-vapp"`,
    `- "Resize ${vmName}-web to 4 CPU and 8192 MB RAM"`,
    '- "Show tasks from the last 30 minutes"',
    `- "Create a new SLES 15SP6 VM with name ${vmName}test and setup ILM 1.3.0"`,
    `- "Create a VM with name ${vmName}test, setup ILM and I will upload a custom .env"`,
    `- "Create a new SLES 15SP6 VM with name ${vmName}test and setup IDM"`,
    `- "Create a VM with name ${vmName}test, setup IDM and I will upload a custom .env"`,
    `- "Create a new SLES 15 SP6 VM with name ${vmName}test"`,
    '',
    '**Deployment Intelligence (new):**',
    '- "I uploaded the IDM install guide — generate a distributed deployment design"',
    '- "Analyze [doc name] and create a deployment plan for single-node mode"',
    '- "Show me the Mermaid topology for the design"',
    '- "Assign IPs from the VCD pool to design [designId]"',
    '- "Show me the IP requirements for this deployment" *(triggers real IP allocation)*',
    '- "Show me all existing deployment designs"',
    '- "Deploy design [designId] — org: MyOrg, template: sles15sp6-base, user: root"',
    '- "What is the status of deployment run [runId]?"',
  ].join('\n');
}

const ChatPane: React.FC<ChatPaneProps> = ({
  checkpointPayload,
  checkpointLoading = false,
  onCheckpointSubmit,
  onCheckpointCancel,
}) => {
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
    { role: 'assistant', content: buildWelcomeMessage('myvm') },
  ]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const conversationIdRef = useRef<string | null>(conversationId);
  useEffect(() => { conversationIdRef.current = conversationId; }, [conversationId]);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState('gpt-4');
  const [isStreaming, setIsStreaming] = useState(false);
  const [useTools, setUseTools] = useState(true);
  const [disabledTools, setDisabledTools] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('copilot:disabledTools');
      return saved ? new Set(JSON.parse(saved) as string[]) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });
  const [showToolsConfig, setShowToolsConfig] = useState(false);
  const [attachedDocs, setAttachedDocs] = useState<AttachedDoc[]>([]);
  const [showDocPicker, setShowDocPicker] = useState(false);
  const [pickerDocs, setPickerDocs] = useState<DocPickerItem[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pendingForm, setPendingForm] = useState<VmDraftForm | null>(null);
  const [pendingCopyForm, setPendingCopyForm] = useState<VmCopyDraftForm | null>(null);
  const [vapps, setVapps] = useState<VApp[]>([]);
  const [vappsLoading, setVappsLoading] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const [isCopyingVm, setIsCopyingVm] = useState(false);
  const [fetchingIp, setFetchingIp] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void)[]>([]);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Personalise the welcome message with the logged-in Copilot username
  useEffect(() => {
    window.copilot.status().then((s) => {
      if (s.user) {
        const vmName = s.user.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
        setMessages((prev) => [
          { ...prev[0], content: buildWelcomeMessage(vmName || 'myvm') },
          ...prev.slice(1),
        ]);
      }
    }).catch(() => { /* keep default */ });

    // Load or create a conversation for chat persistence
    (async () => {
      setConversationLoading(true);
      try {
        const listRes = await window.copilot.chatHistoryList();
        if (listRes && listRes.success && Array.isArray(listRes.conversations) && listRes.conversations.length > 0) {
          const conv = listRes.conversations[0];
          setConversationId(conv.id);
          const getRes = await window.copilot.chatHistoryGet(conv.id);
          if (getRes && getRes.success && getRes.conversation && Array.isArray(getRes.conversation.messages)) {
            // Convert stored messages shape to local Message type if needed
            const stored = getRes.conversation.messages as any[];
            const mapped: Message[] = stored.map((m) => ({ role: m.role, content: m.content, type: m.type }));
            setMessages(mapped.length ? mapped : [{ role: 'assistant', content: buildWelcomeMessage('myvm') }]);
          }
          setConversationLoading(false);
          return;
        }

        // No existing conversation — create one
        const newRes = await window.copilot.chatHistoryNew('Local Copilot');
        if (newRes && newRes.success && newRes.conversation) {
          const conv = newRes.conversation;
          setConversationId(conv.id);
          // Persist initial assistant welcome message
          const welcome = buildWelcomeMessage('myvm');
          await window.copilot.chatHistoryAppend(conv.id, { role: 'assistant', content: welcome, ts: new Date().toISOString() });
          setMessages([{ role: 'assistant', content: welcome }]);
        }
      } catch (e) {
        console.error('[ChatPane] Failed to initialize conversation:', e);
      } finally {
        setConversationLoading(false);
      }
    })();
  }, []);

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
        if (last && last.streaming) {
          const finalized = { ...last, streaming: false };
          const newArr = [...prev.slice(0, -1), finalized];
          // Persist final assistant message using the latest conversationId from ref
          try {
            const convId = conversationIdRef.current;
            if (convId) {
              void window.copilot.chatHistoryAppend(convId, { role: 'assistant', content: finalized.content, ts: new Date().toISOString() });
            }
          } catch (err) {
            // ignore persistence errors
          }
          return newArr;
        }
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
        setup_idm: form.setup_idm !== undefined ? Boolean(form.setup_idm) : false,
        idm_custom_env_content: form.idm_custom_env_content ? String(form.idm_custom_env_content) : undefined,
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

    const unsubWatch = window.copilot.onWatchNotification((_event: unknown, data: { message: string }) => {
      setIsStreaming(false);
      setMessages((prev) => [...prev, { role: 'assistant', content: data.message }]);
    });

    cleanupRef.current = [unsubChunk, unsubEnd, unsubError, unsubDraft, unsubCopyDraft, unsubWatch];
    return () => cleanupRef.current.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pendingForm, pendingCopyForm]);

  useEffect(() => {
    if (!showDocPicker) return;
    const handleClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowDocPicker(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showDocPicker]);

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

    const docsToSend = attachedDocs;
    const userMsg: Message = {
      role: 'user',
      content: trimmed,
      ...(docsToSend.length > 0 && { attachments: docsToSend.map((d) => ({ name: d.title })) }),
    };
    setMessages((prev) => [...prev, userMsg]);
    // Persist user message
    try {
      if (conversationId) {
        await window.copilot.chatHistoryAppend(conversationId, { role: 'user', content: trimmed, ts: new Date().toISOString() });
      }
    } catch (err) {
      // ignore persistence errors
    }
    setInput('');
    // NOTE: attachedDocs intentionally NOT cleared here — docs remain attached
    // for the entire conversation so follow-up questions can still reference them.
    // The user can manually remove a doc via the X button on the attachment chip.
    setIsStreaming(true);

    let apiContent = trimmed;
    if (docsToSend.length > 0) {
      const contextBlocks = docsToSend
        .map((d) => {
          const useCompact = d.alreadySent && !d.forceFullContent;
          if (useCompact) {
            // Compact mode: send a short stub so the LLM knows the doc is still active
            // without re-transmitting the full content (which was already sent earlier).
            const compactBody = d.summary
              ? `[COMPACT SUMMARY — full content was sent in an earlier message]\n${d.summary}`
              : `[COMPACT — full content was sent in an earlier message. docId: ${d.id}]`;
            return `[Document: "${d.title}" | docId: ${d.id} | mode: compact]\n${compactBody}`;
          }
          return `[Document: "${d.title}" | docId: ${d.id}]\n${d.content}`;
        })
        .join('\n\n---\n\n');
      apiContent = `${contextBlocks}\n\n---\n\n${trimmed}`;
    }

    // Mark all attached docs as alreadySent so subsequent messages use compact mode
    if (docsToSend.length > 0) {
      setAttachedDocs((prev) =>
        prev.map((d) =>
          docsToSend.some((ds) => ds.id === d.id) ? { ...d, alreadySent: true } : d
        )
      );
    }

    const apiUserMsg = { role: 'user' as const, content: apiContent };
    const historyForApi = [...messages, apiUserMsg]
      .filter((m) => !m.streaming)
      .map((m) => ({ role: m.role, content: m.content }));

    if (useTools) {
      const disabled = disabledTools.size > 0 ? [...disabledTools] : undefined;
      await window.copilot.sendChatMessageWithTools(selectedModel, historyForApi, disabled);
    } else {
      await window.copilot.sendChatMessage(selectedModel, historyForApi);
    }
  }, [input, isStreaming, messages, selectedModel, useTools, disabledTools, attachedDocs]);

  // Start a new conversation (clear UI and create new persisted conversation)
  const startNewConversation = async () => {
    try {
      const res = await window.copilot.chatHistoryNew('Local Copilot');
      if (!res || !res.success || !res.conversation) {
        alert('Failed to create new conversation');
        return;
      }
      setConversationId(res.conversation.id);
      const welcome = buildWelcomeMessage('myvm');
      await window.copilot.chatHistoryAppend(res.conversation.id, { role: 'assistant', content: welcome, ts: new Date().toISOString() });
      setMessages([{ role: 'assistant', content: welcome }]);
    } catch (err) {
      console.error('[ChatPane] startNewConversation error', err);
    }
  };

  const clearCurrentConversation = async () => {
    if (!conversationId) return;
    try {
      const res = await window.copilot.chatHistoryClear(conversationId);
      if (res && res.success) {
        const welcome = buildWelcomeMessage('myvm');
        await window.copilot.chatHistoryAppend(conversationId, { role: 'assistant', content: welcome, ts: new Date().toISOString() });
        setMessages([{ role: 'assistant', content: welcome }]);
      }
    } catch (err) {
      console.error('[ChatPane] Failed to clear conversation', err);
    }
  };

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

  const handleIdmEnvFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !pendingForm) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result;
      const content = typeof result === 'string' ? result : '';
      updateForm('idm_custom_env_content', content);
    };
    reader.readAsText(file);
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
    const f = pendingForm;

    // Build an explicit payload to ensure required keys are present
    const payload: Record<string, unknown> = {
      vm_name: f.vm_name || '',
      template_id: f.template_id || '',
      template_name: f.template_name || '',
      network_name: f.network_name || '',
      ip_address: f.ip_address || '',
      ip_allocation_mode: (f.ip_allocation_mode || (f.ip_address ? 'MANUAL' : 'DHCP')) as string,
      gateway: f.gateway || '',
      dns_servers: f.dns_servers || '',
      power_on: f.power_on ?? true,
      storage_profile_id: f.storage_profile_id || '',
      compute_policy_id: f.compute_policy_id || '',
      setup_ilm: f.setup_ilm ?? false,
      ilm_version: f.ilm_version || 'latest',
      custom_script: f.custom_script || undefined,
      custom_env_content: f.custom_env_content || undefined,
      setup_idm: f.setup_idm ?? false,
      idm_custom_env_content: f.idm_custom_env_content || undefined,
    };

    try {
      // Basic validation
      if (!String(payload.vm_name).trim() || !String(payload.template_id).trim()) {
        setMessages((prev) => [...prev, { role: 'assistant', content: 'Error: VM name and template ID are required.' }]);
        setIsDeploying(false);
        return;
      }

      // If storage/compute or network defaults are missing, try to fetch vCD context and pre-fill
      try {
        // @ts-ignore
        if (typeof window.copilot.getVcdContext === 'function') {
          // @ts-ignore
          const ctxRes = await window.copilot.getVcdContext();
          if (ctxRes && ctxRes.success && ctxRes.context) {
            const c = ctxRes.context as Record<string, any>;
            if (!payload.storage_profile_id && c.storageProfileId) {
              payload.storage_profile_id = c.storageProfileId;
              updateForm('storage_profile_id', c.storageProfileId);
            }
            if (!payload.compute_policy_id && c.computePolicyId) {
              payload.compute_policy_id = c.computePolicyId;
              updateForm('compute_policy_id', c.computePolicyId);
            }
            if (!payload.network_name && c.networkName) {
              payload.network_name = c.networkName;
              updateForm('network_name', c.networkName);
            }
            if ((!payload.gateway || !String(payload.gateway).trim()) && c.gateway) {
              payload.gateway = c.gateway;
              updateForm('gateway', c.gateway);
            }
            if ((!payload.dns_servers || !String(payload.dns_servers).trim()) && c.dnsServers) {
              const dnsVal = Array.isArray(c.dnsServers) ? c.dnsServers.join(',') : String(c.dnsServers);
              payload.dns_servers = dnsVal;
              updateForm('dns_servers', dnsVal);
            }
          }
        }
      } catch (e) {
        // ignore and rely on backend defaults
      }

      // If MANUAL requested but no IP present, allocate one now
      if (String(payload.ip_allocation_mode).toUpperCase() === 'MANUAL' && !String(payload.ip_address).trim()) {
        setMessages((prev) => [...prev, { role: 'assistant', content: 'No IP provided — allocating a free IP...' }]);
        try {
          const ipRes = await window.copilot.allocateFreeIp();
          if (!ipRes.success || !ipRes.ip) {
            setMessages((prev) => [...prev, { role: 'assistant', content: `Error: IP allocation failed: ${ipRes.error || 'unknown'}` }]);
            setIsDeploying(false);
            return;
          }
          payload.ip_address = ipRes.ip;
          // reflect allocation in UI draft fields
          updateForm('ip_address', ipRes.ip);
          updateForm('ip_allocation_mode', 'MANUAL');
          setMessages((prev) => [...prev, { role: 'assistant', content: `Allocated IP ${ipRes.ip}` }]);
        } catch (e: any) {
          setMessages((prev) => [...prev, { role: 'assistant', content: `Error: IP allocation failed: ${e?.message || String(e)}` }]);
          setIsDeploying(false);
          return;
        }
      }

      setMessages((prev) => [...prev, { role: 'assistant', content: `Submitting create VM request for ${payload.vm_name} (template ${payload.template_id})...` }]);

      const result = await window.copilot.deployVm(payload);
      setPendingForm(null);

      if (result.success) {
        const envUpdate = (result.result as { env_update?: { changesSummary?: string; rationale?: string; usedFallback?: boolean } } | undefined)?.env_update;
        const successMessages: Message[] = [
          { role: 'assistant', content: `OK: VM **${payload.vm_name}** creation started successfully!` },
          { role: 'assistant', content: `VM IP : **${payload.ip_address || ''}** allocated.` },
          { role: 'assistant', content: `User Name : Root , Password : Password1!` },
        ];
        if ((payload.setup_ilm as boolean) && payload.ip_address) {
          const ipAddr = String(payload.ip_address);
          const ilmUrl = `http://${ipAddr}:9888/ilm/#/`;
          const pwNote = payload.custom_env_content ? '_(password depends on your uploaded .env file)_' : '**novell** _(default — change if needed)_';
          successMessages.push({
            role: 'assistant',
            content: `**ILM is being set up on your VM.**\n\nOnce ready, access it at:\n[${ilmUrl}](${ilmUrl})\n\n**Tenant:** thor  |  **Password:** ${pwNote}`,
          });
        }
        setMessages((prev) => [...prev, ...successMessages]);
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

  const handleOpenDocPicker = async () => {
    if (showDocPicker) {
      setShowDocPicker(false);
      return;
    }
    setShowDocPicker(true);
    setPickerLoading(true);
    try {
      const result = await window.copilot.docsList();
      const readyDocs = (result.documents ?? []).filter((d) => d.status === 'ready');
      setPickerDocs(readyDocs);
    } catch {
      setPickerDocs([]);
    } finally {
      setPickerLoading(false);
    }
  };

  const handleAttachDoc = useCallback(async (docId: string, title: string) => {
    setShowDocPicker(false);
    try {
      const result = await window.copilot.docsGetContent(docId);
      if (result.success && result.content) {
        setAttachedDocs((prev) => {
          if (prev.some((d) => d.id === docId)) return prev;
          // Use docId from result if available (IPC now returns it explicitly)
          return [...prev, {
            id: result.docId ?? docId,
            title: result.title ?? title,
            content: result.content!,
            summary: result.summary,
          }];
        });
      }
    } catch (err) {
      console.error('[ChatPane] Failed to attach doc:', err);
    }
  }, []);

  // Listen for attach-doc-to-chat events dispatched from DocUploadPanel
  useEffect(() => {
    const handleEvent = (e: Event) => {
      const { docId, title } = (e as CustomEvent<{ docId: string; title: string }>).detail;
      handleAttachDoc(docId, title);
    };
    window.addEventListener('attach-doc-to-chat', handleEvent);
    return () => window.removeEventListener('attach-doc-to-chat', handleEvent);
  }, [handleAttachDoc]);

  const removeAttachedDoc = (docId: string) => {
    setAttachedDocs((prev) => prev.filter((d) => d.id !== docId));
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
      <div className="flex items-center justify-between px-4 py-2.5 bg-gray-800 border-b border-gray-700/60">
        <span className="text-sm font-semibold text-gray-200">Copilot Chat</span>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={startNewConversation} disabled={conversationLoading}>New Chat</Button>
          <Button size="sm" onClick={clearCurrentConversation} disabled={!conversationId}>Clear Chat</Button>
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
                <div>
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1.5">
                      {msg.attachments.map((a, i) => (
                        <span key={i} className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-blue-900/40 border border-blue-700/50 text-blue-300 text-xs rounded-full">
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                          </svg>
                          {a.name}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                </div>
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
                {/* VM Name + Template ID */}
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
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">TEMPLATE ID</label>
                    <input
                      type="text"
                      value={pendingForm.template_id}
                      onChange={(e) => updateForm('template_id', e.target.value)}
                      className="w-full bg-gray-700 text-gray-100 text-xs rounded px-2.5 py-1.5 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
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
                      <Button secondary size="small" isDisabled={fetchingIp} onClick={handleFetchFreeIp}>
                        {fetchingIp ? '...' : 'Fetch Free IP'}
                      </Button>
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

                {/* Setup IDM */}
                {pendingForm.setup_idm && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="flex items-center gap-2 text-xs font-medium text-gray-400 cursor-pointer">
                          <input type="checkbox" checked={pendingForm.setup_idm} onChange={(e) => updateForm('setup_idm', e.target.checked)} className="w-3.5 h-3.5" />
                          SETUP IDM
                        </label>
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-400 mb-1">CUSTOM .ENV FILE for IDM (optional)</label>
                      <input
                        type="file"
                        accept=".env,text/plain"
                        onChange={handleIdmEnvFileChange}
                        className="w-full text-xs text-gray-400"
                      />
                      {pendingForm.idm_custom_env_content && (
                        <div className="mt-1 text-xs text-green-400">IDM .env file loaded ({pendingForm.idm_custom_env_content.length} chars)</div>
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* Actions */}
              <div className="px-5 py-3 bg-gray-750 border-t border-gray-700 flex gap-3 justify-end">
                <Button secondary isDisabled={isDeploying} onClick={handleCancelReview}>
                  Cancel
                </Button>
                <Button primary isDisabled={isDeploying} onClick={handleDeployVm}
                  iconBefore={isDeploying ? <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> : undefined}
                >
                  {isDeploying ? 'Deploying...' : 'Deploy VM'}
                </Button>
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
                <Button secondary isDisabled={isCopyingVm} onClick={handleCancelCopyReview}>
                  Cancel
                </Button>
                <Button primary isDisabled={isCopyingVm} onClick={handleCopyVm}
                  iconBefore={isCopyingVm ? <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> : undefined}
                >
                  {isCopyingVm ? 'Copying...' : 'Create Copy'}
                </Button>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />

        {/* HITL Deployment Graph checkpoint card — shown inline after messages */}
        {checkpointPayload && (
          <DeploymentCheckpointCard
            payload={checkpointPayload}
            isLoading={checkpointLoading}
            onSubmit={(threadId, answers) => onCheckpointSubmit?.(threadId, answers)}
            onCancel={(threadId) => onCheckpointCancel?.(threadId)}
          />
        )}
      </div>

      {/* ── Input Area ─────────────────────────────────────────────────── */}
      <div className="px-3 pb-3 pt-2">
        {/* Attached doc chips */}
        {attachedDocs.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1 pb-2">
            {attachedDocs.map((doc) => (
              <span key={doc.id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-900/50 border border-blue-700/60 text-blue-300 text-xs rounded-full max-w-[260px]">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
                <span className="truncate">{doc.title}</span>
                {doc.alreadySent && (
                  <button
                    onClick={() =>
                      setAttachedDocs((prev) =>
                        prev.map((d) =>
                          d.id === doc.id ? { ...d, forceFullContent: !d.forceFullContent } : d
                        )
                      )
                    }
                    title={doc.forceFullContent ? 'Sending full content — click to use compact mode' : 'Sending compact summary — click to resend full content'}
                    className={`flex-shrink-0 text-[9px] font-semibold leading-none px-1 rounded ml-0.5 ${doc.forceFullContent ? 'bg-amber-600/60 text-amber-200 hover:bg-amber-500/70' : 'bg-blue-700/60 text-blue-300 hover:bg-blue-600/70'}`}
                  >
                    {doc.forceFullContent ? 'FULL' : 'CMP'}
                  </button>
                )}
                <button onClick={() => removeAttachedDoc(doc.id)} className="flex-shrink-0 hover:text-white ml-0.5" title="Remove attachment">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Textarea */}
        <TextArea
          value={input}
          onValueChange={setInput}
          onKeyDown={handleKeyDown}
          placeholder="Ask Copilot…"
          rows={3}
          style={{ width: '100%', resize: 'none' }}
        />

        {/* Toolbar row */}
        <div className="flex items-center gap-1.5 px-1 pt-2 relative">
          {/* Doc picker dropdown */}
          {showDocPicker && (
            <div ref={pickerRef} className="absolute bottom-full left-0 mb-1 w-64 bg-gray-800 border border-gray-700 rounded-lg shadow-xl overflow-hidden z-20">
              <div className="px-3 py-2 border-b border-gray-700">
                <span className="text-xs font-semibold text-gray-400">Attach Document</span>
              </div>
              {pickerLoading ? (
                <div className="px-3 py-3 text-xs text-gray-500 text-center">Loading…</div>
              ) : pickerDocs.length === 0 ? (
                <div className="px-3 py-3 text-xs text-gray-500 text-center">
                  No ready documents.<br /><span className="opacity-60">Upload docs in the Documents tab.</span>
                </div>
              ) : (
                <ul className="max-h-48 overflow-y-auto">
                  {pickerDocs.map((doc) => {
                    const isAttached = attachedDocs.some((d) => d.id === doc.id);
                    return (
                      <li key={doc.id}>
                        <button
                          disabled={isAttached}
                          onClick={() => handleAttachDoc(doc.id, doc.title ?? doc.filename)}
                          className="w-full text-left px-3 py-2.5 text-xs text-gray-300 hover:bg-gray-700 flex items-center gap-2 disabled:opacity-40 disabled:cursor-default"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="flex-shrink-0">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                          </svg>
                          <span className="truncate flex-1">{doc.title ?? doc.filename}</span>
                          {isAttached && <span className="text-green-400 flex-shrink-0">✓</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {/* Model picker pill */}
          <ModelSelector selectedModel={selectedModel} onModelChange={setSelectedModel} />

          {/* Attach document button */}
          <Button
            flat={!showDocPicker && attachedDocs.length === 0}
            primary={showDocPicker || attachedDocs.length > 0}
            size="small"
            isDisabled={isStreaming}
            onClick={handleOpenDocPicker}
            title="Attach document to chat"
            iconBefore={
              <svg style={{ width: 12, height: 12 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            }
          >
            {attachedDocs.length > 0 ? `Doc (${attachedDocs.length})` : 'Attach Doc'}
          </Button>

          {/* Tools toggle pill */}
          <Button
            flat={!useTools}
            primary={useTools}
            size="small"
            isDisabled={isStreaming}
            onClick={() => setUseTools((t) => !t)}
            title={useTools ? 'Tools enabled — click to disable' : 'Tools disabled — click to enable'}
            iconBefore={
              <svg style={{ width: 12, height: 12 }} viewBox="0 0 16 16" fill="currentColor">
                <path d="M9.5 1.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5L6 5l2.5-1z"/>
                <path d="M3 8l.7 1.8L5.5 10l-1.8.7L3 12.5l-.7-1.8L.5 10l1.8-.7z"/>
              </svg>
            }
          >
            {useTools
              ? disabledTools.size > 0
                ? `Tools (${disabledTools.size} off)`
                : 'Tools on'
              : 'Tools off'}
          </Button>

          {/* Configure tools button */}
          <IconButton
            flat
            size="small"
            isDisabled={isStreaming}
            onClick={() => setShowToolsConfig(true)}
            aria-label="Configure tools"
            title="Configure tools"
            icon={
              <svg style={{ width: 13, height: 13 }} viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 10.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zm0-1a1.5 1.5 0 110-3 1.5 1.5 0 010 3z"/>
                <path d="M13.96 8.49l-.82-.38a5.53 5.53 0 000-1.22l.82-.38a1 1 0 00.45-1.34l-.78-1.34a1 1 0 00-1.35-.37l-.82.38a5.47 5.47 0 00-1.06-.61V2.77a1 1 0 00-1-1H8.6a1 1 0 00-1 1v.46a5.47 5.47 0 00-1.06.61l-.82-.38a1 1 0 00-1.35.37L3.59 5.17a1 1 0 00.45 1.34l.82.38a5.53 5.53 0 000 1.22l-.82.38a1 1 0 00-.45 1.34l.78 1.34a1 1 0 001.35.37l.82-.38c.33.22.68.41 1.06.61v.46a1 1 0 001 1h1.56a1 1 0 001-1v-.46c.38-.2.73-.39 1.06-.61l.82.38a1 1 0 001.35-.37l.78-1.34a1 1 0 00-.45-1.34zM8 10.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"/>
              </svg>
            }
          />

          {/* Spacer */}
          <div className="flex-1" />

          {/* Hint text */}
          {!isStreaming && (
            <span className="text-xs hidden sm:block select-none" style={{ opacity: 0.45 }}>
              Enter ↵ send&nbsp;&nbsp;Shift+Enter newline
            </span>
          )}

          {/* Send / Stop button */}
          {isStreaming ? (
            <IconButton
              icon={<svg style={{ width: 12, height: 12 }} viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1" /></svg>}
              flat
              onClick={() => window.copilot.cancelChat()}
              aria-label="Stop response"
              title="Stop response"
            />
          ) : (
            <IconButton
              icon={<svg style={{ width: 14, height: 14 }} viewBox="0 0 16 16" fill="currentColor"><path d="M8 2l6 6H9v6H7V8H2z" transform="rotate(-90 8 8)" /></svg>}
              primary={!!input.trim()}
              flat={!input.trim()}
              isDisabled={!input.trim()}
              onClick={sendMessage}
              aria-label="Send message"
            />
          )}
        </div>
      </div>

      {/* Configure Tools panel */}
      <ConfigureToolsPanel
        open={showToolsConfig}
        disabledTools={disabledTools}
        onClose={() => setShowToolsConfig(false)}
        onSave={(newDisabled) => {
          setDisabledTools(newDisabled);
          try {
            localStorage.setItem('copilot:disabledTools', JSON.stringify([...newDisabled]));
          } catch {
            // ignore
          }
          setShowToolsConfig(false);
        }}
      />
    </div>
  );
};

export default ChatPane;
