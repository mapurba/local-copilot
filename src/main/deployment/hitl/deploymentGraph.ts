/**
 * HITL Deployment State Machine (LangGraph.js)
 *
 * Implements a 5-node StateGraph that guides the user through the full
 * deployment planning lifecycle with structured pauses for human input.
 *
 * Flow:
 *   START
 *    → classifyIntent          (runs freely)
 *    → generateArchitecture    [INTERRUPT — Checkpoint 1: OS / template?]
 *    → allocateNetwork         [INTERRUPT — Checkpoint 2: Architecture approval?]
 *    → generateScripts         [INTERRUPT — Checkpoint 3: IPs / hostname?]
 *    → finalizeAndVisualize    [INTERRUPT — Checkpoint 4: Credential env vars?]
 *    → END                     [INTERRUPT — Checkpoint 5: Final "Approve"?]
 *
 * Uses dynamic require() for @langchain/langgraph — same pattern as
 * copilotChatApi.ts to avoid TypeScript resolving heavy generic types.
 *
 * The graph is compiled once (module-level singleton) with the FileCheckpointer
 * so that pause/resume persists across Electron restarts.
 */

// @ts-nocheck — Dynamic requires; same approach as copilotChatApi.ts.

import { BrowserWindow } from 'electron';
import { DeploymentGraphState, CheckpointPhase, DeploymentCheckpointPayload } from '../types';
import { extractFromDocument } from '../deploymentExtractor';
import { buildDeploymentDesign } from '../vmPlacementEngine';
import { allocateIpsForDesign } from '../ipPoolManager';
import { getDesign, saveDesign, updateDesign } from '../deploymentStore';
import { generateFullRunbook } from '../runbookGenerator';
import { buildDeploymentPlanPayload } from './graphHelpers';
import { fileCheckpointer } from './fileCheckpointer';

// Dynamic requires — keeps TypeScript from resolving @langchain/langgraph generics.
const { StateGraph, Annotation, START, END, interrupt } = require('@langchain/langgraph');

// ── State annotation ──────────────────────────────────────────────────────────

const GraphState = Annotation.Root({
  userPrompt: Annotation(),
  docId: Annotation(),
  rawContent: Annotation(),
  chatContext: Annotation(),
  osPreference: Annotation(),
  vmTemplate: Annotation(),
  modeName: Annotation(),
  architectureApproved: Annotation(),
  draftDesignId: Annotation(),
  networkDetails: Annotation(),
  credentialVarNames: Annotation(),
  credentialVarsAcknowledged: Annotation(),
  finalApproved: Annotation(),
  phase: Annotation(),
  designId: Annotation(),
  warnings: Annotation({
    default: () => [],
    reducer: (existing: string[], incoming: string[]) => [...existing, ...incoming],
  }),
  checkpointQuestion: Annotation(),
  checkpointPayload: Annotation(),
});

// ── IPC push helper ───────────────────────────────────────────────────────────

function push(channel: string, payload: unknown): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

// ── Node helpers ──────────────────────────────────────────────────────────────

/**
 * Extract OS hint from user text without an LLM call.
 * Returns the first recognised OS string or undefined.
 */
function extractOsHint(text: string): string | undefined {
  const patterns: Array<[RegExp, string]> = [
    [/sles\s*15(?:\s*sp\s*(\d+))?/i, (m: RegExpMatchArray) => `SLES 15${m[1] ? ` SP${m[1]}` : ''}`],
    [/suse\s*linux.*15(?:\s*sp\s*(\d+))?/i, (m: RegExpMatchArray) => `SLES 15${m[1] ? ` SP${m[1]}` : ''}`],
    [/rhel\s*(\d+(?:\.\d+)?)/i, (m: RegExpMatchArray) => `RHEL ${m[1]}`],
    [/red\s*hat.*(\d+(?:\.\d+)?)/i, (m: RegExpMatchArray) => `RHEL ${m[1]}`],
    [/centos\s*(\d+(?:\.\d+)?)/i, (m: RegExpMatchArray) => `CentOS ${m[1]}`],
    [/ubuntu\s*(\d{2}\.\d{2})/i, (m: RegExpMatchArray) => `Ubuntu ${m[1]}`],
  ] as const;

  const combined = text || '';
  for (const [pattern, builder] of patterns) {
    const match = combined.match(pattern);
    if (match) return (builder as (m: RegExpMatchArray) => string)(match);
  }
  return undefined;
}

