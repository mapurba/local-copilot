/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Example 06 — Git Tool Agent  (local git via tool calling)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Concepts shown:
 *   • Reusing production tool implementations from src/tools/git.js
 *   • The LLM composing multiple git commands to answer a question
 *   • Returning structured results (JSON) vs raw stdout
 *   • Scoping tools to a workspace path so commands are predictable
 *
 * Flow:
 *
 *   User goal (plain English)
 *       │
 *       ▼
 *   [LLM with git tools] ──► git:getStatus ──► git:getDiff ──► … ──► END
 *
 * Prerequisites:
 *   Run from inside any git repository, or set REPO_PATH in .env.
 *   No GitHub token needed for the local git tools.
 *
 * Run:  node workshop/06-git-agent.js
 */

const { buildCopilotLLM } = require('./_setup');
const path                = require('path');

// Import the real tool implementations from src/tools/git.js
const gitTools = require('../src/tools/git');

// Default repo: the local-copilot project itself. Override with REPO_PATH env var.
const REPO_PATH = process.env.REPO_PATH || path.join(__dirname, '..');

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Show the working tree status — staged, unstaged, and untracked files.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description:
        'Show what changed. Examples: "" = unstaged, "--staged" = staged, ' +
        '"HEAD~1" = last commit, "HEAD~5..HEAD --stat" = last 5 commits summary, "-- file.js" = one file.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Diff target (optional, default = unstaged)' },
        },
      },
    },
  },
];

// ── Tool dispatcher ───────────────────────────────────────────────────────────
// Maps LLM tool names directly to the real functions in src/tools/git.js.
// executionTarget defaults to 'local', so all commands run on this machine.

async function executeTool(name, args) {
  switch (name) {
    case 'git_status': return gitTools.getStatus(REPO_PATH);
    case 'git_diff':   return gitTools.getDiff(REPO_PATH, args.target ?? '');
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
      return response.content;
    }

    console.log(`\n  LLM called ${response.tool_calls.length} tool(s):`);
    const toolMessages = [];
    for (const tc of response.tool_calls) {
      console.log(`    → ${tc.name}(${JSON.stringify(tc.args)})`);
      let result;
      try   { result = await executeTool(tc.name, tc.args); }
      catch (err) { result = { error: err.message }; }
      console.log(`    ← ${JSON.stringify(result).slice(0, 120)}…`);
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
    `You are a Git assistant. Use the git tools to answer questions about the repository at ${REPO_PATH}. ` +
    'Keep answers concise and factual.'
  );

  console.log(`\nRepo: ${REPO_PATH}\n`);

  // ── Demo 1: recent changes ────────────────────────────────────────────────
  console.log('── Demo 1: recent changes ────────────────────────────────────');
  const q1 = 'What are the last 5 commits in this repo?';
  console.log('User:', q1);
  const a1 = await runAgent(llmWithTools, [system, new HumanMessage(q1)]);
  console.log('\nAgent:', a1);

  // ── Demo 2: uncommitted work ──────────────────────────────────────────────
  console.log('\n── Demo 2: working tree state ────────────────────────────────');
  const q2 = 'Are there any uncommitted changes right now?';
  console.log('User:', q2);
  const a2 = await runAgent(llmWithTools, [system, new HumanMessage(q2)]);
  console.log('\nAgent:', a2);

  // ── Demo 3: what changed in the last commit ───────────────────────────────
  console.log('\n── Demo 3: last commit diff ──────────────────────────────────');
  const q3 = 'What files changed in the most recent commit?';
  console.log('User:', q3);
  const a3 = await runAgent(llmWithTools, [system, new HumanMessage(q3)]);
  console.log('\nAgent:', a3);
}

main().catch((err) => { console.error(err); process.exit(1); });
