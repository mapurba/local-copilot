/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Example 02 — Tool Calling  (LangChain, manual loop, no LangGraph)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Concepts shown:
 *   • Defining tools in the OpenAI function-calling schema
 *   • llm.bindTools()     — attaches available tools to the LLM
 *   • response.tool_calls — how the LLM requests a tool
 *   • ToolMessage         — how we return tool results to the LLM
 *   • The manual "agentic loop" (without LangGraph)
 *
 * Flow:
 *
 *   User message
 *       │
 *       ▼
 *   [LLM with tools] ──► tool_calls? ──YES──► execute tools
 *       │                                         │
 *       │                    ◄────────────────────┘ (ToolMessages)
 *       │
 *       └──NO──► final text reply
 *
 * Run:  node examples/02-tool-calling.js
 */

const { buildCopilotLLM } = require('./_setup');

// ── Define our tools ──────────────────────────────────────────────────────────
// Tools are described in the OpenAI function-calling schema (JSON Schema).
// The LLM reads these descriptions to decide which tool to call.

const TOOLS = [
  {
    type: 'function',
    function: {
      name:        'add',
      description: 'Add two numbers together.',
      parameters: {
        type: 'object',
        required: ['a', 'b'],
        properties: {
          a: { type: 'number', description: 'First operand'  },
          b: { type: 'number', description: 'Second operand' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'multiply',
      description: 'Multiply two numbers together.',
      parameters: {
        type: 'object',
        required: ['a', 'b'],
        properties: {
          a: { type: 'number', description: 'First operand'  },
          b: { type: 'number', description: 'Second operand' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'get_weather',
      description: 'Get the current weather for a city (simulated).',
      parameters: {
        type: 'object',
        required: ['city'],
        properties: {
          city: { type: 'string', description: 'City name, e.g. "London"' },
        },
      },
    },
  },
];

// ── Tool implementations ──────────────────────────────────────────────────────
// In a real app these would call external APIs, databases, etc.

const toolImplementations = {
  add:         ({ a, b }) => ({ result: a + b }),
  multiply:    ({ a, b }) => ({ result: a * b }),
  get_weather: ({ city }) => ({ city, temperature: '18°C', condition: 'Partly cloudy' }),
};

function executeTool(name, args) {
  const fn = toolImplementations[name];
  if (!fn) throw new Error(`Unknown tool: ${name}`);
  return fn(args);
}

// ── Manual agentic loop ───────────────────────────────────────────────────────

async function runWithTools(llmWithTools, messages) {
  let history = [...messages];

  // Keep going until the LLM sends a plain text reply (no tool calls)
  while (true) {
    const response = await llmWithTools.invoke(history);
    history.push(response); // always add the AI reply to history

    // No tool calls → we're done; return the final text
    if (!response.tool_calls?.length) {
      return response.content;
    }

    console.log(`\n  LLM requested ${response.tool_calls.length} tool call(s):`);

    // Execute each requested tool and collect ToolMessages
    const toolMessages = [];
    for (const tc of response.tool_calls) {
      console.log(`    → ${tc.name}(${JSON.stringify(tc.args)})`);
      const result = executeTool(tc.name, tc.args);
      console.log(`    ← ${JSON.stringify(result)}`);

      // ToolMessage pairs the result with the original call via tool_call_id
      const { ToolMessage } = await import('@langchain/core/messages');
      toolMessages.push(new ToolMessage({
        tool_call_id: tc.id,
        content:      JSON.stringify(result),
      }));
    }

    // Feed results back — the LLM will see them on the next iteration
    history = [...history, ...toolMessages];
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { ChatOpenAI }                  = await import('@langchain/openai');
  const { SystemMessage, HumanMessage } = await import('@langchain/core/messages');

  const llm = await buildCopilotLLM(ChatOpenAI, { model: 'gpt-4.1' });

  // bindTools() tells the LLM about our tools.
  // tool_choice: 'auto' lets the LLM decide when to use them.
  const llmWithTools = llm.bindTools(TOOLS, { tool_choice: 'auto' });

  const system = new SystemMessage(
    'You are a helpful assistant. Use the provided tools to answer questions.'
  );

  // ── Test 1: math ──────────────────────────────────────────────────────────
  console.log('\n── Test 1: math ──────────────────────────────────────────────');
  const q1 = 'What is (7 + 3) × 4?';
  console.log('User:', q1);
  const a1 = await runWithTools(llmWithTools, [system, new HumanMessage(q1)]);
  console.log('\nFinal reply:', a1);

  // ── Test 2: weather ───────────────────────────────────────────────────────
  console.log('\n── Test 2: weather ───────────────────────────────────────────');
  const q2 = 'What is the weather like in Tokyo right now?';
  console.log('User:', q2);
  const a2 = await runWithTools(llmWithTools, [system, new HumanMessage(q2)]);
  console.log('\nFinal reply:', a2);

  // ── Test 3: no tool needed ────────────────────────────────────────────────
  console.log('\n── Test 3: no tool needed ────────────────────────────────────');
  const q3 = 'What is the capital of Japan?';
  console.log('User:', q3);
  const a3 = await runWithTools(llmWithTools, [system, new HumanMessage(q3)]);
  console.log('\nFinal reply:', a3);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
