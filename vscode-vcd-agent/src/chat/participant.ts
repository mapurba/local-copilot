import * as vscode from 'vscode';
import { vcdSignIn, vcdSignOut, VcdLoginInput } from '../vcdAuth';
import { ORG_OPTIONS, VCD_HOST, API_VERSION } from '../vcdConfig';

const SYSTEM_PROMPT = [
  'You are a VMware Cloud Director and Linux systems assistant. Use tools for ALL data lookups and actions — never describe how to do something manually when a tool can do it directly.',
  '',
  '── VM MANAGEMENT ──',
  'When the user asks to create a VM, do the following in a single turn without questions:',
  '1) If the user explicitly provides a template UUID (a string matching xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx), use it directly — skip vcd-agent_listTemplates.',
  '   Otherwise call vcd-agent_listTemplates with a name_filter for the OS mentioned.',
  '   Note: "seles", "sles", "suse" all mean SUSE Linux Enterprise Server (SLES) — use name_filter="sles" for those.',
  '2) Pick the closest template by OS name/version (skip if UUID was provided directly).',
  '3) Call vcd-agent_createVmDraft with vm_name, template_id, template_name, and any provided params.',
  '4) Do not ask for confirmation before vcd-agent_createVmDraft. The draft is the review step.',
  '5) Call vcd-agent_createVmConfirmed only after the user explicitly confirms.',
  'When resizing CPU or memory, call vcd-agent_resizeVm directly with vm_name_or_href and num_cpus/memory_mb.',
  'For snapshot actions: use vcd-agent_createSnapshot, vcd-agent_revertSnapshot, and vcd-agent_listSnapshots.',
  'For recent task lookups: use vcd-agent_listTasks with minutes_ago.',
  '',
  '── SSH / REMOTE EXECUTION ──',
  'When the user asks to connect to a VM, run commands on a VM, or perform any remote operation:',
  '1) Call vcd-agent_sshConnect with the host, username, and password (or privateKey) to establish a session.',
  '2) Use the returned sessionId for all subsequent vcd-agent_sshRunCommand, vcd-agent_sshRunSudo, or other ssh_* calls.',
  '3) Always call vcd-agent_sshConnect first — do NOT instruct the user to run SSH commands themselves.',
  '4) After completing the requested task, report the results directly from tool output.',
  '5) Call vcd-agent_sshDisconnect when done.',
  'IMPORTANT: vcd-agent_sshConnect and all ssh_runCommand calls require user approval — the approval dialog will appear automatically.',
  '',
  '── LONG-RUNNING TASKS ──',
  'When the user asks to perform a multi-step operation (e.g., install software, configure a server):',
  '1) Call vcd-agent_taskStart at the very beginning with a descriptive name and the SSH sessionId.',
  '2) Before EACH command, call vcd-agent_sshRunCommand (it will prompt for approval).',
  '3) After EACH command, call vcd-agent_taskLogStep with description, command, output, and exit_code.',
  '4) If a step fails, assess whether to retry, skip, or abort — then call vcd-agent_taskDone.',
  '5) When all steps are complete, call vcd-agent_taskDone.',
  '',
  '── DOCUMENT Q&A ──',
  'When the user asks about uploaded documents: use vcd-agent_docsList, vcd-agent_docsSearch, vcd-agent_docsAsk.',
  'To upload a document: call vcd-agent_docsUpload with the file path.',
  '',
  'IMPORTANT: Format all list results as markdown tables. Do NOT show raw JSON.',
  '- VM lists: columns Name, Status, IP Address, Owner.',
  '- Template lists: columns Name, CPU, Memory, OS.',
  '- Task lists: columns Name, Status, Progress, Start Time.',
].join('\n');

function historyToMessages(history: readonly vscode.ChatRequestTurn[]): vscode.LanguageModelChatMessage[] {
  return history.flatMap((turn) => {
    if (turn instanceof vscode.ChatRequestTurn) {
      return [vscode.LanguageModelChatMessage.User(turn.prompt)];
    }
    return [];
  });
}

async function handleConnect(stream: vscode.ChatResponseStream): Promise<void> {
  const org = await vscode.window.showQuickPick(ORG_OPTIONS, {
    title: `Connect to ${VCD_HOST} — Select Organization`,
    placeHolder: 'Select your VCD organization',
  });
  if (!org) return;

  const username = await vscode.window.showInputBox({
    title: `Connect to ${VCD_HOST} — Username`,
    prompt: `Username for ${org}`,
    ignoreFocusOut: true,
  });
  if (!username) return;

  const password = await vscode.window.showInputBox({
    title: `Connect to ${VCD_HOST} — Password`,
    prompt: `Password for ${username}@${org}`,
    password: true,
    ignoreFocusOut: true,
  });
  if (!password) return;

  stream.markdown(`Connecting to **${org}** on \`${VCD_HOST}\`…`);

  try {
    const input: VcdLoginInput = { host: VCD_HOST, org, username, password, apiVersion: API_VERSION };
    await vcdSignIn(input);
    stream.markdown(`\n\n✅ Connected to **${org}**. Try asking: *"list all VMs"*`);
  } catch (err) {
    stream.markdown(`\n\n❌ Login failed: ${(err as Error).message}`);
  }
}

