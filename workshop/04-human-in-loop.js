/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Example 04 — Human in the Loop  (approval gate before every tool call)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Concepts shown:
 *   • onApproval callback — a hook called BEFORE each tool is executed
 *   • The agent loop pauses at the hook, waiting for human input
 *   • ALWAYS_ALLOW_TOOLS flag — bypass approval in trusted environments
 *   • How the same pattern powers the Allow / Deny buttons in the web UI
 *
 * How it works:
 *
 *   [agent] requests tool call
 *       │
 *       ▼
 *   onApproval({ name, args }) ← YOU ARE HERE (pause)
 *       │
 *       ├── approved → [tools] executes → [agent] sees result → continues
 *       └── denied  → [tools] receives "denied" message → [agent] explains
 *
 * Run:  node examples/04-human-in-loop.js
 *
 * Try typing: "what is 123 * 456, then reverse the string 'hello'"
 * Then approve the first tool and deny the second to see both paths.
 */

const readline       = require('readline');
const { buildCopilotLLM } = require('./_setup');
const { initializeDefaultTools, toolRegistry } = require('../src/tools/index');

// ── Approval helper ───────────────────────────────────────────────────────────

/**
 * Ask the user in the terminal whether to allow a tool call.
 * Returns a Promise<boolean>.
 *
 * In the web UI this same interface is fulfilled by the Allow / Deny buttons
 * posting to /api/chat/approve, which resolves the same kind of Promise.
 */
function askApproval(rl, { name, args }) {
  return new Promise((resolve) => {
    console.log('\n┌─ Tool approval required ──────────────────────────────');
    console.log(`│  Tool : ${name}`);
    console.log(`│  Args : ${JSON.stringify(args)}`);
    console.log('└───────────────────────────────────────────────────────');
    rl.question('  Allow? [Y/n] ', (answer) => {
      resolve(answer.trim().toLowerCase() !== 'n');
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── Load LangChain ─────────────────────────────────────────────────────────
  const { ChatOpenAI }                  = await import('@langchain/openai');
  const { SystemMessage, HumanMessage, AIMessage, ToolMessage } = await import('@langchain/core/messages');
  const { StateGraph, START, END, Annotation } = await import('@langchain/langgraph');

  // ── Init tools ─────────────────────────────────────────────────────────────
  initializeDefaultTools();
  console.log(`[Tools] ${toolRegistry.list().length} tools loaded`);

  // ── Build LLM ──────────────────────────────────────────────────────────────
  const llm = await buildCopilotLLM(ChatOpenAI, { model: 'gpt-4.1' });

  // Convert tools to OpenAI schema (reuse helper from copilotApi)
  // Here we build a minimal version inline so the example is self-contained.
  function sanitize(n) { return n.replace(/[^a-zA-Z0-9_-]/g, '_') || '_tool'; }
  const sanitizedToOriginal = {};
  const openAiTools = toolRegistry.list().map((t) => {
    const safe = sanitize(t.name);
    sanitizedToOriginal[safe] = t.name;
    return {
      type: 'function',
      function: {
        name: safe, description: t.description,
        parameters: { type: 'object', properties: { args: { type: 'array', items: {} } } },
      },
    };
  });
  const llmWithTools = llm.bindTools(openAiTools, { tool_choice: 'auto' });

  // ── Readline interface ─────────────────────────────────────────────────────
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  // ── Build LangGraph ────────────────────────────────────────────────────────
  // This is the same graph as Example 03, but with an approval gate added
  // inside the tools node — the only difference from a standard agent.

  const AgentState = Annotation.Root({
    messages: Annotation({ reducer: (x, y) => x.concat(y), default: () => [] }),
  });

  const agentNode = async (state) => {
    const response = await llmWithTools.invoke(state.messages);
    if (response.tool_calls?.length) {
      console.log(`\n[Agent] Wants to call: ${response.tool_calls.map((t) => t.name).join(', ')}`);
    } else {
      console.log('\n[Agent] Final reply ready.');
    }
    return { messages: [response] };
  };

  const toolsNode = async (state) => {
    const toolCalls = state.messages.at(-1).tool_calls ?? [];
    const results   = [];

    for (const tc of toolCalls) {
      const name = sanitizedToOriginal[tc.name] ?? tc.name;
      const args = Array.isArray(tc.args?.args) ? tc.args.args : Object.values(tc.args ?? {});

      // ── HUMAN-IN-THE-LOOP GATE ────────────────────────────────────────────
      // This is the key addition: pause and wait for approval before running.
      // The web UI replaces this readline prompt with Allow/Deny buttons.
      const approved = await askApproval(rl, { name, args });

      if (!approved) {
        console.log(`  [Tools] Skipped: ${name}`);
        results.push(new ToolMessage({
          tool_call_id: tc.id,
          content: JSON.stringify({ denied: true, message: 'User denied this tool call.' }),
        }));
        continue;
      }

      // User approved — run the tool
      let result;
      try {
        result = await toolRegistry.call(name, ...args);
        console.log(`  [Tools] ${name} →`, JSON.stringify(result).slice(0, 120));
      } catch (err) {
        result = { error: err.message };
      }

      results.push(new ToolMessage({ tool_call_id: tc.id, content: JSON.stringify(result) }));
    }

    return { messages: results };
  };

  const shouldContinue = (state) =>
    state.messages.at(-1).tool_calls?.length > 0 ? 'tools' : END;

  const graph = new StateGraph(AgentState)
    .addNode('agent', agentNode)
    .addNode('tools', toolsNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', shouldContinue)
    .addEdge('tools', 'agent')
    .compile();

  // ── Chat loop ──────────────────────────────────────────────────────────────
  const messages = [
    new SystemMessage(
      'You are a helpful assistant. Use tools when needed. ' +
      'If a tool was denied, explain that you were unable to use it and answer as best you can without it.'
    ),
  ];

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('  Human-in-the-loop demo  (type "exit" to quit)');
  console.log('  Tip: try "calculate 123 * 456, then reverse the string hello"');
  console.log('  Then approve one tool and deny the other.');
  console.log('─────────────────────────────────────────────────────────────\n');

  while (true) {
    const userText = (await ask('You: ')).trim();
    if (!userText || userText === 'exit') break;

    messages.push(new HumanMessage(userText));
    const result = await graph.invoke({ messages });

    // The last message in the final state is the assistant's reply
    const finalMsg = result.messages.at(-1);
    console.log('\nAssistant:', finalMsg.content, '\n');

    // Sync the local messages array with the full graph state
    messages.push(...result.messages.slice(messages.length));
  }

  rl.close();
  console.log('\nBye!');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
