import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { lspClient } from './lspClient';
import { tokenManager } from './tokenManager';
import { getModels, streamChatCompletion, ChatMessage } from './copilotChatApi';
import http from 'http';
import https from 'https';
import { checkForUpdates } from './autoUpdater';
import { logApi } from './apiLogger';
import path from 'path';
import fs from 'fs/promises';
import { runWorkflowAgent } from './workflow/agent';
import { getWorkflowOutputDir, setWorkflowOutputDir } from './workflow/storage';
import { extractAndAnalyzeFromPrdXml } from './workflow/prdConverter';
import { generateJson } from './workflow/llm';
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

type FileNode = {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
};

function slugify(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-_]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized.slice(0, 60) || 'workflow';
}

function isWithin(baseDir: string, targetPath: string): boolean {
  const resolvedBase = path.resolve(baseDir) + path.sep;
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget.startsWith(resolvedBase);
}

async function buildTree(dir: string): Promise<FileNode[]> {
  try {
    console.log('[buildTree] Reading directory:', dir);
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) {
      console.error('[buildTree] Path is not a directory:', dir);
      return [];
    }
    
    const entries = await fs.readdir(dir, { withFileTypes: true });
    console.log('[buildTree] Found', entries.length, 'entries in', dir);
    
    const nodes: FileNode[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          path: fullPath,
          isDirectory: true,
          children: await buildTree(fullPath),
        });
      } else {
        nodes.push({
          name: entry.name,
          path: fullPath,
          isDirectory: false,
        });
      }
    }
    const sorted = nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    console.log('[buildTree] Sorted nodes:', sorted.length);
    return sorted;
  } catch (err) {
    console.error('[buildTree] Error building tree for', dir, ':', err);
    return [];
  }
}

