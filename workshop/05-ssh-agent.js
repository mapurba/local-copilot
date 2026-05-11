/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Example 05 — SSH Agent  (connect to a VM and run commands via tool calling)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Concepts shown:
 *   • Reusing production tool implementations from src/tools/ssh.js
 *   • ssh2 sessions persisted across multiple tool calls in one conversation
 *   • The LLM deciding which commands to run based on a natural-language goal
 *   • Feeding command output back so the LLM can reason about results
 *
 * Flow:
 *
 *   User goal (plain English)
 *       │
 *       ▼
 *   [LLM with ssh tools] ──► ssh:connect ──► ssh:runCommand ──► … ──► END
 *
 * Prerequisites:
 *   Set SSH_HOST, SSH_USER, SSH_PASSWORD in your .env  (or edit the defaults
 *   at the bottom of this file for a quick demo).
 *
 * Run:  node workshop/05-ssh-agent.js
 */

const { buildCopilotLLM } = require('./_setup');

// Import the real tool implementations — sessions and all state live here.
const sshTools = require('../src/tools/ssh');

// ── Tool definitions ──────────────────────────────────────────────────────────
// OpenAI function-calling schema. Descriptions help the LLM choose and use them.

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'ssh_connect',
      description: 'Open an SSH connection to a remote host. Call this first before running any commands.',
      parameters: {
        type: 'object',
        required: ['host', 'username', 'password'],
        properties: {
          host:      { type: 'string', description: 'IP or hostname' },
          username:  { type: 'string' },
          password:  { type: 'string' },
          sessionId: { type: 'string', description: 'Optional name (default: "default")' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ssh_run',
      description: 'Run a shell command on the connected remote host and return stdout/stderr.',
      parameters: {
        type: 'object',
        required: ['command'],
        properties: {
          command:   { type: 'string', description: 'Shell command to execute' },
          sessionId: { type: 'string', description: 'Omit if only one host is connected' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ssh_disconnect',
      description: 'Close the SSH session when done.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
        },
      },
    },
  },
];

// ── Tool dispatcher ───────────────────────────────────────────────────────────
// Maps LLM tool names to the real functions in src/tools/ssh.js.
// sshTools.connect() already handles the { host, username, password } object
// being passed as the first arg (arg-shift detection is built in).

async function executeTool(name, args) {
  switch (name) {
    case 'ssh_connect':    return sshTools.connect(args);                               // { host, username, password, sessionId? }
    case 'ssh_run':        return sshTools.runCommand(args.command, args.sessionId);    // command, sessionId?
    case 'ssh_disconnect': return sshTools.disconnect(args.sessionId);                  // sessionId?
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Agentic loop ──────────────────────────────────────────────────────────────

async function runAgent(llmWithTools, messages) {
  const { ToolMessage } = await import('@langchain/core/messages');
  let history = [...messages];

  while (true) {
    const response = await llmWithTools.invoke(history);
    history.push(response);

    if (!response.tool_calls?.length) {
      return response.content; // LLM is done — return final answer
    }

    console.log(`\n  LLM called ${response.tool_calls.length} tool(s):`);
    const toolMessages = [];
    for (const tc of response.tool_calls) {
      console.log(`    → ${tc.name}(${JSON.stringify(tc.args)})`);
      let result;
      try   { result = await executeTool(tc.name, tc.args); }
      catch (err) { result = { error: err.message }; }
      console.log(`    ← ${JSON.stringify(result).slice(0, 200)}`);
      toolMessages.push(new ToolMessage({ tool_call_id: tc.id, content: JSON.stringify(result) }));
    }
    history = [...history, ...toolMessages];
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { ChatOpenAI }                  = await import('@langchain/openai');
  const { SystemMessage, HumanMessage } = await import('@langchain/core/messages');

  const llm          = await buildCopilotLLM(ChatOpenAI);
  const llmWithTools = llm.bindTools(TOOLS, { tool_choice: 'auto' });

  const system = new SystemMessage(
    'You are a DevOps assistant. Use the SSH tools to connect to remote hosts and run commands. ' +
    'Always disconnect when you are done. Be concise in your final answer.'
  );

  // Edit these or set SSH_HOST / SSH_USER / SSH_PASSWORD in .env
  const host     = process.env.SSH_HOST     || '10.71.33.24';
  const username = process.env.SSH_USER     || 'root';
  const password = process.env.SSH_PASSWORD || 'Password1!';

  // ── Demo 1: disk usage ────────────────────────────────────────────────────
  console.log('\n── Demo 1: disk usage ────────────────────────────────────────');
  const q1 = `Connect to ${host} (username: ${username}, password: ${password}) and show me the disk usage.`;
  console.log('User:', q1);
  const a1 = await runAgent(llmWithTools, [system, new HumanMessage(q1)]);
  console.log('\nAgent:', a1);

  // ── Demo 2: running containers ────────────────────────────────────────────
  console.log('\n── Demo 2: running containers ────────────────────────────────');
  const q2 = `Using the same host (${host}, ${username}, ${password}), list all running Docker containers.`;
  console.log('User:', q2);
  const a2 = await runAgent(llmWithTools, [system, new HumanMessage(q2)]);
  console.log('\nAgent:', a2);
}

main().catch((err) => { console.error(err); process.exit(1); });
