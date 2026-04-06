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

// Tracks requestIds that have been cancelled so the convertPrd handler can abort early
const cancelledConvertRequests = new Set<string>();

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
import { toolRegistry, initializeDefaultTools } from './tools';
import { workspaceContext } from './workspaceContext';

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
  // Initialize workspace (non-blocking, errors are non-fatal)
  workspaceContext.initialize().catch((err) => {
    console.warn('[IPC] Workspace init failed (non-fatal):', err);
  });

  // Initialize tools registry
  initializeDefaultTools();

  // Helper: check that `target` is within `base` path (prevents path-traversal)
  function isWithin(base: string, target: string) {
    const rBase = path.resolve(base);
    const rTarget = path.resolve(target);
    const rel = path.relative(rBase, rTarget);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  // Normalize various shapes returned by extractAndAnalyzeFromPrdXml
  function normalizeResults(result: any): any[] {
    if (!result) return [];
    if ((result as any).results && Array.isArray((result as any).results)) return (result as any).results;
    return [result];
  }

  // ============================================================================
  // DEBUG HANDLERS
  // ============================================================================

  // Dev tools logging for debugging
  ipcMain.on('dev:log', (_event, level: string, ...args: any[]) => {
    if (level === 'error') {
      console.error('[Dev]', ...args);
    } else if (level === 'warn') {
      console.warn('[Dev]', ...args);
    } else {
      console.log('[Dev]', ...args);
    }
  });

  // Manual update check from renderer
  ipcMain.on('check-for-update', async () => {
    checkForUpdates(mainWindow);
  });

  // Initialize LSP on startup
  lspClient.start();
  lspClient.initialize().catch((e) => console.error('[IPC] LSP init error:', e));

  // ============================================================================
  // AUTH HANDLERS
  // ============================================================================
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
      (chunk, type) => {
        mainWindow.webContents.send('chat:stream-chunk', chunk, type);
      },
      () => {
        mainWindow.webContents.send('chat:stream-end');
      },
      (err) => {
        mainWindow.webContents.send('chat:stream-error', err.message);
      },
      async (toolName: string, toolArgs: any) => {
        // Handle tool calls from the LLM
        try {
          const args = Array.isArray(toolArgs) ? toolArgs : (toolArgs === undefined ? [] : [toolArgs]);
          const result = await toolRegistry.call(toolName, ...args);
          mainWindow.webContents.send('chat:tool-called', { toolName, args, result });
          return result;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          mainWindow.webContents.send('chat:tool-error', { toolName, error });
          throw new Error(error);
        }
      }
    );
    return { started: true };
  });


  ipcMain.handle('workflow:getOutputDir', async () => {
    const outputDir = await getWorkflowOutputDir();
    return { path: outputDir };
  });

  ipcMain.handle('workflow:chooseOutputDir', async () => {
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: 'Select workflow output folder',
      properties: ['openDirectory', 'createDirectory'],
    });

    if (choice.canceled || !choice.filePaths.length) {
      return { cancelled: true };
    }

    const selectedPath = choice.filePaths[0];
    await setWorkflowOutputDir(selectedPath);
    return { cancelled: false, path: selectedPath };
  });

  ipcMain.handle('workflow:listTree', async () => {
    try {
      const outputDir = await getWorkflowOutputDir();
      console.log('[IPC] workflow:listTree, outputDir:', outputDir);
      if (!outputDir) {
        console.warn('[IPC] No output folder selected');
        return { success: false, error: 'No output folder selected.' };
      }
      // buildTree: recursively build a simple file tree for renderer
      async function buildTree(dirPath: string) {
        const dirents = await fs.readdir(dirPath, { withFileTypes: true });
        const nodes: any[] = [];
        for (const d of dirents) {
          const full = path.join(dirPath, d.name);
          if (d.isDirectory()) {
            nodes.push({ name: d.name, path: full, isDirectory: true, children: await buildTree(full) });
          } else {
            nodes.push({ name: d.name, path: full, isDirectory: false });
          }
        }
        return nodes.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
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
    function isWithin(base: string, target: string) {
      const rBase = path.resolve(base);
      const rTarget = path.resolve(target);
      const rel = path.relative(rBase, rTarget);
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    }

    if (!filePath || !isWithin(outputDir, filePath)) {
      return { success: false, error: 'Invalid file path.' };
    }
    const content = await fs.readFile(filePath, 'utf8');
    return { success: true, content };
  });

  ipcMain.handle('workflow:cancelConvertPrd', (_event, requestId: string) => {
    if (typeof requestId === 'string' && requestId.trim()) {
      cancelledConvertRequests.add(requestId.trim());
    }
    return { ok: true };
  });

  ipcMain.handle('workflow:convertPrd', async (_event, input: { content?: string; filePath?: string; modelId?: string; fileName?: string; requestId?: string }) => {
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim().length > 0
      ? input.requestId.trim()
      : `convert-${Date.now()}`;

    const emitProgress = (
      stage: string,
      message: string,
      percent?: number,
      details?: Record<string, unknown>
    ) => {
      mainWindow.webContents.send('workflow:convertPrd:progress', {
        requestId,
        stage,
        message,
        percent,
        details,
        timestamp: new Date().toISOString(),
      });
    };

    cancelledConvertRequests.delete(requestId);
    const isCancelled = () => cancelledConvertRequests.has(requestId);

    try {
      emitProgress('started', 'Starting PRD conversion', 2);
      if (isCancelled()) { emitProgress('cancelled', 'Cancelled by user', 100); return { success: false, error: 'Cancelled' }; }

      let prdXml = input.content || '';
      if (!prdXml && input.filePath) {
        emitProgress('reading-file', `Reading PRD file: ${path.basename(input.filePath)}`, 8, { filePath: input.filePath });
        prdXml = await fs.readFile(input.filePath, 'utf8');
      }
      if (!prdXml) {
        emitProgress('failed', 'No PRD content provided', 100);
        return { success: false, error: 'No content provided' };
      }

      emitProgress('parsing', 'Extracting and analyzing PRD XML', 18);

      const result = extractAndAnalyzeFromPrdXml(prdXml);
      const initialResults = normalizeResults(result);
      emitProgress('parsed', 'PRD analysis complete', 30, { candidates: initialResults.length });

      // If caller supplied a modelId, ask the LLM for a deeper, deterministic Markdown summary
      const modelId = (input as any).modelId as string | undefined;
      if (modelId && !isCancelled()) {
          emitProgress('llm-summary', 'Generating deep summary with LLM', 38, { modelId });
          try {
            const resultsArray = normalizeResults(result);

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
                    undefined,
                    `You are an expert workflow analyst. Respond in clear Markdown.`
                  );
                } catch (err) {
                  reject(err);
                }
              });
            };

          for (let i = 0; i < resultsArray.length; i++) {
            if (isCancelled()) { emitProgress('cancelled', 'Cancelled by user', 100); cancelledConvertRequests.delete(requestId); return { success: false, error: 'Cancelled' }; }
            const r = resultsArray[i];
            if (r && r.decodedXml) {
              const itemPercent = 42 + Math.min(22, Math.round(((i + 1) / Math.max(resultsArray.length, 1)) * 22));
              emitProgress('llm-summary-item', `Summarizing candidate ${i + 1} of ${resultsArray.length}`, itemPercent, { index: i, total: resultsArray.length });
              // Build a compact structured payload to help the LLM produce a thorough summary
              const structured: any = {
                processId: r.processId || null,
                processVersion: r.processVersion || null,
                forms: Array.isArray(r.forms) ? r.forms : [],
                activities: Array.isArray(r.activities) ? r.activities : [],
                links: Array.isArray(r.links) ? r.links : [],
                dataItems: Array.isArray(r.dataItems) ? r.dataItems : [],
              };

              const prompt = `You are an expert workflow analyst. Using the structured JSON below (which is authoritative), produce a deterministic Markdown summary with two required sections:\n\n1) Technical Summary (for engineers)\n- process id and version\n- every activity (id, type, step-by-step behavior, form-id if present, addressee, timeouts, notify templates) in execution order\n- transitions/links between activities (include conditions if present)\n- data-items defined for the process (name and type)\n- forms and their fields (name, data-type, options)\n- any conditional expressions or mappings and what they do\n- any detected provisioning operations and their target entity types\n\n2) Beginner-Friendly Workflow Explanation (for less experienced readers)\n- what the old PRD is trying to accomplish in plain language\n- who is involved and what each role does\n- a simple step-by-step walkthrough of the request lifecycle\n- what information is collected and why it matters\n- key risks/validation checks explained in non-technical terms\n\nBe exhaustive and explicit; include numbered steps where appropriate and example values when inferable from the data. Do NOT hallucinate beyond the provided JSON. Output clean Markdown.\n\nStructured JSON:\n\n${JSON.stringify(structured, null, 2)}\n\nIf your first response is brief, expand it to include per-activity minute-level steps, example payloads, exact field lists, and an easy-to-understand explanation for beginners.`;

              try {
                let llmSummary = await askLlmForText(modelId, prompt);
                // If LLM returned a very short response, ask it to expand once more with explicit guidance
                if (!llmSummary || llmSummary.trim().length < 300) {
                  try {
                    const expandPrompt = `Your previous answer was too short. Expand the Markdown summary and keep BOTH required sections: Technical Summary and Beginner-Friendly Workflow Explanation. Add minute-detail for each activity: explicit sequence steps, what data-items are used at each step, exact form fields (name and type), timeout behavior, notification templates, and transition conditions. In the beginner section, explain the old PRD intent and flow in plain language for a less experienced engineer. Use bullet lists and numbered steps. Here is the same structured JSON again:\n\n${JSON.stringify(structured, null, 2)}`;
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
          emitProgress('llm-summary-complete', 'LLM summary generation complete', 64);
        } catch (e) {
          console.warn('[IPC] LLM deep summary failed:', e instanceof Error ? e.message : String(e));
        }
      }

      // Try to persist artifacts into configured workflow output directory
      if (isCancelled()) { emitProgress('cancelled', 'Cancelled by user', 100); cancelledConvertRequests.delete(requestId); return { success: false, error: 'Cancelled' }; }
      emitProgress('saving', 'Preparing output folder and artifacts', 72);
      const baseOutputDir = await getWorkflowOutputDir();
      const saved: any = { outputDir: null, decoded: [], summaries: [], workflows: [], forms: [], todos: [] };

      // Derive a friendly folder name: prefer uploaded filename, else process id from result, else fallback
      let folderBase = `converted-prd`;
      try {
        if (input.filePath) {
          folderBase = path.basename(input.filePath, path.extname(input.filePath));
        } else if ((input as any).fileName) {
          folderBase = path.basename(String((input as any).fileName), path.extname(String((input as any).fileName)));
        } else {
          const maybeResultsForFolder = normalizeResults(result);
          if (maybeResultsForFolder && maybeResultsForFolder[0] && maybeResultsForFolder[0].processId) {
            folderBase = String(maybeResultsForFolder[0].processId || 'converted-prd');
          } else if (result && (result as any).processId) {
            folderBase = String((result as any).processId || 'converted-prd');
          }
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
      emitProgress('output-ready', `Saving artifacts into ${outputDir}`, 78, { outputDir });

      // Normalize results into an array and persist artifacts (always save summary/decoded/workflow/forms if present)
      const resultsArray = normalizeResults(result);
      for (let i = 0; i < resultsArray.length; i++) {
        const r = resultsArray[i];
        const idx = i;
        const savePercent = 80 + Math.min(16, Math.round(((idx + 1) / Math.max(resultsArray.length, 1)) * 16));
        emitProgress('saving-item', `Saving artifacts for candidate ${idx + 1} of ${resultsArray.length}`, savePercent, { index: idx, total: resultsArray.length });
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
        if (Array.isArray(r.prdTodoList) && r.prdTodoList.length) {
          const todoLines = ['# PRD Todo List', ''];
          r.prdTodoList.forEach((t: any) => {
            const mark = t && t.status === 'completed' ? 'x' : ' ';
            const title = t && t.title ? String(t.title) : 'Task';
            const details = t && t.details ? String(t.details) : '';
            todoLines.push(`- [${mark}] ${title}${details ? `: ${details}` : ''}`);
          });
          const todoPath = path.join(outputDir, `todo-${idx}.md`);
          await fs.writeFile(todoPath, todoLines.join('\n'), 'utf8');
          saved.todos.push(todoPath);
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

          // Store each form schema separately for easier editing/import.
          try {
            const parsedForms = JSON.parse(r.formsJson);
            const formsArray = Array.isArray(parsedForms) ? parsedForms : [parsedForms];
            const formsDir = path.join(outputDir, `forms-${idx}`);
            await fs.mkdir(formsDir, { recursive: true });

            for (let formIdx = 0; formIdx < formsArray.length; formIdx++) {
              const formItem = formsArray[formIdx];
              const schema = formItem && typeof formItem === 'object' && (formItem as any).form
                ? (formItem as any).form
                : formItem;
              if (!schema || typeof schema !== 'object') continue;

              const rawFormId = String((schema as any).id || `form-${idx}-${formIdx}`);
              const safeFormId = rawFormId.replace(/[^a-zA-Z0-9-_\.]/g, '-');
              const singleFormPath = path.join(formsDir, `${safeFormId}.json`);
              await fs.writeFile(singleFormPath, JSON.stringify(schema, null, 2), 'utf8');
              saved.forms.push(singleFormPath);
            }
          } catch (formsErr) {
            console.warn('[IPC] Failed to split forms JSON:', formsErr instanceof Error ? formsErr.message : String(formsErr));
          }
        }
      }

      emitProgress('completed', 'PRD conversion completed successfully', 100, {
        outputDir,
        decodedCount: saved.decoded.length,
        summaryCount: saved.summaries.length,
        workflowCount: saved.workflows.length,
        formsCount: saved.forms.length,
      });

      return { success: true, result, saved };
    } catch (err) {
      emitProgress('failed', err instanceof Error ? err.message : String(err), 100);
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

      const { workflowXml, formsJson, mermaidMd, critique, plan, folderName = 'workflow' } = await runWorkflowAgent(input.request, input.modelId);
      
      // Use LLM-suggested folder name with timestamp to ensure uniqueness
      const uniqueFolderName = `${folderName}-${Date.now()}`;
      const outputDir = path.join(baseOutputDir, uniqueFolderName);

      await fs.mkdir(outputDir, { recursive: true });
      const workflowPath = path.join(outputDir, 'workflow.xml');
      const formsPath = path.join(outputDir, 'forms.json');
      const mermaidPath = path.join(outputDir, 'flow-diagram.md');
      await fs.writeFile(workflowPath, workflowXml, 'utf8');
      await fs.writeFile(formsPath, formsJson, 'utf8');
      if (mermaidMd) await fs.writeFile(mermaidPath, mermaidMd, 'utf8');

      return {
        success: true,
        outputDir,
        critique,
        plan,
        files: {
          workflowPath,
          formsPath,
          mermaidPath,
        },
        workflowXml,
        formsJson,
        mermaidMd,
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

  // ============================================================================
  // TOOLS HANDLER (Generic dispatcher for all registered tools)
  // ============================================================================
  ipcMain.handle('tools:call', async (_event, toolName: string, ...args: any[]) => {
    return toolRegistry.call(toolName, ...args);
  });

  ipcMain.handle('tools:list', async (_event) => {
    return toolRegistry.list();
  });

  // ============================================================================
  // WORKSPACE HANDLERS
  // ============================================================================
  ipcMain.handle('workspace:getPath', async () => {
    return workspaceContext.getWorkspacePath();
  });

  ipcMain.handle('workspace:setPath', async (_event, newPath: string) => {
    try {
      await workspaceContext.setWorkspacePath(newPath);
      return { success: true, path: workspaceContext.getWorkspacePath() };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ============================================================================
  // EXTENSION POINT FOR CUSTOM HANDLERS
  // ============================================================================
  // To add a new tool category, create a module in src/main/tools/, then:
  // 1. Import it in src/main/tools/registry.ts
  // 2. Register tools in initializeDefaultTools()
  // 3. Expose them in src/preload/preload.ts
  // See docs/CUSTOM_TOOLS_GUIDE.md for full walkthrough.
}