/**
 * Extract a UUID-like template ID from user text.
 */
function extractTemplateId(text: string): string | undefined {
  const m = text?.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  return m?.[0];
}

/**
 * Get the supported OS list from a design's intelligence, formatted for display.
 */
function getSupportedOsList(state: DeploymentGraphState): string[] {
  if (!state.draftDesignId) return [];
  try {
    const design = getDesign(state.draftDesignId);
    const osList = new Set<string>();
    for (const product of design.intelligence.products ?? []) {
      for (const os of product.supportedOS ?? []) {
        osList.add([os.type, os.minVersion].filter(Boolean).join(' '));
      }
    }
    return Array.from(osList);
  } catch {
    return [];
  }
}

/**
 * Collect the names of credential/name config keys from all services in a design.
 */
function collectCredentialVarNames(designId: string): string[] {
  try {
    const design = getDesign(designId);
    const vars = new Set<string>();
    for (const vm of design.vms) {
      for (const svc of vm.services) {
        for (const ck of svc.configKeys) {
          if (ck.valueType === 'credential' || ck.valueType === 'name') {
            vars.add(ck.key);
          } else if (!ck.valueType) {
            // Legacy heuristic
            const u = ck.key.toUpperCase();
            if (/(PASSWORD|SECRET|TOKEN|CREDENTIAL|CERT|KEY|DB_NAME|DATABASE|USERNAME|USER|TENANT)/
              .test(u)) {
              vars.add(ck.key);
            }
          }
        }
      }
    }
    return Array.from(vars);
  } catch {
    return [];
  }
}

// ── Node 1: classifyIntent ────────────────────────────────────────────────────

async function classifyIntentNode(
  state: DeploymentGraphState
): Promise<Partial<DeploymentGraphState>> {
  console.log('[DeploymentGraph] classifyIntent: scanning user prompt for OS / template hints');

  const combined = [state.userPrompt ?? '', state.chatContext ?? ''].join('\n');
  const osHint = extractOsHint(combined);
  const templateHint = extractTemplateId(combined);

  return {
    phase: 'classifyIntent',
    osPreference: osHint,
    vmTemplate: templateHint,
    warnings: [],
  };
}

// ── Node 2: generateArchitecture ─────────────────────────────────────────────