export function registerChatParticipant(ctx: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant('vcd-agent.vcd', async (
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ) => {
    // ── Slash commands ────────────────────────────────────────────────────────
    if (request.command === 'connect') {
      await handleConnect(stream);
      return;
    }

    if (request.command === 'configure') {
      await vscode.commands.executeCommand('vcdAgent.configureTools');
      stream.markdown('Tool configuration panel opened.');
      return;
    }

    if (request.command === 'tasks') {
      await vscode.commands.executeCommand('vcdAgent.tasks.focus');
      stream.markdown('Task panel focused.');
      return;
    }

    if (request.command === 'disconnect') {
      await vcdSignOut();
      stream.markdown('Disconnected from VCD.');
      return;
    }

    // ── Main chat handler ─────────────────────────────────────────────────────
    const family = vscode.workspace.getConfiguration('vcdAgent').get<string>('preferredModel', 'gpt-4o');
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family });
    const model = models[0];
    if (!model) {
      stream.markdown('❌ No Copilot model available. Make sure GitHub Copilot is installed and signed in.');
      return;
    }

    // Gather disabled tools from settings
    const disabledTools = new Set<string>(
      vscode.workspace.getConfiguration('vcdAgent').get<string[]>('disabledTools', [])
    );

    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
      ...historyToMessages(context.history.filter((h): h is vscode.ChatRequestTurn => h instanceof vscode.ChatRequestTurn)),
      vscode.LanguageModelChatMessage.User(request.prompt),
    ];

    // Collect all registered tools, filtering out disabled ones
    // Use optional chaining on t.name in case a tool has no name set
    const allTools = vscode.lm.tools.filter((t) => t.name?.startsWith('vcd-agent_') && !disabledTools.has(t.name));

    try {
      // Agentic tool-call loop: keep running until the model stops calling tools
      while (true) {
        const response = await model.sendRequest(
          messages,
          {
            tools: allTools,
            toolMode: vscode.LanguageModelChatToolMode.Auto,
            justification: 'VCD Agent needs to interact with VCD infrastructure and remote hosts',
          },
          token
        );

        const textParts: vscode.LanguageModelTextPart[] = [];
        const toolCalls: vscode.LanguageModelToolCallPart[] = [];

        for await (const chunk of response.stream) {
          if (chunk instanceof vscode.LanguageModelTextPart) {
            stream.markdown(chunk.value);
            textParts.push(chunk);
          } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
            toolCalls.push(chunk);
            stream.progress(`Calling \`${chunk.name}\`…`);
          }
        }

        if (toolCalls.length === 0) break; // No more tool calls — done

        // Invoke all tools BEFORE touching messages, so we know whether we're
        // breaking (createVmDraft) or continuing. Pushing the Assistant message
        // with a createVmDraft ToolCallPart causes VS Code to validate its callId
        // internally during invokeTool, which calls .startsWith() on an undefined
        // property and crashes.
        const toolResults: Array<{ callId: string; result: vscode.LanguageModelToolResult }> = [];
        let vmDraftForm: Record<string, unknown> | null = null;

        for (const toolCall of toolCalls) {
          const toolResult = await vscode.lm.invokeTool(
            toolCall.name,
            { input: toolCall.input as Record<string, unknown>, toolInvocationToken: request.toolInvocationToken },
            token
          );

          if (toolCall.name === 'vcd-agent_createVmDraft') {
            try {
              const resultText = toolResult.content
                .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
                .map((p) => p.value)
                .join('');
              const parsed = JSON.parse(resultText) as { form?: Record<string, unknown> };
              if (parsed.form) vmDraftForm = parsed.form;
            } catch { /* non-fatal */ }
            break; // stop processing further tool calls
          }

          toolResults.push({ callId: toolCall.callId, result: toolResult });
        }

        if (vmDraftForm) {
          // Stream form JSON inline and open the panel — do this BEFORE pushing
          // any messages, since we're done with the model for this request.
          try {
            stream.markdown('\n\n```json\n' + JSON.stringify({ type: 'vm_create_form', message: 'Review the VM details and confirm to create the VM.', form: vmDraftForm }, null, 2) + '\n```\n\n');
            stream.markdown('📋 **Review & edit VM details** in the **Create VM** panel below. Use **Fetch IP** if you need a static address, then click **Deploy VM**.\n\n');
            await vscode.commands.executeCommand('vcdAgent.showVmForm', vmDraftForm);
          } catch (formErr) {
            console.error('[vcdAgent] showVmForm error:', formErr);
            stream.markdown('\n\n⚠️ Could not open VM form panel.\n\n');
          }
          break; // exit while loop — user acts via the form
        }

        // Not a createVmDraft turn — safe to add assistant + results to history
        messages.push(vscode.LanguageModelChatMessage.Assistant([...textParts, ...toolCalls]));
        for (const { callId, result } of toolResults) {
          messages.push(vscode.LanguageModelChatMessage.User([
            new vscode.LanguageModelToolResultPart(callId, result.content),
          ]));
        }
      }
    } catch (e) {
      if (e instanceof vscode.CancellationError) return;
      stream.markdown(`❌ Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  participant.iconPath = new vscode.ThemeIcon('vm');
  participant.followupProvider = {
    provideFollowups(_result, _context, _token) {
      return [
        { prompt: 'List all running VMs', label: 'List running VMs', command: '' },
        { prompt: 'Show recent VCD tasks', label: 'Recent tasks', command: '' },
      ];
    },
  };

  ctx.subscriptions.push(participant);
}
