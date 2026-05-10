/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Example 03 — LangGraph Agent  (StateGraph + tool calling)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Concepts shown:
 *   • Annotation.Root  — defines the shared graph state (messages list)
 *   • StateGraph       — the graph itself
 *   • addNode()        — register named processing steps
 *   • addEdge()        — fixed transitions between nodes
 *   • addConditionalEdges() — dynamic routing based on state
 *   • START / END      — reserved entry and exit points
 *   • compile()        — bake the graph into a runnable app
 *   • app.invoke()     — run the graph to completion
 *   • app.stream()     — run and stream state updates step-by-step
 *
 * Graph:
 *
 *   START ──► [agent] ──► shouldContinue ──► [tools] ──┐
 *                │                                      │
 *                │◄─────────────────────────────────────┘
 *                │
 *                └──► END
 *
 * Run:  node examples/03-langgraph-agent.js
 */

const { buildCopilotLLM } = require('./_setup');

// ── Tools ─────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Evaluate a simple arithmetic expression. E.g. "2 + 2 * 3".',
      parameters: {
        type: 'object', required: ['expression'],
        properties: { expression: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'word_count',
      description: 'Count the number of words in a text string.',
      parameters: {
        type: 'object', required: ['text'],
        properties: { text: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reverse_string',
      description: 'Reverse a string character by character.',
      parameters: {
        type: 'object', required: ['text'],
        properties: { text: { type: 'string' } },
      },
    },
  },
];

function executeTool(name, args) {
  switch (name) {
    case 'calculate': {
      // Safe arithmetic eval — only allow numbers and operators
      const safe = args.expression.replace(/[^0-9+\-*/().\s]/g, '');
      // eslint-disable-next-line no-new-func
      return { result: Function(`"use strict"; return (${safe})`)() };
    }
    case 'word_count':
      return { count: args.text.trim().split(/\s+/).length };
    case 'reverse_string':
      return { result: [...args.text].reverse().join('') };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── LangGraph agent ───────────────────────────────────────────────────────────

async function buildAgent(llmWithTools) {
  const { StateGraph, START, END, Annotation } = await import('@langchain/langgraph');
  const { ToolMessage }                         = await import('@langchain/core/messages');

  // ── State definition ───────────────────────────────────────────────────────
  // Annotation.Root() defines the shape of the shared state.
  // The `reducer` here appends new messages to the existing list
  // (rather than replacing it) — this is the key to multi-turn memory.
  const AgentState = Annotation.Root({
    messages: Annotation({
      reducer:  (existing, newMessages) => existing.concat(newMessages),
      default:  () => [],
    }),
  });

  // ── Node: agent ────────────────────────────────────────────────────────────
  // Receives the current state, calls the LLM, returns new messages.
  // The LLM may respond with text OR with tool_calls (or both).
  const agentNode = async (state) => {
    console.log(`  [agent] invoking LLM with ${state.messages.length} message(s)`);
    const response = await llmWithTools.invoke(state.messages);

    if (response.tool_calls?.length) {
      console.log(`  [agent] LLM wants to call: ${response.tool_calls.map((tc) => tc.name).join(', ')}`);
    } else {
      console.log(`  [agent] LLM replied: "${response.content.slice(0, 60)}…"`);
    }

    // Return value is merged into state via the reducer (append)
    return { messages: [response] };
  };

  // ── Node: tools ────────────────────────────────────────────────────────────
  // Reads tool_calls from the last AIMessage, executes them, and
  // wraps each result in a ToolMessage (keyed by tool_call_id).
  const toolsNode = async (state) => {
    const lastMessage = state.messages.at(-1);
    const toolMessages = [];

    for (const tc of lastMessage.tool_calls) {
      console.log(`  [tools] calling ${tc.name}(${JSON.stringify(tc.args)})`);
      let result;
      try   { result = executeTool(tc.name, tc.args); }
      catch (err) { result = { error: err.message }; }
      console.log(`  [tools] result: ${JSON.stringify(result)}`);

      toolMessages.push(new ToolMessage({
        tool_call_id: tc.id,
        content:      JSON.stringify(result),
      }));
    }

    return { messages: toolMessages };
  };

  // ── Router ─────────────────────────────────────────────────────────────────
  // Called after the agent node. Returns the name of the next node.
  // If the LLM requested tools → 'tools'; otherwise → END (stop the graph).
  const shouldContinue = (state) => {
    const last = state.messages.at(-1);
    return last.tool_calls?.length > 0 ? 'tools' : END;
  };

  // ── Build the graph ────────────────────────────────────────────────────────
  const graph = new StateGraph(AgentState)
    .addNode('agent', agentNode)           // Node 1
    .addNode('tools', toolsNode)           // Node 2
    .addEdge(START, 'agent')               // always start at agent
    .addConditionalEdges('agent', shouldContinue)  // route based on state
    .addEdge('tools', 'agent')             // always go back to agent after tools
    .compile();

  return { graph, AgentState };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { ChatOpenAI }                  = await import('@langchain/openai');
  const { SystemMessage, HumanMessage } = await import('@langchain/core/messages');

  const llm          = await buildCopilotLLM(ChatOpenAI, { model: 'gpt-4.1' });
  const llmWithTools = llm.bindTools(TOOLS, { tool_choice: 'auto' });
  const { graph }    = await buildAgent(llmWithTools);

  const system = new SystemMessage(
    'You are a helpful assistant. Use tools when needed to answer accurately.'
  );

  // ── Test 1: invoke() — run to completion, return final state ──────────────
  console.log('\n══ Test 1: invoke() — math expression ════════════════════════\n');
  const q1 = 'What is (15 + 27) * 3? Then reverse the string "LangGraph".';
  console.log('User:', q1, '\n');

  const result1 = await graph.invoke({
    messages: [system, new HumanMessage(q1)],
  });

  // Final state contains ALL messages including intermediate tool calls
  const finalReply = result1.messages.at(-1).content;
  console.log('\nFinal reply:', finalReply);

  // ── Test 2: stream() — see every state update as it happens ───────────────
  console.log('\n══ Test 2: stream() — see each graph step ════════════════════\n');
  const q2 = 'Count the words in "The quick brown fox jumps over the lazy dog", then calculate 6 * 7.';
  console.log('User:', q2, '\n');

  // stream() yields an object per node execution: { nodeName: stateUpdate }
  const stream = await graph.stream(
    { messages: [system, new HumanMessage(q2)] },
    { streamMode: 'updates' },   // 'updates' = only the delta from each node
  );

  let stepIndex = 0;
  for await (const update of stream) {
    stepIndex++;
    const [nodeName, stateUpdate] = Object.entries(update)[0];
    const msgs = stateUpdate.messages ?? [];
    console.log(`\nStep ${stepIndex} — node: "${nodeName}" (${msgs.length} new message(s))`);
    for (const m of msgs) {
      if (m.content)      console.log('  content:', m.content.slice(0, 100));
      if (m.tool_calls?.length) console.log('  tool_calls:', m.tool_calls.map((tc) => tc.name));
    }
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