async function generateArchitectureNode(
  state: DeploymentGraphState
): Promise<Partial<DeploymentGraphState>> {
  console.log('[DeploymentGraph] generateArchitecture: extracting intel from doc', state.docId);

  // ── Checkpoint 1: ask for OS + template if not already known ─────────────
  if (!state.osPreference || !state.architectureApproved) {
    // We need to run extraction first so we can show supported OS options.
    let draftDesignId = state.draftDesignId;

    if (!draftDesignId) {
      const warnings: string[] = [];
      const intel = await extractFromDocument(
        state.docId,
        { strategy: 'auto' },
        state.rawContent,
        state.chatContext
      );
      const design = buildDeploymentDesign(intel, state.modeName ?? 'distributed', {});
      draftDesignId = saveDesign(design);
    }

    const supportedOS = getSupportedOsList({ ...state, draftDesignId });
    const hasMultipleOs = supportedOS.length > 1;
    const needsOsConfirm = !state.osPreference && hasMultipleOs;
    const needsArchApproval = !state.architectureApproved;

    if (needsOsConfirm || needsArchApproval) {
      // Collect what we want to confirm in one checkpoint
      const design = getDesign(draftDesignId);
      const vmSummary = design.vms.map((vm) => ({
        role: vm.role,
        services: vm.services.map((s) => s.name),
        os: vm.osRequirement?.type,
        cpu: vm.resourceHints?.minCpuCores ?? 4,
        ramGb: Math.round((vm.resourceHints?.minMemoryMb ?? 8192) / 1024),
        diskGb: vm.resourceHints?.minDiskGb ?? 40,
      }));

      const question = [
        needsOsConfirm
          ? `The documentation supports: **${supportedOS.join(', ')}**. Which OS would you prefer?`
          : '',
        needsArchApproval
          ? `I've designed a **${design.vms.length}-VM ${state.modeName ?? 'distributed'}** architecture. Does this look correct?`
          : '',
        !state.vmTemplate ? 'Do you have a specific VM template UUID you want to use? (optional)' : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      // LangGraph interrupt — pauses execution and returns this value to the caller.
      // Execution resumes when the caller calls updateState() with user answers.
      interrupt({
        question,
        draftDesignId,
        vmSummary,
        supportedOS,
        needsOsConfirm,
        needsArchApproval,
      });
    }
  }

  // ── User has provided answers (or answers were already set) — build design ──
  const warnings: string[] = [];
  const chatContextWithOs = state.osPreference
    ? `Target OS: ${state.osPreference}\n${state.chatContext ?? ''}`
    : (state.chatContext ?? '');

  let intel;
  try {
    intel = await extractFromDocument(
      state.docId,
      { strategy: 'auto' },
      state.rawContent,
      chatContextWithOs
    );
  } catch (err) {
    warnings.push(`Extraction warning: ${String(err)}`);
    intel = await extractFromDocument(state.docId, { strategy: 'single-pass' }, state.rawContent);
  }

  const design = buildDeploymentDesign(intel, state.modeName ?? 'distributed', {});
  const designId = saveDesign(design);

  return {
    phase: 'generateArchitecture',
    designId,
    draftDesignId: designId,
    warnings,
  };
}

// ── Node 3: allocateNetwork ───────────────────────────────────────────────────

async function allocateNetworkNode(
  state: DeploymentGraphState
): Promise<Partial<DeploymentGraphState>> {
  console.log('[DeploymentGraph] allocateNetwork: assigning IPs for design', state.designId);

  if (!state.networkDetails) {
    // Checkpoint 3: ask user how they want IPs assigned
    const design = getDesign(state.designId!);
    const vmCount = design.vms.length;

    interrupt({
      question: `This deployment requires **${vmCount} IP address${vmCount > 1 ? 'es' : ''}**.\n\n` +
        `Would you like me to allocate IPs from the VCD pool automatically, or do you want to specify static IPs?\n\n` +
        `_(You can also provide a hostname, subnet, and gateway if needed.)_`,
      vmCount,
      vmRoles: design.vms.map((v) => ({ id: v.id, role: v.role })),
    });
  }

  const design = getDesign(state.designId!);
  const warnings: string[] = [];
  let ipAssignments: Record<string, string> = {};

  const usePool = state.networkDetails?.usePoolIps !== false; // default to pool

  if (usePool) {
    try {
      ipAssignments = await allocateIpsForDesign(design);
    } catch (err) {
      warnings.push(`IP allocation warning: ${String(err)}`);
    }
  } else {
    // User provided static IPs — map vmId → serviceId → ip
    const staticIps = state.networkDetails?.staticIps ?? {};
    for (const vm of design.vms) {
      const ip = staticIps[vm.id] ?? staticIps[vm.role];
      if (ip) {
        for (const svc of vm.services) {
          ipAssignments[svc.id] = ip;
        }
      }
    }
  }

  // Persist updated IPs to the design
  updateDesign(state.designId!, { ipAssignments });

  return {
    phase: 'allocateNetwork',
    warnings,
  };
}

// ── Node 4: generateScripts ───────────────────────────────────────────────────

async function generateScriptsNode(
  state: DeploymentGraphState
): Promise<Partial<DeploymentGraphState>> {
  console.log('[DeploymentGraph] generateScripts: building runbook for design', state.designId);

  const design = getDesign(state.designId!);

  // Collect credential/name vars the user must set
  const credentialVarNames = collectCredentialVarNames(state.designId!);

  // Regenerate runbook with full IP context
  const runbook = generateFullRunbook(design, design.intelligence);
  updateDesign(state.designId!, { runbook });

  if (!state.credentialVarsAcknowledged && credentialVarNames.length > 0) {
    interrupt({
      question:
        `The install scripts require the following **${credentialVarNames.length} credential/name variables** to be set in your environment before deployment:\n\n` +
        credentialVarNames.map((v) => `- \`${v}\``).join('\n') +
        `\n\nI have used placeholder names — **never hardcoded passwords**. ` +
        `Please ensure these are configured in your deployment environment, then confirm to continue.`,
      credentialVarNames,
    });
  }

  return {
    phase: 'generateScripts',
    credentialVarNames,
  };
}

// ── Node 5: finalizeAndVisualize ──────────────────────────────────────────────

async function finalizeAndVisualizeNode(
  state: DeploymentGraphState
): Promise<Partial<DeploymentGraphState>> {
  console.log('[DeploymentGraph] finalizeAndVisualize: building final plan for design', state.designId);

  // Checkpoint 5: show the Mermaid diagram and ask for final approval
  if (!state.finalApproved) {
    const design = getDesign(state.designId!);
    interrupt({
      question:
        `Here is the final deployment topology. Review the Mermaid diagram and VM resource table below.\n\n` +
        `Type **Approve** (or click the button) to save this plan, or tell me what you'd like to change.`,
      mermaid: design.mermaid,
      runbookSummary: (design.runbook ?? '').split('\n').slice(0, 40).join('\n'),
      vmTable: design.vms.map((vm) => ({
        role: vm.role,
        ip: vm.ip ?? design.ipAssignments[vm.services[0]?.id] ?? '?',
        cpu: vm.resourceHints?.minCpuCores ?? 4,
        ramGb: Math.round((vm.resourceHints?.minMemoryMb ?? 8192) / 1024),
        diskGb: vm.resourceHints?.minDiskGb ?? 40,
        os: vm.osRequirement?.type,
      })),
    });
  }

  // User approved — mark design as approved and emit the planReady event
  updateDesign(state.designId!, { status: 'approved' });

  // Push to frontend using the same event that the existing planReady flow uses
  try {
    const payload = buildDeploymentPlanPayload(state.designId!);
    push('deployment:planReady', payload);
  } catch (err) {
    console.error('[DeploymentGraph] Failed to emit planReady:', err);
  }

  return {
    phase: 'complete',
  };
}

// ── Graph compilation ─────────────────────────────────────────────────────────

const workflow = new StateGraph(GraphState)
  .addNode('classifyIntent', classifyIntentNode)
  .addNode('generateArchitecture', generateArchitectureNode)
  .addNode('allocateNetwork', allocateNetworkNode)
  .addNode('generateScripts', generateScriptsNode)
  .addNode('finalizeAndVisualize', finalizeAndVisualizeNode)
  .addEdge(START, 'classifyIntent')
  .addEdge('classifyIntent', 'generateArchitecture')
  .addEdge('generateArchitecture', 'allocateNetwork')
  .addEdge('allocateNetwork', 'generateScripts')
  .addEdge('generateScripts', 'finalizeAndVisualize')
  .addEdge('finalizeAndVisualize', END);

// Nodes 2–5 all use interrupt() internally, so no interruptBefore needed at compile-time
const compiledGraph = workflow.compile({ checkpointer: fileCheckpointer });

// ── Public API ────────────────────────────────────────────────────────────────

export interface GraphStartInput {
  userPrompt: string;
  docId: string;
  rawContent?: string;
  chatContext?: string;
  modeName?: string;
}

export interface GraphResumeInput {
  // Checkpoint 1 / 2
  osPreference?: string;
  vmTemplate?: string;
  modeName?: string;
  architectureApproved?: boolean;
  // Checkpoint 3
  networkDetails?: DeploymentGraphState['networkDetails'];
  // Checkpoint 4
  credentialVarsAcknowledged?: boolean;
  // Checkpoint 5
  finalApproved?: boolean;
}

export interface GraphRunResult {
  /** true when the graph reached END */
  done: boolean;
  /** current phase when paused */
  phase: CheckpointPhase;
  /** checkpoint question to show the user (when paused) */
  question?: string;
  /** extra structured data for the checkpoint UI */
  data?: Record<string, unknown>;
  /** designId when available */
  designId?: string;
  /** non-fatal warnings */
  warnings?: string[];
  /** error message if the graph threw */
  error?: string;
}

/**
 * Start or restart the deployment graph for a given thread.
 * The threadId should be the conversationId so state is scoped to one chat session.
 */
export async function startDeploymentGraph(
  threadId: string,
  input: GraphStartInput
): Promise<GraphRunResult> {
  const config = { configurable: { thread_id: threadId } };

  const initialState: Partial<DeploymentGraphState> = {
    userPrompt: input.userPrompt,
    docId: input.docId,
    rawContent: input.rawContent,
    chatContext: input.chatContext,
    modeName: input.modeName ?? 'distributed',
    phase: 'classifyIntent',
    warnings: [],
  };

  return runGraph(config, initialState);
}

/**
 * Resume the deployment graph after a user answers a checkpoint question.
 * Merges the user's answers into the current graph state.
 */
export async function resumeDeploymentGraph(
  threadId: string,
  userUpdate: GraphResumeInput
): Promise<GraphRunResult> {
  const config = { configurable: { thread_id: threadId } };

  // Update state with user answers; LangGraph will resume from the interrupt
  await compiledGraph.updateState(config, {
    ...userUpdate,
    // Ensure the interrupt value is set so the node receives it
    __interrupt_value__: userUpdate,
  } as unknown);

  return runGraph(config, null);
}

/**
 * Shared graph runner — streams events and extracts the result.
 */
async function runGraph(
  config: { configurable: { thread_id: string } },
  input: Partial<DeploymentGraphState> | null
): Promise<GraphRunResult> {
  let lastState: DeploymentGraphState | null = null;

  try {
    // Stream graph events until the graph pauses (interrupt) or finishes (END)
    const stream = input
      ? compiledGraph.stream(input, { ...config, streamMode: 'values' })
      : compiledGraph.stream(null, { ...config, streamMode: 'values' });

    for await (const stateUpdate of await stream) {
      lastState = stateUpdate as DeploymentGraphState;
    }

    // If we get here without error the graph is done
    return {
      done: true,
      phase: 'complete',
      designId: lastState?.designId,
      warnings: lastState?.warnings ?? [],
    };
  } catch (err: unknown) {
    // LangGraph signals interrupts by throwing GraphInterrupt / NodeInterrupt
    const { isGraphInterrupt } = require('@langchain/langgraph');
    if (isGraphInterrupt(err)) {
      // Extract the interrupt value — it's the object we passed to interrupt()
      const interruptData = (err as { interrupts?: Array<{ value: Record<string, unknown> }> })
        .interrupts?.[0]?.value ?? {};

      // Also read the latest saved state to get designId / phase
      const savedTuple = await compiledGraph.getState(config);
      const savedState = savedTuple?.values as DeploymentGraphState | undefined;

      return {
        done: false,
        phase: savedState?.phase ?? 'generateArchitecture',
        question: (interruptData.question as string | undefined) ?? 'Please provide the required information.',
        data: interruptData,
        designId: savedState?.designId ?? savedState?.draftDesignId,
        warnings: savedState?.warnings ?? [],
      };
    }

    console.error('[DeploymentGraph] Unexpected error:', err);
    return {
      done: false,
      phase: lastState?.phase ?? 'classifyIntent',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Delete all checkpoint data for a thread (e.g. when user abandons the flow).
 */
export function clearDeploymentGraph(threadId: string): void {
  fileCheckpointer.deleteThread(threadId);
}