export function registerIpcHandlers(mainWindow: BrowserWindow) {
  // Manual update check from renderer
  ipcMain.on('check-for-update', async () => {
    checkForUpdates(mainWindow);
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
  ipcMain.handle('workflow:chooseOutputDir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      console.log('[IPC] Directory selection cancelled');
      return { cancelled: true };
    }

    const outputDir = result.filePaths[0];
    console.log('[IPC] Selected output directory:', outputDir);
    await setWorkflowOutputDir(outputDir);
    console.log('[IPC] Saved output directory to storage');
    return { cancelled: false, path: outputDir };
  });

  ipcMain.handle('workflow:getOutputDir', async () => {
    const outputDir = await getWorkflowOutputDir();
    return { path: outputDir };
  });

  ipcMain.handle('workflow:listTree', async () => {
    try {
      const outputDir = await getWorkflowOutputDir();
      console.log('[IPC] workflow:listTree, outputDir:', outputDir);
      if (!outputDir) {
        console.warn('[IPC] No output folder selected');
        return { success: false, error: 'No output folder selected.' };
      }
      const tree = await buildTree(outputDir);
      console.log('[IPC] Tree built with', tree.length, 'root items');
      return { success: true, root: outputDir, tree };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[IPC] workflow:listTree failed:', errMsg);
      return { success: false, error: errMsg };
    }
  });

  ipcMain.handle('workflow:readFile', async (_event, filePath: string) => {
    const outputDir = await getWorkflowOutputDir();
    if (!outputDir) {
      return { success: false, error: 'No output folder selected.' };
    }
    if (!filePath || !isWithin(outputDir, filePath)) {
      return { success: false, error: 'Invalid file path.' };
    }
    const content = await fs.readFile(filePath, 'utf8');
    return { success: true, content };
  });

  ipcMain.handle('workflow:convertPrd', async (_event, input: { content?: string; filePath?: string }) => {
    try {
      let prdXml = input.content || '';
      if (!prdXml && input.filePath) {
        prdXml = await fs.readFile(input.filePath, 'utf8');
      }
      if (!prdXml) return { success: false, error: 'No content provided' };

      const result = extractAndAnalyzeFromPrdXml(prdXml);

      // If caller supplied a modelId, ask the LLM for a deeper, deterministic Markdown summary
      const modelId = (input as any).modelId as string | undefined;
      if (modelId) {
        try {
          const resultsArray = result && result.results ? result.results : [result];

          // helper to call the streaming chat completion and collect text
          const askLlmForText = (model: string, promptText: string): Promise<string> => {
            return new Promise((resolve, reject) => {
              let out = '';
              try {
                streamChatCompletion(
                  model,
                  [{ role: 'user', content: promptText }],
                  (chunk: string) => { out += chunk; },
                  () => { resolve(out.trim()); },
                  (err: Error) => { reject(err); },
                  `You are an expert workflow analyst. Respond in clear Markdown.`
                );
              } catch (err) {
                reject(err);
              }
            });
          };

          for (let i = 0; i < resultsArray.length; i++) {
            const r = resultsArray[i];
            if (r && r.decodedXml) {
              // Build a compact structured payload to help the LLM produce a thorough summary
              const structured: any = {
                processId: r.processId || null,
                processVersion: r.processVersion || null,
                forms: Array.isArray(r.forms) ? r.forms : [],
                activities: Array.isArray(r.activities) ? r.activities : [],
                links: Array.isArray(r.links) ? r.links : [],
                dataItems: Array.isArray(r.dataItems) ? r.dataItems : [],
              };

              const prompt = `You are an expert workflow analyst. Using the structured JSON below (which is authoritative), produce a deterministic, minute-detail Markdown summary covering:\n- process id and version\n- every activity (id, type, step-by-step behavior, form-id if present, addressee, timeouts, notify templates) in execution order\n- transitions/links between activities (include conditions if present)\n- data-items defined for the process (name and type)\n- forms and their fields (name, data-type, options)\n- any conditional expressions or mappings and what they do\n- any detected provisioning operations and their target entity types\n\nBe exhaustive and explicit; include numbered steps where appropriate and example values when inferable from the data. Do NOT hallucinate beyond the provided JSON. Output clean Markdown suitable for engineers.\n\nStructured JSON:\n\n${JSON.stringify(structured, null, 2)}\n\nIf your first response is brief, expand it to include per-activity minute-level steps, example payloads, and exact field lists.`;

              try {
                let llmSummary = await askLlmForText(modelId, prompt);
                // If LLM returned a very short response, ask it to expand once more with explicit guidance
                if (!llmSummary || llmSummary.trim().length < 300) {
                  try {
                    const expandPrompt = `Your previous answer was too short. Expand the Markdown summary to provide minute-detail for each activity: include explicit sequence steps, what data-items are used at each step, the exact form fields (name and type), any timeout behavior and notification templates, and clear transition conditions. Use bullet lists and numbered steps. Here is the same structured JSON again:\n\n${JSON.stringify(structured, null, 2)}`;
                    const expanded = await askLlmForText(modelId, expandPrompt);
                    if (expanded && expanded.trim().length) llmSummary = expanded;
                  } catch (reErr) {
                    console.warn('[IPC] LLM expand attempt failed:', reErr instanceof Error ? reErr.message : String(reErr));
                  }
                }
                if (llmSummary && llmSummary.trim().length) {
                  r.summary = llmSummary;
                }
              } catch (err) {
                console.warn('[IPC] LLM deep summary failed:', err instanceof Error ? err.message : String(err));
              }
            }
          }
        } catch (e) {
          console.warn('[IPC] LLM deep summary failed:', e instanceof Error ? e.message : String(e));
        }
      }

      // Try to persist artifacts into configured workflow output directory
      const baseOutputDir = await getWorkflowOutputDir();
      const saved: any = { outputDir: null, decoded: [], summaries: [], workflows: [], forms: [] };

      // Derive a friendly folder name: prefer uploaded filename, else process id from result, else fallback
      let folderBase = `converted-prd`;
      try {
        if (input.filePath) {
          folderBase = path.basename(input.filePath, path.extname(input.filePath));
        } else if ((input as any).fileName) {
          folderBase = path.basename(String((input as any).fileName), path.extname(String((input as any).fileName)));
        } else if (result && result.results && Array.isArray(result.results) && result.results[0] && result.results[0].processId) {
          folderBase = String(result.results[0].processId || 'converted-prd');
        } else if (result && (result as any).processId) {
          folderBase = String((result as any).processId || 'converted-prd');
        }
      } catch {
        folderBase = `converted-prd`;
      }
      // sanitize folder name
      folderBase = folderBase.replace(/[^a-zA-Z0-9-_\.]/g, '-').replace(/^-+|-+$/g, '') || 'converted-prd';
      const uniqueFolder = `${folderBase}-${Date.now()}`;

      // Choose output directory: configured output dir preferred, else repo-local fallback
      let outputDir = '';
      if (baseOutputDir) {
        outputDir = path.join(baseOutputDir, uniqueFolder);
      } else {
        const fallbackRoot = path.join(process.cwd(), 'workflow-agent', 'output');
        await fs.mkdir(fallbackRoot, { recursive: true });
        outputDir = path.join(fallbackRoot, uniqueFolder);
      }
      await fs.mkdir(outputDir, { recursive: true });
      saved.outputDir = outputDir;

      // Normalize results into an array and persist artifacts (always save summary/decoded/workflow/forms if present)
      const resultsArray = result && result.results ? result.results : [result];
      for (let i = 0; i < resultsArray.length; i++) {
        const r = resultsArray[i];
        const idx = i;
        if (r.decodedXml) {
          // prefer to keep original filename for the first decoded file when input.filePath or input.fileName is provided
          const decodedName = (input.filePath && idx === 0) ? `${path.basename(input.filePath)}` : (( (input as any).fileName && idx === 0) ? `${path.basename(String((input as any).fileName))}` : `decoded-${idx}.xml`);
          const decPath = path.join(outputDir, decodedName);
          await fs.writeFile(decPath, r.decodedXml, 'utf8');
          saved.decoded.push(decPath);
        }
        if (r.summary) {
          const sumPath = path.join(outputDir, `summary-${idx}.md`);
          await fs.writeFile(sumPath, r.summary, 'utf8');
          saved.summaries.push(sumPath);
        }
        if (r.workflowXml) {
          const wfPath = path.join(outputDir, `workflow-${idx}.xml`);
          await fs.writeFile(wfPath, r.workflowXml, 'utf8');
          saved.workflows.push(wfPath);
        }
        if (r.formsJson) {
          const formsPath = path.join(outputDir, `forms-${idx}.json`);
          await fs.writeFile(formsPath, r.formsJson, 'utf8');
          saved.forms.push(formsPath);
        }
      }

      return { success: true, result, saved };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('workflow:saveFile', async (_event, filePath: string, content: string) => {
    const outputDir = await getWorkflowOutputDir();
    if (!outputDir) {
      return { success: false, error: 'No output folder selected.' };
    }
    if (!filePath || !isWithin(outputDir, filePath)) {
      return { success: false, error: 'Invalid file path.' };
    }
    try {
      await fs.writeFile(filePath, content, 'utf8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('workflow:openOutputDir', async (_event, outputDir: string) => {
    if (!outputDir) {
      return { success: false, error: 'Missing output folder path.' };
    }
    const result = await shell.openPath(outputDir);
    if (result) {
      return { success: false, error: result };
    }
    return { success: true };
  });

  ipcMain.handle('workflow:generate', async (_event, input: { modelId: string; request: string; outputDir?: string }) => {
    try {
      const baseOutputDir = input.outputDir || (await getWorkflowOutputDir());
      if (!baseOutputDir) {
        throw new Error('No output folder selected. Choose an output directory first.');
      }

      const { workflowXml, formsJson, critique, plan, folderName = 'workflow' } = await runWorkflowAgent(input.request, input.modelId);
      
      // Use LLM-suggested folder name with timestamp to ensure uniqueness
      const uniqueFolderName = `${folderName}-${Date.now()}`;
      const outputDir = path.join(baseOutputDir, uniqueFolderName);

      await fs.mkdir(outputDir, { recursive: true });
      const workflowPath = path.join(outputDir, 'workflow.xml');
      const formsPath = path.join(outputDir, 'forms.json');
      await fs.writeFile(workflowPath, workflowXml, 'utf8');
      await fs.writeFile(formsPath, formsJson, 'utf8');

      return {
        success: true,
        outputDir,
        critique,
        plan,
        files: {
          workflowPath,
          formsPath,
        },
        workflowXml,
        formsJson,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
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

  // Legacy VCD and VM handlers removed.

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
}
