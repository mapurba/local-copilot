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
import { listDocuments, getDocument, deleteDocument, getChunks } from './tools/categories/docs/storage';
import { taskTracker } from './taskTracker';
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
  // Initialize LSP on startup
  lspClient.start();
  lspClient.initialize().catch((e) => console.error('[IPC] LSP init error:', e));

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
    custom_env_content?: string;
    setup_idm?: boolean;
    idm_custom_env_content?: string;
  }) => {
    try {
      const ctx = getVcdContext();
      if (!ctx.vdcId) throw new Error('Missing VDC ID in context.');
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
        custom_env_content: form.custom_env_content,
        setup_idm: form.setup_idm,
        idm_custom_env_content: form.idm_custom_env_content,
      });
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
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
      const chunks = getChunks(docId);
      const fullContent = chunks.map((c: { cleanedContent?: string; content: string }) => c.cleanedContent ?? c.content).join('\n\n');
      return { success: true, title: doc.title ?? doc.filename, content: fullContent };
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
}
