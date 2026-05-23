import { BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { lspClient } from './lspClient';
import { tokenManager } from './tokenManager';
import { getModels, streamChatCompletion, chatWithTools, cancelChatWithTools, ChatMessage, getToolManifest } from './copilotChatApi';
import http from 'http';
import https from 'https';
import { vcdSignIn, vcdStatus, vcdSignOut } from './vcdAuth';
import {
  createVmFromTemplate,
  powerOnVm,
  powerOffVm,
  deleteVm,
  getVmDetails,
  getTemplateXml,
  updateTemplateXml,
  listTemplates,
  allocateFreeIp,
  createSnapshot,
  revertSnapshot,
  createVmCopy,
  listAllSnapshots,
  listVApps,
} from './vcdApi';
import { getVcdContext } from './vcdStore';
import { deleteTerminalSession, listSavedTerminalSessions, saveTerminalSession } from './terminalSessionsStore';
import { checkForUpdates } from './autoUpdater';
import { listVms } from './vcdApi';
import { logApi } from './apiLogger';
import { approvalSystem } from './tools';
import { listDocuments, getDocument, deleteDocument } from './tools/categories/docs/storage';
import { readDocContent } from './tools/categories/docs/fileStore';
import { taskTracker } from './taskTracker';
import {
  saveDeploymentDraft,
  loadDeploymentDraft,
  listDeploymentDrafts,
  deleteDeploymentDraft,
} from './deploymentPlanDraftStore';
import {
  createConversation,
  listConversations,
  getConversation,
  appendMessage,
  clearConversation,
  deleteConversation,
} from './chatHistory';
// DISABLED: SSH2/SFTP functionality disabled to prevent antivirus quarantine
// import {
//   connectTerminalFileSession,
//   deleteRemotePath,
//   disconnectTerminalFileSession,
//   getTerminalDirectory,
//   listDirectory,
//   makeRemoteDirectory,
//   readRemoteFile,
//   renameRemotePath,
//   setTerminalDirectory,
//   writeRemoteFile,
// } from './sftpManager';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export function registerIpcHandlers(mainWindow: BrowserWindow) {
      // Manual update check from renderer
      ipcMain.on('check-for-update', async () => {
        checkForUpdates(mainWindow);
      });
    // VCD: List VMs (direct, not via LLM)
    ipcMain.handle('vcd:listVms', async () => {
      try {
        const result = await listVms(200);
        return result;
      } catch (err) {
        return { vms: [], error: err instanceof Error ? err.message : String(err) };
      }
    });
    // VCD: List vApps (direct, not via LLM)
    ipcMain.handle('vcd:listVapps', async () => {
      try {
        const result = await listVApps(200);
        return result;
      } catch (err) {
        return { vapps: [], error: err instanceof Error ? err.message : String(err) };
      }
    });
  // Initialize LSP on startup (non-fatal) - don't let LSP failures prevent IPC handlers
  try {
    lspClient.start();
    lspClient.initialize().catch((e) => console.error('[IPC] LSP init error:', e));
  } catch (e) {
    console.error('[IPC] LSP start failed (non-fatal):', e);
  }

  // Auth: Check status
  ipcMain.handle('copilot:status', async () => {
    try {
      await withTimeout(lspClient.initialize(), 10000, 'lspInitialize');
      const result = await lspClient.checkStatus();
      return result;
    } catch (err) {
      console.error('[IPC] status failed:', err);
      return { status: 'NotAuthorized' };
    }
  });

  // Auth: Start sign-in flow
  ipcMain.handle('copilot:signIn', async () => {
    try {
      await withTimeout(lspClient.initialize(), 10000, 'lspInitialize');
      const result = await withTimeout(lspClient.signInInitiate(), 15000, 'signInInitiate');
      return result;
    } catch (_e) {
      console.error('[IPC] signInInitiate failed:', _e);
      throw new Error('Failed to initiate sign-in');
    }
  });

  // Auth: Confirm sign-in (user entered code in browser)
  ipcMain.handle('copilot:signInConfirm', async () => {
    try {
      await withTimeout(lspClient.initialize(), 10000, 'lspInitialize');
      const result = await withTimeout(lspClient.signInConfirm(), 30000, 'signInConfirm');
      console.log('[IPC] signInConfirm result:', JSON.stringify(result));
      
      // After successful sign-in, refresh token with extended wait
      if (result.status === 'OK' || result.status === 'AlreadySignedIn') {
        // Wait longer for LSP to process and send token notifications
        console.log('[IPC] Waiting for token notifications...');
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // Try to refresh token via checkStatus
        try {
          const refreshResult = await tokenManager.refreshToken();
          console.log('[IPC] Token refresh result:', refreshResult ? 'Success' : 'Failed');
        } catch (e) {
          console.warn('[IPC] Token refresh after sign-in failed:', e);
        }
      }
      
      return result;
    } catch (_e) {
      console.error('[IPC] signInConfirm failed:', _e);
      throw new Error('Failed to confirm sign-in');
    }
  });

  // Auth: Sign out
  ipcMain.handle('copilot:signOut', async () => {
    try {
      await lspClient.signOut();
      tokenManager.clear();
      return { success: true };
    } catch {
      return { success: false };
    }
  });

  // Chat: Get available models
  ipcMain.handle('copilot:getModels', async () => {
    return getModels();
  });

  ipcMain.handle('terminal:sessions:list', async () => {
    try {
      return { success: true, sessions: listSavedTerminalSessions() };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), sessions: [] };
    }
  });

  ipcMain.handle('terminal:sessions:save', async (_event, input: { id?: string; label: string; command: string; host?: string; username?: string; port?: number; password?: string; vmName?: string; ip?: string; source?: 'vm' | 'manual' }) => {
    try {
      const session = saveTerminalSession({
        id: input.id,
        label: input.label,
        command: input.command,
        host: input.host,
        username: input.username,
        port: input.port,
        password: input.password,
        vmName: input.vmName,
        ip: input.ip,
        source: input.source,
        lastUsedAt: Date.now(),
      });
      return { success: true, session };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('terminal:sessions:delete', async (_event, input: { id: string }) => {
    try {
      return deleteTerminalSession(input.id);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Chat: Send message and stream response
  ipcMain.handle('copilot:sendChatMessage', async (_event, modelId: string, messages: ChatMessage[]) => {
    streamChatCompletion(
      modelId,
      messages,
      (chunk) => {
        mainWindow.webContents.send('chat:stream-chunk', chunk);
      },
      () => {
        mainWindow.webContents.send('chat:stream-end');
      },
      (err) => {
        mainWindow.webContents.send('chat:stream-error', err.message);
      }
    );
    return { started: true };
  });

  // Chat: Send message with tool calling support
  ipcMain.handle('copilot:sendChatMessageWithTools', async (_event, modelId: string, messages: ChatMessage[], disabledToolNames?: string[]) => {
    try {
      console.log('[IPC] sendChatMessageWithTools called');
      await chatWithTools(
        modelId,
        messages,
        (chunk, type) => {
          mainWindow.webContents.send('chat:stream-chunk', chunk, type);
        },
        () => {
          mainWindow.webContents.send('chat:stream-end');
        },
        (err) => {
          mainWindow.webContents.send('chat:stream-error', err.message);
        },
        (form) => {
          console.log('[IPC] onVmDraft callback triggered, emitting chat:vm-draft event');
          console.log('[IPC] Form data:', JSON.stringify(form, null, 2));
          mainWindow.webContents.send('chat:vm-draft', form);
        },
        (form) => {
          console.log('[IPC] onVmCopyDraft callback triggered, emitting chat:vm-copy-draft event');
          console.log('[IPC] Copy form data:', JSON.stringify(form, null, 2));
          mainWindow.webContents.send('chat:vm-copy-draft', form);
        },
        (plan) => {
          console.log('[IPC] onDeploymentPlanReady callback triggered, emitting deployment:planReady event');
          mainWindow.webContents.send('deployment:planReady', plan);
        },
        disabledToolNames
      );
      return { started: true };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      mainWindow.webContents.send('chat:stream-error', errorMsg);
      return { started: false, error: errorMsg };
    }
  });

  // Tools: list all available tools for the Configure Tools panel
  ipcMain.handle('tools:list', async () => {
    return getToolManifest();
  });

  // Chat: Cancel an in-progress request
  ipcMain.handle('copilot:cancelChat', () => {
    cancelChatWithTools();
    return { cancelled: true };
  });

  // Deployment draft file lifecycle
  ipcMain.handle('deploymentDraft:save', async (_event, plan: Record<string, unknown>) => {
    try {
      const result = saveDeploymentDraft(plan as { id: string; [key: string]: unknown });
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('deploymentDraft:load', async (_event, id: string) => {
    try {
      const plan = loadDeploymentDraft(id);
      if (!plan) return { success: false, error: `Draft not found: ${id}` };
      return { success: true, plan };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('deploymentDraft:list', async () => {
    try {
      const drafts = listDeploymentDrafts();
      return { success: true, drafts };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), drafts: [] };
    }
  });

  ipcMain.handle('deploymentDraft:delete', async (_event, id: string) => {
    try {
      const deleted = deleteDeploymentDraft(id);
      return { success: deleted };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Chat history handlers
  ipcMain.handle('chat:createConversation', async (_event, name?: string) => {
    try {
      const conv = await createConversation(name);
      return { success: true, conversation: conv };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('chat:listConversations', async () => {
    try {
      const list = await listConversations();
      return { success: true, conversations: list };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('chat:getConversation', async (_event, id: string) => {
    try {
      const conv = await getConversation(id);
      if (!conv) return { success: false, error: 'Not found' };
      return { success: true, conversation: conv };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('chat:appendMessage', async (_event, id: string, message: any) => {
    try {
      const conv = await appendMessage(id, message);
      return { success: true, conversation: conv };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('chat:clearConversation', async (_event, id: string) => {
    try {
      const conv = await clearConversation(id);
      if (!conv) return { success: false, error: 'Not found' };
      return { success: true, conversation: conv };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('chat:deleteConversation', async (_event, id: string) => {
    try {
      const ok = await deleteConversation(id);
      return { success: ok };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Deploy VM directly from the reviewed form (no LLM involved)
  ipcMain.handle('vcd:deployVm', async (_event, form: {
    vm_name: string;
    template_id: string;
    template_name?: string;
    network_name?: string;
    ip_address?: string;
    ip_allocation_mode?: string;
    gateway?: string;
    dns_servers?: string;
    power_on?: boolean;
    storage_profile_id?: string;
    compute_policy_id?: string;
    setup_ilm?: boolean;
    ilm_version?: string;
    custom_script?: string;
    custom_env_content?: string;
    setup_idm?: boolean;
    idm_custom_env_content?: string;
  }) => {
    try {
      const ctx = getVcdContext();
      if (!ctx.vdcId) throw new Error('Missing VDC ID in context.');
      // If caller requested MANUAL IP allocation but did not provide an IP, try to allocate one.
      try {
        if (form.ip_allocation_mode && String(form.ip_allocation_mode).toUpperCase() === 'MANUAL' && !(form.ip_address && String(form.ip_address).trim())) {
          const ipRes = await allocateFreeIp();
          if (ipRes && ipRes.success && ipRes.ip) {
            form.ip_address = ipRes.ip;
          } else {
            return { success: false, error: `IP allocation failed: ${ipRes?.error || 'unknown'}` };
          }
        }
      } catch (e) {
        return { success: false, error: `IP allocation failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      const dnsList = form.dns_servers
        ? form.dns_servers.split(',').map((s: string) => s.trim()).filter(Boolean)
        : ctx.dnsServers || ['15.122.222.53'];
      const result = await createVmFromTemplate({
        vdc_id: ctx.vdcId,
        template_vm_id: form.template_id,
        vm_name: form.vm_name,
        template_name: form.template_name || '',
        org_name: ctx.orgName,
        org_uuid: ctx.orgUuid,
        network_name: form.network_name || ctx.networkName || '',
        ip_address: form.ip_address || '',
        gateway: form.gateway || ctx.gateway || '',
        dns_servers: dnsList,
        power_on: form.power_on ?? true,
        ip_allocation_mode: form.ip_allocation_mode || 'DHCP',
        network_adapter_type: 'VMXNET3',
        storage_profile_id: form.storage_profile_id || ctx.storageProfileId || '',
        compute_policy_id: form.compute_policy_id || ctx.computePolicyId || '',
        setup_ilm: form.setup_ilm,
        ilm_version: form.ilm_version,
        custom_script: form.custom_script,
        custom_env_content: form.custom_env_content,
        setup_idm: form.setup_idm,
        idm_custom_env_content: form.idm_custom_env_content,
      });
      return { success: true, result };
    } catch (err) {
      // Build a richer error string including status/body snippets when available
      const baseMsg = err instanceof Error ? err.message : String(err);
      const e = err as any;
      let errMsg = baseMsg;
      if (e?.status) errMsg += ` | status: ${e.status}`;
      if (e?.body) {
        try {
          const bodySnippet = typeof e.body === 'string' ? e.body.slice(0, 2000) : JSON.stringify(e.body).slice(0, 2000);
          errMsg += ` | body: ${bodySnippet}`;
        } catch (ex) {
          // ignore body serialization errors
        }
      }
      return { success: false, error: errMsg };
    }
  });

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    await shell.openExternal(url);
  });

  ipcMain.handle('vcd:signIn', async (_event, input) => {
    return vcdSignIn(input);
  });

  ipcMain.handle('vcd:status', async () => {
    return vcdStatus();
  });

  // Return a sanitized vCD context (no tokens)
  ipcMain.handle('vcd:getContext', async () => {
    try {
      const ctx = getVcdContext();
      return {
        success: true,
        context: {
          host: ctx.host,
          apiVersion: ctx.apiVersion,
          orgName: ctx.orgName,
          orgUuid: ctx.orgUuid,
          username: ctx.username,
          vdcId: ctx.vdcId,
          networkName: ctx.networkName,
          gateway: ctx.gateway,
          dnsServers: ctx.dnsServers,
          storageProfileId: ctx.storageProfileId,
          computePolicyId: ctx.computePolicyId,
          rejectUnauthorized: ctx.rejectUnauthorized,
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('vcd:signOut', async () => {
    return vcdSignOut();
  });

  ipcMain.handle('proxy:http', async (_event, options: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => {
    const { url, method = 'GET', headers = {}, body } = options || {};
    if (!url) {
      throw new Error('proxy:http requires a url');
    }

    const client = url.startsWith('https:') ? https : http;

    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      logApi({
        source: 'ipc.proxy:http',
        stage: 'request',
        method,
        url,
        headers,
        requestBody: body,
      });

      const req = client.request(url, { method, headers }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          logApi({
            source: 'ipc.proxy:http',
            stage: 'response',
            method,
            url,
            status: res.statusCode || 0,
            durationMs: Date.now() - startedAt,
            headers: res.headers as Record<string, unknown>,
            responseBody: data,
          });
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: data,
          });
        });
      });

      req.on('error', (err) => {
        logApi({
          source: 'ipc.proxy:http',
          stage: 'error',
          method,
          url,
          durationMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        });
        reject(err);
      });
      if (body) req.write(body);
      req.end();
    });
  });

  // VCD: Power on VM (direct API)
  ipcMain.handle('vcd:powerOnVm', async (_event, vmHref: string) => {
    try {
      const result = await powerOnVm(vmHref);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // VCD: Power off VM (direct API)
  ipcMain.handle('vcd:powerOffVm', async (_event, vmHref: string) => {
    try {
      const result = await powerOffVm(vmHref);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // VCD: Delete VM (stop first, then delete)
  ipcMain.handle('vcd:deleteVm', async (_event, input: { href: string; powered_on?: boolean }) => {
    try {
      const vmHref = input?.href;
      if (!vmHref) throw new Error('Missing VM href for delete');

      if (input.powered_on) {
        await powerOffVm(vmHref);
      }

      // Wait until VM is powered off before delete (best effort)
      try {
        const vmId = vmHref.includes('/vm-') ? vmHref.split('/vm-')[1] : '';
        if (vmId) {
          for (let i = 0; i < 20; i += 1) {
            const details = await getVmDetails(vmId);
            if (details.status === 8 || details.status === '8') break;
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
      } catch {
        // Ignore status polling errors; delete may still succeed
      }

      const result = await deleteVm(vmHref);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // VCD: Allocate free IP from registrar
  ipcMain.handle('vcd:allocateFreeIp', async () => {
    try {
      const result = await allocateFreeIp();
      return result;
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // VCD: List templates (optional name filter)
  console.log('[IPC] Registering handler: vcd:listTemplates');
  ipcMain.handle('vcd:listTemplates', async (_event, nameFilter?: string) => {
    try {
      const result = await listTemplates(nameFilter ?? '');
      return { success: true, ...result };
    } catch (err) {
      return { success: false, templates: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  // VCD: Get raw template XML by template UUID
  ipcMain.handle('vcd:getTemplate', async (_event, templateId: string) => {
    try {
      if (!templateId) throw new Error('templateId required');
      const xml = await getTemplateXml(templateId);
      return { success: true, xml };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // VCD: Update template XML body (may be restricted by server permissions)
  ipcMain.handle('vcd:updateTemplate', async (_event, input: { templateId: string; xml: string }) => {
    try {
      if (!input || !input.templateId) throw new Error('templateId required');
      const result = await updateTemplateXml(input.templateId, input.xml || '');
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // VCD: Create snapshot
  ipcMain.handle('vcd:createSnapshot', async (_event, input: { vmNameOrHref: string; name?: string; description?: string; memory?: boolean; quiesce?: boolean }) => {
    try {
      const snapshotName = input.name ?? input.description;
      const result = await createSnapshot(
        input.vmNameOrHref,
        snapshotName,
        input.memory ?? false,
        input.quiesce ?? false
      );
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // VCD: Revert to latest/current snapshot
  ipcMain.handle('vcd:revertSnapshot', async (_event, input: { vmNameOrHref: string }) => {
    try {
      const result = await revertSnapshot(input.vmNameOrHref);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // VCD: Create copy/clone of a VM (via vApp recompose)
  ipcMain.handle('vcd:createVmCopy', async (_event, input: { vmNameOrHref: string; newVmName: string; targetVappHref: string; powerOn?: boolean; description?: string }) => {
    try {
      const result = await createVmCopy(
        input.vmNameOrHref,
        input.newVmName,
        input.targetVappHref,
        input.powerOn ?? false,
        input.description
      );
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // VCD: List snapshots across tenant
  ipcMain.handle('vcd:listSnapshots', async () => {
    try {
      const result = await listAllSnapshots(200);
      return { success: true, ...result };
    } catch (err) {
      return { success: false, snapshots: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  // DISABLED: SSH2/SFTP file handlers disabled to prevent antivirus quarantine
  // ipcMain.handle('file:connect', async (_event, options: { terminalId: string; command: string; password?: string }) => {
  //   return connectTerminalFileSession(options.terminalId, options.command, { password: options.password });
  // });

  // ipcMain.handle('file:disconnect', async (_event, options: { terminalId: string }) => {
  //   return disconnectTerminalFileSession(options.terminalId);
  // });

  // ipcMain.handle('file:getDirectory', async (_event, options: { terminalId: string }) => {
  //   try {
  //     return getTerminalDirectory(options.terminalId);
  //   } catch (err) {
  //     return { success: false, error: err instanceof Error ? err.message : String(err) };
  //   }
  // });

  // ipcMain.handle('file:setDirectory', async (_event, options: { terminalId: string; directory: string }) => {
  //   try {
  //     return setTerminalDirectory(options.terminalId, options.directory);
  //   } catch (err) {
  //     return { success: false, error: err instanceof Error ? err.message : String(err) };
  //   }
  // });

  // ipcMain.handle('file:list', async (_event, options: { terminalId: string; path?: string }) => {
  //   try {
  //     return await listDirectory(options.terminalId, options.path);
  //   } catch (err) {
  //     return { success: false, error: err instanceof Error ? err.message : String(err), entries: [] };
  //   }
  // });

  // ipcMain.handle('file:read', async (_event, options: { terminalId: string; path: string }) => {
  //   try {
  //     return await readRemoteFile(options.terminalId, options.path);
  //   } catch (err) {
  //     return { success: false, error: err instanceof Error ? err.message : String(err) };
  //   }
  // });

  // ipcMain.handle('file:write', async (_event, options: { terminalId: string; path: string; content: string }) => {
  //   try {
  //     return await writeRemoteFile(options.terminalId, options.path, options.content);
  //   } catch (err) {
  //     return { success: false, error: err instanceof Error ? err.message : String(err) };
  //   }
  // });

  // ipcMain.handle('file:delete', async (_event, options: { terminalId: string; path: string }) => {
  //   try {
  //     return await deleteRemotePath(options.terminalId, options.path);
  //   } catch (err) {
  //     return { success: false, error: err instanceof Error ? err.message : String(err) };
  //   }
  // });

  // ipcMain.handle('file:rename', async (_event, options: { terminalId: string; oldPath: string; newPath: string }) => {
  //   try {
  //     return await renameRemotePath(options.terminalId, options.oldPath, options.newPath);
  //   } catch (err) {
  //     return { success: false, error: err instanceof Error ? err.message : String(err) };
  //   }
  // });

  // ipcMain.handle('file:mkdir', async (_event, options: { terminalId: string; path: string }) => {
  //   try {
  //     return await makeRemoteDirectory(options.terminalId, options.path);
  //   } catch (err) {
  //     return { success: false, error: err instanceof Error ? err.message : String(err) };
  //   }
  // });

  // ── Tool Approval Handlers ────────────────────────────────────────────────

  // Handle approval response from renderer
  ipcMain.handle('tool:approval-response', async (_event, response: {
    requestId: string;
    approved: boolean;
    approvalType?: 'once' | 'session' | 'always';
    denialReason?: string;
  }) => {
    try {
      approvalSystem.handleApprovalResponse(response);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Get approval system status
  ipcMain.handle('tool:approval-status', async () => {
    return {
      pendingCount: approvalSystem.pendingCount,
    };
  });

  // ── Document Management Handlers ──────────────────────────────────────────

  // Open native file picker and trigger document upload
  ipcMain.handle('docs:openAndUpload', async () => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) return { success: false, error: 'No window available' };

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Upload Document',
      filters: [
        { name: 'Documents', extensions: ['pdf', 'docx', 'doc', 'md', 'markdown', 'txt', 'log', 'json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    // Trigger processing via tool registry for each file
    const { toolRegistry } = await import('./tools');
    const uploads = await Promise.all(
      result.filePaths.map(filePath =>
        toolRegistry.execute({ toolName: 'docs:upload', args: { filePath } })
      )
    );

    return { success: true, uploads: uploads.map(u => u.result) };
  });

  // List uploaded documents
  ipcMain.handle('docs:list', async () => {
    try {
      return { success: true, documents: listDocuments(50) };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Get single document status
  ipcMain.handle('docs:get', async (_event, docId: string) => {
    try {
      const doc = getDocument(docId);
      return { success: !!doc, document: doc };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Get full document content (for attaching to chat)
  ipcMain.handle('docs:getContent', async (_event, docId: string) => {
    try {
      const doc = getDocument(docId);
      if (!doc) return { success: false, error: `Document not found: ${docId}` };
      const content = readDocContent(docId) ?? '';
      return { success: true, docId, title: doc.title ?? doc.filename, summary: doc.summary, content };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Delete a document
  ipcMain.handle('docs:delete', async (_event, docId: string) => {
    try {
      deleteDocument(docId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Task Tracker Handlers ─────────────────────────────────────────────────

  // List recent tasks
  ipcMain.handle('task:list', async () => {
    try {
      return { success: true, tasks: taskTracker.listTasks(30) };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Get a single task by ID
  ipcMain.handle('task:get', async (_event, taskId: string) => {
    try {
      const task = taskTracker.getTask(taskId);
      return { success: !!task, task };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Cancel a running task
  ipcMain.handle('task:cancel', async (_event, taskId: string) => {
    try {
      const cancelled = taskTracker.cancelTask(taskId);
      return { success: cancelled, error: cancelled ? undefined : 'Task not found or not running' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Deployment Intelligence Handlers ──────────────────────────────────────

  ipcMain.handle('deployment:analyze', async (_event, docId: string, options?: { strategy?: string }) => {
    try {
      const { extractFromDocument } = await import('./deployment/deploymentExtractor');
      const result = await extractFromDocument(docId, options as { strategy?: 'auto' | 'single-pass' | 'chunked' });
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('deployment:generate', async (_event, intel: unknown, modeName: string) => {
    try {
      const { buildDeploymentDesign } = await import('./deployment/vmPlacementEngine');
      const { saveDesign } = await import('./deployment/deploymentStore');
      const design = buildDeploymentDesign(intel as import('./deployment/types').DeploymentIntelligence, modeName);
      const id = saveDesign(design);
      return { success: true, designId: id, mermaid: design.mermaid, runbook: design.runbook };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('deployment:list', async () => {
    try {
      const { listDesigns } = await import('./deployment/deploymentStore');
      return { success: true, designs: listDesigns() };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('deployment:get', async (_event, designId: string) => {
    try {
      const { getDesign } = await import('./deployment/deploymentStore');
      return { success: true, design: getDesign(designId) };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('deployment:update', async (_event, designId: string, designJson: string) => {
    try {
      const { getDesign, updateDesign } = await import('./deployment/deploymentStore');
      const { buildDependencyGraph } = await import('./deployment/dependencyAnalyzer');
      const { generateTopologyDiagram } = await import('./deployment/mermaidGenerator');
      const { generateFullRunbook } = await import('./deployment/runbookGenerator');
      const partial = JSON.parse(designJson) as Partial<import('./deployment/types').DeploymentDesign>;
      const existing = getDesign(designId);
      const merged = { ...existing, ...partial };
      if (partial.vms || partial.intelligence) {
        const allServices = merged.vms.flatMap((v) => v.services);
        merged.dependencyGraph = buildDependencyGraph(allServices);
        merged.mermaid = generateTopologyDiagram(merged);
        merged.runbook = generateFullRunbook(merged);
      }
      updateDesign(designId, merged);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('deployment:assignIps', async (_event, designId: string) => {
    try {
      const { getDesign, updateDesign } = await import('./deployment/deploymentStore');
      const { allocateIpsForDesign } = await import('./deployment/ipPoolManager');
      const { generateTopologyDiagram } = await import('./deployment/mermaidGenerator');
      const { generateFullRunbook } = await import('./deployment/runbookGenerator');
      const design = getDesign(designId);
      const ipAssignments = await allocateIpsForDesign(design);
      for (const vm of design.vms) {
        const ip = ipAssignments[vm.services[0]?.id];
        if (ip) vm.ip = ip;
      }
      design.ipAssignments = ipAssignments;
      design.mermaid = generateTopologyDiagram(design);
      design.runbook = generateFullRunbook(design);
      updateDesign(designId, design);
      return { success: true, ipAssignments };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('deployment:start', async (_event, designId: string, params: unknown) => {
    try {
      const { start } = await import('./deployment/deploymentOrchestrator');
      const runId = await start(designId, params as import('./deployment/deploymentOrchestrator').DeploymentParams);
      return { success: true, runId };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('deployment:runStatus', async (_event, runId: string) => {
    try {
      const { getRun } = await import('./deployment/deploymentStore');
      return { success: true, run: getRun(runId) };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('deployment:cancel', async (_event, runId: string) => {
    try {
      const { cancel } = await import('./deployment/deploymentOrchestrator');
      await cancel(runId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('deployment:validateEndpoints', async (_event, designId: string) => {
    try {
      const { getDesign, getRunsForDesign } = await import('./deployment/deploymentStore');
      const { validateAllServices } = await import('./deployment/healthValidationEngine');
      const design = getDesign(designId);
      const runs = getRunsForDesign(designId);
      const latestRun = runs[0];
      if (!latestRun) return { success: false, error: 'No deployment run found for this design.' };
      const allResults: import('./deployment/types').ValidationResult[] = [];
      for (const vm of design.vms) {
        const sessionId = latestRun.vmSessions[vm.id];
        if (!sessionId) continue;
        const results = await validateAllServices(sessionId, vm, design);
        allResults.push(...results);
      }
      return { success: true, results: allResults };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
